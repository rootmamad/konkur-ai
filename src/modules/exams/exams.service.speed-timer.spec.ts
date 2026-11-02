import type { Db } from '../../db/db.module';
import { MAX_EXAM_DURATION_SECONDS } from './exam.constants';
import { QuestionType } from '../questions/enums/question-type.enum';
import type { CountsDto, StartExamDto } from './dto/start-exam.dto';
import type { ExamSession } from './exams.service';
import { ExamsService } from './exams.service';

const STUDENT_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';
const CLIENT_KEY = 'a3f0c1d2-4b5e-4f6a-9b7c-8d9e0f1a2b3c';
const STARTED_AT = new Date('2026-11-02T00:00:00.000Z');

type DtoWithCounts = StartExamDto & {
  counts: CountsDto;
  durationSeconds: number;
};

function makeDto(overrides: Partial<DtoWithCounts> = {}): DtoWithCounts {
  return {
    questionType: QuestionType.MULTIPLE_CHOICE,
    kind: 'speed',
    counts: { easy: 1, normal: 0, hard: 0 },
    durationSeconds: 900,
    ...overrides,
  };
}

type PrivateService = {
  requireStudentId(userId: string): Promise<string>;
  findSessionByKey(key: string): Promise<ExamSession | null>;
  hasPaidPlan(userId: string): Promise<boolean>;
  getSpeedSecondsPerQuestion(): Promise<number>;
  selectQuestionIds(dto: StartExamDto, studentId: string): Promise<string[]>;
};

/** Paid student so the free-quota path stays out of these assertions. */
function setup() {
  const tx = {
    execute: jest.fn(() => Promise.resolve([])),
    insert: jest.fn(() => ({
      values: jest.fn(() => ({
        returning: () =>
          Promise.resolve([{ id: 'row-1', startedAt: STARTED_AT }]),
        then: (resolve: (value?: unknown) => void) => resolve(),
      })),
    })),
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
  jest.spyOn(priv, 'hasPaidPlan').mockResolvedValue(true);
  jest.spyOn(priv, 'selectQuestionIds').mockResolvedValue(['q-1']);

  return { service, priv };
}

describe('ExamsService speed timer', () => {
  it('overrides the client duration with total × seconds-per-question', async () => {
    const { service, priv } = setup();
    const perQuestion = jest
      .spyOn(priv, 'getSpeedSecondsPerQuestion')
      .mockResolvedValue(60);

    const session = await service.startExam(
      'user-1',
      makeDto({
        counts: { easy: 2, normal: 1, hard: 0 },
        durationSeconds: 900,
      }),
      CLIENT_KEY,
    );

    expect(perQuestion).toHaveBeenCalledTimes(1);
    expect(session.durationSeconds).toBe(180);
    expect(session.expiresAt.getTime() - session.startedAt.getTime()).toBe(
      180_000,
    );
  });

  it('caps the speed budget at the global maximum duration', async () => {
    const { service, priv } = setup();
    jest.spyOn(priv, 'getSpeedSecondsPerQuestion').mockResolvedValue(60);

    const session = await service.startExam(
      'user-1',
      makeDto({ counts: { easy: 120, normal: 80, hard: 0 } }),
      CLIENT_KEY,
    );

    // 200 questions × 60s = 12000s, capped at 3 hours.
    expect(session.durationSeconds).toBe(MAX_EXAM_DURATION_SECONDS);
  });

  it('keeps the client duration for non-speed kinds', async () => {
    const { service, priv } = setup();
    const perQuestion = jest.spyOn(priv, 'getSpeedSecondsPerQuestion');

    const session = await service.startExam(
      'user-1',
      makeDto({ kind: 'general_prep', durationSeconds: 900 }),
      CLIENT_KEY,
    );

    expect(session.durationSeconds).toBe(900);
    expect(perQuestion).not.toHaveBeenCalled();
  });

  it('reads seconds-per-question from config and defaults to 60', async () => {
    function serviceWithConfig(rows: unknown[]): ExamsService {
      const limit = jest.fn(() => Promise.resolve(rows));
      const orderBy = jest.fn(() => ({ limit }));
      const where = jest.fn(() => ({ orderBy }));
      const from = jest.fn(() => ({ where }));
      const select = jest.fn(() => ({ from }));
      return new ExamsService({ select } as unknown as Db);
    }

    const getValue = (service: ExamsService) =>
      (service as unknown as PrivateService).getSpeedSecondsPerQuestion();

    await expect(
      getValue(
        serviceWithConfig([{ quotas: { speed_seconds_per_question: 30 } }]),
      ),
    ).resolves.toBe(30);
    await expect(getValue(serviceWithConfig([{ quotas: {} }]))).resolves.toBe(
      60,
    );
    await expect(getValue(serviceWithConfig([]))).resolves.toBe(60);
    await expect(
      getValue(
        serviceWithConfig([{ quotas: { speed_seconds_per_question: '30' } }]),
      ),
    ).resolves.toBe(60);
    await expect(
      getValue(
        serviceWithConfig([{ quotas: { speed_seconds_per_question: 0 } }]),
      ),
    ).resolves.toBe(60);
    await expect(
      getValue(
        serviceWithConfig([{ quotas: { speed_seconds_per_question: -10 } }]),
      ),
    ).resolves.toBe(60);
  });
});
