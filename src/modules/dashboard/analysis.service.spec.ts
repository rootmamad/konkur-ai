// `analysis.service` -> `ai.service` imports the ESM-only @nestjs/axios package;
// the fake AIService below never uses HTTP, so intercept the module here.
jest.mock('@nestjs/axios', () => ({
  HttpService: class {},
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';

import { chatMessage, chatThread } from '../../db/schema/chat';
import type { Db } from '../../db/db.module';
import type { AIService, RunJobInput } from '../ai/ai.service';
import { AnalysisService, parseOverallAnalysis } from './analysis.service';
import type { OverallAnalysis } from './analysis.service';
import { DashboardService } from './dashboard.service';
import type { DashboardSummary, TrendPoint } from './dashboard.service';

const STUDENT_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';
const USER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const THREAD_ID = '9d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const ANALYSIS_AT = new Date('2026-11-05T20:00:00.000Z');

type Row = Record<string, unknown>;

const NARRATIVE =
  'این هفته در مشتق پیشرفت داشتی اما هنوز خطاهای محاسباتی تکرار می‌شود. ' +
  'دو جلسه مرور هدفمند و یک آزمونک کوتاه کافی است تا تسلط کامل شود.';

/**
 * Mock of the two chain shapes the analysis service uses:
 *   select().from(t).where(c).limit(1)
 *   select().from(m).innerJoin(t).where(c).orderBy(o).limit(2)
 * plus an insert-only `transaction(fn)` whose `tx` records every insert.
 */
function makeDb(seed: { threads?: Row[]; messages?: Row[] } = {}) {
  const threads = [...(seed.threads ?? [])];
  const messages = [...(seed.messages ?? [])];
  const inserts: { table: unknown; values: unknown }[] = [];

  const insert = jest.fn((table: unknown) => ({
    values: (values: unknown) => {
      inserts.push({ table, values });
      if (table === chatThread) {
        threads.push({ id: THREAD_ID, ...(values as Row) });
        return { returning: () => Promise.resolve([{ id: THREAD_ID }]) };
      }
      return {
        then: (resolve: (value: unknown) => void) => resolve([]),
      };
    },
  }));

  const select = jest.fn(() => ({
    from: (table: unknown) => {
      const rows = table === chatThread ? threads : messages;
      // The service always orders messages by createdAt descending.
      const ordered = (): Row[] =>
        table === chatThread
          ? rows
          : [...rows].sort(
              (a, b) =>
                new Date(b.createdAt as Date).getTime() -
                new Date(a.createdAt as Date).getTime(),
            );
      const chain = {
        innerJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: (count: number) => Promise.resolve(ordered().slice(0, count)),
        then: (resolve: (value: Row[]) => void) => resolve(ordered()),
      };
      return chain;
    },
  }));

  const transaction = jest.fn(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      await fn({ insert, select }),
  );

  const db = { select, transaction } as unknown as Db;
  return { db, inserts, log: { select, transaction, insert } };
}

function makeSummary(
  overrides: Partial<DashboardSummary> = {},
): DashboardSummary {
  return {
    masteredCount: 4,
    inProgressCount: 3,
    totalAttempts: 6,
    lastExamScore: 82,
    lastStudyWeekMinutes: 120,
    weakTopics: [],
    freeQuota: { used: 2, limit: 3, windowDays: 7 },
    nextAction: { action: 'debug_errors', reason: 'مشتق را رفع اشکال کن.' },
    ...overrides,
  };
}

const TREND: TrendPoint[] = [
  {
    date: '2026-11-04',
    answeredCorrect: 2,
    answeredWrong: 3,
    studyMinutes: 40,
  },
  {
    date: '2026-11-05',
    answeredCorrect: 5,
    answeredWrong: 1,
    studyMinutes: 60,
  },
];

function makeDashboard(summary: DashboardSummary = makeSummary()) {
  const resolveStudentId = jest
    .fn<Promise<string>, [string]>()
    .mockResolvedValue(STUDENT_ID);
  const getSummary = jest
    .fn<Promise<DashboardSummary>, [string]>()
    .mockResolvedValue(summary);
  const getTrend = jest
    .fn<Promise<TrendPoint[]>, [string, number?]>()
    .mockResolvedValue(TREND);

  return {
    service: {
      resolveStudentId,
      getSummary,
      getTrend,
    } as unknown as DashboardService,
    resolveStudentId,
    getSummary,
    getTrend,
  };
}

function makeAi(
  result: OverallAnalysis = { narrative: NARRATIVE, emphasis: 'مشتق' },
) {
  /** Typed record of every runJob input, so assertions stay type-safe. */
  const calls: RunJobInput<OverallAnalysis>[] = [];
  const runJob = jest.fn((input: RunJobInput<OverallAnalysis>) => {
    calls.push(input);
    return Promise.resolve(result);
  });
  return { service: { runJob } as unknown as AIService, runJob, calls };
}

function build(
  options: {
    summary?: DashboardSummary;
    aiResult?: OverallAnalysis;
    threads?: Row[];
    messages?: Row[];
  } = {},
) {
  const { db, inserts, log } = makeDb({
    threads: options.threads,
    messages: options.messages,
  });
  const dashboard = makeDashboard(options.summary);
  const ai = makeAi(options.aiResult);
  const service = new AnalysisService(db, dashboard.service, ai.service);
  return { service, inserts, log, dashboard, ai };
}

/** The single chat_message insert's rows, typed for assertions. */
function messageRows(inserts: { table: unknown; values: unknown }[]) {
  const insert = inserts.find((entry) => entry.table === chatMessage);
  return insert ? (insert.values as Row[]) : [];
}

describe('AnalysisService', () => {
  it('a) persists the snapshot and narrative in one insert and reuses the thread', async () => {
    const { service, inserts, log, ai } = build();

    await service.generateOverallAnalysis(USER_ID);

    // First run: thread created, then exactly one message insert with both rows.
    expect(log.transaction).toHaveBeenCalledTimes(1);
    expect(inserts.map((entry) => entry.table)).toEqual([
      chatThread,
      chatMessage,
    ]);
    expect(log.insert).toHaveBeenCalledTimes(2);

    const rows = messageRows(inserts);
    expect(rows).toHaveLength(2);
    expect(rows[0].role).toBe('user');
    expect(rows[0].threadId).toBe(THREAD_ID);
    expect(rows[1].role).toBe('assistant');
    expect(rows[1].threadId).toBe(THREAD_ID);
    expect(rows[1].body).toBe(NARRATIVE);

    // The user row is the compact JSON request payload (snapshot + emphasis).
    const payload = JSON.parse(String(rows[0].body)) as {
      emphasis: string;
      snapshot: { summary: DashboardSummary; trend: TrendPoint[] };
    };
    expect(payload.emphasis).toBe('مشتق');
    expect(payload.snapshot.summary.masteredCount).toBe(4);
    expect(payload.snapshot.trend).toEqual(TREND);

    // Second run reuses the existing thread: no second chat_thread insert.
    await service.generateOverallAnalysis(USER_ID);

    expect(log.transaction).toHaveBeenCalledTimes(2);
    expect(inserts.filter((entry) => entry.table === chatThread)).toHaveLength(
      1,
    );
    const second = inserts.filter((entry) => entry.table === chatMessage)[1];
    expect((second.values as Row[])[0].threadId).toBe(THREAD_ID);
    expect(ai.runJob).toHaveBeenCalledTimes(2);
  });

  it('b) calls runJob with the overall_analysis operation and the snapshot in the prompt', async () => {
    const summary = makeSummary({ masteredCount: 11, lastExamScore: 64 });
    const { service, ai, dashboard } = build({ summary });

    await service.generateOverallAnalysis(USER_ID);

    expect(ai.runJob).toHaveBeenCalledTimes(1);
    const input = ai.calls[0];
    expect(input.operation).toBe('overall_analysis');
    expect(input.promptVersion).toBe('overall-v1');
    expect(typeof input.parse).toBe('function');

    // The rule-based snapshot is embedded verbatim, so the model sees no raw rows.
    expect(input.prompt).toContain('"masteredCount":11');
    expect(input.prompt).toContain('"lastExamScore":64');
    expect(input.prompt).toContain('"trend":');
    expect(input.prompt).toContain('"2026-11-05"');
    expect(input.prompt).toContain('{"narrative"');

    // The snapshot is built from the public dashboard reads, 7 trend days.
    expect(dashboard.getSummary).toHaveBeenCalledWith(USER_ID);
    expect(dashboard.getTrend).toHaveBeenCalledWith(USER_ID, 7);
    expect(dashboard.resolveStudentId).toHaveBeenCalledWith(USER_ID);
  });

  it('c) a failed model call rejects and writes nothing (no half thread)', async () => {
    const { service, inserts, log, ai } = build();
    ai.runJob.mockRejectedValueOnce(new Error('upstream 500'));

    await expect(service.generateOverallAnalysis(USER_ID)).rejects.toThrow(
      'upstream 500',
    );

    expect(log.transaction).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it('d) a schema failure surfaces BadRequestException and inserts nothing', async () => {
    const { service, inserts, log, ai } = build();
    ai.runJob.mockRejectedValueOnce(
      new BadRequestException('AI output failed schema validation'),
    );

    await expect(
      service.generateOverallAnalysis(USER_ID),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(log.transaction).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it('e) getLatestAnalysis returns the newest assistant body or 404', async () => {
    const { service } = build({
      messages: [
        { role: 'assistant', body: 'تحلیل قدیمی', createdAt: ANALYSIS_AT },
        {
          role: 'user',
          body: JSON.stringify({ emphasis: 'مشتق', snapshot: {} }),
          createdAt: new Date(ANALYSIS_AT.getTime() + 1000),
        },
        {
          role: 'assistant',
          body: NARRATIVE,
          createdAt: new Date(ANALYSIS_AT.getTime() + 2000),
        },
      ],
    });

    const latest = await service.getLatestAnalysis(USER_ID);
    expect(latest.narrative).toBe(NARRATIVE);
    expect(latest.emphasis).toBe('مشتق');
    expect(latest.at).toEqual(new Date(ANALYSIS_AT.getTime() + 2000));

    const empty = build();
    await expect(
      empty.service.getLatestAnalysis(USER_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('f) parseOverallAnalysis enforces the output contract', () => {
    const valid = parseOverallAnalysis(
      JSON.stringify({ narrative: `  ${NARRATIVE}  `, emphasis: ' مشتق ' }),
    );
    expect(valid).toEqual({ narrative: NARRATIVE, emphasis: 'مشتق' });

    // Too short, too long, wrong types and non-objects are all rejected so
    // runJob retries once and then fails the job.
    expect(() =>
      parseOverallAnalysis(
        JSON.stringify({ narrative: 'کوتاه', emphasis: '' }),
      ),
    ).toThrow(/at least 50/);
    expect(() =>
      parseOverallAnalysis(
        JSON.stringify({ narrative: 'x'.repeat(4001), emphasis: '' }),
      ),
    ).toThrow(/at most 4000/);
    expect(() =>
      parseOverallAnalysis(
        JSON.stringify({ narrative: NARRATIVE, emphasis: 'x'.repeat(301) }),
      ),
    ).toThrow(/at most 300/);
    expect(() =>
      parseOverallAnalysis(
        JSON.stringify({ narrative: NARRATIVE, emphasis: 5 }),
      ),
    ).toThrow(/emphasis must be a string/);
    expect(() => parseOverallAnalysis('[]')).toThrow(/JSON object/);
    expect(() => parseOverallAnalysis('not json')).toThrow();
  });
});
