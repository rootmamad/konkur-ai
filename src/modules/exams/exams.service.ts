import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import type { DbOrTx, Tx } from '../../db/types';
import { isUniqueViolation } from '../../db/pg-errors';
import { examInstance, examTemplate } from '../../db/schema/exam';
import { attempt } from '../../db/schema/attempt';
import { response } from '../../db/schema/response';
import { correction } from '../../db/schema/correction';
import { question } from '../../db/schema/question';
import { student } from '../../db/schema/student';
import { answerKey } from '../../db/schema/answer-key';
import { QuestionType } from '../questions/enums/question-type.enum';
import { StartExamDto } from './dto/start-exam.dto';
import { ANSWER_SUBMIT_GRACE_SECONDS, MAX_QUESTIONS_PER_EXAM, MAX_TEXT_ANSWER_LENGTH } from './exam.constants';

export interface ExamSession {
  attemptId: string;
  questionOrder: string[];
  durationSeconds: number;
  startedAt: Date;
  /** Server-authoritative deadline; frontend counts down from this (spec 8). */
  expiresAt: Date;
  serverTime: Date;
}

type StoredAnswer = { selectedOption: number | null; textAnswer: string | null };
type ResponseRow = typeof response.$inferSelect;

/** Current difficulty buckets used for selection (see open decision on 1-5 scale). */
const DIFFICULTY_BUCKETS = [
  { level: 1, key: 'easy' },
  { level: 2, key: 'normal' },
  { level: 3, key: 'hard' },
] as const;

@Injectable()
export class ExamsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async startExam(userId: string, dto: StartExamDto, clientKey: string): Promise<ExamSession> {
    const studentId = await this.requireStudentId(userId);
    const idempotencyKey = `${studentId}:${clientKey}`;

    // Retry of the same start (dropped connection) returns the same attempt (spec 15).
    const replay = await this.findSessionByKey(idempotencyKey);
    if (replay) return replay;

    const total = dto.counts.easy + dto.counts.normal + dto.counts.hard;
    if (total === 0) throw new BadRequestException('At least one question must be selected');
    if (total > MAX_QUESTIONS_PER_EXAM) {
      throw new BadRequestException(`At most ${MAX_QUESTIONS_PER_EXAM} questions per exam`);
    }

    const questionIds = await this.selectQuestionIds(dto);
    if (questionIds.length === 0) throw new BadRequestException('No questions found matching criteria');

