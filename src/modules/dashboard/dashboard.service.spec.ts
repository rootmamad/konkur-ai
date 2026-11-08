import type { SQL } from 'drizzle-orm';

import { appConfig } from '../../db/schema/app-config';
import { attempt } from '../../db/schema/attempt';
import { quotaUsage } from '../../db/schema/billing';
import { questionMastery } from '../../db/schema/question-mastery';
import { response } from '../../db/schema/response';
import { student } from '../../db/schema/student';
import { studyLog } from '../../db/schema/study';
import type { StudyLog } from '../../db/schema/study';
import type { Db } from '../../db/db.module';
import type {
  HistoryContext,
  WeakTopicContext,
} from '../ai/history-context.service';
import { HistoryContextService } from '../ai/history-context.service';
import type { WeekSummary } from '../study/study.service';
import { StudyService } from '../study/study.service';
import { DashboardService } from './dashboard.service';
import type { DashboardSummary } from './dashboard.service';

const STUDENT_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';
const USER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const DAY_MS = 24 * 60 * 60 * 1000;

type Row = Record<string, unknown>;

/** Table fixtures are keyed by schema name, one queue of result sets each. */
const TABLES: Record<string, unknown> = {
  student,
  questionMastery,
  response,
  attempt,
  quotaUsage,
  appConfig,
  studyLog,
};

interface MockChain {
  where(condition: SQL): MockChain;
  innerJoin(table: unknown, on: SQL): MockChain;
  orderBy(...orderings: SQL[]): MockChain;
  limit(count: number): Promise<Row[]>;
  /** Makes the chain awaitable, like a Drizzle query builder. */
  then(resolve: (value: Row[]) => void): void;
}

/**
 * Table-routed mock of the Drizzle chains the dashboard uses:
 *   select().from(t).where(c)[.innerJoin(...)][.orderBy(...)][.limit(n)]
 * Each table has its own FIFO queue of result sets, so query order is per
 * table and unaffected by concurrent reads.
 */
function makeDb(fixtures: Record<string, Row[][]> = {}) {
  const queues = new Map<unknown, Row[][]>();
  for (const [name, sets] of Object.entries(fixtures)) {
    const table = TABLES[name];
    if (!table) throw new Error(`Unknown table fixture: ${name}`);
    queues.set(table, [...sets]);
  }
  // Every test resolves an account -> student mapping at least once.
  if (!queues.has(student)) queues.set(student, [[{ id: STUDENT_ID }]]);

  const conditions: SQL[] = [];
  const limits: number[] = [];

  // The account -> student lookup repeats across calls, so it is not consumed.
  const take = (table: unknown): Row[] => {
    const queue = queues.get(table);
    if (!queue) return [];
    return table === student ? (queue[0] ?? []) : (queue.shift() ?? []);
  };

  const makeChain = (table: unknown, result: Row[]): MockChain => {
    const chain: MockChain = {
      where(condition: SQL) {
        if (table !== student) conditions.push(condition);
        return chain;
      },
      innerJoin() {
        return chain;
      },
      orderBy() {
        return chain;
      },
      limit(count: number) {
        if (table !== student) limits.push(count);
        return Promise.resolve(result);
      },
      then(resolve: (value: Row[]) => void) {
        resolve(result);
      },
    };
    return chain;
  };

  const select = jest.fn(() => ({
    from: jest.fn((table: unknown) => makeChain(table, take(table))),
  }));

  const db = { select } as unknown as Db;
  return { db, log: { conditions, limits, select } };
}

function makeStudyService(
  options: { totalMinutes?: number; recent?: StudyLog[] } = {},
) {
  const summary: WeekSummary = {
    weekStart: new Date('2026-01-05T00:00:00.000Z'),
    weekEnd: new Date('2026-01-12T00:00:00.000Z'),
    totalMinutes: options.totalMinutes ?? 0,
    entries: 0,
    perActivity: {},
    perDay: {},
    vagueCount: 0,
  };
  const getWeekSummary = jest
    .fn<Promise<WeekSummary>, [string, string?]>()
    .mockResolvedValue(summary);
  const getRecent = jest
    .fn<Promise<StudyLog[]>, [string, number?]>()
    .mockResolvedValue(options.recent ?? []);

  return {
    service: { getWeekSummary, getRecent } as unknown as StudyService,
    getWeekSummary,
    getRecent,
  };
}

function makeHistoryContext(weakTopics: WeakTopicContext[] = []) {
  const context: HistoryContext = {
    studentId: STUDENT_ID,
    totalWrong: weakTopics.reduce((sum, t) => sum + t.wrongCount, 0),
    windowDays: 30,
    weakTopics,
  };
  const buildForStudent = jest
    .fn<Promise<HistoryContext>, [string]>()
    .mockResolvedValue(context);

  return {
    service: { buildForStudent } as unknown as HistoryContextService,
    buildForStudent,
  };
}

