import type { Db } from '../../db/db.module';
import { QuestionType } from '../questions/enums/question-type.enum';
import type { CountsDto, StartExamDto } from './dto/start-exam.dto';
import { ExamsService } from './exams.service';

const STUDENT_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';

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
 * The selector only touches the database for the two newcomer probes
 * (question_mastery, then response). Pool selectors are stubbed on the service,
 * so `probes` holds one result set per probe, in call order.
 */
function mockDb(probes: string[][] = []): {
  db: Db;
  log: { select: jest.Mock; limits: number[] };
} {
  const limits: number[] = [];
  let call = 0;

  const limit = jest.fn((count: number) => {
    limits.push(count);
    return Promise.resolve((probes[call++] ?? []).map((id) => ({ id })));
  });
  const where = jest.fn(() => ({ limit }));
  const innerJoin = jest.fn(() => ({ where }));
  const from = jest.fn(() => ({ where, innerJoin }));
  const select = jest.fn(() => ({ from }));

  return { db: { select } as unknown as Db, log: { select, limits } };
}

type SmartMixInternals = {
  selectSmartMix(dto: DtoWithCounts, studentId: string): Promise<string[]>;
  selectDueReview: jest.Mock;
  selectDebugErrors: jest.Mock;
  selectTrapFinder: jest.Mock;
  selectGeneralPrep: jest.Mock;
  selectDiagnostic: jest.Mock;
};

function makeService(db: Db): SmartMixInternals {
  const service = new ExamsService(db);
  const internals = service as unknown as SmartMixInternals;
  internals.selectDueReview = jest.fn().mockResolvedValue([]);
  internals.selectDebugErrors = jest.fn().mockResolvedValue([]);
  internals.selectTrapFinder = jest.fn().mockResolvedValue([]);
  internals.selectGeneralPrep = jest.fn().mockResolvedValue([]);
  internals.selectDiagnostic = jest.fn().mockResolvedValue([]);
  return internals;
}

