import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import type { DbOrTx, Tx } from '../../db/types';
import { isUniqueViolation } from '../../db/pg-errors';
import {
  examInstance,
  examTemplate,
  examTemplateKind,
} from '../../db/schema/exam';
import { attempt } from '../../db/schema/attempt';
import { response } from '../../db/schema/response';
import { correction } from '../../db/schema/correction';
import { question } from '../../db/schema/question';
import { student } from '../../db/schema/student';
import { answerKey } from '../../db/schema/answer-key';
import { questionMastery } from '../../db/schema/question-mastery';
import { quotaUsage, subscription } from '../../db/schema/billing';
import { appConfig } from '../../db/schema/app-config';
import { QuestionType } from '../questions/enums/question-type.enum';
import { StartExamDto, CountsDto } from './dto/start-exam.dto';
// Value import (not `import type`): design:paramtypes must carry the real
// class for Nest to inject the optional dependency in production.
import { QuestionDrafterService } from '../ai/question-drafter.service';
import { ReferralsService } from '../referrals/referrals.service';
import {
  ANSWER_SUBMIT_GRACE_SECONDS,
  DIAGNOSTIC_DURATION_SECONDS,
  DIAGNOSTIC_QUESTION_COUNT,
  FINAL_SIM_DURATION_SECONDS,
  KONKUR_SIM_DURATION_SECONDS,
  MAX_EXAM_DURATION_SECONDS,
  MAX_QUESTIONS_PER_EXAM,
  MAX_TEXT_ANSWER_LENGTH,
  SIM_QUESTION_COUNT_DEFAULT,
  SIM_QUESTION_COUNT_KEY,
  SIM_SOURCE_MIN_YEAR,
  SIM_TOPIC_CAP,
} from './exam.constants';

/**
 * ترکیبی هوشمند — MVP default shares of the question budget handed to each
 * history-driven pool. Quotas are targets, not guarantees: a short pool is
 * topped up from general prep. Candidates for app_config later (spec §10).
 */
export const SMART_MIX_DUE_RATIO = 0.4;
export const SMART_MIX_ERROR_RATIO = 0.3;
export const SMART_MIX_TRAP_RATIO = 0.3;

export interface ExamSession {
  attemptId: string;
  questionOrder: string[];
  durationSeconds: number;
  startedAt: Date;
  /** Server-authoritative deadline; frontend counts down from this (spec 8). */
  expiresAt: Date;
  serverTime: Date;
}

type StoredAnswer = {
  selectedOption: number | null;
  textAnswer: string | null;
};
type ResponseRow = typeof response.$inferSelect;
type ExamKind = (typeof examTemplateKind.enumValues)[number];
type SelectDto = StartExamDto & {
  counts: CountsDto;
  durationSeconds: number;
};

const KIND_TITLES: Record<ExamKind, string> = {
  quiz_after_study: 'Quiz After Study',
  debug_errors: 'Debug Errors',
  due_review: 'Due Review',
  speed: 'Speed Quiz',
  trap_finder: 'Trap Finder',
  general_prep: 'General Prep',
  smart_mix: 'Smart Mix',
  diagnostic: 'Diagnostic',
  konkur_sim: 'Konkur Simulation',
  final_sim: 'Final Simulation',
};

/** Current difficulty buckets used for selection (see open decision on 1-5 scale). */
const DIFFICULTY_BUCKETS = [
  { level: 1, key: 'easy' },
  { level: 2, key: 'normal' },
  { level: 3, key: 'hard' },
] as const;

/**
 * Spec §3.3: the diagnostic measures the basics, so it draws level-1
 * questions only.
 */
const DIAGNOSTIC_DIFFICULTY_LEVEL = 1;

/**
 * Maximum share of the total smart_mix quota that can be filled by the
 * AI-generated pool (pool 0). Candidate for app_config override later.
 */
const AI_MAX_SHARE = 0.5;

/**
 * Free-plan quiz quota (spec section 10). The authoritative numbers live in the
 * active app_config row; the value below is only the documented default for
 * "3 آزمونک در هر ۷ روز" when no active setting exists yet.
 */
const QUIZ_QUOTA_OPERATION = 'quiz';
const FREE_QUIZ_WEEKLY_KEY = 'free_quiz_weekly';
const FREE_QUIZ_WEEKLY_DEFAULT = 3;
const FREE_QUIZ_QUOTA_EXHAUSTED = 'سهمیه آزمونک هفتگی پلن رایگان تمام شده است';

/**
 * Free-plan per-quiz question cap (spec 10): «هرکدام حداکثر ۱۰ سؤال».
 * Config-driven like the weekly quota; 10 is the documented default.
 */
const FREE_QUIZ_MAX_QUESTIONS_KEY = 'free_quiz_max_questions';
const FREE_QUIZ_MAX_QUESTIONS_DEFAULT = 10;

/**
 * Speed quiz (spec §5): a correct answer slower than this many seconds counts as
 * "correct but slow". Config-driven like every other limit; 90s is the default.
 */
const SPEED_SLOW_THRESHOLD_KEY = 'speed_slow_threshold_seconds';
const SPEED_SLOW_THRESHOLD_DEFAULT = 90;

/**
 * Fast timer for the speed quiz (spec §5, §8): the server grants this many
 * seconds per question instead of trusting the client-supplied duration.
 */
const SPEED_SECONDS_PER_QUESTION_KEY = 'speed_seconds_per_question';
const SPEED_SECONDS_PER_QUESTION_DEFAULT = 60;

