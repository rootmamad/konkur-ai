import { BadRequestException } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Db } from '../../db/db.module';
import {
  answerKey,
  attempt,
  correction,
  response,
  student,
} from '../../db/schema';
import { QuestionType } from '../questions/enums/question-type.enum';
import type { GradingService } from '../grading/grading.service';
import type { CountsDto, StartExamDto } from './dto/start-exam.dto';
import { ExamsService } from './exams.service';

const TOPIC_ID = '6f1f4c2e-0b1a-4c3d-9f2e-2c7b5a4d8e11';
const STUDENT_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';
const CLIENT_KEY = 'a3f0c1d2-4b5e-4f6a-9b7c-8d9e0f1a2b3c';

const dialect = new PgDialect();

type DtoWithCounts = StartExamDto & {
  counts: CountsDto;
  durationSeconds: number;
};

function makeDto(overrides: Partial<DtoWithCounts> = {}): DtoWithCounts {
  return {
    questionType: QuestionType.MULTIPLE_CHOICE,
    kind: 'quiz_after_study',
    counts: { easy: 0, normal: 0, hard: 0 },
    durationSeconds: 600,
    ...overrides,
  };
}

/**
 * Minimal Drizzle stand-in: the selection helpers only use
 * `select().from().where().orderBy().limit()`. One result set per difficulty
 * bucket, in call order.
 */
function mockDb(rowsPerQuery: string[][] = []) {
  const conditions: SQL[] = [];
  let call = 0;

  const limit = jest.fn(() =>
    Promise.resolve((rowsPerQuery[call++] ?? []).map((id) => ({ id }))),
  );
  const orderBy = jest.fn(() => ({ limit }));
  const where = jest.fn((condition: SQL) => {
    conditions.push(condition);
    return { orderBy };
  });
  const from = jest.fn(() => ({ where }));
  const select = jest.fn(() => ({ from }));

  return { db: { select } as unknown as Db, select, conditions };
}

function callSelectQuestionIds(
  service: ExamsService,
  dto: DtoWithCounts,
  studentId: string,
): Promise<string[]> {
  const privateService = service as unknown as {
    selectQuestionIds(dto: DtoWithCounts, studentId: string): Promise<string[]>;
  };
  return privateService.selectQuestionIds(dto, studentId);
}

