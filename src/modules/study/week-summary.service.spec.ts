// `week-summary.service` -> `ai.service` imports the ESM-only @nestjs/axios
// package; the fake AIService below never uses HTTP, so intercept it here.
jest.mock('@nestjs/axios', () => ({
  HttpService: class {},
}));

import { NotFoundException } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Db } from '../../db/db.module';
import { chatMessage, chatThread } from '../../db/schema/chat';
import { studyLog } from '../../db/schema/study';
import type { StudyLog } from '../../db/schema/study';
import type { AIService, RunJobInput } from '../ai/ai.service';
import { StudyService } from './study.service';
import { WeekSummaryService, parseWeekSummary } from './week-summary.service';
import type { WeekSummaryOutput } from './week-summary.service';

const STUDENT_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';
const USER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const THREAD_ID = '9d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const WEEK_START = new Date('2026-01-05T00:00:00.000Z');
const WEEK_END = new Date('2026-01-12T00:00:00.000Z');

const WEEK_TEXT =
  'این هفته دو جلسه ریاضی و فیزیک ثبت کردی و در مجموع ۶۰ دقیقه مطالعه داشتی. ' +
  'هفته آینده با یک جلسه کوتاه مرور مشتق شروع کن.';

type Row = Record<string, unknown>;

const dialect = new PgDialect();

/** One stored entry with sensible defaults; override any field. */
function entry(overrides: Partial<StudyLog> = {}): StudyLog {
  return {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    studentId: STUDENT_ID,
    lesson: 'ریاضی',
    topic: 'مشتق',
    activity: 'learning',
    minutes: 40,
    doneAt: new Date('2026-01-06T09:00:00.000Z'),
    exerciseCount: null,
    result: null,
    source: 'form',
    feeling: 'clear',
    note: null,
    status: 'pending',
    createdAt: new Date('2026-01-06T09:00:00.000Z'),
    ...overrides,
  };
}

interface MakeDbOptions {
  /** Rows the study_log select returns (already window-filtered by SQL). */
  rows?: StudyLog[];
  /** Rows of the coach thread lookup. */
  threads?: Row[];
  /** All chat messages; the mock applies the assistant-only WHERE. */
  messages?: Row[];
}

/**
 * Fluent mock of the chains used by WeekSummaryService:
 *   select().from(t).where(c).orderBy(o).limit(n)
 *   select().from(m).innerJoin(t).where(c).orderBy(o).limit(n)
 *   insert(t).values(v)[.returning()]
 *   update(t).set(v).where(c)
 * plus `transaction(fn)` whose `tx` exposes the same insert/update/select.
 *
 * Every captured condition is kept with its table, so tests can render the
 * real SQL with `dialect.sqlToQuery` instead of inspecting Drizzle internals.
 */
