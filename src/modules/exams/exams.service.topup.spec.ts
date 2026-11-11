import type { Db } from '../../db/db.module';
import { QuestionType } from '../questions/enums/question-type.enum';
import type { CountsDto, StartExamDto } from './dto/start-exam.dto';
import { ExamsService } from './exams.service';
import { QuestionDrafterService } from '../ai/question-drafter.service';

/* eslint-disable @typescript-eslint/unbound-method */

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
 * Helper to wait for an async condition (polling).
 */
function waitFor(
  callback: () => void,
  options: { timeout: number; interval: number } = {
    timeout: 1000,
    interval: 10,
  },
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        callback();
        resolve();
      } catch (e) {
        if (Date.now() - start > options.timeout) {
          reject(e instanceof Error ? e : new Error(String(e)));
        } else {
          setTimeout(check, options.interval);
        }
      }
    };
    check();
  });
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
  weakTopicIds: string[] = ['wt-1'],
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

  const transaction = jest.fn(async (fn: (t: MockTx) => Promise<unknown>) =>
    fn(tx),
  );

  // Mock select for:
  // 1. Two newcomer probes (question_mastery, then response)
  // 2. getWeakTopicIds (questionMastery innerJoin question)
  // 3. selectAIGenPool (question with origin='ai' filter) - returns empty for top-up test
  let probeCall = 0;
  const probeResults = [
    ['m-1'], // mastery probe
    [], // response probe (empty)
    weakTopicIds, // getWeakTopicIds
    [], // selectAIGenPool - empty to trigger top-up
  ];
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

/** Pool selectors are jest mocks: callable by startExam and assertable here. */
type PoolSelector = jest.Mock<Promise<string[]>, [DtoWithCounts, string]>;
type StudentSelector = jest.Mock<Promise<string[]>, [string]>;

