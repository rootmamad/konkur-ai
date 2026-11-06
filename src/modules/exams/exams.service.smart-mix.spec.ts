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
 * The selector touches the database for:
 * 1. Newcomer probes: mastery probe (always), response probe (only if no mastery)
 * 2. getWeakTopicIds (questionMastery innerJoin question)
 * Pool selectors are stubbed on the service.
 */
function mockDb(
  probes: string[][] = [],
  weakTopicProbe: string[] = ['wt-1'],
): {
  db: Db;
  log: { select: jest.Mock; limits: number[] };
} {
  const limits: number[] = [];
  let call = 0;
  let masteryFound = false;

  const limit = jest.fn((count: number) => {
    limits.push(count);
    // First call is always mastery probe
    if (call === 0) {
      const result = (probes[0] ?? []).map((id) => ({ id }));
      masteryFound = result.length > 0;
      call++;
      return Promise.resolve(result);
    }
    // Second call: response probe ONLY if no mastery, otherwise getWeakTopicIds
    if (call === 1) {
      if (!masteryFound) {
        // No mastery -> response probe
        const result = (probes[1] ?? []).map((id) => ({ id }));
        call++;
        return Promise.resolve(result);
      }
      // Has mastery -> skip response, go straight to getWeakTopicIds
      const result = weakTopicProbe.map((id) => ({ topicId: id }));
      call++;
      return Promise.resolve(result);
    }
    // Third call: getWeakTopicIds (only reached if no mastery)
    const result = weakTopicProbe.map((id) => ({ topicId: id }));
    call++;
    return Promise.resolve(result);
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
  selectAIGenPool: jest.Mock;
};

function makeService(db: Db): SmartMixInternals {
  const service = new ExamsService(db);
  const internals = service as unknown as SmartMixInternals;
  internals.selectDueReview = jest.fn().mockResolvedValue([]);
  internals.selectDebugErrors = jest.fn().mockResolvedValue([]);
  internals.selectTrapFinder = jest.fn().mockResolvedValue([]);
  internals.selectGeneralPrep = jest.fn().mockResolvedValue([]);
  internals.selectDiagnostic = jest.fn().mockResolvedValue([]);
  internals.selectAIGenPool = jest.fn().mockResolvedValue([]);
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
    // (Newcomer path returns early, doesn't call getWeakTopicIds)
    expect(log.select).toHaveBeenCalledTimes(2);
    expect(log.limits).toEqual([1, 1]);
  });

  it('is not a newcomer once the student has any mastery row', async () => {
    const { db, log } = mockDb([['m-1']]);
    const internals = makeService(db);

    await internals.selectSmartMix(makeDto(), STUDENT_ID);

    // Non-newcomer with mastery: 1 mastery probe (response probe skipped) + 1 getWeakTopicIds = 2 select calls
    expect(log.select).toHaveBeenCalledTimes(2);
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

  // ---- Task 8 spec coverage ----

  it('a) AIGEN first + dedupe: weak topics present and selectAIGenPool returns ids -> both in final exactly once, called with AI_MAX_SHARE quota', async () => {
    const { db } = mockDb([['m-1']]);
    const internals = makeService(db);

    internals.selectAIGenPool.mockResolvedValue(['ai-1', 'ai-2']);
    internals.selectDueReview.mockResolvedValue(['ai-1', 'due-1']);
    internals.selectDebugErrors.mockResolvedValue(['err-1']);
    internals.selectTrapFinder.mockResolvedValue(['trap-1']);
    internals.selectGeneralPrep.mockResolvedValue(['gp-1', 'gp-2']);

    const dto = makeDto({ counts: { easy: 10, normal: 0, hard: 0 } });
    const ids = await internals.selectSmartMix(dto, STUDENT_ID);

    expect(internals.selectAIGenPool).toHaveBeenCalledWith(
      expect.objectContaining({ counts: { easy: 5, normal: 0, hard: 0 } }),
      STUDENT_ID,
      ['wt-1'],
      5,
    );

    expect(ids).toContain('ai-1');
    expect(ids).toContain('ai-2');
    expect(ids.filter((id) => id === 'ai-1')).toHaveLength(1);
    expect(ids.filter((id) => id === 'ai-2')).toHaveLength(1);
    expect(ids.length).toBeLessThanOrEqual(10);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('b) AI pool empty -> behavior identical to pre-Task-8: selectAIGenPool returns [] -> no ids from it, existing pools drive selection', async () => {
    const { db } = mockDb([['m-1']]);
    const internals = makeService(db);

    internals.selectAIGenPool.mockResolvedValue([]);
    internals.selectDueReview.mockResolvedValue(['due-1', 'due-2']);
    internals.selectDebugErrors.mockResolvedValue(['err-1']);
    internals.selectTrapFinder.mockResolvedValue(['trap-1']);
    internals.selectGeneralPrep.mockResolvedValue(['gp-1']);

    const dto = makeDto({ counts: { easy: 5, normal: 0, hard: 0 } });
    const ids = await internals.selectSmartMix(dto, STUDENT_ID);

    expect(internals.selectAIGenPool).toHaveBeenCalled();
    expect(ids).toEqual(
      expect.arrayContaining(['due-1', 'due-2', 'err-1', 'trap-1', 'gp-1']),
    );
    expect(ids).not.toContain('ai-');
    expect(ids.length).toBeLessThanOrEqual(5);
  });

  it('c) AI pool short (returns fewer than its quota) -> remainder comes from existing pools; final unique length == total', async () => {
    const { db } = mockDb([['m-1']]);
    const internals = makeService(db);

    internals.selectAIGenPool.mockResolvedValue(['ai-1', 'ai-2']);
    internals.selectDueReview.mockResolvedValue(['due-1', 'due-2', 'due-3']);
    internals.selectDebugErrors.mockResolvedValue(['err-1']);
    internals.selectTrapFinder.mockResolvedValue(['trap-1', 'trap-2']);
    internals.selectGeneralPrep.mockResolvedValue(['gp-1', 'gp-2', 'gp-3']);

    const dto = makeDto({ counts: { easy: 10, normal: 0, hard: 0 } });
    const ids = await internals.selectSmartMix(dto, STUDENT_ID);

    expect(ids).toContain('ai-1');
    expect(ids).toContain('ai-2');
    expect(ids.length).toBeLessThanOrEqual(10);
    expect(new Set(ids).size).toBe(ids.length);

    expect(internals.selectAIGenPool).toHaveBeenCalledWith(
      expect.objectContaining({ counts: { easy: 5, normal: 0, hard: 0 } }),
      STUDENT_ID,
      ['wt-1'],
      5,
    );
  });

  it('d) AI_MAX_SHARE respected: total=10 -> selectAIGenPool requested with 5; remainder uses shared Set (no dupes)', async () => {
    const { db } = mockDb([['m-1']]);
    const internals = makeService(db);

    internals.selectAIGenPool.mockResolvedValue([
      'ai-1',
      'ai-2',
      'ai-3',
      'ai-4',
      'ai-5',
    ]);
    internals.selectDueReview.mockResolvedValue(['ai-3', 'due-1', 'due-2']);
    internals.selectDebugErrors.mockResolvedValue(['err-1']);
    internals.selectTrapFinder.mockResolvedValue(['trap-1']);
    internals.selectGeneralPrep.mockResolvedValue([
      'gp-1',
      'gp-2',
      'gp-3',
      'gp-4',
    ]);

    const dto = makeDto({ counts: { easy: 10, normal: 0, hard: 0 } });
    const ids = await internals.selectSmartMix(dto, STUDENT_ID);

    expect(internals.selectAIGenPool).toHaveBeenCalledWith(
      expect.objectContaining({ counts: { easy: 5, normal: 0, hard: 0 } }),
      STUDENT_ID,
      ['wt-1'],
      5,
    );

    ['ai-1', 'ai-2', 'ai-3', 'ai-4', 'ai-5'].forEach((id) =>
      expect(ids).toContain(id),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeLessThanOrEqual(10);
  });
});