function makeDb(options: MakeDbOptions = {}) {
  const rows = [...(options.rows ?? [])];
  const threads = [...(options.threads ?? [])];
  const messages = [...(options.messages ?? [])];

  const conditions: { table: unknown; condition: SQL }[] = [];
  const orderings: SQL[] = [];
  const limits: number[] = [];
  const inserts: { table: unknown; values: unknown }[] = [];
  const updates: { table: unknown; values: Row; condition: SQL }[] = [];

  function selectChain() {
    const select = jest.fn(() => ({
      from: (table: unknown) => {
        const source =
          table === studyLog ? rows : table === chatThread ? threads : messages;

        // Models the WHERE: the latest-summary query only sees assistant rows.
        const visible = (): Row[] =>
          table === chatMessage
            ? source.filter((row) => row.role === 'assistant')
            : source;

        const ordered = (): Row[] =>
          table === chatMessage
            ? [...visible()].sort(
                (a, b) =>
                  new Date(b.createdAt as Date).getTime() -
                  new Date(a.createdAt as Date).getTime(),
              )
            : visible();

        const chain = {
          innerJoin: () => chain,
          where: (condition: SQL) => {
            conditions.push({ table, condition });
            return chain;
          },
          orderBy: (ordering: SQL) => {
            orderings.push(ordering);
            return chain;
          },
          limit: (count: number) => {
            limits.push(count);
            return Promise.resolve(ordered().slice(0, count));
          },
          then: (resolve: (value: Row[]) => void) => resolve(ordered()),
        };
        return chain;
      },
    }));
    return select;
  }

  const select = selectChain();

  const insert = jest.fn((table: unknown) => ({
    values: (values: unknown) => {
      inserts.push({ table, values });

      if (table === chatThread) {
        threads.push({ id: THREAD_ID, ...(values as Row) });
        return { returning: () => Promise.resolve([{ id: THREAD_ID }]) };
      }

      const created = Array.isArray(values)
        ? values
        : [{ ...(values as Row), createdAt: new Date() }];
      messages.push(...(created as Row[]));
      return {
        then: (resolve: (value: unknown) => void) => resolve([]),
      };
    },
  }));

  const update = jest.fn((table: unknown) => ({
    set: (values: Row) => ({
      where: (condition: SQL) => {
        updates.push({ table, values, condition });
        return Promise.resolve([]);
      },
    }),
  }));

  const transaction = jest.fn(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      await fn({ select, insert, update }),
  );

  const db = { select, insert, update, transaction } as unknown as Db;

  return {
    db,
    log: {
      conditions,
      orderings,
      limits,
      inserts,
      updates,
      select,
      insert,
      update,
      transaction,
      /** Conditions captured for one table, in call order. */
      conditionsFor: (table: unknown) =>
        conditions.filter((item) => item.table === table),
    },
  };
}

/** Fake StudyService: only the account -> student lookup is used. */
function makeStudy() {
  const resolveStudentId = jest
    .fn<(userId: string) => Promise<string>>()
    .mockResolvedValue(STUDENT_ID);
  return {
    service: { resolveStudentId } as unknown as StudyService,
    resolveStudentId,
  };
}

function makeAi(
  result: WeekSummaryOutput = { summary: WEEK_TEXT, nextFocus: 'مشتق' },
) {
  /** Typed record of every runJob input, so assertions stay type-safe. */
  const calls: RunJobInput<WeekSummaryOutput>[] = [];
  const runJob = jest.fn((input: RunJobInput<WeekSummaryOutput>) => {
    calls.push(input);
    return Promise.resolve(result);
  });
  return { service: { runJob } as unknown as AIService, runJob, calls };
}

function build(options: MakeDbOptions & { aiResult?: WeekSummaryOutput } = {}) {
  const { db, log } = makeDb(options);
  const study = makeStudy();
  const ai = makeAi(options.aiResult);
  const service = new WeekSummaryService(db, study.service, ai.service);
  return { service, log, study, ai };
}