describe('ExamsService quiz_after_study selection', () => {
  it('limits every difficulty bucket to the chosen topic', async () => {
    const { db, select, conditions } = mockDb([
      ['q-easy-1', 'q-easy-2'],
      ['q-normal-1'],
    ]);
    const service = new ExamsService(db);

    const ids = await callSelectQuestionIds(
      service,
      makeDto({
        topicId: TOPIC_ID,
        counts: { easy: 2, normal: 1, hard: 0 },
      }),
      STUDENT_ID,
    );

    expect(ids.sort()).toEqual(['q-easy-1', 'q-easy-2', 'q-normal-1']);
    // The empty "hard" bucket is skipped, so one query per non-zero bucket.
    expect(select).toHaveBeenCalledTimes(2);

    for (const condition of conditions) {
      const { sql: text, params } = dialect.sqlToQuery(condition);
      expect(text).toContain('"question"."topic_id" =');
      expect(text).toContain('"question"."status" =');
      expect(text).toContain('"question"."type" =');
      expect(text).toContain('"question"."difficulty_ai" =');
      expect(text).toContain('NOT EXISTS');
      expect(params).toContain(TOPIC_ID);
      expect(params).toContain(STUDENT_ID);
    }
  });

  it('returns partial results when the topic has fewer questions', async () => {
    const { db } = mockDb([['q-easy-1', 'q-easy-2']]);
    const service = new ExamsService(db);

    const ids = await callSelectQuestionIds(
      service,
      makeDto({ topicId: TOPIC_ID, counts: { easy: 3, normal: 0, hard: 0 } }),
      STUDENT_ID,
    );

    expect(ids.sort()).toEqual(['q-easy-1', 'q-easy-2']);
  });

  it('rejects a quiz_after_study start without topicId (HTTP 400)', async () => {
    const { db, select } = mockDb();
    const service = new ExamsService(db);
    const spyTarget = service as unknown as {
      requireStudentId(userId: string): Promise<string>;
      findSessionByKey(key: string): Promise<null>;
      hasPaidPlan(userId: string): Promise<boolean>;
      getFreeQuizLimit(): Promise<number>;
      getFreeQuizMaxQuestions(): Promise<number>;
      countQuizUsage(studentId: string): Promise<number>;
    };
    jest.spyOn(spyTarget, 'requireStudentId').mockResolvedValue(STUDENT_ID);
    jest.spyOn(spyTarget, 'findSessionByKey').mockResolvedValue(null);
    jest.spyOn(spyTarget, 'hasPaidPlan').mockResolvedValue(false);
    jest.spyOn(spyTarget, 'getFreeQuizLimit').mockResolvedValue(3);
    jest.spyOn(spyTarget, 'getFreeQuizMaxQuestions').mockResolvedValue(10);
    jest.spyOn(spyTarget, 'countQuizUsage').mockResolvedValue(0);

    const start = service.startExam(
      'user-1',
      makeDto({ counts: { easy: 1, normal: 0, hard: 0 } }),
      CLIENT_KEY,
    );

    await expect(start).rejects.toBeInstanceOf(BadRequestException);
    await expect(start).rejects.toThrow(/topicId is required/);
    expect(select).not.toHaveBeenCalled();
  });

  it('ignores topicId for other quiz kinds', async () => {
    const { db, conditions } = mockDb([['q-a'], ['q-b']]);
    const service = new ExamsService(db);

    const ids = await callSelectQuestionIds(
      service,
      makeDto({
        kind: 'general_prep',
        topicId: TOPIC_ID,
        counts: { easy: 1, normal: 1, hard: 0 },
      }),
      STUDENT_ID,
    );

    expect(ids.sort()).toEqual(['q-a', 'q-b']);
    for (const condition of conditions) {
      expect(dialect.sqlToQuery(condition).sql).not.toContain('topic_id');
    }
  });
});

