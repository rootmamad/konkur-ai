import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
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
import {
  ANSWER_SUBMIT_GRACE_SECONDS,
  DIAGNOSTIC_DURATION_SECONDS,
  DIAGNOSTIC_QUESTION_COUNT,
  FINAL_SIM_DURATION_SECONDS,
  KONKUR_SIM_DURATION_SECONDS,
  MAX_EXAM_DURATION_SECONDS,
  MAX_QUESTIONS_PER_EXAM,
  MAX_TEXT_ANSWER_LENGTH,
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
 * Free-plan quiz quota (spec section 10). The authoritative numbers live in the
 * active app_config row; the value below is only the documented default for
 * "3 آزمونک در هر ۷ روز" when no active setting exists yet.
 */
const QUIZ_QUOTA_OPERATION = 'quiz';
const FREE_QUIZ_WEEKLY_KEY = 'free_quiz_weekly';
const FREE_QUIZ_WEEKLY_DEFAULT = 3;
const FREE_QUIZ_QUOTA_EXHAUSTED = 'سهمیه آزمونک هفتگی پلن رایگان تمام شده است';

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
  constructor(@Inject(DB) private readonly db: Db) {}

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

    if (
      q.type === QuestionType.MULTIPLE_CHOICE ||
      q.type === QuestionType.TRUE_FALSE
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

  async finishExam(
    attemptId: string,
    userId: string,
  ): Promise<{ totalScore: number; pendingDescriptive: number }> {
    const studentId = await this.requireStudentId(userId);

    return this.db.transaction(async (tx) => {
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
        // sourceYear is stored as the Persian (Solar Hijri / Shamsi) year,
        // e.g. 1398 = کنکور ۱۳۹۸. If the DB is ever switched to Gregorian
        // years, change the gte values below to 2019 (konkur) / 2023 (final).
        return this.selectFromSource(studentId, {
          mode: 'konkur',
          sourceYear: { gte: 1398 },
          limit: undefined,
        });
      case 'final_sim':
        return this.selectFromSource(studentId, {
          mode: 'final',
          sourceYear: { gte: 1402 },
          limit: undefined,
        });
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

    // One ordered list keeps the pool priorities in a single place.
    // TODO: future: AI-generated questions (origin='ai', status='published')
    // become pool 0 targeting the student's weak concepts — the generation func
    // is built separately.
    const poolSteps: {
      ratio: number;
      select: (poolDto: SelectDto) => Promise<string[]>;
    }[] = [
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
    ];

    const chosen = new Set<string>();
    const ids: string[] = [];

    for (const step of poolSteps) {
      if (ids.length >= total) break;
      const quota = Math.floor(step.ratio * total);
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

  private async selectDiagnostic(studentId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: question.id })
      .from(question)
      .where(eq(question.status, 'published'))
      .orderBy(sql`random()`)
      .limit(DIAGNOSTIC_QUESTION_COUNT);
    return rows.map((r) => r.id);
  }

  private async selectFromSource(
    studentId: string,
    opts: {
      mode: 'konkur' | 'final';
      sourceYear?: { gte: number };
      limit?: number;
    },
  ): Promise<string[]> {
    const conditions = [
      eq(question.status, 'published'),
      sql`${question.sourceYear} IS NOT NULL`,
    ];
    if (opts.sourceYear) {
      conditions.push(sql`${question.sourceYear} >= ${opts.sourceYear.gte}`);
    }
    if (opts.mode === 'konkur') {
      conditions.push(sql`${question.sourceSession} IS NOT NULL`);
    } else {
      conditions.push(sql`${question.sourceLesson} IS NOT NULL`);
    }

    const rows = await this.db
      .select({ id: question.id })
      .from(question)
      .where(and(...conditions))
      .orderBy(sql`random()`)
      .limit(opts.limit ?? MAX_QUESTIONS_PER_EXAM);

    return rows.map((r) => r.id);
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
    if (type === QuestionType.MULTIPLE_CHOICE) {
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

    if (type === QuestionType.DESCRIPTIVE) {
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
