import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';

import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import { appConfig } from '../../db/schema/app-config';
import { attempt } from '../../db/schema/attempt';
import { quotaUsage } from '../../db/schema/billing';
import { questionMastery } from '../../db/schema/question-mastery';
import { response } from '../../db/schema/response';
import { student } from '../../db/schema/student';
import { studyLog } from '../../db/schema/study';
import { HistoryContextService } from '../ai/history-context.service';
import type { WeakTopicContext } from '../ai/history-context.service';
// Free-quiz quota pieces shared with ExamsService (spec §10) — one source, so
// this card can never drift from the enforcement in exams.
import {
  FREE_QUIZ_WEEKLY_DEFAULT,
  FREE_QUIZ_WEEKLY_KEY,
  QUOTA_WINDOW_DAYS,
  QUIZ_QUOTA_OPERATION,
} from '../billing/quiz-quota.shared';
import { StudyService } from '../study/study.service';

export const DEFAULT_TREND_DAYS = 7;
export const MAX_TREND_DAYS = 30;
export const DEFAULT_ACTIVITY_LIMIT = 10;
export const MAX_ACTIVITY_LIMIT = 20;
/** How many weak topics the dashboard card shows (spec §3.7). */
export const SUMMARY_WEAK_TOPICS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Deterministic next-step rules (spec §3.7 "اقدام بعدی"). No AI involved. */
export type NextActionKind =
  'diagnostic' | 'due_review' | 'debug_errors' | 'study';

export interface NextAction {
  action: NextActionKind;
  /** One-line Persian explanation shown under the action. */
  reason: string;
}

export interface DashboardSummary {
  masteredCount: number;
  inProgressCount: number;
  totalAttempts: number;
  lastExamScore: number | null;
  lastStudyWeekMinutes: number;
  weakTopics: WeakTopicContext[];
  freeQuota: { used: number; limit: number; windowDays: number };
  nextAction: NextAction;
}

/** One UTC day of the trend chart. */
export interface TrendPoint {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  answeredCorrect: number;
  answeredWrong: number;
  studyMinutes: number;
}

/** One row of the merged "فعالیت اخیر" feed. */
export interface ActivityItem {
  type: 'exam' | 'study';
  at: Date;
  summary: string;
}

/** Start of a UTC calendar day (the dashboard's "naive server day"). */
function utcDayStart(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function clampTrendDays(days?: number): number {
  if (days === undefined || !Number.isFinite(days)) return DEFAULT_TREND_DAYS;
  return Math.min(Math.max(Math.trunc(days), 1), MAX_TREND_DAYS);
}

function clampActivityLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_ACTIVITY_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_ACTIVITY_LIMIT);
}