describe('WeekSummaryService', () => {
  it('a) buildWeekContext selects only pending rows of the week and maps a compact list', async () => {
    const longNote = 'ن'.repeat(250);
    const { service, log } = build({
      rows: [
        entry({
          lesson: 'ریاضی',
          topic: 'مشتق',
          activity: 'learning',
          minutes: 40,
          feeling: 'clear',
          note: longNote,
        }),
        entry({
          id: 'entry-2',
          lesson: 'فیزیک',
          topic: null,
          activity: null,
          minutes: 20,
          feeling: null,
          note: '   ',
        }),
      ],
    });

    const context = await service.buildWeekContext(STUDENT_ID, WEEK_START);

    // Raw columns (id, status, doneAt, source) never reach the prompt.
    expect(context).toEqual([
      {
        lesson: 'ریاضی',
        topic: 'مشتق',
        activity: 'learning',
        minutes: 40,
        feeling: 'clear',
        note: longNote.slice(0, 200),
      },
      { lesson: 'فیزیک', minutes: 20 },
    ]);
    expect(context[0].note).toHaveLength(200);

    // The exclusion work is the SQL: pending rows of exactly this week.
    const [condition] = log.conditionsFor(studyLog);
    const { sql: text, params } = dialect.sqlToQuery(condition.condition);
    expect(text).toContain('"study_log"."student_id" =');
    expect(text).toContain('"study_log"."status" =');
    expect(text).toContain('"study_log"."done_at" >=');
    expect(text).toContain('"study_log"."done_at" <');
    expect(params).toEqual([
      STUDENT_ID,
      'pending',
      WEEK_START.toISOString(),
      WEEK_END.toISOString(),
    ]);

    // Newest first, capped at 50 rows.
    expect(dialect.sqlToQuery(log.orderings[0]).sql).toContain(
      '"study_log"."done_at" desc',
    );
    expect(log.limits).toEqual([50]);
  });

  it('a2) buildWeekContext caps the context at 50 entries', async () => {
    const many = Array.from({ length: 51 }, (_, index) =>
      entry({
        id: `entry-${index}`,
        minutes: index,
        doneAt: new Date(WEEK_START.getTime() + index * 60 * 1000),
      }),
    );
    const { service } = build({ rows: many });

    const context = await service.buildWeekContext(STUDENT_ID, WEEK_START);

    expect(context).toHaveLength(50);
    expect(context[0].minutes).toBe(0);
  });

  it('b) generateWeekSummary calls runJob with study_extract and the compact list in the prompt', async () => {
    const { service, ai, study } = build({
      rows: [entry({ lesson: 'ریاضی', topic: 'مشتق', minutes: 40 })],
    });

    await service.generateWeekSummary(USER_ID, WEEK_START);

    expect(ai.runJob).toHaveBeenCalledTimes(1);
    const input = ai.calls[0];
    expect(input.operation).toBe('study_extract');
    expect(input.promptVersion).toBe('week-v1');
    expect(typeof input.parse).toBe('function');

    // The mapped list — not the DB rows — is embedded in the prompt.
    expect(input.prompt).toContain('"lesson":"ریاضی"');
    expect(input.prompt).toContain('"topic":"مشتق"');
    expect(input.prompt).toContain('"minutes":40');
    expect(input.prompt).not.toContain(STUDENT_ID);
    expect(input.prompt).toContain('{"summary"');
    expect(input.prompt).toContain('"nextFocus"');

    expect(study.resolveStudentId).toHaveBeenCalledWith(USER_ID);
  });

  it('c) a failed model call flips nothing and writes no message or thread', async () => {
    const { service, log, ai } = build({ rows: [entry()] });
    ai.runJob.mockRejectedValueOnce(new Error('model down'));

    await expect(
      service.generateWeekSummary(USER_ID, WEEK_START),
    ).rejects.toThrow('model down');

    expect(log.transaction).not.toHaveBeenCalled();
    expect(log.updates).toHaveLength(0);
    expect(log.inserts).toHaveLength(0);
  });

  it('d) success flips exactly the week pending rows and appends one coach message, reusing the thread', async () => {
    const { service, log } = build({ rows: [entry(), entry({ id: 'e-2' })] });

    await service.generateWeekSummary(USER_ID, WEEK_START);

    expect(log.transaction).toHaveBeenCalledTimes(1);

    // One assistant message, body is the summary itself.
    const messageInserts = log.inserts.filter(
      (item) => item.table === chatMessage,
    );
    expect(messageInserts).toHaveLength(1);
    expect(messageInserts[0].values).toMatchObject({
      role: 'assistant',
      body: WEEK_TEXT,
    });

    // Exactly one flip, scoped to student + pending + the same week window.
    expect(log.updates).toHaveLength(1);
    expect(log.updates[0].table).toBe(studyLog);
    expect(log.updates[0].values).toEqual({ status: 'summarized' });
    const { sql: text, params } = dialect.sqlToQuery(log.updates[0].condition);
    expect(text).toContain('"study_log"."student_id" =');
    expect(text).toContain('"study_log"."status" =');
    expect(text).toContain('"study_log"."done_at" >=');
    expect(text).toContain('"study_log"."done_at" <');
    expect(params).toEqual([
      STUDENT_ID,
      'pending',
      WEEK_START.toISOString(),
      WEEK_END.toISOString(),
    ]);

    // Second run: the single coach thread is reused, not created again.
    await service.generateWeekSummary(USER_ID, WEEK_START);
    expect(
      log.inserts.filter((item) => item.table === chatThread),
    ).toHaveLength(1);
    expect(
      log.inserts.filter((item) => item.table === chatMessage),
    ).toHaveLength(2);
    expect(log.transaction).toHaveBeenCalledTimes(2);
  });

  it('e) parseWeekSummary enforces the output contract and a bad completion writes nothing', async () => {
    expect(
      parseWeekSummary(
        JSON.stringify({ summary: `  ${WEEK_TEXT}  `, nextFocus: ' مشتق ' }),
      ),
    ).toEqual({ summary: WEEK_TEXT, nextFocus: 'مشتق' });
    // nextFocus is optional and an empty one is dropped.
    expect(parseWeekSummary(JSON.stringify({ summary: WEEK_TEXT }))).toEqual({
      summary: WEEK_TEXT,
    });

    expect(() => parseWeekSummary('not json')).toThrow();
    expect(() => parseWeekSummary('[]')).toThrow(/object/);
    expect(() => parseWeekSummary(JSON.stringify({ summary: 5 }))).toThrow(
      /string/,
    );
    expect(() =>
      parseWeekSummary(JSON.stringify({ summary: 'کوتاه' })),
    ).toThrow(/at least/);
    expect(() =>
      parseWeekSummary(JSON.stringify({ summary: 'x'.repeat(3001) })),
    ).toThrow(/at most/);
    expect(() =>
      parseWeekSummary(JSON.stringify({ summary: WEEK_TEXT, nextFocus: 7 })),
    ).toThrow(/string/);
    expect(() =>
      parseWeekSummary(
        JSON.stringify({ summary: WEEK_TEXT, nextFocus: 'y'.repeat(301) }),
      ),
    ).toThrow(/at most/);

    // The same rejection inside the real parse rejects the job before any write.
    const { service, log, ai } = build({ rows: [entry()] });
    ai.runJob.mockImplementation((input: RunJobInput<WeekSummaryOutput>) => {
      const parsed = input.parse?.('{"summary":"کوتاه"}');
      return Promise.resolve(parsed as WeekSummaryOutput);
    });

    await expect(
      service.generateWeekSummary(USER_ID, WEEK_START),
    ).rejects.toThrow(/at least/);
    expect(log.transaction).not.toHaveBeenCalled();
    expect(log.inserts).toHaveLength(0);
    expect(log.updates).toHaveLength(0);
  });

  it('f) getLatestWeekSummary returns the newest assistant message or 404', async () => {
    const messages: Row[] = [
      {
        role: 'assistant',
        body: 'خلاصه هفته قبل',
        createdAt: new Date('2026-01-06T10:00:00.000Z'),
      },
      {
        role: 'user',
        body: 'سلام مربی',
        createdAt: new Date('2026-01-08T10:00:00.000Z'),
      },
      {
        role: 'assistant',
        body: WEEK_TEXT,
        createdAt: new Date('2026-01-07T10:00:00.000Z'),
      },
    ];
    const { service, log } = build({ messages });

    const latest = await service.getLatestWeekSummary(USER_ID);

    // A newer user message does not shadow the newest assistant summary.
    expect(latest.summary).toBe(WEEK_TEXT);
    expect(latest.at).toEqual(new Date('2026-01-07T10:00:00.000Z'));

    const [condition] = log.conditionsFor(chatMessage);
    const { sql: text, params } = dialect.sqlToQuery(condition.condition);
    expect(text).toContain('"chat_thread"."student_id" =');
    expect(text).toContain('"chat_thread"."space" =');
    expect(text).toContain('"chat_message"."role" =');
    expect(params).toEqual([STUDENT_ID, 'coach', 'assistant']);
    expect(log.limits).toEqual([1]);

    const empty = build({ messages: [] });
    await expect(empty.service.getLatestWeekSummary(USER_ID)).rejects.toThrow(
      NotFoundException,
    );
  });
});