function weakTopic(title: string, wrongCount: number): WeakTopicContext {
  return {
    topicId: `topic-${title}`,
    topicTitle: title,
    wrongCount,
    distinctWrongQuestions: wrongCount,
    lastWrongAt: new Date('2026-01-06T00:00:00.000Z'),
    concepts: [],
    sampleWrongTexts: [],
    avgDifficulty: null,
  };
}

function studyEntry(overrides: Partial<StudyLog> = {}): StudyLog {
  return {
    id: 'study-1',
    studentId: STUDENT_ID,
    lesson: 'ریاضی',
    topic: null,
    activity: 'learning',
    minutes: 30,
    doneAt: new Date('2026-01-05T09:00:00.000Z'),
    exerciseCount: null,
    result: null,
    source: 'form',
    feeling: null,
    note: null,
    status: 'pending',
    createdAt: new Date('2026-01-05T09:00:00.000Z'),
    ...overrides,
  };
}

async function buildSummary(
  options: {
    mastery?: Row;
    responses?: number;
    attempts?: number;
    lastExam?: Row | null;
    weakTopics?: WeakTopicContext[];
    weeklyMinutes?: number;
    config?: Row | null;
  } = {},
): Promise<DashboardSummary> {
  const attemptSets: Row[][] = [[{ count: options.attempts ?? 0 }]];
  if (options.lastExam) attemptSets.push([options.lastExam]);

  const fixtures: Record<string, Row[][]> = {
    questionMastery: [
      [options.mastery ?? { mastered: 0, inProgress: 0, due: 0 }],
    ],
    response: [[{ count: options.responses ?? 0 }]],
    attempt: attemptSets,
  };
  if (options.config) fixtures.appConfig = [[options.config]];

  const { db } = makeDb(fixtures);
  const study = makeStudyService({ totalMinutes: options.weeklyMinutes ?? 0 });
  const history = makeHistoryContext(options.weakTopics ?? []);
  const service = new DashboardService(db, study.service, history.service);

  return service.getSummary(USER_ID);
}

function utcDayStart(offsetDays = 0): Date {
  const now = new Date();
  const start = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return new Date(start + offsetDays * DAY_MS);
}