type ExamsInternals = {
  selectQuestionIds: (
    dto: DtoWithCounts,
    studentId: string,
  ) => Promise<string[]>;
  selectSmartMix: PoolSelector;
  selectDueReview: PoolSelector;
  selectDebugErrors: PoolSelector;
  selectTrapFinder: PoolSelector;
  selectGeneralPrep: PoolSelector;
  selectDiagnostic: StudentSelector;
  selectKonkurSim: StudentSelector;
  selectFinalSim: StudentSelector;
  selectSpeed: PoolSelector;
  selectAfterStudy: PoolSelector;
  selectQuizAfterStudy: PoolSelector;
  requireStudentId: jest.Mock<Promise<string>, [string]>;
  findSessionByKey: jest.Mock<Promise<ExamSession | null>, [string]>;
  hasPaidPlan: jest.Mock<Promise<boolean>, [string]>;
  getFreeQuizLimit: jest.Mock<Promise<number>, []>;
  getFreeQuizMaxQuestions: jest.Mock<Promise<number>, []>;
  countQuizUsage: jest.Mock<Promise<number>, [string]>;
  getWeakTopicIds: (studentId: string) => Promise<string[]>;
  maybeMutateForPersistentShortage: (
    studentId: string,
    questionType: QuestionType,
  ) => void;
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
    .fn<Promise<string[]>, [DtoWithCounts, string]>()
    .mockResolvedValue([]);
  internals.selectDueReview = jest
    .fn<Promise<string[]>, [DtoWithCounts, string]>()
    .mockResolvedValue([]);
  internals.selectDebugErrors = jest
    .fn<Promise<string[]>, [DtoWithCounts, string]>()
    .mockResolvedValue([]);
  internals.selectTrapFinder = jest
    .fn<Promise<string[]>, [DtoWithCounts, string]>()
    .mockResolvedValue([]);
  internals.selectGeneralPrep = jest
    .fn<Promise<string[]>, [DtoWithCounts, string]>()
    .mockResolvedValue([]);
  internals.selectDiagnostic = jest
    .fn<Promise<string[]>, [string]>()
    .mockResolvedValue([]);
  internals.selectKonkurSim = jest
    .fn<Promise<string[]>, [string]>()
    .mockResolvedValue([]);
  internals.selectFinalSim = jest
    .fn<Promise<string[]>, [string]>()
    .mockResolvedValue([]);
  internals.selectSpeed = jest
    .fn<Promise<string[]>, [DtoWithCounts, string]>()
    .mockResolvedValue([]);
  internals.selectAfterStudy = jest
    .fn<Promise<string[]>, [DtoWithCounts, string]>()
    .mockResolvedValue([]);
  internals.selectQuizAfterStudy = jest
    .fn<Promise<string[]>, [DtoWithCounts, string]>()
    .mockResolvedValue([]);
  // Bind startExam to the service instance so it's callable with proper `this`
  internals.startExam = service.startExam.bind(
    service,
  ) as ExamsInternals['startExam'];
  // Mock private methods used by startExam
  internals.requireStudentId = jest
    .fn<Promise<string>, [string]>()
    .mockResolvedValue(STUDENT_ID);
  internals.findSessionByKey = jest
    .fn<Promise<ExamSession | null>, [string]>()
    .mockResolvedValue(null);
  internals.hasPaidPlan = jest
    .fn<Promise<boolean>, [string]>()
    .mockResolvedValue(false);
  internals.getFreeQuizLimit = jest
    .fn<Promise<number>, []>()
    .mockResolvedValue(3);
  internals.getFreeQuizMaxQuestions = jest
    .fn<Promise<number>, []>()
    .mockResolvedValue(10);
  internals.countQuizUsage = jest
    .fn<Promise<number>, [string]>()
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

  // ---- Task 8 spec coverage ----

  it('e) Mutation-fill heuristic: (i) no published origin-ai for weak topics -> drafter.mutateQuestion called (≥1 call), startExam returned normally; (ii) published origin-ai exists -> mutateQuestion NOT called; 3-question cap respected', async () => {
    // Part (i): No published origin-ai for weak topics -> mutation fires
    {
      const weakTopicIds = ['wt-1', 'wt-2'];
      const { db: db1 } = mockDbWithTransaction(['q-1', 'q-2'], weakTopicIds);

      const drafter1 = makeDrafterMock();
      const internals1 = makeService(db1, drafter1);

      // Override the select mock for the heuristic's internal queries
      // Probe sequence for maybeMutateForPersistentShortage:
      // 1. getWeakTopicIds -> ['wt-1', 'wt-2']
      // 2. anyPublishedAI check -> [] (empty, no published AI)
      // 3. bank questions for mutation -> ['bank-1', 'bank-2', 'bank-3', 'bank-4']
      let probeCall1 = 0;
      // Row shapes must match the select projections: getWeakTopicIds selects
      // { topicId }, while the AI/bank probes select { id }.
      const probeResults1: Array<Array<{ id?: string; topicId?: string }>> = [
        [{ topicId: 'wt-1' }, { topicId: 'wt-2' }], // 1. getWeakTopicIds
        [], // 2. anyPublishedAI check - empty
        [
          { id: 'bank-1' },
          { id: 'bank-2' },
          { id: 'bank-3' },
          { id: 'bank-4' },
        ], // 3. bank questions
      ];
      // Emulate SQL LIMIT so the 3-question cap is applied by the query itself.
      const limit1 = jest.fn((n?: number) =>
        Promise.resolve((probeResults1[probeCall1++] ?? []).slice(0, n)),
      );
      const orderBy1 = jest.fn(() => ({ limit: limit1 }));
      const where1 = jest.fn(() => ({ limit: limit1, orderBy: orderBy1 }));
      const innerJoin1 = jest.fn(() => ({ where: where1 }));
      const from1 = jest.fn(() => ({ where: where1, innerJoin: innerJoin1 }));
      const select1 = jest.fn(() => ({ from: from1 }));
      (db1 as unknown as { select: jest.Mock }).select = select1;

      // Call the private method directly (bound to the mocked internals)
      internals1.maybeMutateForPersistentShortage(
        STUDENT_ID,
        QuestionType.MULTIPLE_CHOICE,
      );

      // Poll for mutation to be called (fire-and-forget async)
      await waitFor(() => expect(drafter1.mutateQuestion).toHaveBeenCalled(), {
        timeout: 1000,
        interval: 10,
      });

      // mutateQuestion should be called at least once (up to 3 times)
      expect(drafter1.mutateQuestion).toHaveBeenCalled();
      const mutateCalls1 = drafter1.mutateQuestion.mock.calls.length;
      expect(mutateCalls1).toBeGreaterThanOrEqual(1);
      expect(mutateCalls1).toBeLessThanOrEqual(3); // 3-question cap
    }

    // Part (ii): Published origin-ai exists -> mutation NOT called
    {
      const weakTopicIds2 = ['wt-1'];
      const { db: db2 } = mockDbWithTransaction(['q-1', 'q-2'], weakTopicIds2);

      const drafter2 = makeDrafterMock();
      const internals2 = makeService(db2, drafter2);

      // Probe sequence:
      // 1. getWeakTopicIds -> ['wt-1']
      // 2. anyPublishedAI check -> ['ai-1'] (finds published AI)
      // 3. bank questions -> (not reached)
      let probeCall2 = 0;
      const probeResults2: Array<Array<{ id?: string; topicId?: string }>> = [
        [{ topicId: 'wt-1' }], // 1. getWeakTopicIds
        [{ id: 'ai-1' }], // 2. anyPublishedAI check - finds published AI
        [{ id: 'bank-1' }, { id: 'bank-2' }, { id: 'bank-3' }], // 3. bank questions (not reached)
      ];
      const limit2 = jest.fn((n?: number) =>
        Promise.resolve((probeResults2[probeCall2++] ?? []).slice(0, n)),
      );
      const orderBy2 = jest.fn(() => ({ limit: limit2 }));
      const where2 = jest.fn(() => ({ limit: limit2, orderBy: orderBy2 }));
      const innerJoin2 = jest.fn(() => ({ where: where2 }));
      const from2 = jest.fn(() => ({ where: where2, innerJoin: innerJoin2 }));
      const select2 = jest.fn(() => ({ from: from2 }));
      (db2 as unknown as { select: jest.Mock }).select = select2;

      internals2.maybeMutateForPersistentShortage(
        STUDENT_ID,
        QuestionType.MULTIPLE_CHOICE,
      );

      // Give time for the async function to complete and check anyPublishedAI
      await new Promise((r) => setTimeout(r, 50));

      // mutateQuestion should NOT be called because published AI exists
      expect(drafter2.mutateQuestion).not.toHaveBeenCalled();
    }
  });
});
