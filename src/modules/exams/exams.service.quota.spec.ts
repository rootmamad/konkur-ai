import { ForbiddenException } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Db } from '../../db/db.module';
import { QuestionType } from '../questions/enums/question-type.enum';
import type { CountsDto, StartExamDto } from './dto/start-exam.dto';
import type { ExamSession } from './exams.service';
import { ExamsService } from './exams.service';

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
    kind: 'general_prep',
    counts: { easy: 1, normal: 0, hard: 0 },
    durationSeconds: 600,
    ...overrides,
  };
}

function makeSession(): ExamSession {
  const startedAt = new Date();
  return {
    attemptId: 'attempt-1',
    questionOrder: ['q-1'],
    durationSeconds: 600,
    startedAt,
    expiresAt: new Date(startedAt.getTime() + 600_000),
    serverTime: new Date(),
  };
}

type PrivateService = {
  requireStudentId(userId: string): Promise<string>;
  findSessionByKey(key: string): Promise<ExamSession | null>;
  hasPaidPlan(userId: string): Promise<boolean>;
  getFreeQuizLimit(): Promise<number>;
  getFreeQuizMaxQuestions(): Promise<number>;
  countQuizUsage(studentId: string): Promise<number>;
  selectQuestionIds(dto: StartExamDto, studentId: string): Promise<string[]>;
};

/**
 * Mock DB with a transaction stub. `startExam` reaches the database only
 * through the private helpers, which each test stubs explicitly, plus the
 * template/instance/attempt inserts inside `db.transaction`.
 */
function setup(options: {
  paid?: boolean;
  used?: number;
  limit?: number;
  replay?: ExamSession | null;
}) {
  const quotaRows: Record<string, unknown>[] = [];
  const attemptRows: Record<string, unknown>[] = [];
  const instanceRows: Record<string, unknown>[] = [];

  const values = jest.fn((row: Record<string, unknown>) => {
    if (row.operation === 'quiz') quotaRows.push(row);
    else if (row.examInstanceId) attemptRows.push(row);
    else instanceRows.push(row);
    return {
      returning: () =>
        Promise.resolve([{ id: 'row-1', startedAt: new Date() }]),
      then: (resolve: (value?: unknown) => void) => resolve(),
    };
  });

  const tx = {
    execute: jest.fn(() => Promise.resolve([])),
    insert: jest.fn(() => ({ values })),
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: jest.fn(() => Promise.resolve([{ id: 'template-1' }])),
        })),
      })),
    })),
  };

  const transaction = jest.fn((callback: (t: typeof tx) => unknown) =>
    Promise.resolve(callback(tx)),
  );
  const db = { transaction } as unknown as Db;
  const service = new ExamsService(db);
  const priv = service as unknown as PrivateService;

  jest.spyOn(priv, 'requireStudentId').mockResolvedValue(STUDENT_ID);
  jest
    .spyOn(priv, 'findSessionByKey')
    .mockResolvedValue(options.replay ?? null);
  jest.spyOn(priv, 'selectQuestionIds').mockResolvedValue(['q-1']);
  const spies = {
    hasPaidPlan: jest
      .spyOn(priv, 'hasPaidPlan')
      .mockResolvedValue(options.paid ?? false),
    getFreeQuizLimit: jest
      .spyOn(priv, 'getFreeQuizLimit')
      .mockResolvedValue(options.limit ?? 3),
    getFreeQuizMaxQuestions: jest
      .spyOn(priv, 'getFreeQuizMaxQuestions')
      .mockResolvedValue(10),
    countQuizUsage: jest
      .spyOn(priv, 'countQuizUsage')
      .mockResolvedValue(options.used ?? 0),
  };

  return {
    service,
    priv,
    spies,
    tx,
    transaction,
    quotaRows,
    attemptRows,
    instanceRows,
  };
}