/**
 * Read model for the student dashboard / مانیتور (spec §1.1 page 3 and §3.7).
 *
 * Rule-based only: no AI call and no writes. The AI overall analysis, the
 * weekly-AI summary and the coach chat link are separate tasks; the coach chat
 * is a frontend link, not an endpoint here.
 *
 * Data ownership: counts and per-day buckets are queried directly here because
 * no other service exposes them; the weekly study aggregate and the weak-topic
 * ranking are owned by StudyService / HistoryContextService and are injected
 * rather than re-implemented.
 */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly studyService: StudyService,
    private readonly historyContext: HistoryContextService,
  ) {}

  /**
   * Dashboard head card. Every number is computed for the resolved student;
   * `nextAction` is a fixed rule ladder (first match wins):
   * 1. no mastery data and no answered question -> `diagnostic`
   * 2. an unmastered question whose review is due -> `due_review`
   * 3. ranked weak topics exist -> `debug_errors`
   * 4. otherwise -> `study`
   */
  async getSummary(userId: string): Promise<DashboardSummary> {
    const studentId = await this.resolveStudentId(userId);

    const [mastery] = await this.db
      .select({
        mastered: sql<number>`(count(*) filter (where ${questionMastery.masteredAt} is not null))::int`,
        inProgress: sql<number>`(count(*) filter (where ${questionMastery.masteredAt} is null))::int`,
        due: sql<number>`(count(*) filter (where ${questionMastery.masteredAt} is null and ${questionMastery.nextDueAt} <= now()))::int`,
      })
      .from(questionMastery)
      .where(eq(questionMastery.studentId, studentId));

    const masteredCount = mastery?.mastered ?? 0;
    const inProgressCount = mastery?.inProgress ?? 0;
    const dueCount = mastery?.due ?? 0;

    const [responseCount] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(response)
      .innerJoin(attempt, eq(attempt.id, response.attemptId))
      .where(eq(attempt.studentId, studentId));
    const answeredCount = responseCount?.count ?? 0;

    const [attemptCount] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(attempt)
      .where(eq(attempt.studentId, studentId));
    const totalAttempts = attemptCount?.count ?? 0;

    const [lastExam] = await this.db
      .select({
        totalScore: attempt.totalScore,
        submittedAt: attempt.submittedAt,
      })
      .from(attempt)
      .where(
        and(eq(attempt.studentId, studentId), isNotNull(attempt.submittedAt)),
      )
      .orderBy(desc(attempt.submittedAt))
      .limit(1);

    const freeQuotaUsed = await this.countQuizUsage(studentId);
    const freeQuotaLimit = await this.getFreeQuizLimit();

    const week = await this.studyService.getWeekSummary(userId);
    const history = await this.historyContext.buildForStudent(studentId);
    const weakTopics = history.weakTopics.slice(0, SUMMARY_WEAK_TOPICS);

    return {
      masteredCount,
      inProgressCount,
      totalAttempts,
      lastExamScore: lastExam?.totalScore ?? null,
      lastStudyWeekMinutes: week.totalMinutes,
      weakTopics,
      freeQuota: {
        used: freeQuotaUsed,
        limit: freeQuotaLimit,
        windowDays: QUOTA_WINDOW_DAYS,
      },
      nextAction: this.decideNextAction({
        hasMasteryRows: masteredCount + inProgressCount > 0,
        answeredCount,
        dueCount,
        weakTopics,
      }),
    };
  }

  /**
   * Per-UTC-day trend for the last `days` calendar days (today included,
   * default 7, capped at 30). Days without activity are zero-filled, so the
   * chart always receives exactly `days` points in ascending date order.
   */
  async getTrend(userId: string, days?: number): Promise<TrendPoint[]> {
    const studentId = await this.resolveStudentId(userId);
    const windowDays = clampTrendDays(days);

    const todayStart = utcDayStart(new Date());
    const start = new Date(todayStart.getTime() - (windowDays - 1) * DAY_MS);
    const end = new Date(todayStart.getTime() + DAY_MS);

    const responseRows = await this.db
      .select({
        isCorrect: response.isCorrect,
        answeredAt: response.answeredAt,
      })
      .from(response)
      .innerJoin(attempt, eq(attempt.id, response.attemptId))
      .where(
        and(
          eq(attempt.studentId, studentId),
          gte(response.answeredAt, start),
          lt(response.answeredAt, end),
        ),
      );

    const studyRows = await this.db
      .select({ minutes: studyLog.minutes, doneAt: studyLog.doneAt })
      .from(studyLog)
      .where(
        and(
          eq(studyLog.studentId, studentId),
          gte(studyLog.doneAt, start),
          lt(studyLog.doneAt, end),
        ),
      );

    const buckets = new Map<string, TrendPoint>();
    for (let i = 0; i < windowDays; i += 1) {
      const date = new Date(start.getTime() + i * DAY_MS);
      buckets.set(utcDayKey(date), {
        date: utcDayKey(date),
        answeredCorrect: 0,
        answeredWrong: 0,
        studyMinutes: 0,
      });
    }

    for (const row of responseRows) {
      if (row.answeredAt == null) continue;
      if (row.isCorrect == null) continue;
      const bucket = buckets.get(utcDayKey(row.answeredAt));
      if (!bucket) continue;
      if (row.isCorrect) bucket.answeredCorrect += 1;
      else bucket.answeredWrong += 1;
    }

    for (const row of studyRows) {
      const bucket = buckets.get(utcDayKey(row.doneAt));
      if (!bucket) continue;
      bucket.studyMinutes += row.minutes;
    }

    return [...buckets.values()];
  }

  /**
   * Merged recent activity feed: exam attempts and study entries sorted by
   * time descending and capped (default 10, max 20). Missing data yields an
   * empty list, never an error.
   */
  async getActivity(userId: string, limit?: number): Promise<ActivityItem[]> {
    const studentId = await this.resolveStudentId(userId);
    const cap = clampActivityLimit(limit);

    const [examRows, studyRows] = await Promise.all([
      this.db
        .select({
          status: attempt.status,
          startedAt: attempt.startedAt,
          submittedAt: attempt.submittedAt,
          totalScore: attempt.totalScore,
        })
        .from(attempt)
        .where(eq(attempt.studentId, studentId))
        .orderBy(desc(attempt.startedAt))
        .limit(cap),
      this.studyService.getRecent(userId, cap),
    ]);

    const items: ActivityItem[] = [
      ...examRows.map((row) => ({
        type: 'exam' as const,
        at: row.submittedAt ?? row.startedAt,
        summary: examSummary(row.totalScore, row.status),
      })),
      ...studyRows.map((row) => ({
        type: 'study' as const,
        at: row.doneAt,
        summary: studySummary(row.lesson, row.topic, row.minutes),
      })),
    ];

    items.sort((a, b) => b.at.getTime() - a.at.getTime());
    return items.slice(0, cap);
  }

  // ---------- helpers ----------

  private decideNextAction(input: {
    hasMasteryRows: boolean;
    answeredCount: number;
    dueCount: number;
    weakTopics: WeakTopicContext[];
  }): NextAction {
    if (!input.hasMasteryRows && input.answeredCount === 0) {
      return {
        action: 'diagnostic',
        reason:
          'هنوز سابقه‌ای ثبت نشده؛ با آزمون تشخیصی سطح فعلی‌ات مشخص می‌شود.',
      };
    }
    if (input.dueCount > 0) {
      return {
        action: 'due_review',
        reason: `${input.dueCount} سؤال موعد مرورش رسیده؛ اول آن‌ها را مرور کن.`,
      };
    }
    if (input.weakTopics.length > 0) {
      const title = input.weakTopics[0].topicTitle ?? 'ضعیف‌ترین مبحث';
      return {
        action: 'debug_errors',
        reason: `بیشترین خطا را در «${title}» داری؛ همان را رفع اشکال کن.`,
      };
    }
    return {
      action: 'study',
      reason: 'وضعیتت مرتب است؛ با مطالعه و آزمون عمومی پیش برو.',
    };
  }

  /** Rolling 7-day quiz quota consumption, same window as exams.service. */
  private async countQuizUsage(studentId: string): Promise<number> {
    const [row] = await this.db
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
   * Effective free-plan quiz limit from the active versioned settings row
   * (spec §10.2), replicating the small read in exams.service so this module
   * does not need ExamsService. Falls back to the documented default only
   * when no active app_config row exists.
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
   * Resolve the JWT subject (an account id) to the student profile id.
   *
   * Public because every student-scoped dashboard feature — including the
   * async overall analysis — must map the account exactly this way instead of
   * duplicating the lookup.
   */
  async resolveStudentId(userId: string): Promise<string> {
    const [row] = await this.db
      .select({ id: student.id })
      .from(student)
      .where(eq(student.accountId, userId))
      .limit(1);
    if (!row) throw new NotFoundException('Student profile not found');
    return row.id;
  }
}

function examSummary(totalScore: number | null, status: string): string {
  if (totalScore != null) return `آزمون — نمره ${totalScore}`;
  return status === 'in_progress' ? 'آزمون — در حال انجام' : 'آزمون — ثبت‌شده';
}

function studySummary(
  lesson: string,
  topic: string | null,
  minutes: number,
): string {
  const subject = topic ? `${lesson} — ${topic}` : lesson;
  return `مطالعه — ${subject} (${minutes} دقیقه)`;
}