@Injectable()
export class ExamsService {
  private readonly logger = new Logger(ExamsService.name);
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() private readonly drafter?: QuestionDrafterService,
    @Optional() private readonly referrals?: ReferralsService,
  ) {}

  async startExam(
    userId: string,
    dto: StartExamDto,
    clientKey: string,
  ): Promise<ExamSession> {
    // 1) Subscription check for simulation kinds (before resolving student).
    if (dto.kind === 'konkur_sim' || dto.kind === 'final_sim') {
      if (!(await this.hasPaidPlan(userId))) {
        throw new ForbiddenException('این آزمون نیازمند پلن پولی است');
      }
    }

    const studentId = await this.requireStudentId(userId);
    const idempotencyKey = `${studentId}:${clientKey}`;

    // Retry of the same start (dropped connection) returns the same attempt (spec 15).
    const replay = await this.findSessionByKey(idempotencyKey);
    if (replay) return replay;

    // Free plan: 3 quizlets per rolling 7 days (spec 10). The cap is checked
    // before selection and the slot is reserved inside the attempt transaction
    // (spec 3.4) so a started quiz can always be finished. Paid plans and the
    // paid-only simulators are not quota-limited.
    const isSimulation = dto.kind === 'konkur_sim' || dto.kind === 'final_sim';
    const enforceFreeQuizQuota =
      !isSimulation && !(await this.hasPaidPlan(userId));
    let freeQuizLimit = 0;
    if (enforceFreeQuizQuota) {
      freeQuizLimit = await this.getFreeQuizLimit();
      const used = await this.countQuizUsage(studentId);
      if (used >= freeQuizLimit) {
        throw new ForbiddenException(FREE_QUIZ_QUOTA_EXHAUSTED);
      }
    }

    let counts: StartExamDto['counts'];
    let durationSeconds: number;

    if (dto.kind === ('diagnostic' as ExamKind)) {
      counts = { easy: 0, normal: 0, hard: 0 };
      durationSeconds = DIAGNOSTIC_DURATION_SECONDS;
    } else if (dto.kind === ('konkur_sim' as ExamKind)) {
      counts = { easy: 0, normal: 0, hard: 0 };
      durationSeconds = KONKUR_SIM_DURATION_SECONDS;
    } else if (dto.kind === ('final_sim' as ExamKind)) {
      counts = { easy: 0, normal: 0, hard: 0 };
      durationSeconds = FINAL_SIM_DURATION_SECONDS;
    } else {
      if (!dto.counts || !dto.durationSeconds) {
        throw new BadRequestException(
          'counts and durationSeconds are required for this exam kind',
        );
      }
      const total = dto.counts.easy + dto.counts.normal + dto.counts.hard;
      if (total === 0) {
        throw new BadRequestException('At least one question must be selected');
      }
      if (total > MAX_QUESTIONS_PER_EXAM) {
        throw new BadRequestException(
          `At most ${MAX_QUESTIONS_PER_EXAM} questions per exam`,
        );
      }
      if (enforceFreeQuizQuota) {
        // Free-plan per-quiz cap (spec 10): «هرکدام حداکثر ۱۰ سؤال». Checked
        // here — before selection and before the quota-reserving transaction —
        // so a rejected start consumes nothing. Diagnostic and the paid-only
        // sims never reach this branch.
        const maxQuestions = await this.getFreeQuizMaxQuestions();
        if (total > maxQuestions) {
          throw new BadRequestException(
            `سقف تعداد سوال آزمونک پلن رایگان حداکثر ${maxQuestions} سوال است`,
          );
        }
      }
      counts = dto.counts;
      if (dto.kind === 'speed') {
        // Server-owned fast timer (spec §5, §8): the client cannot self-pace a
        // speed quiz, so its durationSeconds is ignored in favour of a
        // per-question budget that is capped by the global maximum.
        const perQuestion = await this.getSpeedSecondsPerQuestion();
        durationSeconds = Math.min(
          total * perQuestion,
          MAX_EXAM_DURATION_SECONDS,
        );
      } else {
        durationSeconds = dto.durationSeconds;
      }
    }

    const questionIds = await this.selectQuestionIds(
      { ...dto, counts: counts, durationSeconds },
      studentId,
    );
    if (questionIds.length === 0)
      throw new BadRequestException('No questions found matching criteria');

    // Fire-and-forget AI top-up for smart_mix when selection falls short.
    // Never awaited; .catch ensures no unhandled rejection can crash the process.
    const totalRequested = counts.easy + counts.normal + counts.hard;
    if (dto.kind === 'smart_mix' && questionIds.length < totalRequested) {
      // 1. Normal top-up path (generates new AI questions if not throttled)
      void this.drafter
        ?.topUpForShortage(studentId)
        ?.catch((err: unknown) =>
          this.logger.warn(
            `[${studentId}] AI top-up failed: ${String(
              err instanceof Error ? err.message : err,
            )}`,
          ),
        );

      // 2. Persistent-shortage mutation fallback: if no published AI questions
      // exist for weak topics at all, mutate existing bank questions.
      void this.maybeMutateForPersistentShortage(studentId, dto.questionType);
    }

    try {
      return await this.db.transaction(async (tx) => {
        if (enforceFreeQuizQuota) {
          await this.reserveQuizQuota(tx, studentId, freeQuizLimit);
        }

        const templateId = await this.getOrCreateTemplateId(tx, dto);
        const [instance] = await tx
          .insert(examInstance)
          .values({
            templateId,
            questionOrder: questionIds,
            settingsSnapshot: {
              kind: dto.kind,
              questionType: dto.questionType,
              counts,
              durationSeconds,
              generatedAt: new Date().toISOString(),
            },
          })
          .returning({ id: examInstance.id });

        const [created] = await tx
          .insert(attempt)
          .values({
            studentId,
            examInstanceId: instance.id,
            status: 'in_progress',
            idempotencyKey,
          })
          .returning({ id: attempt.id, startedAt: attempt.startedAt });

        return this.toSession(
          created.id,
          questionIds,
          durationSeconds,
          created.startedAt,
        );
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

  async submitAnswer(
    attemptId: string,
    userId: string,
    questionIndex: number,
    answer: unknown,
    activeSeconds = 0,
  ): Promise<void> {
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
      .select({
        version: question.version,
        type: question.type,
        options: question.options,
      })
      .from(question)
      .where(eq(question.id, questionId))
      .limit(1);
    if (!q) throw new NotFoundException('Question not found');

    const stored = this.normalizeAnswer(q.type, q.options, answer);
    const attemptNumber =
      (await this.countPriorAttempts(studentId, questionId, attemptId)) + 1;

    // Upsert keeps the save idempotent: a retried or changed answer
    // overwrites the same row instead of creating duplicates. activeSeconds is
    // the cumulative time on the question (spec 8), so overwriting is safe.
    await this.db
      .insert(response)
      .values({
        attemptId,
        questionId,
        questionVersion: q.version,
        ...stored,
        activeSeconds,
        attemptNumber,
        answeredAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [response.attemptId, response.questionId],
        set: { ...stored, activeSeconds, answeredAt: new Date() },
      });

    const qType = q.type as QuestionType;
    if (
      qType === QuestionType.MULTIPLE_CHOICE ||
      qType === QuestionType.TRUE_FALSE
    ) {
      const [key] = await this.db
        .select({ correctOptionIndex: answerKey.correctOptionIndex })
        .from(answerKey)
        .where(
          and(
            eq(answerKey.questionId, questionId),
            eq(answerKey.questionVersion, q.version),
          ),
        )
        .limit(1);

      if (key?.correctOptionIndex != null && stored.selectedOption != null) {
        const isCorrect = key.correctOptionIndex === stored.selectedOption;
        await this.recordAnswerOutcome(
          this.db,
          studentId,
          questionId,
          isCorrect,
          new Date(),
        );
      }
    }
  }

  /**
   * Spec 8: the client keeps timing locally and periodically reports the
   * cumulative elapsed seconds, so a closed page does not lose time. Same
   * guards as submitAnswer, but only time is written: an answer already saved
   * keeps its selectedOption/textAnswer/isCorrect/attemptNumber/answeredAt.
   */
  async syncQuestionTime(
    attemptId: string,
    userId: string,
    questionIndex: number,
    activeSeconds: number,
  ): Promise<void> {
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
      .select({ version: question.version })
      .from(question)
      .where(eq(question.id, questionId))
      .limit(1);
    if (!q) throw new NotFoundException('Question not found');

    // Absolute value, not a delta (retry-safe). On conflict only the time
    // column is touched, so a periodic ping can never clear or regrade an
    // answer; a row created here is answer-less and contributes no score.
    await this.db
      .insert(response)
      .values({
        attemptId,
        questionId,
        questionVersion: q.version,
        activeSeconds,
        answeredAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [response.attemptId, response.questionId],
        set: { activeSeconds },
      });
  }

  async finishExam(
    attemptId: string,
    userId: string,
  ): Promise<{ totalScore: number; pendingDescriptive: number }> {
    const studentId = await this.requireStudentId(userId);

    const result = await this.db.transaction(async (tx) => {
      // Row lock: a double-click or retry cannot finish/grade twice.
      const ctx = await this.loadOwnedAttempt(tx, attemptId, studentId, true);
      this.assertInProgress(ctx.status);

      const rows = await tx
        .select()
        .from(response)
        .where(eq(response.attemptId, attemptId));
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

    // Referral progression (spec §11): fire-and-forget AFTER the finish
    // transaction commits — the same pattern as drafter.topUpForShortage.
    // Never awaited; .catch ensures no unhandled rejection can crash the
    // process, and the service itself logs and swallows its own errors.
    void this.referrals
      ?.onInviteeExamFinished(studentId)
      ?.catch((err: unknown) =>
        this.logger.warn(
          `[${studentId}] Referral first_exam bonus failed: ${String(
            err instanceof Error ? err.message : err,
          )}`,
        ),
      );

    return result;
  }

  async getExamAttempt(attemptId: string, userId: string) {
    const studentId = await this.requireStudentId(userId);
    const ctx = await this.loadOwnedAttempt(this.db, attemptId, studentId);
    const responses = await this.db
      .select({
        questionId: response.questionId,
        selectedOption: response.selectedOption,
        textAnswer: response.textAnswer,
        activeSeconds: response.activeSeconds,
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

  private async hasPaidPlan(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ plan: subscription.plan })
      .from(subscription)
      .innerJoin(student, eq(student.id, subscription.studentId))
      .where(
        and(
          eq(student.accountId, userId),
          inArray(subscription.plan, ['full', 'advisor']),
          or(
            isNull(subscription.expiresAt),
            sql`${subscription.expiresAt} > now()`,
          ),
        ),
      )
      .limit(1);
    return !!row;
  }

  /**
   * Effective free-plan quiz limit from the active versioned settings row
   * (spec 10.2). Never a per-request constant: falls back to the documented
   * default only when no active app_config row exists.
   */
  private async getFreeQuizLimit(): Promise<number> {
    const [row] = await this.db
      .select({ quotas: appConfig.quotas })
      .from(appConfig)
      .where(eq(appConfig.isActive, true))
      .orderBy(desc(appConfig.version))
      .limit(1);

    const quotas = row?.quotas as Record<string, unknown> | null | undefined;
    const value = quotas?.[FREE_QUIZ_WEEKLY_KEY];
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
      ? value
      : FREE_QUIZ_WEEKLY_DEFAULT;
  }

  /**
   * Free-plan per-quiz question cap (spec 10): «هرکدام حداکثر ۱۰ سؤال».
   * Read from the active settings row exactly like the weekly quota; a
   * missing or invalid (non-positive/non-integer) value falls back to the
   * documented default of 10.
   */
  private async getFreeQuizMaxQuestions(): Promise<number> {
    const [row] = await this.db
      .select({ quotas: appConfig.quotas })
      .from(appConfig)
      .where(eq(appConfig.isActive, true))
      .orderBy(desc(appConfig.version))
      .limit(1);

    const quotas = row?.quotas as Record<string, unknown> | null | undefined;
    const value = quotas?.[FREE_QUIZ_MAX_QUESTIONS_KEY];
    return typeof value === 'number' && Number.isInteger(value) && value > 0
      ? value
      : FREE_QUIZ_MAX_QUESTIONS_DEFAULT;
  }

  /**
   * Seconds above which a correct answer counts as "slow" for speed quizzes
   * (spec §5). Read from the active settings row exactly like the free quota,
   * falling back to the documented default when the key is missing or invalid.
   */
  private async getSpeedSlowThreshold(): Promise<number> {
    const [row] = await this.db
      .select({ quotas: appConfig.quotas })
      .from(appConfig)
      .where(eq(appConfig.isActive, true))
      .orderBy(desc(appConfig.version))
      .limit(1);

    const quotas = row?.quotas as Record<string, unknown> | null | undefined;
    const value = quotas?.[SPEED_SLOW_THRESHOLD_KEY];
    return typeof value === 'number' && Number.isInteger(value) && value > 0
      ? value
      : SPEED_SLOW_THRESHOLD_DEFAULT;
  }

  /**
   * Seconds granted per question by the server-owned speed timer (spec §5, §8).
   * Same versioned-settings pattern as the other limits; default 60s.
   */
  private async getSpeedSecondsPerQuestion(): Promise<number> {
    const [row] = await this.db
      .select({ quotas: appConfig.quotas })
      .from(appConfig)
      .where(eq(appConfig.isActive, true))
      .orderBy(desc(appConfig.version))
      .limit(1);

    const quotas = row?.quotas as Record<string, unknown> | null | undefined;
    const value = quotas?.[SPEED_SECONDS_PER_QUESTION_KEY];
    return typeof value === 'number' && Number.isInteger(value) && value > 0
      ? value
      : SPEED_SECONDS_PER_QUESTION_DEFAULT;
  }

  /** Quiz starts inside the rolling 7-day window (spec 10). */
  private async countQuizUsage(
    studentId: string,
    executor: DbOrTx = this.db,
  ): Promise<number> {
    const [row] = await executor
      .select({ count: sql<number>`count(*)::int` })
      .from(quotaUsage)
      .where(
        and(
          eq(quotaUsage.studentId, studentId),
          eq(quotaUsage.operation, QUIZ_QUOTA_OPERATION),
          sql`${quotaUsage.windowStart} >= now() - interval '7 days'`,
        ),
      );
    return row?.count ?? 0;
  }

  /**
   * Reserve one quiz slot in the same transaction as the attempt (spec 3.4,
   * 13.4): a retry that loses the idempotency unique constraint rolls the
   * reservation back, and the row lock on the student serialises concurrent
   * starts so two parallel requests cannot both consume the last slot.
   */
  private async reserveQuizQuota(
    tx: Tx,
    studentId: string,
    limit: number,
  ): Promise<void> {
    await tx.execute(
      sql`SELECT id FROM student WHERE id = ${studentId} FOR UPDATE`,
    );

    const used = await this.countQuizUsage(studentId, tx);
    if (used >= limit) {
      throw new ForbiddenException(FREE_QUIZ_QUOTA_EXHAUSTED);
    }

    await tx.insert(quotaUsage).values({
      studentId,
      operation: QUIZ_QUOTA_OPERATION,
      amount: 1,
      windowStart: new Date(),
    });
  }

  private async loadOwnedAttempt(
    executor: DbOrTx,
    attemptId: string,
    studentId: string,
    lock = false,
  ) {
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

  private async findSessionByKey(
    idempotencyKey: string,
  ): Promise<ExamSession | null> {
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
    return this.toSession(
      row.id,
      row.questionOrder as string[],
      this.durationOf(row.settings),
      row.startedAt,
    );
  }

  private async selectQuestionIds(
    dto: SelectDto,
    studentId: string,
  ): Promise<string[]> {
    switch (dto.kind) {
      case 'diagnostic':
        return this.selectDiagnostic(studentId);
      case 'konkur_sim':
        // Real-exam simulation (spec 3.5): unseen past-exam questions,
        // spread across topics and weighted towards weak ones.
        return this.selectComprehensive(studentId, 'konkur');
      case 'final_sim':
        return this.selectComprehensive(studentId, 'final');
      case 'trap_finder':
        return this.selectTrapFinder(dto, studentId);
      case 'debug_errors':
        return this.selectDebugErrors(dto, studentId);
      case 'due_review':
        return this.selectDueReview(dto, studentId);
      case 'speed':
        return this.selectSpeed(dto, studentId);
      case 'quiz_after_study':
        return this.selectAfterStudy(dto, studentId);
      case 'smart_mix':
        return this.selectSmartMix(dto, studentId);
      case 'general_prep':
      default:
        return this.selectGeneralPrep(dto, studentId);
    }
  }

  /**
   * ترکیبی هوشمند — spec §5: a mix of the other quiz kinds proportional to the
   * student's history. For a newcomer (no mastery rows and no answers yet) the
   * smart mix IS the diagnostic, so `dto.counts` is ignored on that path.
   * Pool 0 (aigen): published AI questions from the student's weak topics,
   * up to AI_MAX_SHARE of the total quota.
   */
  private async selectSmartMix(
    dto: SelectDto,
    studentId: string,
  ): Promise<string[]> {
    const total = dto.counts.easy + dto.counts.normal + dto.counts.hard;

    // Two cheap existence probes — zero rows in both means "newcomer".
    const [mastery] = await this.db
      .select({ id: questionMastery.id })
      .from(questionMastery)
      .where(eq(questionMastery.studentId, studentId))
      .limit(1);
    if (!mastery) {
      const [answer] = await this.db
        .select({ id: response.id })
        .from(response)
        .innerJoin(attempt, eq(attempt.id, response.attemptId))
        .where(eq(attempt.studentId, studentId))
        .limit(1);
      if (!answer) return this.selectDiagnostic(studentId);
    }

    // Build weak topic IDs using the same evidence the history builder uses:
    // recent wrong answers (mastery + response probes already ran above).
    // We reuse the history context's weak topics for the AI pool targeting.
    const weakTopicIds = await this.getWeakTopicIds(studentId);

    // One ordered list keeps the pool priorities in a single place.
    // Pool 0 (aigen): published AI questions from weak topics, up to AI_MAX_SHARE.
    const poolSteps: {
      ratio: number;
      select: (poolDto: SelectDto) => Promise<string[]>;
    }[] = [];

    // Pool 0: AI-generated questions from weak topics (highest priority)
    if (weakTopicIds.length > 0) {
      const aiQuota = Math.floor(AI_MAX_SHARE * total);
      if (aiQuota > 0) {
        poolSteps.push({
          ratio: 1, // handled specially with aiQuota
          select: async (poolDto) =>
            this.selectAIGenPool(poolDto, studentId, weakTopicIds, aiQuota),
        });
      }
    }

    // Existing pools: due review, debug errors, trap finder
    poolSteps.push(
      {
        ratio: SMART_MIX_DUE_RATIO,
        select: (poolDto) => this.selectDueReview(poolDto, studentId),
      },
      {
        ratio: SMART_MIX_ERROR_RATIO,
        select: (poolDto) => this.selectDebugErrors(poolDto, studentId),
      },
      {
        ratio: SMART_MIX_TRAP_RATIO,
        select: (poolDto) => this.selectTrapFinder(poolDto, studentId),
      },
    );

    const chosen = new Set<string>();
    const ids: string[] = [];

    for (const step of poolSteps) {
      if (ids.length >= total) break;
      // For pool 0 (aigen), use the pre-calculated aiQuota; for others use ratio * total
      const quota =
        step.ratio === 1 && weakTopicIds.length > 0
          ? Math.floor(AI_MAX_SHARE * total)
          : Math.floor(step.ratio * total);
      if (quota <= 0) continue;
      const poolIds = await step.select({
        ...dto,
        counts: { easy: quota, normal: 0, hard: 0 },
      });
      for (const id of poolIds) {
        if (chosen.has(id)) continue;
        chosen.add(id);
        ids.push(id);
        if (ids.length >= total) break;
      }
    }

    if (ids.length < total) {
      const fill = await this.selectGeneralPrep(
        {
          ...dto,
          counts: { easy: total - ids.length, normal: 0, hard: 0 },
        },
        studentId,
      );
      for (const id of fill) {
        if (chosen.has(id)) continue;
        chosen.add(id);
        ids.push(id);
        if (ids.length >= total) break;
      }
    }

    return this.shuffle(ids.slice(0, total));
  }

  /**
   * Get weak topic IDs for a student using the same evidence as the history builder.
   * Returns topic IDs from recent wrong answers (mastery + response data).
   * Avoids GROUP BY/DISTINCT for test mock compatibility — dedupes in JS.
   */
  private async getWeakTopicIds(studentId: string): Promise<string[]> {
    // Get topic IDs from non-mastered questions the student has attempted
    // We select all matching rows and deduplicate topicIds in JS.
    const rows = await this.db
      .select({ topicId: question.topicId })
      .from(questionMastery)
      .innerJoin(question, eq(question.id, questionMastery.questionId))
      .where(
        and(
          eq(questionMastery.studentId, studentId),
          isNull(questionMastery.masteredAt),
          isNotNull(question.topicId),
        ),
      )
      .limit(50); // Fetch more than needed, we'll dedupe and limit to 5

    const seen = new Set<string>();
    const topicIds: string[] = [];
    for (const r of rows) {
      if (r.topicId && !seen.has(r.topicId)) {
        seen.add(r.topicId);
        topicIds.push(r.topicId);
        if (topicIds.length >= 5) break; // Same as MAX_WEAK_TOPICS
      }
    }
    return topicIds;
  }

  /**
   * Pool 0 (aigen): Select published AI-generated questions from weak topics.
   * Excludes already mastered questions and deduplicates against already chosen IDs.
   */
  private async selectAIGenPool(
    dto: SelectDto,
    studentId: string,
    weakTopicIds: string[],
    quota: number,
  ): Promise<string[]> {
    const rows = await this.db
      .select({ id: question.id })
      .from(question)
      .where(
        and(
          eq(question.status, 'published'),
          eq(question.origin, 'ai'),
          eq(question.type, dto.questionType),
          inArray(question.topicId, weakTopicIds),
          sql`NOT EXISTS (
            SELECT 1 FROM question_mastery qm
            WHERE qm.student_id = ${studentId}
              AND qm.question_id = ${question.id}
              AND qm.mastered_at IS NOT NULL
          )`,
        ),
      )
      .orderBy(sql`random()`)
      .limit(quota);

    return rows.map((r) => r.id);
  }

  /**
   * Persistent-shortage mutation fallback (async, fire-and-forget).
   * Triggered when smart_mix selection falls short AND no published AI questions
   * exist for any weak topic (heuristic: throttle query returns empty for all time).
   * Fires mutateQuestion on up to 3 existing bank questions from weak topics.
   * Never blocks startExam; all errors caught and logged.
   */
  private maybeMutateForPersistentShortage(
    studentId: string,
    questionType: QuestionType,
  ): void {
    void (async () => {
      try {
        // Get weak topic IDs
        const weakTopicIds = await this.getWeakTopicIds(studentId);
        if (weakTopicIds.length === 0) return;

        // Heuristic: check if ANY published origin='ai' questions exist for these weak topics.
        // If yes, the throttle in topUpForShortage would have fired (or will fire), so skip mutation.
        const anyPublishedAI = await this.db
          .select({ id: question.id })
          .from(question)
          .where(
            and(
              eq(question.status, 'published'),
              eq(question.origin, 'ai'),
              inArray(question.topicId, weakTopicIds),
            ),
          )
          .limit(1);

        if (anyPublishedAI.length > 0) {
          // Published AI questions exist — normal top-up path will handle it (or already did).
          return;
        }

        // No published AI questions for weak topics: persistent shortage.
        // Find up to 3 bank questions from weak topics to mutate.
        const bankQuestions = await this.db
          .select({ id: question.id })
          .from(question)
          .where(
            and(
              eq(question.status, 'published'),
              eq(question.origin, 'bank'),
              eq(question.type, questionType),
              inArray(question.topicId, weakTopicIds),
              sql`NOT EXISTS (
                SELECT 1 FROM question_mastery qm
                WHERE qm.student_id = ${studentId}
                  AND qm.question_id = ${question.id}
                  AND qm.mastered_at IS NOT NULL
              )`,
            ),
          )
          .orderBy(sql`random()`)
          .limit(3);

        if (bankQuestions.length === 0) return;

        // Fire mutations in parallel (fire-and-forget)
        // Wrap each in Promise.resolve to handle optional drafter and ensure we always pass Promises
        await Promise.allSettled(
          bankQuestions.map((q) =>
            Promise.resolve(
              this.drafter
                ?.mutateQuestion(q.id)
                .catch((err: unknown) =>
                  this.logger.warn(
                    `[${studentId}] Mutation failed for ${q.id}: ${String(
                      err instanceof Error ? err.message : err,
                    )}`,
                  ),
                ),
            ),
          ),
        );
      } catch (err: unknown) {
        this.logger.warn(
          `[${studentId}] Persistent-shortage mutation check failed: ${String(
            err instanceof Error ? err.message : err,
          )}`,
        );
      }
    })();
  }

  private async selectGeneralPrep(
    dto: SelectDto,
    studentId: string,
  ): Promise<string[]> {
    const ids: string[] = [];
    const counts = dto.counts;

    // spec §5: general prep must cover the chosen topics evenly. Only that kind
    // balances topics; other kinds use this selector as a fallback and ignore
    // topicIds, exactly as they ignore topicId.
    const topicIds =
      dto.kind === 'general_prep' && dto.topicIds
        ? [...new Set(dto.topicIds)]
        : [];

    for (const { level, key } of DIFFICULTY_BUCKETS) {
      const count = counts[key];
      if (count === 0) continue;

      const targets: { topicId: string | undefined; limit: number }[] = [];
      if (topicIds.length === 0) {
        targets.push({ topicId: undefined, limit: count });
      } else {
        const base = Math.floor(count / topicIds.length);
        const extra = count % topicIds.length;
        topicIds.forEach((topicId, index) => {
          targets.push({
            topicId,
            limit: base + (index < extra ? 1 : 0),
          });
        });
      }

      for (const target of targets) {
        if (target.limit === 0) continue;
        const rows = await this.db
          .select({ id: question.id })
          .from(question)
          .where(
            and(
              eq(question.status, 'published'),
              eq(question.type, dto.questionType),
              eq(question.difficultyAi, level),
              target.topicId ? eq(question.topicId, target.topicId) : undefined,
              sql`NOT EXISTS (
                SELECT 1 FROM question_mastery qm
                WHERE qm.student_id = ${studentId}
                  AND qm.question_id = ${question.id}
                  AND qm.mastered_at IS NOT NULL
              )`,
            ),
          )
          .orderBy(sql`random()`)
          .limit(target.limit);
        ids.push(...rows.map((r) => r.id));
      }
    }
    return this.shuffle(ids);
  }

  /**
   * سنجش بعد از مطالعه — spec §5: the quiz must cover the main concepts of the
   * topic the student studied, so this mirrors `selectGeneralPrep` and adds a
   * topic filter. Partial results are acceptable when the topic is small; the
   * caller rejects an entirely empty selection.
   */
  private async selectAfterStudy(
    dto: SelectDto,
    studentId: string,
  ): Promise<string[]> {
    if (!dto.topicId) {
      throw new BadRequestException(
        'topicId is required for quiz_after_study (select the studied topic)',
      );
    }

    const ids: string[] = [];
    const counts = dto.counts;
    for (const { level, key } of DIFFICULTY_BUCKETS) {
      const count = counts[key];
      if (count === 0) continue;
      const rows = await this.db
        .select({ id: question.id })
        .from(question)
        .where(
          and(
            eq(question.status, 'published'),
            eq(question.type, dto.questionType),
            eq(question.difficultyAi, level),
            eq(question.topicId, dto.topicId),
            sql`NOT EXISTS (
              SELECT 1 FROM question_mastery qm
              WHERE qm.student_id = ${studentId}
                AND qm.question_id = ${question.id}
                AND qm.mastered_at IS NOT NULL
            )`,
          ),
        )
        .orderBy(sql`random()`)
        .limit(count);
      ids.push(...rows.map((r) => r.id));
    }
    return this.shuffle(ids);
  }

  /**
   * تله‌یاب — spec §5: only trap questions, prioritising the traps this student
   * actually fell for: wrong traps first, then traps never seen, then traps last
   * answered correctly. Random inside each pool, no duplicates, and partial
   * when the bank is short — non-trap questions are never used as filler.
   */
  private async selectTrapFinder(
    dto: SelectDto,
    studentId: string,
  ): Promise<string[]> {
    const counts = dto.counts;
    const total = counts.easy + counts.normal + counts.hard;
    if (total <= 0) return [];

    const pools = [
      // 1) wrong-trap: last answer on this question was incorrect
      sql`EXISTS (
        SELECT 1 FROM question_mastery qm
        WHERE qm.student_id = ${studentId}
          AND qm.question_id = ${question.id}
          AND qm.last_is_correct = false
      )`,
      // 2) unseen-trap: no answer recorded yet
      sql`NOT EXISTS (
        SELECT 1 FROM question_mastery qm
        WHERE qm.student_id = ${studentId}
          AND qm.question_id = ${question.id}
      )`,
      // 3) seen-correct-trap: last answer was correct
      sql`EXISTS (
        SELECT 1 FROM question_mastery qm
        WHERE qm.student_id = ${studentId}
          AND qm.question_id = ${question.id}
          AND qm.last_is_correct = true
      )`,
    ];

    const ids: string[] = [];
    const seen = new Set<string>();
    for (const pool of pools) {
      const need = total - ids.length;
      if (need <= 0) break;
      const rows = await this.db
        .select({ id: question.id })
        .from(question)
        .where(
          and(
            eq(question.status, 'published'),
            eq(question.type, dto.questionType),
            eq(question.hasTrap, true),
            pool,
          ),
        )
        .orderBy(sql`random()`)
        .limit(need);
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        ids.push(row.id);
      }
    }
    return this.shuffle(ids);
  }

  private async selectDebugErrors(
    dto: SelectDto,
    studentId: string,
  ): Promise<string[]> {
    const total = dto.counts.easy + dto.counts.normal + dto.counts.hard;

    const wrongRows = await this.db
      .selectDistinct({ id: question.id, topicId: question.topicId })
      .from(question)
      .innerJoin(response, eq(response.questionId, question.id))
      .innerJoin(attempt, eq(attempt.id, response.attemptId))
      .where(
        and(
          eq(attempt.studentId, studentId),
          eq(response.isCorrect, false),
          eq(question.status, 'published'),
          eq(question.type, dto.questionType),
          sql`NOT EXISTS (
            SELECT 1 FROM question_mastery qm
            WHERE qm.student_id = ${studentId}
              AND qm.question_id = ${question.id}
              AND qm.mastered_at IS NOT NULL
          )`,
        ),
      )
      .limit(total);

    const ids = wrongRows.map((r) => r.id);
    const topicsWithErrors = [
      ...new Set(
        wrongRows
          .map((r) => r.topicId)
          .filter((id): id is string => id != null),
      ),
    ];

    if (ids.length >= total) return this.shuffle(ids);

    const need = total - ids.length;
    if (topicsWithErrors.length > 0) {
      const freshRows = await this.db
        .select({ id: question.id })
        .from(question)
        .where(
          and(
            eq(question.status, 'published'),
            eq(question.type, dto.questionType),
            inArray(question.topicId, topicsWithErrors),
            sql`NOT EXISTS (
              SELECT 1
              FROM response r
              JOIN attempt a ON a.id = r.attempt_id
              WHERE a.student_id = ${studentId}
                AND r.question_id = ${question.id}
            )`,
          ),
        )
        .orderBy(sql`random()`)
        .limit(need);
      ids.push(...freshRows.map((r) => r.id));
    }

    if (ids.length < total) {
      const still = total - ids.length;
      const fill = await this.selectGeneralPrep(
        {
          ...dto,
          counts: { easy: still, normal: 0, hard: 0 },
        },
        studentId,
      );
      // The fill excludes only mastered questions, so it can re-offer ids from
      // the wrong/fresh pools — never serve the same question twice (spec §5).
      const chosen = new Set(ids);
      ids.push(...fill.filter((id) => !chosen.has(id)));
    }

    return this.shuffle(ids);
  }

  /**
   * سرعتی — spec §5: questions from topics the student knows, with a fast timer.
   * Priority: (1) questions already answered correctly but slowly, (2) questions
   * from topics with mastery/streak evidence, (3) general prep when the student
   * has no known topics yet. Partial results are allowed; pool 1 ids are never
   * re-added by a later pool.
   */
  private async selectSpeed(
    dto: SelectDto,
    studentId: string,
  ): Promise<string[]> {
    const total = dto.counts.easy + dto.counts.normal + dto.counts.hard;
    if (total <= 0) return [];

    const slowThreshold = await this.getSpeedSlowThreshold();

    // 1) correct-but-slow: answered correctly in a previous attempt, slowly.
    const slowRows = await this.db
      .select({ id: question.id })
      .from(question)
      .where(
        and(
          eq(question.status, 'published'),
          eq(question.type, dto.questionType),
          sql`EXISTS (
            SELECT 1
            FROM response r
            JOIN attempt a ON a.id = r.attempt_id
            WHERE a.student_id = ${studentId}
              AND r.question_id = ${question.id}
              AND r.is_correct = true
              AND r.active_seconds > ${slowThreshold}
          )`,
        ),
      )
      .orderBy(sql`random()`)
      .limit(total);

    const ids = slowRows.map((r) => r.id);
    if (ids.length >= total) return this.shuffle(ids);

    // 2) known-topic fallback: same evidence rule as before, minus pool 1.
    const evidenceTopics = await this.db
      .selectDistinct({ topicId: question.topicId })
      .from(question)
      .innerJoin(questionMastery, eq(questionMastery.questionId, question.id))
      .where(
        and(
          eq(questionMastery.studentId, studentId),
          sql`${questionMastery.masteredAt} IS NOT NULL OR ${questionMastery.currentStreak} >= 2`,
          sql`${question.topicId} IS NOT NULL`,
        ),
      );

    const topicIds = evidenceTopics
      .map((r) => r.topicId)
      .filter((id): id is string => id != null);

    const stillNeeded = total - ids.length;

    // 3) no known topics yet: general prep fills the remaining capacity.
    if (topicIds.length === 0) {
      const fill = await this.selectGeneralPrep(
        {
          ...dto,
          counts: { easy: stillNeeded, normal: 0, hard: 0 },
        },
        studentId,
      );
      const chosen = new Set(ids);
      return this.shuffle([...ids, ...fill.filter((id) => !chosen.has(id))]);
    }

    const knownRows = await this.db
      .select({ id: question.id })
      .from(question)
      .where(
        and(
          eq(question.status, 'published'),
          eq(question.type, dto.questionType),
          inArray(question.topicId, topicIds),
          ids.length > 0 ? notInArray(question.id, ids) : undefined,
          sql`NOT EXISTS (
            SELECT 1 FROM question_mastery qm
            WHERE qm.student_id = ${studentId}
              AND qm.question_id = ${question.id}
              AND qm.mastered_at IS NOT NULL
          )`,
        ),
      )
      .orderBy(sql`random()`)
      .limit(stillNeeded);

    return this.shuffle([...ids, ...knownRows.map((r) => r.id)]);
  }

  private async selectDueReview(
    dto: SelectDto,
    studentId: string,
  ): Promise<string[]> {
    const total = dto.counts.easy + dto.counts.normal + dto.counts.hard;

    const rows = await this.db
      .select({ id: question.id })
      .from(question)
      .innerJoin(questionMastery, eq(questionMastery.questionId, question.id))
      .where(
        and(
          eq(questionMastery.studentId, studentId),
          eq(question.status, 'published'),
          eq(question.type, dto.questionType),
          sql`${questionMastery.masteredAt} IS NULL`,
          sql`${questionMastery.nextDueAt} IS NOT NULL`,
          sql`${questionMastery.nextDueAt} <= now()`,
        ),
      )
      .orderBy(sql`${questionMastery.nextDueAt} ASC`)
      .limit(total);

    const ids = rows.map((r) => r.id);
    if (ids.length < total) {
      const fill = await this.selectGeneralPrep(
        {
          ...dto,
          counts: { easy: total - ids.length, normal: 0, hard: 0 },
        },
        studentId,
      );
      // The fill excludes only mastered questions, so it can re-offer due ids
      // — never serve the same question twice (spec §5).
      const chosen = new Set(ids);
      ids.push(...fill.filter((id) => !chosen.has(id)));
    }

    return this.shuffle(ids);
  }

  /**
   * Initial diagnostic (spec §3.3): ten basic questions drawn from the topics
   * the student reported studying in onboarding (§3.2), split evenly between
   * multiple choice and short written answers (descriptive) so both recall
   * modes are measured. Each half stays partial when its pool is short: a thin
   * topic must not block the start, and the caller only rejects a fully empty
   * selection. A newcomer with no studied topics keeps the old global random
   * pool (no type split, no topic filter).
   */
  private async selectDiagnostic(studentId: string): Promise<string[]> {
    const [row] = await this.db
      .select({ studiedTopicIds: student.studiedTopicIds })
      .from(student)
      .where(eq(student.id, studentId))
      .limit(1);
    const studiedTopicIds = row?.studiedTopicIds ?? [];

    if (studiedTopicIds.length === 0) {
      const rows = await this.db
        .select({ id: question.id })
        .from(question)
        .where(eq(question.status, 'published'))
        .orderBy(sql`random()`)
        .limit(DIAGNOSTIC_QUESTION_COUNT);
      return rows.map((r) => r.id);
    }

    const choiceCount = Math.ceil(DIAGNOSTIC_QUESTION_COUNT / 2);
    const choice = await this.selectDiagnosticPool(
      studiedTopicIds,
      QuestionType.MULTIPLE_CHOICE,
      choiceCount,
    );
    const descriptive = await this.selectDiagnosticPool(
      studiedTopicIds,
      QuestionType.DESCRIPTIVE,
      DIAGNOSTIC_QUESTION_COUNT - choiceCount,
    );

    // Interleave the halves: never five choices followed by five short ones.
    return this.shuffle([...choice, ...descriptive]);
  }

  /**
   * One half of the diagnostic: published basic (level 1) questions of a
   * single type from the studied topics, random order, partial when short.
   */
  private async selectDiagnosticPool(
    topicIds: string[],
    type: QuestionType,
    limit: number,
  ): Promise<string[]> {
    if (limit <= 0) return [];
    const rows = await this.db
      .select({ id: question.id })
      .from(question)
      .where(
        and(
          eq(question.status, 'published'),
          eq(question.type, type),
          eq(question.difficultyAi, DIAGNOSTIC_DIFFICULTY_LEVEL),
          inArray(question.topicId, topicIds),
        ),
      )
      .orderBy(sql`random()`)
      .limit(limit);
    return rows.map((r) => r.id);
  }

  /**
   * Real-exam simulation (spec 3.5). The pool is the past-exam bank only:
   * published, origin bank, a source year inside the kind window plus a
   * session (konkur) or lesson (final) label. Nothing the student has already
   * answered or opened is ever served again, and no AI-generated question can
   * appear. The available pool is split evenly across topics, boosted by one
   * for weak topics and capped per topic, so a shallow pool yields a shorter
   * exam instead of an over-request.
   */
  private async selectComprehensive(
    studentId: string,
    mode: 'konkur' | 'final',
  ): Promise<string[]> {
    const total = await this.getSimQuestionCount(mode);
    if (total <= 0) return [];

    const seenIds = await this.collectSeenQuestionIds(studentId);
    const pool = await this.countComprehensivePool(mode, seenIds);
    if (pool.length === 0) return [];

    const weakTopicIds = new Set(await this.getWeakTopicIds(studentId));
    const allocations = this.allocateComprehensiveTopics(
      pool,
      total,
      weakTopicIds,
    );

    const selected: string[] = [];
    for (const allocation of allocations) {
      const rows = await this.db
        .select({ id: question.id })
        .from(question)
        .where(
          and(
            ...this.comprehensiveConditions(mode, seenIds),
            eq(question.topicId, allocation.topicId),
          ),
        )
        .orderBy(sql`random()`)
        .limit(allocation.count);
      for (const row of rows) selected.push(row.id);
    }

    return this.shuffle(selected);
  }

  /**
   * Questions the student has already met: answered rows (a time-sync row
   * counts too, so a question that was only opened is not re-served) and
   * mastery rows. Deduplicated in JS like the other history queries.
   */
  private async collectSeenQuestionIds(studentId: string): Promise<string[]> {
    const answered = await this.db
      .select({ questionId: response.questionId })
      .from(response)
      .innerJoin(attempt, eq(attempt.id, response.attemptId))
      .where(eq(attempt.studentId, studentId));

    const tracked = await this.db
      .select({ questionId: questionMastery.questionId })
      .from(questionMastery)
      .where(eq(questionMastery.studentId, studentId));

    const seen = new Set<string>();
    for (const row of [...answered, ...tracked]) seen.add(row.questionId);
    return [...seen];
  }

  /**
   * Filters shared by the availability count and the per-topic pick, so the
   * allocation can never promise a question the pick query would not return.
   */
  private comprehensiveConditions(
    mode: 'konkur' | 'final',
    seenIds: string[],
  ): SQL[] {
    const conditions: SQL[] = [
      eq(question.status, 'published'),
      eq(question.origin, 'bank'),
      isNotNull(question.sourceYear),
      sql`${question.sourceYear} >= ${SIM_SOURCE_MIN_YEAR[mode]}`,
    ];
    conditions.push(
      mode === 'konkur'
        ? isNotNull(question.sourceSession)
        : isNotNull(question.sourceLesson),
    );
    if (seenIds.length > 0) {
      conditions.push(notInArray(question.id, seenIds));
    }
    return conditions;
  }

  /** Unseen availability per topic; topics with no eligible row are absent. */
  private async countComprehensivePool(
    mode: 'konkur' | 'final',
    seenIds: string[],
  ): Promise<{ topicId: string; available: number }[]> {
    const rows = await this.db
      .select({
        topicId: question.topicId,
        available: sql<number>`count(*)::int`,
      })
      .from(question)
      .where(
        and(
          ...this.comprehensiveConditions(mode, seenIds),
          isNotNull(question.topicId),
        ),
      )
      .groupBy(question.topicId)
      .orderBy(question.topicId);

    const pool: { topicId: string; available: number }[] = [];
    for (const row of rows) {
      if (row.topicId && row.available > 0) {
        pool.push({ topicId: row.topicId, available: row.available });
      }
    }
    return pool;
  }

  /**
   * Rules 1-3 of the comprehensive spread:
   * 1. an even baseline over every pool topic (the first `total % n` topics
   *    take the remainder), so a topic with unseen questions is never skipped;
   * 2. weak topics get one extra question;
   * 3. no topic exceeds min(baseline + 1, SIM_TOPIC_CAP) or its own unseen
   *    availability. Boosts are funded by taking one question back from
   *    non-weak topics first, so the total never grows past the target.
   */
  private allocateComprehensiveTopics(
    pool: { topicId: string; available: number }[],
    total: number,
    weakTopicIds: ReadonlySet<string>,
  ): { topicId: string; count: number }[] {
    const topics = pool.length;
    if (topics === 0 || total <= 0) return [];

    const baseline = Math.floor(total / topics);
    const remainder = total % topics;
    const cap = Math.min(baseline + 1, SIM_TOPIC_CAP);

    const allocations = pool.map((entry, index) => ({
      topicId: entry.topicId,
      available: entry.available,
      weak: weakTopicIds.has(entry.topicId),
      count: Math.min(
        baseline + (index < remainder ? 1 : 0),
        cap,
        entry.available,
      ),
    }));

    let excess = 0;
    for (const allocation of allocations) {
      if (!allocation.weak) continue;
      const ceiling = Math.min(cap, allocation.available);
      if (allocation.count >= ceiling) continue;
      allocation.count += 1;
      excess += 1;
    }

    // Pay for the boosts from non-weak topics first; only when none of them
    // has anything left to give does a weak topic give its boost back.
    for (const weakPass of [false, true]) {
      while (excess > 0) {
        let trimmed = 0;
        for (const allocation of allocations) {
          if (excess === 0) break;
          if (allocation.weak !== weakPass || allocation.count === 0) {
            continue;
          }
          allocation.count -= 1;
          excess -= 1;
          trimmed += 1;
        }
        if (trimmed === 0) break;
      }
    }

    return allocations
      .filter((allocation) => allocation.count > 0)
      .map((allocation) => ({
        topicId: allocation.topicId,
        count: allocation.count,
      }));
  }

  /**
   * Simulation length (spec 3.5) from the active app_config row: a number for
   * both kinds, or { konkur, final } per kind, clamped to the per-exam maximum.
   */
  private async getSimQuestionCount(mode: 'konkur' | 'final'): Promise<number> {
    const [row] = await this.db
      .select({ quotas: appConfig.quotas })
      .from(appConfig)
      .where(eq(appConfig.isActive, true))
      .orderBy(desc(appConfig.version))
      .limit(1);

    const quotas = row?.quotas as Record<string, unknown> | null | undefined;
    const configured = quotas?.[SIM_QUESTION_COUNT_KEY];
    const perKind =
      configured && typeof configured === 'object'
        ? (configured as Record<string, unknown>)[mode]
        : configured;
    const value =
      typeof perKind === 'number' && Number.isInteger(perKind) && perKind > 0
        ? perKind
        : SIM_QUESTION_COUNT_DEFAULT[mode];
    return Math.min(value, MAX_QUESTIONS_PER_EXAM);
  }

  private async getOrCreateTemplateId(
    tx: Tx,
    dto: StartExamDto,
  ): Promise<string> {
    const [existing] = await tx
      .select({ id: examTemplate.id })
      .from(examTemplate)
      .where(eq(examTemplate.kind, dto.kind))
      .limit(1);
    if (existing) return existing.id;

    const [created] = await tx
      .insert(examTemplate)
      .values({
        kind: dto.kind,
        title: KIND_TITLES[dto.kind],
        config: {
          questionType: dto.questionType,
          counts: dto.counts,
        },
        settingsVersion: 1,
      })
      .returning({ id: examTemplate.id });
    return created.id;
  }

  private async recordAnswerOutcome(
    executor: DbOrTx,
    studentId: string,
    questionId: string,
    isCorrect: boolean,
    answeredAt: Date,
  ): Promise<void> {
    const answeredAtIso = answeredAt.toISOString();

    await executor
      .insert(questionMastery)
      .values({
        studentId,
        questionId,
        currentStreak: isCorrect ? 1 : 0,
        totalAttempts: 1,
        totalCorrect: isCorrect ? 1 : 0,
        lastIsCorrect: isCorrect,
        lastAnsweredAt: answeredAt,
        masteredAt: null,
        nextDueAt: sql`
          ${answeredAtIso}::timestamptz + interval '1 day'
        `,
      })
      .onConflictDoUpdate({
        target: [questionMastery.studentId, questionMastery.questionId],
        set: {
          currentStreak: sql`
            CASE
              WHEN ${isCorrect}
                THEN ${questionMastery.currentStreak} + 1
              ELSE 0
            END
          `,
          totalAttempts: sql`
            ${questionMastery.totalAttempts} + 1
          `,
          totalCorrect: sql`
            ${questionMastery.totalCorrect} + ${isCorrect ? 1 : 0}
          `,
          lastIsCorrect: isCorrect,
          lastAnsweredAt: answeredAt,
          masteredAt: sql`
            CASE
              WHEN NOT ${isCorrect}
                THEN NULL
              WHEN ${questionMastery.currentStreak} + 1 >= 2
                THEN COALESCE(
                  ${questionMastery.masteredAt},
                  ${answeredAtIso}::timestamptz
                )
              ELSE ${questionMastery.masteredAt}
            END
          `,
          nextDueAt: sql`
            CASE
              WHEN NOT ${isCorrect}
                THEN ${answeredAtIso}::timestamptz + interval '1 day'
              WHEN ${questionMastery.currentStreak} + 1 >= 2
                THEN LEAST(
                  ${answeredAtIso}::timestamptz
                    + (
                      LEAST(
                        ${questionMastery.currentStreak} + 2,
                        30
                      ) * interval '1 day'
                    ),
                  ${answeredAtIso}::timestamptz
                    + interval '30 days'
                )
              ELSE ${answeredAtIso}::timestamptz + interval '1 day'
            END
          `,
          updatedAt: new Date(),
        },
      });
  }

  private normalizeAnswer(
    type: string,
    options: unknown,
    answer: unknown,
  ): StoredAnswer {
    if (type === String(QuestionType.MULTIPLE_CHOICE)) {
      const optionCount = Array.isArray(options) ? options.length : 0;
      if (
        typeof answer !== 'number' ||
        !Number.isInteger(answer) ||
        answer < 0 ||
        answer >= optionCount
      ) {
        throw new BadRequestException(
          'Answer must be a valid option index for this question',
        );
      }
      return { selectedOption: answer, textAnswer: null };
    }

    if (type === String(QuestionType.DESCRIPTIVE)) {
      if (typeof answer !== 'string')
        throw new BadRequestException('Answer must be text for this question');
      const text = answer.trim();
      if (text.length === 0 || text.length > MAX_TEXT_ANSWER_LENGTH) {
        throw new BadRequestException(
          `Text answer must be 1-${MAX_TEXT_ANSWER_LENGTH} characters`,
        );
      }
      return { selectedOption: null, textAnswer: text };
    }

    throw new BadRequestException(
      `Answering "${type}" questions is not supported yet`,
    );
  }

  private async countPriorAttempts(
    studentId: string,
    questionId: string,
    currentAttemptId: string,
  ): Promise<number> {
    const [row] = await this.db
      .select({
        count: sql<number>`count(distinct ${response.attemptId})::int`,
      })
      .from(response)
      .innerJoin(attempt, eq(attempt.id, response.attemptId))
      .where(
        and(
          eq(attempt.studentId, studentId),
          eq(response.questionId, questionId),
          ne(response.attemptId, currentAttemptId),
          // Spec 8 time-sync rows are not answers, so they must not inflate
          // the spec 7 first-try attemptNumber of a later exam.
          or(
            isNotNull(response.selectedOption),
            isNotNull(response.textAnswer),
          ),
        ),
      );
    return row?.count ?? 0;
  }

  private async gradeChoiceResponses(
    tx: Tx,
    rows: ResponseRow[],
  ): Promise<number> {
    if (rows.length === 0) return 0;

    const keys = await tx
      .select({
        questionId: answerKey.questionId,
        questionVersion: answerKey.questionVersion,
        correctOptionIndex: answerKey.correctOptionIndex,
      })
      .from(answerKey)
      .where(
        inArray(answerKey.questionId, [
          ...new Set(rows.map((r) => r.questionId)),
        ]),
      );

    const correctByVersion = new Map(
      keys.map((k) => [
        `${k.questionId}:${k.questionVersion}`,
        k.correctOptionIndex,
      ]),
    );

    let score = 0;
    for (const r of rows) {
      const correct = correctByVersion.get(
        `${r.questionId}:${r.questionVersion}`,
      );
      // Missing key => unknown (null), never a silent "wrong".
      const isCorrect = correct == null ? null : correct === r.selectedOption;
      await tx.update(response).set({ isCorrect }).where(eq(response.id, r.id));
      if (isCorrect) score += 1;
    }
    return score;
  }

  /** Spec 6: descriptive answers are never string-matched; they wait for rubric grading. */
  private async queueDescriptiveForReview(
    tx: Tx,
    rows: ResponseRow[],
  ): Promise<void> {
    if (rows.length === 0) return;
    const ids = rows.map((r) => r.id);

    await tx
      .update(response)
      .set({ isCorrect: null })
      .where(inArray(response.id, ids));

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
    if (status !== 'in_progress')
      throw new ConflictException('Attempt is not in progress');
  }

  private assertBeforeDeadline(startedAt: Date, settings: unknown): void {
    const hardStop =
      this.deadlineOf(startedAt, settings).getTime() +
      ANSWER_SUBMIT_GRACE_SECONDS * 1000;
    if (Date.now() > hardStop) throw new ConflictException('Exam time is over');
  }

  private deadlineOf(startedAt: Date, settings: unknown): Date {
    return new Date(startedAt.getTime() + this.durationOf(settings) * 1000);
  }

  private durationOf(settings: unknown): number {
    const duration = (settings as { durationSeconds?: unknown } | null)
      ?.durationSeconds;
    if (
      typeof duration !== 'number' ||
      !Number.isInteger(duration) ||
      duration <= 0
    ) {
      throw new InternalServerErrorException(
        'Exam settings snapshot is invalid',
      );
    }
    return duration;
  }

  private toSession(
    attemptId: string,
    questionOrder: string[],
    durationSeconds: number,
    startedAt: Date,
  ): ExamSession {
    return {
      attemptId,
      questionOrder,
      durationSeconds,
      startedAt,
      expiresAt: new Date(startedAt.getTime() + durationSeconds * 1000),
      serverTime: new Date(),
    };
  }

  private shuffle(items: string[]): string[] {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
}