describe('ExamsService free-plan quiz quota', () => {
  it('rejects the 4th quiz in the rolling window with 403', async () => {
    const { service, transaction, quotaRows } = setup({ used: 3, limit: 3 });

    await expect(
      service.startExam('user-1', makeDto(), CLIENT_KEY),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(transaction).not.toHaveBeenCalled();
    expect(quotaRows).toHaveLength(0);
  });

  it('reserves exactly one quiz slot for each of the first 3 quizzes', async () => {
    for (const used of [0, 1, 2]) {
      const { service, quotaRows } = setup({ used, limit: 3 });

      const session = await service.startExam('user-1', makeDto(), CLIENT_KEY);

      expect(session.attemptId).toBe('row-1');
      expect(quotaRows).toHaveLength(1);
      expect(quotaRows[0]).toEqual({
        studentId: STUDENT_ID,
        operation: 'quiz',
        amount: 1,
        windowStart: expect.any(Date) as Date,
      });
    }
  });

  it('returns the replayed session without checking or consuming quota again', async () => {
    const replay = makeSession();
    const { service, spies, transaction, quotaRows } = setup({ replay });

    const session = await service.startExam('user-1', makeDto(), CLIENT_KEY);

    expect(session).toBe(replay);
    expect(spies.countQuizUsage).not.toHaveBeenCalled();
    expect(spies.getFreeQuizLimit).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(quotaRows).toHaveLength(0);
  });

  it('does not limit or charge a student with an active paid plan', async () => {
    const { service, spies, quotaRows } = setup({ paid: true });

    await expect(
      service.startExam('user-1', makeDto(), CLIENT_KEY),
    ).resolves.toBeDefined();

    expect(spies.countQuizUsage).not.toHaveBeenCalled();
    expect(spies.getFreeQuizLimit).not.toHaveBeenCalled();
    expect(quotaRows).toHaveLength(0);
  });

  it('never writes a quota row for konkur_sim / final_sim', async () => {
    for (const kind of ['konkur_sim', 'final_sim'] as const) {
      const { service, spies, quotaRows, attemptRows, instanceRows } = setup({
        paid: true,
      });

      await service.startExam('user-1', makeDto({ kind }), CLIENT_KEY);

      expect(spies.getFreeQuizLimit).not.toHaveBeenCalled();
      expect(instanceRows).toHaveLength(1);
      expect(attemptRows).toHaveLength(1);
      expect(quotaRows).toHaveLength(0);
    }
  });

  it('counts only quiz rows inside the rolling 7-day window', async () => {
    const conditions: SQL[] = [];
    const selectedFields: SQL[] = [];
    const where = jest.fn((condition: SQL) => {
      conditions.push(condition);
      return Promise.resolve([{ count: 2 }]);
    });
    const select = jest.fn((fields: Record<string, SQL>) => {
      selectedFields.push(...Object.values(fields));
      return { from: jest.fn(() => ({ where })) };
    });
    const service = new ExamsService({ select } as unknown as Db);

    const used = await (service as unknown as PrivateService).countQuizUsage(
      STUDENT_ID,
    );

    expect(used).toBe(2);
    expect(selectedFields).toHaveLength(1);
    expect(dialect.sqlToQuery(selectedFields[0]).sql).toContain(
      'count(*)::int',
    );
    expect(conditions).toHaveLength(1);
    const { sql: text, params } = dialect.sqlToQuery(conditions[0]);
    expect(text).toContain('"quota_usage"."student_id" =');
    expect(text).toContain('"quota_usage"."operation" =');
    expect(text).toContain(
      `"quota_usage"."window_start" >= now() - interval '7 days'`,
    );
    expect(params).toContain(STUDENT_ID);
    expect(params).toContain('quiz');
  });

  it('reads the limit from the active config and defaults to 3', async () => {
    function serviceWithQuotas(rows: unknown[]): ExamsService {
      const limit = jest.fn(() => Promise.resolve(rows));
      const orderBy = jest.fn(() => ({ limit }));
      const where = jest.fn(() => ({ orderBy }));
      const from = jest.fn(() => ({ where }));
      const select = jest.fn(() => ({ from }));
      return new ExamsService({ select } as unknown as Db);
    }

    const getLimit = (service: ExamsService) =>
      (service as unknown as PrivateService).getFreeQuizLimit();

    await expect(
      getLimit(serviceWithQuotas([{ quotas: { free_quiz_weekly: 5 } }])),
    ).resolves.toBe(5);
    await expect(getLimit(serviceWithQuotas([{ quotas: {} }]))).resolves.toBe(
      3,
    );
    await expect(getLimit(serviceWithQuotas([]))).resolves.toBe(3);
    await expect(
      getLimit(serviceWithQuotas([{ quotas: { free_quiz_weekly: '5' } }])),
    ).resolves.toBe(3);
  });
});
