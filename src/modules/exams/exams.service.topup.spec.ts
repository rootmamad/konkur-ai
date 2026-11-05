import type { Db, Tx } from '../../db/db.module';
import { QuestionType } from '../questions/enums/question-type.enum';
import type { CountsDto, StartExamDto } from './dto/start-exam.dto';
import { ExamsService } from './exams.service';
import { QuestionDrafterService } from '../ai/question-drafter.service';

/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/unbound-method */

const STUDENT_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';
const USER_ID = 'user-1';
const CLIENT_KEY = 'a3f0c1d2-4b5e-4f6a-9b7c-8d9e0f1a2b3c';

type DtoWithCounts = StartExamDto & {
  counts: CountsDto;
  durationSeconds: number;
};

function makeDto(overrides: Partial<DtoWithCounts> = {}): DtoWithCounts {
  return {
    questionType: QuestionType.MULTIPLE_CHOICE,
    kind: 'smart_mix',
    counts: { easy: 10, normal: 0, hard: 0 },
    durationSeconds: 600,
    ...overrides,
  };
}

/**
 * Mock DB for startExam with transaction support.
 */
type MockTx = {
  select: ReturnType<typeof jest.fn>;
  insert: ReturnType<typeof jest.fn>;
  execute: ReturnType<typeof jest.fn>;
};

type MockDb = {
  select: ReturnType<typeof jest.fn>;
  transaction: ReturnType<typeof jest.fn>;
};

function mockDbWithTransaction(
  selectQuestionIdsResult: string[] = ['q-1', 'q-2'],
): {
  db: MockDb;
  tx: MockTx;
  transaction: ReturnType<typeof jest.fn>;
} {
  // Mock transaction
  let insertCall = 0;
  const tx: MockTx = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          orderBy: jest.fn(() => ({
            limit: jest.fn(() =>
              Promise.resolve(selectQuestionIdsResult.map((id) => ({ id }))),
            ),
          })),
          limit: jest.fn(() => Promise.resolve([{ id: 'template-id' }])),
        })),
      })),
    })),
    insert: jest.fn(() => ({
      values: jest.fn(() => {
        insertCall += 1;
        // Always return attempt-like result for the last insert (attempt)
        // The attempt insert is the second insert (after examInstance)
        if (insertCall >= 2) {
          return {
            returning: jest.fn(() =>
              Promise.resolve([{ id: 'attempt-id', startedAt: new Date() }]),
            ),
          };
        }
        // examInstance insert
        return {
          returning: jest.fn(() =>
            Promise.resolve([{ id: 'exam-instance-id' }]),
          ),
        };
      }),
    })),
    execute: jest.fn(() => Promise.resolve([])),
  };

  const transaction = jest.fn(async (fn: (t: Tx) => Promise<unknown>) =>
    fn(tx),
  );

  // Mock select for the two newcomer probes (question_mastery, response)
  let probeCall = 0;
  const probeResults = [['m-1'], []]; // has mastery row, no responses
  const limit = jest.fn(() =>
    Promise.resolve((probeResults[probeCall++] ?? []).map((id) => ({ id }))),
  );
  const where = jest.fn(() => ({ limit }));
  const innerJoin = jest.fn(() => ({ where }));
  const from = jest.fn(() => ({ where, innerJoin }));
  const select = jest.fn(() => ({ from }));

  const db: MockDb = { select, transaction };

  return { db, tx, transaction };
}

type ExamsInternals = {
  selectQuestionIds: (
    dto: DtoWithCounts,
    studentId: string,
  ) => Promise<string[]>;
  selectSmartMix: (dto: DtoWithCounts, studentId: string) => Promise<string[]>;
  selectDueReview: (dto: DtoWithCounts, studentId: string) => Promise<string[]>;
  selectDebugErrors: (
    dto: DtoWithCounts,
    studentId: string,
  ) => Promise<string[]>;
  selectTrapFinder: (
    dto: DtoWithCounts,
    studentId: string,
  ) => Promise<string[]>;
  selectGeneralPrep: (
    dto: DtoWithCounts,
    studentId: string,
  ) => Promise<string[]>;
  selectDiagnostic: (studentId: string) => Promise<string[]>;
  selectKonkurSim: (studentId: string) => Promise<string[]>;
  selectFinalSim: (studentId: string) => Promise<string[]>;
  selectSpeed: (dto: DtoWithCounts, studentId: string) => Promise<string[]>;
  selectAfterStudy: (
    dto: DtoWithCounts,
    studentId: string,
  ) => Promise<string[]>;
  selectQuizAfterStudy: (
    dto: DtoWithCounts,
    studentId: string,
  ) => Promise<string[]>;
  requireStudentId: (userId: string) => Promise<string>;
  findSessionByKey: (key: string) => Promise<ExamSession | null>;
  hasPaidPlan: (userId: string) => Promise<boolean>;
  getFreeQuizLimit: () => Promise<number>;
  countQuizUsage: (studentId: string) => Promise<number>;
  startExam: (
    userId: string,
    dto: StartExamDto,
    clientKey: string,
  ) => Promise<ExamSession>;
};

