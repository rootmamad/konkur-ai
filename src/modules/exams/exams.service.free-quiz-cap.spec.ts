import { BadRequestException } from '@nestjs/common';

import type { Db } from '../../db/db.module';
import { QuestionType } from '../questions/enums/question-type.enum';
import type { CountsDto, StartExamDto } from './dto/start-exam.dto';
import type { ExamSession } from './exams.service';
import { ExamsService } from './exams.service';

const STUDENT_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';
const CLIENT_KEY = 'a3f0c1d2-4b5e-4f6a-9b7c-8d9e0f1a2b3c';

type DtoWithCounts = StartExamDto & {
  counts: CountsDto;
  durationSeconds: number;
};

function makeDto(overrides: Partial<DtoWithCounts> = {}): DtoWithCounts {
  return {
    questionType: QuestionType.MULTIPLE_CHOICE,
    kind: 'general_prep',
    counts: { easy: 11, normal: 0, hard: 0 },
    durationSeconds: 600,
    ...overrides,
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
 * Mock DB with a transaction stub, same shape as the quota spec: startExam
 * reaches the database only through the private helpers (each stubbed) plus
 * the template/instance/attempt inserts inside `db.transaction`.
 */
function setup(options: {
  paid?: boolean;
  used?: number;
  limit?: number;
  maxQuestions?: number;
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
  jest.spyOn(priv, 'findSessionByKey').mockResolvedValue(null);
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
      .mockResolvedValue(options.maxQuestions ?? 10),
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

describe('ExamsService free-plan per-quiz question cap', () => {
  it('rejects a free quiz above the cap with 400 before any write', async () => {
    const { service, transaction, quotaRows, attemptRows, instanceRows } =
      setup({ paid: false, used: 0, limit: 3, maxQuestions: 10 });

    await expect(
      service.startExam('user-1', makeDto(), CLIENT_KEY),
    ).rejects.toBeInstanceOf(BadRequestException);

    // The check runs before the quota-reserving transaction: nothing consumed.
    expect(transaction).not.toHaveBeenCalled();
    expect(quotaRows).toHaveLength(0);
    expect(attemptRows).toHaveLength(0);
    expect(instanceRows).toHaveLength(0);
  });

  it('allows a free quiz of exactly the cap', async () => {
    const { service, transaction, quotaRows, attemptRows } = setup({
      paid: false,
      used: 0,
      limit: 3,
      maxQuestions: 10,
    });

    const session = await service.startExam(
      'user-1',
      makeDto({ counts: { easy: 10, normal: 0, hard: 0 } }),
      CLIENT_KEY,
    );

    expect(session.attemptId).toBe('row-1');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(quotaRows).toHaveLength(1);
    expect(attemptRows).toHaveLength(1);
  });

  it('a configured cap below the default also applies', async () => {
    const { service } = setup({ paid: false, maxQuestions: 5 });

    await expect(
      service.startExam(
        'user-1',
        makeDto({ counts: { easy: 6, normal: 0, hard: 0 } }),
        CLIENT_KEY,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('paid users are not capped by the free per-quiz limit', async () => {
    const { service, spies, quotaRows } = setup({ paid: true });

    await expect(
      service.startExam('user-1', makeDto(), CLIENT_KEY),
    ).resolves.toBeDefined();

    expect(spies.getFreeQuizMaxQuestions).not.toHaveBeenCalled();
    expect(quotaRows).toHaveLength(0);
  });

  it('diagnostic never reads the per-quiz cap (fixed count outside the branch)', async () => {
    const { service, spies } = setup({ paid: false, used: 0 });

    await service.startExam(
      'user-1',
      makeDto({
        kind: 'diagnostic' as DtoWithCounts['kind'],
        counts: { easy: 0, normal: 0, hard: 0 },
        durationSeconds: 60,
      }),
      CLIENT_KEY,
    );

    expect(spies.getFreeQuizMaxQuestions).not.toHaveBeenCalled();
  });

  it('reads the cap from the active config and defaults to 10', async () => {
    function serviceWithQuotas(rows: unknown[]): ExamsService {
      const limit = jest.fn(() => Promise.resolve(rows));
      const orderBy = jest.fn(() => ({ limit }));
      const where = jest.fn(() => ({ orderBy }));
      const from = jest.fn(() => ({ where }));
      const select = jest.fn(() => ({ from }));
      return new ExamsService({ select } as unknown as Db);
    }

    const getMax = (service: ExamsService) =>
      (service as unknown as PrivateService).getFreeQuizMaxQuestions();

    // Active config value wins.
    await expect(
      getMax(serviceWithQuotas([{ quotas: { free_quiz_max_questions: 25 } }])),
    ).resolves.toBe(25);
    // Missing / invalid values fall back to 10.
    await expect(getMax(serviceWithQuotas([{ quotas: {} }]))).resolves.toBe(10);
    await expect(getMax(serviceWithQuotas([]))).resolves.toBe(10);
    await expect(
      getMax(
        serviceWithQuotas([{ quotas: { free_quiz_max_questions: '10' } }]),
      ),
    ).resolves.toBe(10);
    await expect(
      getMax(serviceWithQuotas([{ quotas: { free_quiz_max_questions: 0 } }])),
    ).resolves.toBe(10);
    await expect(
      getMax(serviceWithQuotas([{ quotas: { free_quiz_max_questions: 2.5 } }])),
    ).resolves.toBe(10);
  });
});
