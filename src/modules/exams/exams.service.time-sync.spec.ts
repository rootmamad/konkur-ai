import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import { ExamsController } from './exams.controller';
import type { Db } from '../../db/db.module';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { ExamsService } from './exams.service';

const ATTEMPT_ID = '2f1c6a4e-8b3d-4c5f-9a7e-1d2b3c4e5f60';
const USER_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const STUDENT_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';
const QUESTION_ID = '7c6d5e4f-3a2b-4c1d-9e8f-7a6b5c4d3e2f';
const QUESTION_VERSION = 5;

type AttemptContext = {
  id: string;
  status: string;
  startedAt: Date;
  submittedAt: Date | null;
  totalScore: number | null;
  questionOrder: string[];
  settings: { durationSeconds: number };
};

function makeContext(overrides: Partial<AttemptContext> = {}): AttemptContext {
  return {
    id: ATTEMPT_ID,
    status: 'in_progress',
    startedAt: new Date(),
    submittedAt: null,
    totalScore: null,
    questionOrder: [QUESTION_ID],
    settings: { durationSeconds: 600 },
    ...overrides,
  };
}

type SavedUpsert = {
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
  target?: unknown;
};

/**
 * Mock DB for the time upsert: the single select returns the question row,
 * and the insert records what would be written / overwritten.
 */
function timeDb(
  questionRows: { version: number }[] = [{ version: QUESTION_VERSION }],
) {
  const saved: SavedUpsert = {};
  const update = jest.fn();

  const limit = jest.fn(() => Promise.resolve(questionRows));
  const where = jest.fn(() => ({ limit }));
  const from = jest.fn(() => ({ where }));
  const select = jest.fn(() => ({ from }));

  const onConflictDoUpdate = jest.fn(
    (arg: { set: Record<string, unknown>; target: unknown }) => {
      saved.set = arg.set;
      saved.target = arg.target;
      return Promise.resolve();
    },
  );
  const values = jest.fn((value: Record<string, unknown>) => {
    saved.values = value;
    return { onConflictDoUpdate };
  });
  const insert = jest.fn(() => ({ values }));

  return {
    db: { select, insert, update } as unknown as Db,
    saved,
    insert,
    update,
  };
}

type AttemptPrivates = {
  requireStudentId(userId: string): Promise<string>;
  loadOwnedAttempt(
    executor: unknown,
    attemptId: string,
    studentId: string,
    lock?: boolean,
  ): Promise<AttemptContext>;
};

function stubAttempt(
  service: ExamsService,
  ctx: AttemptContext = makeContext(),
): AttemptPrivates {
  const priv = service as unknown as AttemptPrivates;
  jest.spyOn(priv, 'requireStudentId').mockResolvedValue(STUDENT_ID);
  jest.spyOn(priv, 'loadOwnedAttempt').mockResolvedValue(ctx);
  return priv;
}

