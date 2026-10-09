import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql, SQL } from 'drizzle-orm';

import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import type { DbOrTx } from '../../db/types';
import { question } from '../../db/schema/question';
import { answerKey } from '../../db/schema/answer-key';
import { explanation } from '../../db/schema/explanation';
import { rubric } from '../../db/schema/rubric';
import { topic } from '../../db/schema/topic';
import { response } from '../../db/schema/response';
import { QuestionType } from './enums/question-type.enum';
import { CreateQuestionDto, UpdateQuestionDto } from './dto/question.dto';
import { QuestionListQueryDto, QuestionStatus, RandomQuestionsQueryDto } from './dto/question-query.dto';

export type QuestionAudience = 'admin' | 'student';

export interface QuestionWithDetails {
  id: string;
  version: number;
  topicId: string | null;
  type: QuestionType;
  status: string;
  text: string;
  contentBlocks: unknown[];
  options: unknown[];
  subject: string;
  concepts: string[];
  prerequisites: string[];
  hasTrap: boolean;
  difficultyAi: number | null;
  sourceYear: number | null;
  sourceSession: string | null;
  sourceMajor: string | null;
  sourceLesson: string | null;
  sourceNumber: number | null;
  sourcePage: number | null;
  createdAt: Date;
  updatedAt: Date;
  answerKey?: { correctOptionIndex: number | null; correctText: string | null };
  explanations?: Array<{ origin: string; body: string }>;
  rubric: Array<{ partKey: string; maxScore: string; order: number }>;
}

type QuestionRow = typeof question.$inferSelect;

/**
 * Spec 4: extract -> review -> publish only approved, versioned.
 * Until versioning lands, published content is immutable.
 */
const EDITABLE_STATUSES: ReadonlySet<QuestionStatus> = new Set(['draft', 'in_review']);
const STATUS_TRANSITIONS: Record<QuestionStatus, readonly QuestionStatus[]> = {
  draft: ['in_review'],
  in_review: ['draft', 'published'],
  published: ['archived'],
  archived: [],
};

@Injectable()
export class QuestionsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async createQuestion(dto: CreateQuestionDto): Promise<QuestionWithDetails> {
    this.assertChoiceShape(dto.questionType, dto.options, dto.correctOptionIndex);

    const id = await this.db.transaction(async (tx) => {
      const topicId = await this.resolveTopicId(tx, dto.topic);
      const [created] = await tx
        .insert(question)
        .values({
          topicId,
          type: dto.questionType,
          status: 'draft',
          text: dto.text,
          contentBlocks: [{ type: 'text', content: dto.text }],
          options: this.toOptions(dto.options),
          subject: dto.subject,
          difficultyAi: dto.difficulty,
        })
        .returning({ id: question.id, version: question.version });

      await tx.insert(answerKey).values({
        questionId: created.id,
        questionVersion: created.version,
        correctOptionIndex: dto.correctOptionIndex ?? null,
        correctText: null,
      });

      if (dto.explanation) {
        await tx.insert(explanation).values({
          questionId: created.id,
          questionVersion: created.version,
          origin: 'official',
          body: dto.explanation,
        });
      }
      return created.id;
    });