describe('ExamsService finishExam — AI grading trigger (spec 6)', () => {
  const USER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  const ATTEMPT_ID = '9d8c7b6a-5f4e-4d3c-2b1a-0f9e8d7c6b5a';
  const Q_MCQ = '7a9b1c3d-5e7f-4a9b-8c1d-3e5f7a9b1c3d';
  const Q_DESC = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';

  type Row = Record<string, unknown>;
  const TABLES: Record<string, unknown> = {
    student,
    attempt,
    response,
    answerKey,
    correction,
  };

  /** Table-routed mock covering the whole finish transaction. */
  function makeFinishDb(fixtures: Record<string, Row[][]> = {}) {
    const queues = new Map<unknown, Row[][]>();
    for (const [name, sets] of Object.entries(fixtures)) {
      const table = TABLES[name];
      if (!table) throw new Error(`Unknown table fixture: ${name}`);
      queues.set(table, [...sets]);
    }

    const conditions: SQL[] = [];
    const updated: Array<{ table: unknown; values: Row }> = [];
    const inserted: Array<{ table: unknown; values: Row }> = [];

    const take = (table: unknown): Row[] => {
      const queue = queues.get(table);
      if (!queue) return [];
      return table === student ? (queue[0] ?? []) : (queue.shift() ?? []);
    };

    const resolvable = (rows: Row[]): unknown => ({
      then: (resolve: (value: Row[]) => void) => resolve(rows),
      for: () => resolvable(rows), // the finish path locks the attempt row
    });

    const makeChain = (table: unknown, result: Row[]) => {
      const chain = {
        innerJoin() {
          return chain;
        },
        where(condition: SQL) {
          if (table !== student) conditions.push(condition);
          return chain;
        },
        limit(count: number) {
          return resolvable(result.slice(0, count));
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
    const update = jest.fn((table: unknown) => ({
      set: jest.fn((values: Row) => ({
        where: jest.fn(() => {
          updated.push({ table, values });
          return Promise.resolve();
        }),
      })),
    }));
    const insert = jest.fn((table: unknown) => ({
      values: jest.fn((values: Row) => ({
        returning: jest.fn(() => {
          inserted.push({ table, values });
          return Promise.resolve([]);
        }),
        then: (resolve: (value: Row[]) => void) => {
          inserted.push({ table, values });
          resolve([]);
        },
      })),
    }));

    const tx = { select, update, insert };
    const transaction = jest.fn((callback: (t: typeof tx) => unknown) =>
      Promise.resolve(callback(tx)),
    );
    const db = { select, update, insert, transaction } as unknown as Db;

    return { db, transaction, conditions, updated, inserted };
  }

  function attemptRow(): Row {
    return {
      id: ATTEMPT_ID,
      status: 'in_progress',
      startedAt: new Date(), // inside the duration window
      submittedAt: null,
      totalScore: null,
      questionOrder: [Q_MCQ, Q_DESC],
      settings: { durationSeconds: 600 },
    };
  }

  function responseRows(): Row[] {
    return [
      {
        id: 'resp-mcq',
        questionId: Q_MCQ,
        questionVersion: 1,
        selectedOption: 1,
        textAnswer: null,
        isCorrect: null,
      },
      {
        id: 'resp-desc',
        questionId: Q_DESC,
        questionVersion: 1,
        selectedOption: null,
        textAnswer: 'پاسخ تشریحی',
        isCorrect: null,
      },
    ];
  }

  function makeGrading(impl: () => Promise<void>) {
    const gradeAttempt = jest.fn<Promise<void>, [string]>(impl);
    return {
      service: { gradeAttempt } as unknown as GradingService,
      gradeAttempt,
    };
  }

  it('fires the AI grading once, after the finish transaction commits', async () => {
    const { db, transaction, updated, inserted } = makeFinishDb({
      student: [[{ id: STUDENT_ID }]],
      attempt: [[attemptRow()]],
      response: [responseRows()],
      answerKey: [
        [{ questionId: Q_MCQ, questionVersion: 1, correctOptionIndex: 1 }],
      ],
      correction: [[]], // nothing queued yet → the descriptive row is inserted
    });
    const { service: grading, gradeAttempt } = makeGrading(() =>
      Promise.resolve(),
    );
    const service = new ExamsService(
      db,
      undefined,
      undefined,
      undefined,
      grading,
    );

    const result = await service.finishExam(ATTEMPT_ID, USER_ID);

    // The finish result is the choice score + the pending count — grading
    // never changes it.
    expect(result).toEqual({ totalScore: 1, pendingDescriptive: 1 });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(gradeAttempt).toHaveBeenCalledTimes(1);
    expect(gradeAttempt).toHaveBeenCalledWith(ATTEMPT_ID);
    // The finish transaction did its own writes; grading is separate.
    expect(updated.map((u) => u.table)).toEqual([response, response, attempt]);
    expect(inserted.map((i) => i.table)).toEqual([correction]);
  });

  it('a grading failure never breaks the exam result', async () => {
    const { db } = makeFinishDb({
      student: [[{ id: STUDENT_ID }]],
      attempt: [[attemptRow()]],
      response: [responseRows()],
      answerKey: [
        [{ questionId: Q_MCQ, questionVersion: 1, correctOptionIndex: 1 }],
      ],
      correction: [[]],
    });
    const { service: grading, gradeAttempt } = makeGrading(() =>
      Promise.reject(new Error('grading down')),
    );
    const service = new ExamsService(
      db,
      undefined,
      undefined,
      undefined,
      grading,
    );

    const result = await service.finishExam(ATTEMPT_ID, USER_ID);

    expect(result).toEqual({ totalScore: 1, pendingDescriptive: 1 });
    expect(gradeAttempt).toHaveBeenCalledWith(ATTEMPT_ID);

    // Let the swallowed rejection settle; no unhandled rejection may surface.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('works without a GradingService at all (optional dep)', async () => {
    const { db } = makeFinishDb({
      student: [[{ id: STUDENT_ID }]],
      attempt: [[attemptRow()]],
      response: [responseRows()],
      answerKey: [
        [{ questionId: Q_MCQ, questionVersion: 1, correctOptionIndex: 1 }],
      ],
      correction: [[]],
    });
    const service = new ExamsService(db);

    const result = await service.finishExam(ATTEMPT_ID, USER_ID);

    expect(result).toEqual({ totalScore: 1, pendingDescriptive: 1 });
  });
});