describe('ExamsService.syncQuestionTime (spec 8)', () => {
  it('creates a time-only response row before the question is answered', async () => {
    const { db, saved } = timeDb();
    const service = new ExamsService(db);
    stubAttempt(service);

    await service.syncQuestionTime(ATTEMPT_ID, USER_ID, 0, 17);

    expect(saved.values).toMatchObject({
      attemptId: ATTEMPT_ID,
      questionId: QUESTION_ID,
      questionVersion: QUESTION_VERSION,
      activeSeconds: 17,
    });
    expect(saved.values?.answeredAt).toBeInstanceOf(Date);
    // A time-only row must not look like an answer.
    expect(saved.values).not.toHaveProperty('selectedOption');
    expect(saved.values).not.toHaveProperty('textAnswer');
    expect(saved.values).not.toHaveProperty('isCorrect');
    expect(saved.values).not.toHaveProperty('attemptNumber');
  });

  it('overwrites only activeSeconds when an answer already exists', async () => {
    const { db, saved, update } = timeDb();
    const service = new ExamsService(db);
    stubAttempt(service);

    await service.syncQuestionTime(ATTEMPT_ID, USER_ID, 0, 64);

    // The conflict update touches the time column and nothing else, so the
    // stored answer (selectedOption/textAnswer/isCorrect/attemptNumber/
    // answeredAt) cannot be cleared or regraded by a periodic report.
    expect(saved.set).toEqual({ activeSeconds: 64 });
    expect(Object.keys(saved.set ?? {})).toEqual(['activeSeconds']);
    expect(saved.target).toHaveLength(2);
    // No outcome/mastery write: syncing time never grades anything.
    expect(update).not.toHaveBeenCalled();
  });

  it('is an absolute overwrite: a retried report cannot double-count', async () => {
    const { db, saved } = timeDb();
    const service = new ExamsService(db);
    stubAttempt(service);

    await service.syncQuestionTime(ATTEMPT_ID, USER_ID, 0, 30);
    await service.syncQuestionTime(ATTEMPT_ID, USER_ID, 0, 45);

    expect(saved.values).toMatchObject({ activeSeconds: 45 });
    expect(saved.set).toMatchObject({ activeSeconds: 45 });
  });

  it('rejects an attempt owned by another student', async () => {
    const { db, insert } = timeDb();
    const service = new ExamsService(db);
    const priv = stubAttempt(service);
    jest
      .spyOn(priv, 'loadOwnedAttempt')
      .mockRejectedValue(new NotFoundException('Attempt not found'));

    await expect(
      service.syncQuestionTime(ATTEMPT_ID, USER_ID, 0, 10),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(insert).not.toHaveBeenCalled();
  });

  it('rejects an attempt that is no longer in progress', async () => {
    const { db, insert } = timeDb();
    const service = new ExamsService(db);
    stubAttempt(service, makeContext({ status: 'submitted' }));

    await expect(
      service.syncQuestionTime(ATTEMPT_ID, USER_ID, 0, 10),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(insert).not.toHaveBeenCalled();
  });

  it('rejects a report sent after the exam deadline', async () => {
    const { db, insert } = timeDb();
    const service = new ExamsService(db);
    stubAttempt(
      service,
      makeContext({
        startedAt: new Date(Date.now() - 3_600_000),
        settings: { durationSeconds: 60 },
      }),
    );

    await expect(
      service.syncQuestionTime(ATTEMPT_ID, USER_ID, 0, 10),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(insert).not.toHaveBeenCalled();
  });

  it.each([-1, 1, 42])(
    'rejects out-of-range question index %i',
    async (index) => {
      const { db, insert } = timeDb();
      const service = new ExamsService(db);
      stubAttempt(service);

      await expect(
        service.syncQuestionTime(ATTEMPT_ID, USER_ID, index, 10),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(insert).not.toHaveBeenCalled();
    },
  );

  it('rejects a question that no longer exists', async () => {
    const { db, insert } = timeDb([]);
    const service = new ExamsService(db);
    stubAttempt(service);

    await expect(
      service.syncQuestionTime(ATTEMPT_ID, USER_ID, 0, 10),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(insert).not.toHaveBeenCalled();
  });
});

type FinishPrivates = {
  requireStudentId(userId: string): Promise<string>;
  loadOwnedAttempt(
    executor: unknown,
    attemptId: string,
    studentId: string,
    lock?: boolean,
  ): Promise<AttemptContext>;
};

describe('finishExam with a time-only row', () => {
  it('scores nothing and queues nothing for review', async () => {
    const timeOnlyRow = {
      id: '0f3f3b6e-4d4a-4b8f-9f3c-1b2c3d4e5f60',
      attemptId: ATTEMPT_ID,
      questionId: QUESTION_ID,
      questionVersion: QUESTION_VERSION,
      selectedOption: null,
      textAnswer: null,
      activeSeconds: 90,
      attemptNumber: 1,
      isCorrect: null,
      answeredAt: new Date(),
    };

    const updateWhere = jest.fn(() => Promise.resolve());
    const updateSet = jest.fn(() => ({ where: updateWhere }));
    const txUpdate = jest.fn(() => ({ set: updateSet }));
    const txInsert = jest.fn();
    const tx = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => Promise.resolve([timeOnlyRow])),
        })),
      })),
      update: txUpdate,
      insert: txInsert,
    };
    const db = {
      transaction: jest.fn((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    } as unknown as Db;

    const service = new ExamsService(db);
    const priv = service as unknown as FinishPrivates;
    jest.spyOn(priv, 'requireStudentId').mockResolvedValue(STUDENT_ID);
    jest.spyOn(priv, 'loadOwnedAttempt').mockResolvedValue(makeContext());

    const result = await service.finishExam(ATTEMPT_ID, USER_ID);

    expect(result).toEqual({ totalScore: 0, pendingDescriptive: 0 });
    // Only the attempt row is updated (to submitted); the time-only response
    // row is never graded and nothing is queued for correction.
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(txInsert).not.toHaveBeenCalled();
  });
});

/** Column names referenced by a drizzle SQL node (used to inspect a WHERE). */
function columnsIn(clause: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    const record = node as {
      name?: unknown;
      columnType?: unknown;
      queryChunks?: unknown;
    };
    if (
      typeof record.name === 'string' &&
      typeof record.columnType === 'string'
    ) {
      found.push(record.name);
      return;
    }
    if (Array.isArray(record.queryChunks)) record.queryChunks.forEach(walk);
  };
  walk(clause);
  return found;
}

type CountPrivates = {
  countPriorAttempts(
    studentId: string,
    questionId: string,
    currentAttemptId: string,
  ): Promise<number>;
};

describe('countPriorAttempts (spec 7)', () => {
  function countDb() {
    const whereClauses: unknown[] = [];
    const where = jest.fn((clause: unknown) => {
      whereClauses.push(clause);
      return Promise.resolve([{ count: 2 }]);
    });
    const innerJoin = jest.fn(() => ({ where }));
    const from = jest.fn(() => ({ innerJoin }));
    const select = jest.fn(() => ({ from }));
    return { db: { select } as unknown as Db, whereClauses, innerJoin };
  }

  it('counts only answered rows, not time-only rows from a closed page', async () => {
    const { db, whereClauses } = countDb();
    const service = new ExamsService(db);
    const priv = service as unknown as CountPrivates;

    await expect(
      priv.countPriorAttempts(STUDENT_ID, QUESTION_ID, ATTEMPT_ID),
    ).resolves.toBe(2);

    const columns = columnsIn(whereClauses[0]);
    expect(columns).toEqual(
      expect.arrayContaining(['selected_option', 'text_answer']),
    );
    // ...while still scoping to the student, the question and other attempts.
    expect(columns).toEqual(
      expect.arrayContaining(['student_id', 'question_id', 'attempt_id']),
    );
  });
});

describe('ExamsController time-sync endpoint', () => {
  it('forwards attemptId, user and body to the service', async () => {
    const syncQuestionTime = jest.fn().mockResolvedValue(undefined);
    const controller = new ExamsController({
      syncQuestionTime,
    } as unknown as ExamsService);

    const response = await controller.syncQuestionTime(
      ATTEMPT_ID,
      { userId: USER_ID } as AuthenticatedUser,
      { questionIndex: 3, activeSeconds: 88 },
    );

    expect(syncQuestionTime.mock.calls[0]).toEqual([
      ATTEMPT_ID,
      USER_ID,
      3,
      88,
    ]);
    expect(response).toEqual({ message: 'Time synced' });
  });
});