describe('DashboardService', () => {
  it('a) getSummary counts mastery/attempts, keeps the top-3 weak topics, reads quota and last score', async () => {
    const weakTopics = [
      weakTopic('مشتق', 9),
      weakTopic('الکتریسیته', 6),
      weakTopic('ژنتیک', 4),
      weakTopic('عربی', 1),
    ];

    const summary = await buildSummary({
      mastery: { mastered: 4, inProgress: 3, due: 0 },
      responses: 12,
      attempts: 6,
      lastExam: {
        totalScore: 82,
        submittedAt: new Date('2026-01-06T10:00:00.000Z'),
      },
      weakTopics,
      weeklyMinutes: 120,
    });

    expect(summary.masteredCount).toBe(4);
    expect(summary.inProgressCount).toBe(3);
    expect(summary.totalAttempts).toBe(6);
    expect(summary.lastExamScore).toBe(82);
    expect(summary.lastStudyWeekMinutes).toBe(120);
    expect(summary.weakTopics.map((t) => t.topicTitle)).toEqual([
      'مشتق',
      'الکتریسیته',
      'ژنتیک',
    ]);
    // No active app_config row -> documented default of 3 quizzes per 7 days.
    expect(summary.freeQuota).toEqual({ used: 0, limit: 3, windowDays: 7 });
    expect(summary.nextAction.action).toBe('debug_errors');
  });

  it('b) getSummary quota limit follows the active app_config override', async () => {
    const overridden = await buildSummary({
      config: { quotas: { free_quiz_weekly: 7 } },
    });
    expect(overridden.freeQuota.limit).toBe(7);

    // Non-integer overrides are ignored in favour of the documented default.
    const invalid = await buildSummary({
      config: { quotas: { free_quiz_weekly: '7' } },
    });
    expect(invalid.freeQuota.limit).toBe(3);
  });

  it('c) nextAction fires each of the four deterministic rules', async () => {
    // 1. No mastery rows and no answered question.
    const diagnostic = await buildSummary({});
    expect(diagnostic.nextAction.action).toBe('diagnostic');

    // 2. An unmastered question with a due review outranks weak topics.
    const due = await buildSummary({
      mastery: { mastered: 2, inProgress: 3, due: 1 },
      responses: 8,
      weakTopics: [weakTopic('مشتق', 5)],
    });
    expect(due.nextAction.action).toBe('due_review');

    // 3. Weak topics exist and nothing is due.
    const debug = await buildSummary({
      mastery: { mastered: 2, inProgress: 1, due: 0 },
      responses: 8,
      weakTopics: [weakTopic('مشتق', 5)],
    });
    expect(debug.nextAction.action).toBe('debug_errors');

    // 4. Clean history: keep studying / general prep.
    const study = await buildSummary({
      mastery: { mastered: 2, inProgress: 1, due: 0 },
      responses: 8,
    });
    expect(study.nextAction.action).toBe('study');

    // Every branch carries a non-empty Persian reason line.
    for (const action of [diagnostic, due, debug, study]) {
      expect(action.nextAction.reason.length).toBeGreaterThan(0);
    }
  });

  it('d) getTrend zero-fills UTC days, buckets answers and study minutes, and caps at 30 days', async () => {
    const today = utcDayStart();
    const todayKey = today.toISOString().slice(0, 10);

    const { db } = makeDb({
      response: [
        [
          {
            isCorrect: true,
            answeredAt: new Date(today.getTime() + 2 * 3600_000),
          },
          {
            isCorrect: false,
            answeredAt: new Date(today.getTime() + 3 * 3600_000),
          },
          {
            isCorrect: false,
            answeredAt: new Date(today.getTime() - DAY_MS + 5 * 3600_000),
          },
          // Null verdict and null timestamp are ignored.
          {
            isCorrect: null,
            answeredAt: new Date(today.getTime() + 4 * 3600_000),
          },
          { isCorrect: true, answeredAt: null },
        ],
      ],
      studyLog: [
        [
          { minutes: 45, doneAt: new Date(today.getTime() + 3600_000) },
          // Ten days back: outside the default 7-day window.
          { minutes: 30, doneAt: new Date(today.getTime() - 10 * DAY_MS) },
        ],
      ],
    });
    const study = makeStudyService();
    const history = makeHistoryContext();
    const service = new DashboardService(db, study.service, history.service);

    const trend = await service.getTrend(USER_ID);

    expect(trend).toHaveLength(7);
    expect(trend[trend.length - 1].date).toBe(todayKey);
    expect(trend[0].date).toBe(
      new Date(today.getTime() - 6 * DAY_MS).toISOString().slice(0, 10),
    );
    expect(trend[trend.length - 1]).toMatchObject({
      answeredCorrect: 1,
      answeredWrong: 1,
      studyMinutes: 45,
    });
    expect(trend[trend.length - 2]).toMatchObject({
      answeredWrong: 1,
      studyMinutes: 0,
    });
    expect(trend.reduce((sum, point) => sum + point.studyMinutes, 0)).toBe(45);

    // A longer request is capped at 30 points.
    const { db: cappedDb } = makeDb();
    const capped = await new DashboardService(
      cappedDb,
      makeStudyService().service,
      makeHistoryContext().service,
    ).getTrend(USER_ID, 90);
    expect(capped).toHaveLength(30);
    expect(capped[0].date).toBe(
      new Date(today.getTime() - 29 * DAY_MS).toISOString().slice(0, 10),
    );
  });

  it('e) getActivity merges exams and study newest first, caps the list, and tolerates empty data', async () => {
    const examScoreTime = new Date('2026-01-06T10:00:00.000Z');
    const examStartTime = new Date('2026-01-06T09:50:00.000Z');
    const studyTime = new Date('2026-01-07T08:00:00.000Z');

    const { db } = makeDb({
      attempt: [
        [
          {
            status: 'submitted',
            startedAt: examStartTime,
            submittedAt: examScoreTime,
            totalScore: 70,
          },
          {
            status: 'in_progress',
            startedAt: new Date('2026-01-05T09:00:00.000Z'),
            submittedAt: null,
            totalScore: null,
          },
        ],
      ],
    });
    const study = makeStudyService({
      recent: [
        studyEntry({
          lesson: 'فیزیک',
          topic: 'حرکت',
          minutes: 20,
          doneAt: studyTime,
        }),
      ],
    });
    const history = makeHistoryContext();
    const service = new DashboardService(db, study.service, history.service);

    const activity = await service.getActivity(USER_ID, 2);

    expect(activity).toHaveLength(2);
    expect(activity[0]).toMatchObject({ type: 'study', at: studyTime });
    expect(activity[0].summary).toContain('فیزیک');
    expect(activity[1]).toMatchObject({ type: 'exam', at: examScoreTime });
    expect(activity[1].summary).toContain('70');
    // The cap is forwarded to the study service too.
    expect(study.getRecent).toHaveBeenCalledWith(USER_ID, 2);

    // Out-of-range limits are clamped to 20 rather than rejected.
    await service.getActivity(USER_ID, 500);
    expect(study.getRecent).toHaveBeenLastCalledWith(USER_ID, 20);

    // No rows at all: empty list, no crash.
    const { db: emptyDb } = makeDb();
    const empty = await new DashboardService(
      emptyDb,
      makeStudyService().service,
      makeHistoryContext().service,
    ).getActivity(USER_ID);
    expect(empty).toEqual([]);
  });
});