    try {
      return await this.db.transaction(async (tx) => {
        const templateId = await this.getOrCreateTemplateId(tx, dto);
        const [instance] = await tx
          .insert(examInstance)
          .values({
            templateId,
            questionOrder: questionIds,
            settingsSnapshot: {
              questionType: dto.questionType,
              counts: dto.counts,
              durationSeconds: dto.durationSeconds,
              generatedAt: new Date().toISOString(),
            },
          })
          .returning({ id: examInstance.id });

        const [created] = await tx
          .insert(attempt)
          .values({ studentId, examInstanceId: instance.id, status: 'in_progress', idempotencyKey })
          .returning({ id: attempt.id, startedAt: attempt.startedAt });

        return this.toSession(created.id, questionIds, dto.durationSeconds, created.startedAt);
      });
    } catch (error) {
      // Two concurrent retries: the loser reads the winner's attempt.
      if (isUniqueViolation(error)) {
        const winner = await this.findSessionByKey(idempotencyKey);
        if (winner) return winner;
      }
      throw error;
    }
  }

  async submitAnswer(attemptId: string, userId: string, questionIndex: number, answer: unknown): Promise<void> {
    const studentId = await this.requireStudentId(userId);
    const ctx = await this.loadOwnedAttempt(this.db, attemptId, studentId);
    this.assertInProgress(ctx.status);
    this.assertBeforeDeadline(ctx.startedAt, ctx.settings);

    const order = ctx.questionOrder as string[];
    if (questionIndex < 0 || questionIndex >= order.length) {
      throw new BadRequestException('Invalid question index');
    }
    const questionId = order[questionIndex];

    const [q] = await this.db
      .select({ version: question.version, type: question.type, options: question.options })
      .from(question)
      .where(eq(question.id, questionId))
      .limit(1);
    if (!q) throw new NotFoundException('Question not found');

    const stored = this.normalizeAnswer(q.type, q.options, answer);
    const attemptNumber = (await this.countPriorAttempts(studentId, questionId, attemptId)) + 1;

    // Upsert keeps the save idempotent: a retried or changed answer
    // overwrites the same row instead of creating duplicates.
    await this.db
      .insert(response)
      .values({
        attemptId,
        questionId,
        questionVersion: q.version,
        ...stored,
        attemptNumber,
        answeredAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [response.attemptId, response.questionId],
        set: { ...stored, answeredAt: new Date() },
      });
  }

  async finishExam(attemptId: string, userId: string): Promise<{ totalScore: number; pendingDescriptive: number }> {
    const studentId = await this.requireStudentId(userId);

    return this.db.transaction(async (tx) => {
      // Row lock: a double-click or retry cannot finish/grade twice.
      const ctx = await this.loadOwnedAttempt(tx, attemptId, studentId, true);
      this.assertInProgress(ctx.status);

      const rows = await tx.select().from(response).where(eq(response.attemptId, attemptId));
      const descriptive = rows.filter((r) => r.textAnswer !== null);
      const choice = rows.filter((r) => r.selectedOption !== null);

      const totalScore = await this.gradeChoiceResponses(tx, choice);
      await this.queueDescriptiveForReview(tx, descriptive);

      await tx
        .update(attempt)
        .set({ status: 'submitted', submittedAt: new Date(), totalScore })
        .where(eq(attempt.id, attemptId));

      return { totalScore, pendingDescriptive: descriptive.length };
    });
  }

  async getExamAttempt(attemptId: string, userId: string) {
    const studentId = await this.requireStudentId(userId);
    const ctx = await this.loadOwnedAttempt(this.db, attemptId, studentId);
    const responses = await this.db
      .select({
        questionId: response.questionId,
        selectedOption: response.selectedOption,
        textAnswer: response.textAnswer,
        isCorrect: response.isCorrect,
        answeredAt: response.answeredAt,
      })
      .from(response)
      .where(eq(response.attemptId, attemptId));

    return {
      id: ctx.id,
      status: ctx.status,
      startedAt: ctx.startedAt,
      submittedAt: ctx.submittedAt,
      totalScore: ctx.totalScore,
      questionOrder: ctx.questionOrder as string[],
      expiresAt: this.deadlineOf(ctx.startedAt, ctx.settings),
      serverTime: new Date(),
      responses,
    };
  }

  async getUserExams(userId: string) {
    const studentId = await this.requireStudentId(userId);
    return this.db
      .select({
        id: attempt.id,
        status: attempt.status,
        startedAt: attempt.startedAt,
        submittedAt: attempt.submittedAt,
        totalScore: attempt.totalScore,
      })
      .from(attempt)
      .where(eq(attempt.studentId, studentId))
      .orderBy(desc(attempt.startedAt))
      .limit(50);
  }

  // ---------- helpers ----------

  private async requireStudentId(userId: string): Promise<string> {
    const [row] = await this.db
      .select({ id: student.id })
      .from(student)
      .where(eq(student.accountId, userId))
      .limit(1);
    if (!row) throw new NotFoundException('Student profile not found');
    return row.id;
  }

  private async loadOwnedAttempt(executor: DbOrTx, attemptId: string, studentId: string, lock = false) {
    const base = executor
      .select({
        id: attempt.id,
        status: attempt.status,
        startedAt: attempt.startedAt,
        submittedAt: attempt.submittedAt,
        totalScore: attempt.totalScore,
        questionOrder: examInstance.questionOrder,
        settings: examInstance.settingsSnapshot,
      })
      .from(attempt)
      .innerJoin(examInstance, eq(examInstance.id, attempt.examInstanceId))
      .where(and(eq(attempt.id, attemptId), eq(attempt.studentId, studentId)))
      .limit(1);

    const rows = lock ? await base.for('update', { of: attempt }) : await base;
    if (!rows[0]) throw new NotFoundException('Attempt not found');
    return rows[0];
  }

  private async findSessionByKey(idempotencyKey: string): Promise<ExamSession | null> {
    const [row] = await this.db
      .select({
        id: attempt.id,
        startedAt: attempt.startedAt,
        questionOrder: examInstance.questionOrder,
        settings: examInstance.settingsSnapshot,
      })
      .from(attempt)
      .innerJoin(examInstance, eq(examInstance.id, attempt.examInstanceId))
      .where(eq(attempt.idempotencyKey, idempotencyKey))
      .limit(1);

    if (!row) return null;
    return this.toSession(row.id, row.questionOrder as string[], this.durationOf(row.settings), row.startedAt);
  }

  private async selectQuestionIds(dto: StartExamDto): Promise<string[]> {
    const ids: string[] = [];
    for (const { level, key } of DIFFICULTY_BUCKETS) {
      const count = dto.counts[key];
      if (count === 0) continue;
      const rows = await this.db
        .select({ id: question.id })
        .from(question)
        .where(
          and(
            eq(question.status, 'published'),
            eq(question.type, dto.questionType),
            eq(question.difficultyAi, level),
          ),
        )
        .orderBy(sql`random()`)
        .limit(count);
      ids.push(...rows.map((r) => r.id));
    }
    return this.shuffle(ids);
  }

  /** Placeholder until the 7 quiz kinds land (step 6). */
  private async getOrCreateTemplateId(tx: Tx, dto: StartExamDto): Promise<string> {
    const [existing] = await tx
      .select({ id: examTemplate.id })
      .from(examTemplate)
      .where(eq(examTemplate.kind, 'smart_mix'))
      .limit(1);
    if (existing) return existing.id;

    const [created] = await tx
      .insert(examTemplate)
      .values({
        kind: 'smart_mix',
        title: 'Smart Mix Exam',
        config: { questionType: dto.questionType, counts: dto.counts },
        settingsVersion: 1,
      })
      .returning({ id: examTemplate.id });
    return created.id;
  }

  private normalizeAnswer(type: string, options: unknown, answer: unknown): StoredAnswer {
    if (type === QuestionType.MULTIPLE_CHOICE) {
      const optionCount = Array.isArray(options) ? options.length : 0;
      if (typeof answer !== 'number' || !Number.isInteger(answer) || answer < 0 || answer >= optionCount) {
        throw new BadRequestException('Answer must be a valid option index for this question');
      }
      return { selectedOption: answer, textAnswer: null };
    }

    if (type === QuestionType.DESCRIPTIVE) {
      if (typeof answer !== 'string') throw new BadRequestException('Answer must be text for this question');
      const text = answer.trim();
      if (text.length === 0 || text.length > MAX_TEXT_ANSWER_LENGTH) {
        throw new BadRequestException(`Text answer must be 1-${MAX_TEXT_ANSWER_LENGTH} characters`);
      }
      return { selectedOption: null, textAnswer: text };
    }

    throw new BadRequestException(`Answering "${type}" questions is not supported yet`);
  }

  private async countPriorAttempts(studentId: string, questionId: string, currentAttemptId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(distinct ${response.attemptId})::int` })
      .from(response)
      .innerJoin(attempt, eq(attempt.id, response.attemptId))
      .where(
        and(
          eq(attempt.studentId, studentId),
          eq(response.questionId, questionId),
          ne(response.attemptId, currentAttemptId),
        ),
      );
    return row?.count ?? 0;
  }

  private async gradeChoiceResponses(tx: Tx, rows: ResponseRow[]): Promise<number> {
    if (rows.length === 0) return 0;

    const keys = await tx
      .select({
        questionId: answerKey.questionId,
        questionVersion: answerKey.questionVersion,
        correctOptionIndex: answerKey.correctOptionIndex,
      })
      .from(answerKey)
      .where(inArray(answerKey.questionId, [...new Set(rows.map((r) => r.questionId))]));

    const correctByVersion = new Map(keys.map((k) => [`${k.questionId}:${k.questionVersion}`, k.correctOptionIndex]));

    let score = 0;
    for (const r of rows) {
      const correct = correctByVersion.get(`${r.questionId}:${r.questionVersion}`);
      // Missing key => unknown (null), never a silent "wrong".
      const isCorrect = correct == null ? null : correct === r.selectedOption;
      await tx.update(response).set({ isCorrect }).where(eq(response.id, r.id));
      if (isCorrect) score += 1;
    }
    return score;
  }

  /** Spec 6: descriptive answers are never string-matched; they wait for rubric grading. */
  private async queueDescriptiveForReview(tx: Tx, rows: ResponseRow[]): Promise<void> {
    if (rows.length === 0) return;
    const ids = rows.map((r) => r.id);

    await tx.update(response).set({ isCorrect: null }).where(inArray(response.id, ids));

    const existing = await tx
      .select({ responseId: correction.responseId })
      .from(correction)
      .where(inArray(correction.responseId, ids));
    const queued = new Set(existing.map((e) => e.responseId));

    const missing = ids.filter((id) => !queued.has(id));
    if (missing.length === 0) return;

    await tx.insert(correction).values(
      missing.map((responseId) => ({
        responseId,
        partScores: [],
        totalScore: null,
        status: 'needs_review' as const,
        modelVersion: null,
      })),
    );
  }

  private assertInProgress(status: string): void {
    if (status !== 'in_progress') throw new ConflictException('Attempt is not in progress');
  }

  private assertBeforeDeadline(startedAt: Date, settings: unknown): void {
    const hardStop = this.deadlineOf(startedAt, settings).getTime() + ANSWER_SUBMIT_GRACE_SECONDS * 1000;
    if (Date.now() > hardStop) throw new ConflictException('Exam time is over');
  }

  private deadlineOf(startedAt: Date, settings: unknown): Date {
    return new Date(startedAt.getTime() + this.durationOf(settings) * 1000);
  }

  private durationOf(settings: unknown): number {
    const duration = (settings as { durationSeconds?: unknown } | null)?.durationSeconds;
    if (typeof duration !== 'number' || !Number.isInteger(duration) || duration <= 0) {
      throw new InternalServerErrorException('Exam settings snapshot is invalid');
    }
    return duration;
  }

  private toSession(attemptId: string, questionOrder: string[], durationSeconds: number, startedAt: Date): ExamSession {
    return {
      attemptId,
      questionOrder,
      durationSeconds,
      startedAt,
      expiresAt: new Date(startedAt.getTime() + durationSeconds * 1000),
      serverTime: new Date(),
    };
  }

  private shuffle<T>(items: T[]): T[] {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
}