    return this.getQuestionById(id, 'admin');
  }

  async getQuestions(query: QuestionListQueryDto, audience: QuestionAudience): Promise<QuestionWithDetails[]> {
    const conditions = this.buildFilters(query);
    const status = audience === 'student' ? 'published' : query.status;
    if (status) conditions.push(eq(question.status, status));

    const rows = await this.db
      .select()
      .from(question)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(question.createdAt))
      .limit(100);

    return Promise.all(rows.map((q) => this.enrichQuestion(q, audience)));
  }

  async getQuestionById(id: string, audience: QuestionAudience): Promise<QuestionWithDetails> {
    const conditions: SQL[] = [eq(question.id, id)];
    // Students only ever see published content (no draft/archived leak).
    if (audience === 'student') conditions.push(eq(question.status, 'published'));

    const [row] = await this.db.select().from(question).where(and(...conditions)).limit(1);
    if (!row) throw new NotFoundException('Question not found');
    return this.enrichQuestion(row, audience);
  }

  async getRandomQuestions(query: RandomQuestionsQueryDto, audience: QuestionAudience): Promise<QuestionWithDetails[]> {
    const conditions = this.buildFilters(query);
    conditions.push(eq(question.status, 'published'));
    if (query.difficulty !== undefined) conditions.push(eq(question.difficultyAi, query.difficulty));

    const rows = await this.db
      .select()
      .from(question)
      .where(and(...conditions))
      .orderBy(sql`random()`)
      .limit(query.count);

    return Promise.all(rows.map((q) => this.enrichQuestion(q, audience)));
  }

  async updateQuestion(id: string, dto: UpdateQuestionDto): Promise<QuestionWithDetails> {
    const existing = await this.requireQuestion(id);
    if (!EDITABLE_STATUSES.has(existing.status)) {
      throw new ConflictException(
        'Published or archived questions are immutable until question versioning is implemented',
      );
    }
    this.assertChoiceShape(
      dto.questionType ?? (existing.type as QuestionType),
      dto.options ?? (existing.options as Array<{ text: string }>).map((o) => o.text),
      dto.correctOptionIndex,
    );

    await this.db.transaction(async (tx) => {
      const changes: Partial<typeof question.$inferInsert> = { updatedAt: new Date() };
      if (dto.text !== undefined) {
        changes.text = dto.text;
        changes.contentBlocks = [{ type: 'text', content: dto.text }];
      }
      if (dto.options !== undefined) changes.options = this.toOptions(dto.options);
      if (dto.subject !== undefined) changes.subject = dto.subject;
      if (dto.topic !== undefined) changes.topicId = await this.resolveTopicId(tx, dto.topic);
      if (dto.difficulty !== undefined) changes.difficultyAi = dto.difficulty;
      if (dto.questionType !== undefined) changes.type = dto.questionType;

      await tx.update(question).set(changes).where(eq(question.id, id));

      if (dto.correctOptionIndex !== undefined) {
        await tx
          .update(answerKey)
          .set({ correctOptionIndex: dto.correctOptionIndex })
          .where(and(eq(answerKey.questionId, id), eq(answerKey.questionVersion, existing.version)));
      }
      if (dto.explanation !== undefined) {
        await tx
          .update(explanation)
          .set({ body: dto.explanation })
          .where(
            and(
              eq(explanation.questionId, id),
              eq(explanation.questionVersion, existing.version),
              eq(explanation.origin, 'official'),
            ),
          );
      }
    });

    return this.getQuestionById(id, 'admin');
  }

  async updateStatus(id: string, next: QuestionStatus): Promise<QuestionWithDetails> {
    const existing = await this.requireQuestion(id);
    if (!STATUS_TRANSITIONS[existing.status].includes(next)) {
      throw new ConflictException(`Cannot move question from "${existing.status}" to "${next}"`);
    }
    if (next === 'published' && existing.type === QuestionType.MULTIPLE_CHOICE) {
      const [key] = await this.db
        .select({ correctOptionIndex: answerKey.correctOptionIndex })
        .from(answerKey)
        .where(and(eq(answerKey.questionId, id), eq(answerKey.questionVersion, existing.version)))
        .limit(1);
      if (key?.correctOptionIndex == null) {
        throw new BadRequestException('A multiple-choice question needs an answer key before publishing');
      }
    }

    await this.db.update(question).set({ status: next, updatedAt: new Date() }).where(eq(question.id, id));
    return this.getQuestionById(id, 'admin');
  }

  async deleteQuestion(id: string): Promise<'deleted' | 'archived'> {
    await this.requireQuestion(id);

    const used = await this.db
      .select({ id: response.id })
      .from(response)
      .where(eq(response.questionId, id))
      .limit(1);

    if (used.length > 0) {
      await this.db.update(question).set({ status: 'archived', updatedAt: new Date() }).where(eq(question.id, id));
      return 'archived';
    }

    await this.db.delete(question).where(eq(question.id, id));
    return 'deleted';
  }

  private async requireQuestion(id: string): Promise<QuestionRow> {
    const [row] = await this.db.select().from(question).where(eq(question.id, id)).limit(1);
    if (!row) throw new NotFoundException('Question not found');
    return row;
  }

  private buildFilters(query: Pick<QuestionListQueryDto, 'subject' | 'type' | 'topicId'>): SQL[] {
    const conditions: SQL[] = [];
    if (query.subject) conditions.push(eq(question.subject, query.subject));
    if (query.type) conditions.push(eq(question.type, query.type));
    if (query.topicId) conditions.push(eq(question.topicId, query.topicId));
    return conditions;
  }

  private assertChoiceShape(type: QuestionType, options?: string[], correctIndex?: number): void {
    if (type !== QuestionType.MULTIPLE_CHOICE) return;
    if (!options || options.length < 2) {
      throw new BadRequestException('Multiple-choice questions need at least 2 options');
    }
    if (correctIndex !== undefined && correctIndex >= options.length) {
      throw new BadRequestException('correctOptionIndex is out of range');
    }
  }

  private toOptions(options?: string[]) {
    return (options ?? []).map((text, index) => ({ index, text }));
  }

  private async resolveTopicId(executor: DbOrTx, title: string): Promise<string | null> {
    if (!title) return null;
    const slug = title.toLowerCase().trim().replace(/\s+/g, '-');
    const [found] = await executor.select({ id: topic.id }).from(topic).where(eq(topic.slug, slug)).limit(1);
    if (found) return found.id;

    const [created] = await executor
      .insert(topic)
      .values({ slug, title, parentId: null })
      .returning({ id: topic.id });
    return created.id;
  }

  private async enrichQuestion(q: QuestionRow, audience: QuestionAudience): Promise<QuestionWithDetails> {
    const isAdmin = audience === 'admin';

    // Answer key AND explanations stay server-side for students:
    // official explanations usually contain the answer (spec 13.2).
    const [keyRows, explanationRows, rubricRows] = await Promise.all([
      isAdmin
        ? this.db
            .select()
            .from(answerKey)
            .where(and(eq(answerKey.questionId, q.id), eq(answerKey.questionVersion, q.version)))
            .limit(1)
        : Promise.resolve([]),
      isAdmin
        ? this.db
            .select()
            .from(explanation)
            .where(and(eq(explanation.questionId, q.id), eq(explanation.questionVersion, q.version)))
        : Promise.resolve([]),
      this.db.select().from(rubric).where(eq(rubric.questionId, q.id)).orderBy(rubric.order),
    ]);

    return {
      id: q.id,
      version: q.version,
      topicId: q.topicId,
      type: q.type as QuestionType,
      status: q.status,
      text: q.text,
      contentBlocks: q.contentBlocks as unknown[],
      options: q.options as unknown[],
      subject: q.subject,
      concepts: q.concepts as string[],
      prerequisites: q.prerequisites as string[],
      hasTrap: q.hasTrap,
      difficultyAi: q.difficultyAi,
      sourceYear: q.sourceYear,
      sourceSession: q.sourceSession,
      sourceMajor: q.sourceMajor,
      sourceLesson: q.sourceLesson,
      sourceNumber: q.sourceNumber,
      sourcePage: q.sourcePage,
      createdAt: q.createdAt,
      updatedAt: q.updatedAt,
      ...(isAdmin && {
        answerKey: keyRows[0]
          ? { correctOptionIndex: keyRows[0].correctOptionIndex, correctText: keyRows[0].correctText }
          : undefined,
        explanations: explanationRows.map((e) => ({ origin: e.origin, body: e.body })),
      }),
      rubric: rubricRows.map((r) => ({ partKey: r.partKey, maxScore: r.maxScore, order: r.order })),
    };
  }
}