interface ExamSession {
  attemptId: string;
  questionOrder: string[];
  durationSeconds: number;
  startedAt: Date;
  expiresAt: Date;
  serverTime: Date;
}

function makeService(
  db: MockDb,
  drafter?: QuestionDrafterService,
): ExamsInternals {
  const service = new ExamsService(db as unknown as Db, drafter);
  const internals = service as unknown as ExamsInternals;
  // Mock pool selectors with proper function types
  internals.selectSmartMix = jest
    .fn<(dto: DtoWithCounts, studentId: string) => Promise<string[]>>()
    .mockResolvedValue([]);
  internals.selectDueReview = jest
    .fn<(dto: DtoWithCounts, studentId: string) => Promise<string[]>>()
    .mockResolvedValue([]);
  internals.selectDebugErrors = jest
    .fn<(dto: DtoWithCounts, studentId: string) => Promise<string[]>>()
    .mockResolvedValue([]);
  internals.selectTrapFinder = jest
    .fn<(dto: DtoWithCounts, studentId: string) => Promise<string[]>>()
    .mockResolvedValue([]);
  internals.selectGeneralPrep = jest
    .fn<(dto: DtoWithCounts, studentId: string) => Promise<string[]>>()
    .mockResolvedValue([]);
  internals.selectDiagnostic = jest
    .fn<(studentId: string) => Promise<string[]>>()
    .mockResolvedValue([]);
  internals.selectKonkurSim = jest
    .fn<(studentId: string) => Promise<string[]>>()
    .mockResolvedValue([]);
  internals.selectFinalSim = jest
    .fn<(studentId: string) => Promise<string[]>>()
    .mockResolvedValue([]);
  internals.selectSpeed = jest
    .fn<(dto: DtoWithCounts, studentId: string) => Promise<string[]>>()
    .mockResolvedValue([]);
  internals.selectAfterStudy = jest
    .fn<(dto: DtoWithCounts, studentId: string) => Promise<string[]>>()
    .mockResolvedValue([]);
  internals.selectQuizAfterStudy = jest
    .fn<(dto: DtoWithCounts, studentId: string) => Promise<string[]>>()
    .mockResolvedValue([]);
  // Bind startExam to the service instance so it's callable with proper `this`
  internals.startExam = service.startExam.bind(
    service,
  ) as ExamsInternals['startExam'];
  // Mock private methods used by startExam
  internals.requireStudentId = jest
    .fn<(userId: string) => Promise<string>>()
    .mockResolvedValue(STUDENT_ID);
  internals.findSessionByKey = jest
    .fn<(key: string) => Promise<ExamSession | null>>()
    .mockResolvedValue(null);
  internals.hasPaidPlan = jest
    .fn<(userId: string) => Promise<boolean>>()
    .mockResolvedValue(false);
  internals.getFreeQuizLimit = jest
    .fn<() => Promise<number>>()
    .mockResolvedValue(3);
  internals.countQuizUsage = jest
    .fn<(studentId: string) => Promise<number>>()
    .mockResolvedValue(0);
  return internals;
}

function makeDrafterMock(): jest.Mocked<QuestionDrafterService> {
  return {
    topUpForShortage: jest.fn().mockResolvedValue(undefined),
    generateDraftsForStudent: jest
      .fn()
      .mockResolvedValue({ created: 0, published: 0, deferred: 0 }),
    mutateQuestion: jest
      .fn()
      .mockResolvedValue({ created: 0, published: 0, deferred: 0 }),
    verifyDraft: jest.fn().mockResolvedValue(null),
    historyContext: {} as never,
    db: {} as never,
    ai: {} as never,
    logger: {} as never,
  } as unknown as jest.Mocked<QuestionDrafterService>;
}

