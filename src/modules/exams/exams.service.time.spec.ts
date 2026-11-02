import { ExamsController } from './exams.controller';
import type { Db } from '../../db/db.module';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { QuestionType } from '../questions/enums/question-type.enum';
import { ExamsService } from './exams.service';

const ATTEMPT_ID = '2f1c6a4e-8b3d-4c5f-9a7e-1d2b3c4e5f60';
const USER_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const STUDENT_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';
const QUESTION_ID = '7c6d5e4f-3a2b-4c1d-9e8f-7a6b5c4d3e2f';

type AttemptContext = {
  id: string;
  status: string;
  startedAt: Date;
  submittedAt: Date | null;
  totalScore: number | null;
  questionOrder: string[];
  settings: { durationSeconds: number };
};

function makeContext(): AttemptContext {
  return {
    id: ATTEMPT_ID,
    status: 'in_progress',
    startedAt: new Date(),
    submittedAt: null,
    totalScore: null,
    questionOrder: [QUESTION_ID],
    settings: { durationSeconds: 600 },
  };
}

type SavedAnswer = {
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
};

/**
 * Mock DB for the answer upsert: the first select returns the question row,
 * the second the answer key row.
 */
function answerDb() {
  const saved: SavedAnswer = {};
  let selectCall = 0;

  const limit = jest.fn(() => {
    selectCall += 1;
    return Promise.resolve(
      selectCall % 2 === 1
        ? [
            {
              version: 3,
              type: QuestionType.MULTIPLE_CHOICE,
              options: [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }],
            },
          ]
        : [{ correctOptionIndex: 1 }],
    );
  });
  const where = jest.fn(() => ({ limit }));
  const from = jest.fn(() => ({ where }));
  const select = jest.fn(() => ({ from }));

  const insert = jest.fn(() => ({
    values: jest.fn((values: Record<string, unknown>) => {
      saved.values = values;
      return {
        onConflictDoUpdate: jest.fn((arg: { set: Record<string, unknown> }) => {
          saved.set = arg.set;
          return Promise.resolve();
        }),
      };
    }),
  }));

  return { db: { select, insert } as unknown as Db, saved };
}

type PrivateService = {
  requireStudentId(userId: string): Promise<string>;
  loadOwnedAttempt(
    executor: unknown,
    attemptId: string,
    studentId: string,
    lock?: boolean,
  ): Promise<AttemptContext>;
  countPriorAttempts(
    studentId: string,
    questionId: string,
    attemptId: string,
  ): Promise<number>;
  recordAnswerOutcome(
    executor: unknown,
    studentId: string,
    questionId: string,
    isCorrect: boolean,
    answeredAt: Date,
  ): Promise<void>;
};

function stubAttempt(service: ExamsService): void {
  const priv = service as unknown as PrivateService;
  jest.spyOn(priv, 'requireStudentId').mockResolvedValue(STUDENT_ID);
  jest.spyOn(priv, 'loadOwnedAttempt').mockResolvedValue(makeContext());
  jest.spyOn(priv, 'countPriorAttempts').mockResolvedValue(0);
  jest.spyOn(priv, 'recordAnswerOutcome').mockResolvedValue();
}

describe('ExamsService per-question active time', () => {
  it('stores the submitted cumulative activeSeconds on a new answer', async () => {
    const { db, saved } = answerDb();
    const service = new ExamsService(db);
    stubAttempt(service);

    await service.submitAnswer(ATTEMPT_ID, USER_ID, 0, 1, 42);

    expect(saved.values).toMatchObject({
      attemptId: ATTEMPT_ID,
      questionId: QUESTION_ID,
      selectedOption: 1,
      activeSeconds: 42,
    });
    // Overwrite path (retry/answer change) keeps the same absolute value.
    expect(saved.set).toMatchObject({ selectedOption: 1, activeSeconds: 42 });
  });

  it('overwrites activeSeconds on a repeat save of the same answer', async () => {
    const { db, saved } = answerDb();
    const service = new ExamsService(db);
    stubAttempt(service);

    await service.submitAnswer(ATTEMPT_ID, USER_ID, 0, 1, 20);
    await service.submitAnswer(ATTEMPT_ID, USER_ID, 0, 1, 95);

    expect(saved.values).toMatchObject({ activeSeconds: 95 });
    expect(saved.set).toMatchObject({ activeSeconds: 95 });
  });

  it('defaults activeSeconds to 0 when the client omits it', async () => {
    const { db, saved } = answerDb();
    const service = new ExamsService(db);
    stubAttempt(service);

    await service.submitAnswer(ATTEMPT_ID, USER_ID, 0, 1);

    expect(saved.values).toMatchObject({ activeSeconds: 0 });
    expect(saved.set).toMatchObject({ activeSeconds: 0 });
  });

  it('exposes activeSeconds in the attempt report', async () => {
    const rows = [
      {
        questionId: QUESTION_ID,
        selectedOption: 1,
        textAnswer: null,
        activeSeconds: 7,
        isCorrect: true,
        answeredAt: new Date(),
      },
    ];
    const selectedFields: Record<string, unknown>[] = [];
    const select = jest.fn((fields: Record<string, unknown>) => {
      selectedFields.push(fields);
      return {
        from: jest.fn(() => ({ where: jest.fn(() => Promise.resolve(rows)) })),
      };
    });
    const service = new ExamsService({ select } as unknown as Db);
    stubAttempt(service);

    const attempt = await service.getExamAttempt(ATTEMPT_ID, USER_ID);

    expect(attempt.responses).toHaveLength(1);
    expect(attempt.responses[0].activeSeconds).toBe(7);
    expect(Object.keys(selectedFields[0])).toContain('activeSeconds');
  });

  it('passes activeSeconds from the request body to the service', async () => {
    const submitAnswer = jest.fn().mockResolvedValue(undefined);
    const controller = new ExamsController({
      submitAnswer,
    } as unknown as ExamsService);

    await controller.submitAnswer(
      ATTEMPT_ID,
      { userId: USER_ID } as AuthenticatedUser,
      { questionIndex: 0, answer: 1, activeSeconds: 33 },
    );

    expect(submitAnswer.mock.calls[0]).toEqual([ATTEMPT_ID, USER_ID, 0, 1, 33]);
  });
});
