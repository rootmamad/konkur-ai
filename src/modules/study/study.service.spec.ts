import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Db } from '../../db/db.module';
import { student } from '../../db/schema/student';
import type { StudyLog } from '../../db/schema/study';
import type { CreateStudyEntryDto } from './dto/create-study-entry.dto';
import { StudyService } from './study.service';

const STUDENT_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';
const USER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const dialect = new PgDialect();

/** One stored entry with sensible defaults; override any field. */
function entry(overrides: Partial<StudyLog> = {}): StudyLog {
  return {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
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

interface MockDbOptions {
  /** Rows for the account -> student lookup (defaults to one student). */
  students?: Array<{ id: string }>;
  /** Rows per `study_log` select, in call order. */
  rows?: unknown[][];
  /** Rows returned by each insert().returning(), in call order. */
  inserted?: StudyLog[];
}

/**
 * Fluent mock of the Drizzle chains used by StudyService:
 *   select().from(student).where().limit(1)
 *   select().from(studyLog).where().orderBy()[.limit(n)]
 *   insert(studyLog).values(v).returning()
 * `orderBy()` resolves like a thenable so it also supports a trailing limit().
 */
function makeDb(options: MockDbOptions = {}) {
  const conditions: SQL[] = [];
  const orderings: SQL[] = [];
  const limits: number[] = [];
  const insertedValues: Record<string, unknown>[] = [];
  let dataQueries = 0;

  const select = jest.fn(() => ({
    from: jest.fn((table: unknown) => {
      const result =
        table === student
          ? (options.students ?? [{ id: STUDENT_ID }])
          : (options.rows?.[dataQueries++] ?? []);

      const limit = jest.fn((count: number) => {
        if (table !== student) limits.push(count);
        return Promise.resolve(result);
      });
      const orderBy = jest.fn((ordering: SQL) => {
        orderings.push(ordering);
        return Object.assign(Promise.resolve(result), { limit });
      });
      const where = jest.fn((condition: SQL) => {
        if (table !== student) conditions.push(condition);
        return { limit, orderBy };
      });

      return { where };
    }),
  }));

  const insert = jest.fn(() => ({
    values: jest.fn((values: Record<string, unknown>) => {
      insertedValues.push(values);
      const row = options.inserted?.[insertedValues.length - 1];
      return { returning: jest.fn(() => Promise.resolve(row ? [row] : [])) };
    }),
  }));

  const db = { select, insert } as unknown as Db;

  return {
    db,
    log: { conditions, orderings, limits, insertedValues, insert },
  };
}

/** Construction helper: direct instantiation, no Nest module (house style). */
function makeService(db: Db): StudyService {
  return new StudyService(db);
}

describe('StudyService', () => {
  it('a) createStudyEntry inserts a form entry as pending and returns the created row', async () => {
    const created = entry({
      id: 'new-entry',
      source: 'form',
      status: 'pending',
      minutes: 45,
      topic: 'مشتق',
      exerciseCount: 5,
      feeling: 'clear',
      note: 'تمرین ۳ را نتوانستم',
      doneAt: new Date('2026-01-05T09:30:00.000Z'),
    });
    const clamped = entry({
      id: 'new-entry-2',
      doneAt: new Date('2026-01-06T00:00:00.000Z'),
    });
    const { db, log } = makeDb({ inserted: [created, clamped] });
    const service = makeService(db);

    const dto: CreateStudyEntryDto = {
      lesson: 'ریاضی دوازدهم — مشتق',
      activity: 'learning',
      minutes: 45,
      topic: 'مشتق',
      exerciseCount: 5,
      feeling: 'clear',
      note: 'تمرین ۳ را نتوانستم',
      doneAt: '2026-01-05T09:30:00.000Z',
    };

    const result = await service.createStudyEntry(USER_ID, dto);

    expect(result).toBe(created);
    // source/status are server-set: the DTO never carries them.
    expect(log.insertedValues[0]).toMatchObject({
      studentId: STUDENT_ID,
      lesson: 'ریاضی دوازدهم — مشتق',
      topic: 'مشتق',
      activity: 'learning',
      minutes: 45,
      exerciseCount: 5,
      feeling: 'clear',
      note: 'تمرین ۳ را نتوانستم',
      source: 'form',
      status: 'pending',
    });
    expect((log.insertedValues[0].doneAt as Date).toISOString()).toBe(
      '2026-01-05T09:30:00.000Z',
    );

    // A future doneAt is clamped to now instead of being rejected.
    const beforeCall = Date.now();
    await service.createStudyEntry(USER_ID, {
      lesson: 'فیزیک',
      activity: 'test',
      minutes: 5,
      doneAt: '2999-01-01T00:00:00.000Z',
    });
    const storedDoneAt = log.insertedValues[1].doneAt as Date;
    expect(storedDoneAt.getTime()).toBeGreaterThanOrEqual(beforeCall);
    expect(storedDoneAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("b) repeatYesterday copies yesterday's latest entry with minutes=0 and source=repeat_yesterday", async () => {
    const yesterday = entry({
      lesson: 'فیزیک',
      topic: 'حرکت',
      activity: 'exercise',
      exerciseCount: 12,
      note: 'یادداشت',
      minutes: 45,
      feeling: 'vague',
      doneAt: new Date('2026-01-06T20:00:00.000Z'),
    });
    const copy = entry({
      id: 'copy-1',
      lesson: 'فیزیک',
      topic: 'حرکت',
      activity: 'exercise',
      exerciseCount: 12,
      note: 'یادداشت',
      minutes: 0,
      source: 'repeat_yesterday',
      doneAt: new Date('2026-01-07T08:00:00.000Z'),
    });
    const { db, log } = makeDb({ rows: [[yesterday]], inserted: [copy] });
    const service = makeService(db);

    const beforeCall = Date.now();
    const result = await service.repeatYesterday(USER_ID);
    const afterCall = Date.now();

    expect(result).toBe(copy);
    expect(log.insertedValues[0]).toMatchObject({
      studentId: STUDENT_ID,
      lesson: 'فیزیک',
      topic: 'حرکت',
      activity: 'exercise',
      exerciseCount: 12,
      note: 'یادداشت',
      minutes: 0,
      source: 'repeat_yesterday',
      status: 'pending',
    });
    // feeling describes yesterday's session; the repeat carries none.
    expect(log.insertedValues[0]).not.toHaveProperty('feeling');
    const doneAt = log.insertedValues[0].doneAt as Date;
    expect(doneAt.getTime()).toBeGreaterThanOrEqual(beforeCall);
    expect(doneAt.getTime()).toBeLessThanOrEqual(afterCall);

    // Yesterday = the naive server day: [date_trunc('day', now() - 1 day), today).
    const { sql: text, params } = dialect.sqlToQuery(log.conditions[0]);
    expect(text).toContain("date_trunc('day', now() - interval '1 day')");
    expect(text).toContain("date_trunc('day', now())");
    expect(text).toContain('"study_log"."done_at" >=');
    expect(text).toContain('"study_log"."done_at" <');
    expect(params).toContain(STUDENT_ID);
    // Newest-first pick, one row only.
    expect(dialect.sqlToQuery(log.orderings[0]).sql).toContain('desc');
    expect(log.limits).toEqual([1]);
  });

  it('c) repeatYesterday without an entry from yesterday throws NotFoundException and inserts nothing', async () => {
    const { db, log } = makeDb({ rows: [[]] });
    const service = makeService(db);

    await expect(service.repeatYesterday(USER_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.repeatYesterday(USER_ID)).rejects.toThrow(
      'No study entry from yesterday',
    );
    expect(log.insert).not.toHaveBeenCalled();
  });

  it('d) getWeekSummary aggregates perActivity/perDay/totalMinutes/vagueCount and excludes out-of-week rows', async () => {
    const rows: StudyLog[] = [
      entry({
        doneAt: new Date('2026-01-05T09:00:00.000Z'),
        minutes: 30,
        activity: 'learning',
        feeling: 'clear',
      }),
      entry({
        doneAt: new Date('2026-01-05T18:00:00.000Z'),
        minutes: 20,
        activity: 'exercise',
        feeling: 'vague',
      }),
      entry({
        doneAt: new Date('2026-01-06T08:00:00.000Z'),
        minutes: 10,
        activity: 'learning',
        feeling: null,
      }),
      // Outside the window: previous Sunday and the following Monday.
      entry({
        doneAt: new Date('2026-01-04T23:59:00.000Z'),
        minutes: 99,
        activity: 'test',
      }),
      entry({
        doneAt: new Date('2026-01-12T00:00:00.000Z'),
        minutes: 77,
        activity: 'review',
      }),
    ];
    const { db, log } = makeDb({ rows: [rows] });

    const summary = await makeService(db).getWeekSummary(
      USER_ID,
      '2026-01-05T00:00:00.000Z',
    );

    expect(summary.weekStart.toISOString()).toBe('2026-01-05T00:00:00.000Z');
    expect(summary.weekEnd.toISOString()).toBe('2026-01-12T00:00:00.000Z');
    expect(summary.entries).toBe(3);
    expect(summary.totalMinutes).toBe(60);
    expect(summary.perActivity).toEqual({ learning: 40, exercise: 20 });
    expect(summary.perDay).toEqual({ '2026-01-05': 50, '2026-01-06': 10 });
    expect(summary.vagueCount).toBe(1);

    // Pure aggregation: no status flip and no writes in this endpoint.
    expect(log.insert).not.toHaveBeenCalled();

    const { sql: text, params } = dialect.sqlToQuery(log.conditions[0]);
    expect(text).toContain('"study_log"."student_id" =');
    expect(text).toContain('"study_log"."done_at" >=');
    expect(text).toContain('"study_log"."done_at" <');
    // Drizzle renders Date parameters as ISO strings.
    expect(params).toEqual([
      STUDENT_ID,
      '2026-01-05T00:00:00.000Z',
      '2026-01-12T00:00:00.000Z',
    ]);
  });

  it('e) getWeekSummary defaults to Monday of the current ISO week and rejects an unparsable weekStart', async () => {
    const { db } = makeDb({ rows: [[]] });
    const service = makeService(db);

    const now = new Date();
    const expectedStart = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - ((now.getUTCDay() + 6) % 7),
      ),
    );

    const summary = await service.getWeekSummary(USER_ID);

    expect(summary.weekStart.toISOString()).toBe(expectedStart.toISOString());
    expect(summary.weekStart.getUTCDay()).toBe(1);
    expect(summary.weekStart.toISOString().slice(11)).toBe('00:00:00.000Z');
    expect(summary.weekEnd.getTime() - summary.weekStart.getTime()).toBe(
      WEEK_MS,
    );
    expect(summary).toMatchObject({
      totalMinutes: 0,
      entries: 0,
      perActivity: {},
      perDay: {},
      vagueCount: 0,
    });

    await expect(
      service.getWeekSummary(USER_ID, 'not-a-date'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('f) getRecent returns newest first and clamps limit to 1..50', async () => {
    const newest = entry({
      id: 'e-new',
      doneAt: new Date('2026-01-06T00:00:00.000Z'),
    });
    const older = entry({
      id: 'e-old',
      doneAt: new Date('2026-01-05T00:00:00.000Z'),
    });
    const { db, log } = makeDb({
      rows: [
        [newest, older],
        [newest, older],
        [newest, older],
      ],
    });
    const service = makeService(db);

    const recent = await service.getRecent(USER_ID);
    expect(recent.map((row) => row.id)).toEqual(['e-new', 'e-old']);
    expect(log.limits).toEqual([20]);
    expect(dialect.sqlToQuery(log.orderings[0]).sql).toContain(
      '"study_log"."done_at" desc',
    );

    // Above the cap, below the floor.
    await service.getRecent(USER_ID, 500);
    expect(log.limits).toEqual([20, 50]);
    await service.getRecent(USER_ID, 0);
    expect(log.limits).toEqual([20, 50, 1]);
  });
});