describe('ExamsService AI top-up (fire-and-forget)', () => {
  it('d) smart_mix selection short -> drafter.topUpForShortage called with studentId, startExam returns normally', async () => {
    const { db, transaction } = mockDbWithTransaction(['q-1', 'q-2']); // short: 2 questions
    const drafter = makeDrafterMock();
    const internals = makeService(db, drafter);

    // Smart mix returns fewer questions than requested (short)
    internals.selectSmartMix.mockResolvedValue(['q-1', 'q-2']); // only 2 questions
    internals.selectDueReview.mockResolvedValue(['q-1']);
    internals.selectDebugErrors.mockResolvedValue([]);
    internals.selectTrapFinder.mockResolvedValue([]);
    internals.selectGeneralPrep.mockResolvedValue([]);

    const dto = makeDto({ counts: { easy: 5, normal: 0, hard: 0 } }); // requests 5

    // Call startExam (public method) - this is where the top-up is triggered
    const session = await internals.startExam(USER_ID, dto, CLIENT_KEY);

    // startExam should return normally (not await the top-up)
    expect(session).toBeDefined();
    expect(session.attemptId).toBeDefined();
    expect(session.questionOrder).toHaveLength(2);
    // Transaction should have been called
    expect(transaction).toHaveBeenCalledTimes(1);
    // Drafter topUpForShortage should have been called with studentId (fire-and-forget)
    expect(drafter.topUpForShortage).toHaveBeenCalledWith(STUDENT_ID);
    expect(drafter.topUpForShortage).toHaveBeenCalledTimes(1);
  });

  it('e) smart_mix selection full (>= requested) -> topUpForShortage NOT called', async () => {
    const { db, transaction } = mockDbWithTransaction([
      'q-1',
      'q-2',
      'q-3',
      'q-4',
      'q-5',
    ]); // full: 5 questions
    const drafter = makeDrafterMock();
    const internals = makeService(db, drafter);

    // Smart mix returns exactly the requested count
    internals.selectSmartMix.mockResolvedValue([
      'q-1',
      'q-2',
      'q-3',
      'q-4',
      'q-5',
    ]);
    internals.selectDueReview.mockResolvedValue([
      'q-1',
      'q-2',
      'q-3',
      'q-4',
      'q-5',
    ]);
    internals.selectDebugErrors.mockResolvedValue([]);
    internals.selectTrapFinder.mockResolvedValue([]);
    internals.selectGeneralPrep.mockResolvedValue([]);

    const dto = makeDto({ counts: { easy: 5, normal: 0, hard: 0 } });

    await internals.startExam(USER_ID, dto, CLIENT_KEY);

    expect(drafter.topUpForShortage).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('f) non-smart_mix kind short -> topUpForShortage NOT called', async () => {
    const { db, transaction } = mockDbWithTransaction(['q-1']); // short: 1 question
    const drafter = makeDrafterMock();
    const internals = makeService(db, drafter);

    // Use a different kind (e.g., general_prep) that returns short
    internals.selectGeneralPrep.mockResolvedValue(['q-1']); // only 1 question
    internals.selectDiagnostic.mockResolvedValue([]);

    const dto = makeDto({
      kind: 'general_prep',
      counts: { easy: 5, normal: 0, hard: 0 },
    });

    await internals.startExam(USER_ID, dto, CLIENT_KEY);

    expect(drafter.topUpForShortage).not.toHaveBeenCalled();
    expect(internals.selectGeneralPrep).toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('g) drafter undefined (new ExamsService(db)) -> no crash, top-up simply skipped', async () => {
    const { db, transaction } = mockDbWithTransaction(['q-1']); // short
    // Construct without drafter (as specs do)
    const internals = makeService(db, undefined);

    internals.selectSmartMix.mockResolvedValue(['q-1']); // short
    internals.selectDueReview.mockResolvedValue(['q-1']);
    internals.selectDebugErrors.mockResolvedValue([]);
    internals.selectTrapFinder.mockResolvedValue([]);
    internals.selectGeneralPrep.mockResolvedValue([]);

    const dto = makeDto({ counts: { easy: 5, normal: 0, hard: 0 } });

    // Should not throw even though drafter is undefined
    await expect(
      internals.startExam(USER_ID, dto, CLIENT_KEY),
    ).resolves.toBeDefined();
    expect(transaction).toHaveBeenCalledTimes(1);
    // No drafter to call, so no error
  });
});