describe('ExamsService smart_mix selection', () => {
  it('treats a student with no mastery rows and no answers as a newcomer and returns the diagnostic', async () => {
    const { db, log } = mockDb([[], []]);
    const internals = makeService(db);
    internals.selectDiagnostic.mockResolvedValue([
      'd-1',
      'd-2',
      'd-3',
      'd-4',
      'd-5',
      'd-6',
      'd-7',
      'd-8',
      'd-9',
      'd-10',
    ]);

    // dto.counts says 2 questions; the newcomer path ignores it entirely.
    const ids = await internals.selectSmartMix(
      makeDto({ counts: { easy: 2, normal: 0, hard: 0 } }),
      STUDENT_ID,
    );

    expect(ids).toHaveLength(10);
    expect(internals.selectDiagnostic).toHaveBeenCalledWith(STUDENT_ID);
    expect(internals.selectDueReview).not.toHaveBeenCalled();
    expect(internals.selectDebugErrors).not.toHaveBeenCalled();
    expect(internals.selectTrapFinder).not.toHaveBeenCalled();
    expect(internals.selectGeneralPrep).not.toHaveBeenCalled();

    // Two cheap existence probes, each limited to a single row.
    expect(log.select).toHaveBeenCalledTimes(2);
    expect(log.limits).toEqual([1, 1]);
  });

  it('is not a newcomer once the student has any mastery row', async () => {
    const { db, log } = mockDb([['m-1']]);
    const internals = makeService(db);

    await internals.selectSmartMix(makeDto(), STUDENT_ID);

    expect(log.select).toHaveBeenCalledTimes(1);
    expect(internals.selectDiagnostic).not.toHaveBeenCalled();
  });

  it('includes a question that appears in two pools exactly once', async () => {
    const { db } = mockDb([['m-1']]);
    const internals = makeService(db);
    internals.selectDueReview.mockResolvedValue(['a', 'b']);
    internals.selectDebugErrors.mockResolvedValue(['b', 'c']);
    internals.selectTrapFinder.mockResolvedValue(['a', 'c']);
    internals.selectGeneralPrep.mockResolvedValue(['d', 'e', 'f', 'g', 'b']);

    const ids = await internals.selectSmartMix(
      makeDto({ counts: { easy: 7, normal: 0, hard: 0 } }),
      STUDENT_ID,
    );

    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === 'a')).toHaveLength(1);
    expect(ids.filter((id) => id === 'b')).toHaveLength(1);
    expect(ids.filter((id) => id === 'c')).toHaveLength(1);
  });

  it('tops up short pools from general prep so the count reaches the total', async () => {
    const { db } = mockDb([['m-1']]);
    const internals = makeService(db);
    internals.selectDueReview.mockResolvedValue(['q-1']);
    internals.selectDebugErrors.mockResolvedValue([]);
    internals.selectTrapFinder.mockResolvedValue([]);
    internals.selectGeneralPrep.mockResolvedValue([
      'q-2',
      'q-3',
      'q-4',
      'q-5',
      'q-6',
    ]);

    const ids = await internals.selectSmartMix(
      makeDto({ counts: { easy: 4, normal: 0, hard: 0 } }),
      STUDENT_ID,
    );

    expect(ids).toHaveLength(4);
    expect(new Set(ids)).toEqual(new Set(['q-1', 'q-2', 'q-3', 'q-4']));
    expect(internals.selectGeneralPrep).toHaveBeenCalledWith(
      expect.objectContaining({ counts: { easy: 3, normal: 0, hard: 0 } }),
      STUDENT_ID,
    );
  });

  it('returns unique ids between 1 and the requested total for a returning student', async () => {
    const { db } = mockDb([['m-1']]);
    const internals = makeService(db);
    internals.selectDueReview.mockResolvedValue(['a']);
    internals.selectDebugErrors.mockResolvedValue(['b']);
    internals.selectTrapFinder.mockResolvedValue(['b']);
    internals.selectGeneralPrep.mockResolvedValue(['c']);

    const ids = await internals.selectSmartMix(
      makeDto({ counts: { easy: 3, normal: 1, hard: 1 } }),
      STUDENT_ID,
    );

    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids.length).toBeLessThanOrEqual(5);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('asks each pool for floor(ratio * total) easy questions', async () => {
    const { db } = mockDb([['m-1']]);
    const internals = makeService(db);

    await internals.selectSmartMix(
      makeDto({ counts: { easy: 4, normal: 3, hard: 3 } }),
      STUDENT_ID,
    );

    // total = 10 -> 0.4 -> 4, 0.3 -> 3, 0.3 -> 3
    expect(internals.selectDueReview).toHaveBeenCalledWith(
      expect.objectContaining({ counts: { easy: 4, normal: 0, hard: 0 } }),
      STUDENT_ID,
    );
    expect(internals.selectDebugErrors).toHaveBeenCalledWith(
      expect.objectContaining({ counts: { easy: 3, normal: 0, hard: 0 } }),
      STUDENT_ID,
    );
    expect(internals.selectTrapFinder).toHaveBeenCalledWith(
      expect.objectContaining({ counts: { easy: 3, normal: 0, hard: 0 } }),
      STUDENT_ID,
    );
    // All pools came back empty, so the remainder is general prep.
    expect(internals.selectGeneralPrep).toHaveBeenCalledWith(
      expect.objectContaining({ counts: { easy: 10, normal: 0, hard: 0 } }),
      STUDENT_ID,
    );
  });

  it('skips a pool whose floored quota is zero', async () => {
    const { db } = mockDb([['m-1']]);
    const internals = makeService(db);

    // total = 2 -> floor(0.4 * 2) = 0, floor(0.3 * 2) = 0
    await internals.selectSmartMix(
      makeDto({ counts: { easy: 2, normal: 0, hard: 0 } }),
      STUDENT_ID,
    );

    expect(internals.selectDueReview).not.toHaveBeenCalled();
    expect(internals.selectDebugErrors).not.toHaveBeenCalled();
    expect(internals.selectTrapFinder).not.toHaveBeenCalled();
    expect(internals.selectGeneralPrep).toHaveBeenCalledWith(
      expect.objectContaining({ counts: { easy: 2, normal: 0, hard: 0 } }),
      STUDENT_ID,
    );
  });
});
