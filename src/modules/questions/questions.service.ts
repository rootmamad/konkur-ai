import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import { question } from '../../db/schema/question';
import { answerKey } from '../../db/schema/answer-key';
import { explanation } from '../../db/schema/explanation';
import { rubric } from '../../db/schema/rubric';
import { topic } from '../../db/schema/topic';
import { response } from '../../db/schema/response';
import { eq, and, desc, sql, SQL } from 'drizzle-orm';
import { QuestionType } from './enums/question-type.enum';
import { CreateQuestionDto, UpdateQuestionDto } from './dto/question.dto';

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
  answerKey?: {
    correctOptionIndex: number | null;
    correctText: string | null;
  };
  explanations?: Array<{
    origin: string;
    body: string;
  }>;
  rubric?: Array<{
    partKey: string;
    maxScore: string;
    order: number;
  }>;
}

@Injectable()
export class QuestionsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async createQuestion(dto: CreateQuestionDto): Promise<QuestionWithDetails> {
    // Find or create topic
    let topicId: string | null = null;
    if (dto.topic) {
      const existingTopic = await this.db
        .select({ id: topic.id })
        .from(topic)
        .where(eq(topic.slug, dto.topic.toLowerCase().replace(/\s+/g, '-')))
        .limit(1);

      if (existingTopic.length > 0) {
        topicId = existingTopic[0].id;
      } else {
        const newTopic = await this.db
          .insert(topic)
          .values({
            slug: dto.topic.toLowerCase().replace(/\s+/g, '-'),
            title: dto.topic,
            parentId: null,
          })
          .returning({ id: topic.id });
        topicId = newTopic[0].id;
      }
    }

    // Insert question - use sql template for enum
    const questionResult = await this.db
      .insert(question)
      .values({
        topicId,
        type: dto.questionType as 'multiple_choice' | 'true_false' | 'fill_blank' | 'descriptive' | 'multi_part',
        status: 'published',
        text: dto.text,
        contentBlocks: [{ type: 'text', content: dto.text }],
        options: dto.options ? dto.options.map((opt, idx) => ({ index: idx, text: opt })) : [],
        subject: dto.subject,
        concepts: [],
        prerequisites: [],
        hasTrap: false,
        difficultyAi: dto.difficulty,
      })
      .returning();

    const newQuestion = questionResult[0];

    // Insert answer key
    await this.db.insert(answerKey).values({
      questionId: newQuestion.id,
      questionVersion: newQuestion.version,
      correctOptionIndex: dto.correctOptionIndex ?? null,
      correctText: null,
    });

    // Insert explanation if provided
    if (dto.explanation) {
      await this.db.insert(explanation).values({
        questionId: newQuestion.id,
        questionVersion: newQuestion.version,
        origin: 'official',
        body: dto.explanation,
      });
    }

    // Return with details
    return this.getQuestionById(newQuestion.id);
  }

  async getQuestions(
    filters: Record<string, unknown>,
    includeAnswerKey = true,
  ): Promise<QuestionWithDetails[]> {
    const conditions: SQL<unknown>[] = [];

    if (filters.subject) {
      conditions.push(eq(question.subject, filters.subject as string));
    }
    if (filters.type) {
      conditions.push(sql`${question.type} = ${filters.type as string}`);
    }
    if (filters.status) {
      conditions.push(sql`${question.status} = ${filters.status as string}`);
    }
    if (filters.topicId) {
      conditions.push(eq(question.topicId, filters.topicId as string));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await this.db
      .select()
      .from(question)
      .where(whereClause)
      .orderBy(desc(question.createdAt))
      .limit(100);

    return Promise.all(
      rows.map((q) => this.enrichQuestion(q, includeAnswerKey)),
    );
  }

  async getQuestionById(
    id: string,
    includeAnswerKey = true,
  ): Promise<QuestionWithDetails> {
    const rows = await this.db
      .select()
      .from(question)
      .where(eq(question.id, id))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundException('Question not found');
    }

    return this.enrichQuestion(rows[0], includeAnswerKey);
  }

  async updateQuestion(id: string, dto: UpdateQuestionDto): Promise<QuestionWithDetails> {
    const existing = await this.db
      .select()
      .from(question)
      .where(eq(question.id, id))
      .limit(1);

    if (existing.length === 0) {
      throw new NotFoundException('Question not found');
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };

    if (dto.text !== undefined) {
      updateData.text = dto.text;
      updateData.contentBlocks = [{ type: 'text', content: dto.text }];
    }
    if (dto.options !== undefined) {
      updateData.options = dto.options.map((opt, idx) => ({ index: idx, text: opt }));
    }
    if (dto.subject !== undefined) {
      updateData.subject = dto.subject;
    }
    if (dto.topic !== undefined) {
      let topicId: string | null = null;
      if (dto.topic) {
        const existingTopic = await this.db
          .select({ id: topic.id })
          .from(topic)
          .where(eq(topic.slug, dto.topic.toLowerCase().replace(/\s+/g, '-')))
          .limit(1);

        if (existingTopic.length > 0) {
          topicId = existingTopic[0].id;
        } else {
          const newTopic = await this.db
            .insert(topic)
            .values({
              slug: dto.topic.toLowerCase().replace(/\s+/g, '-'),
              title: dto.topic,
              parentId: null,
            })
            .returning({ id: topic.id });
          topicId = newTopic[0].id;
        }
      }
      updateData.topicId = topicId;
    }
    if (dto.difficulty !== undefined) {
      updateData.difficultyAi = dto.difficulty;
    }
    if (dto.questionType !== undefined) {
      updateData.type = dto.questionType as 'multiple_choice' | 'true_false' | 'fill_blank' | 'descriptive' | 'multi_part';
    }

    await this.db
      .update(question)
      .set(updateData)
      .where(eq(question.id, id));

    // Update answer key if provided
    if (dto.correctOptionIndex !== undefined) {
      await this.db
        .update(answerKey)
        .set({ correctOptionIndex: dto.correctOptionIndex })
        .where(
          and(
            eq(answerKey.questionId, id),
            eq(answerKey.questionVersion, existing[0].version),
          ),
        );
    }

    // Update explanation if provided
    if (dto.explanation !== undefined) {
      await this.db
        .update(explanation)
        .set({ body: dto.explanation })
        .where(
          and(
            eq(explanation.questionId, id),
            eq(explanation.questionVersion, existing[0].version),
            eq(explanation.origin, 'official'),
          ),
        );
    }

    return this.getQuestionById(id);
  }

  async deleteQuestion(id: string): Promise<'deleted' | 'archived'> {
    const existing = await this.db
      .select({ id: question.id })
      .from(question)
      .where(eq(question.id, id))
      .limit(1);

    if (existing.length === 0) {
      throw new NotFoundException('Question not found');
    }

    // A question referenced by response rows is exam history and must
    // survive: archive it instead of deleting (spec section 15,
    // migration acceptance: relationships and history stay intact).
    const used = await this.db
      .select({ id: response.id })
      .from(response)
      .where(eq(response.questionId, id))
      .limit(1);

    if (used.length > 0) {
      await this.db
        .update(question)
        .set({ status: 'archived', updatedAt: new Date() })
        .where(eq(question.id, id));
      return 'archived';
    }

    // Unused questions delete cleanly; answer_key, explanation and
    // rubric rows cascade via foreign keys.
    await this.db.delete(question).where(eq(question.id, id));
    return 'deleted';
  }

  async getRandomQuestions(
    count: number,
    filters: Record<string, unknown>,
    includeAnswerKey = true,
  ): Promise<QuestionWithDetails[]> {
    const conditions: SQL<unknown>[] = [sql`${question.status} = 'published'`];

    if (filters.subject) {
      conditions.push(eq(question.subject, filters.subject as string));
    }
    if (filters.type) {
      conditions.push(sql`${question.type} = ${filters.type as string}`);
    }
    if (filters.topicId) {
      conditions.push(eq(question.topicId, filters.topicId as string));
    }
    if (filters.difficulty) {
      conditions.push(eq(question.difficultyAi, filters.difficulty as number));
    }

    // Use PostgreSQL's random() for random selection
    const rows = await this.db
      .select()
      .from(question)
      .where(and(...conditions))
      .orderBy(sql`random()`)
      .limit(count);

    return Promise.all(
      rows.map((q) => this.enrichQuestion(q, includeAnswerKey)),
    );
  }

  private async enrichQuestion(
    q: typeof question.$inferSelect,
    includeAnswerKey = true,
  ): Promise<QuestionWithDetails> {
    // Answer keys stay server-side for students (spec section 13.2):
    // only admins receive them. Students get content + rubric only.
    const answerKeyRows: Array<typeof answerKey.$inferSelect> =
      includeAnswerKey
        ? await this.db
            .select()
            .from(answerKey)
            .where(
              and(
                eq(answerKey.questionId, q.id),
                eq(answerKey.questionVersion, q.version),
              ),
            )
            .limit(1)
        : [];

    // Get explanations
    const explanationRows = await this.db
      .select()
      .from(explanation)
      .where(
        and(
          eq(explanation.questionId, q.id),
          eq(explanation.questionVersion, q.version),
        ),
      );

    // Get rubric
    const rubricRows = await this.db
      .select()
      .from(rubric)
      .where(eq(rubric.questionId, q.id))
      .orderBy(rubric.order);

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
      answerKey: answerKeyRows[0]
        ? {
            correctOptionIndex: answerKeyRows[0].correctOptionIndex,
            correctText: answerKeyRows[0].correctText,
          }
        : undefined,
      explanations: explanationRows.map((e) => ({
        origin: e.origin,
        body: e.body,
      })),
      rubric: rubricRows.map((r) => ({
        partKey: r.partKey,
        maxScore: r.maxScore,
        order: r.order,
      })),
    };
  }
}