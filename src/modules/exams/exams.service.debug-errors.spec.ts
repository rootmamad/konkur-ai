import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Db } from '../../db/db.module';
import { QuestionType } from '../questions/enums/question-type.enum';
import type { CountsDto, StartExamDto } from './dto/start-exam.dto';
import { ExamsService } from './exams.service';

const STUDENT_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';
const TOPIC_A = '11111111-1111-4111-8111-111111111111';
const TOPIC_B = '22222222-2222-4222-8222-222222222222';
const TOPIC_C = '33333333-3333-4333-8333-333333333333';

const dialect = new PgDialect();

type DtoWithCounts = StartExamDto & {
  counts: CountsDto;
  durationSeconds: number;
};

function makeDto(overrides: Partial<DtoWithCounts> = {}): DtoWithCounts {
  return {
    questionType: QuestionType.MULTIPLE_CHOICE,
    kind: 'debug_errors',
    counts: { easy: 0, normal: 0, hard: 0 },
    durationSeconds: 600,
    ...overrides,
  };
}

type DebugErrorsStage = 'wrong' | 'fresh' | 'fill';

type DebugErrorsQueryLog = {
  conditions: SQL[];
  distinctProjections: object[];
  limits: number[];
  /** Query executions in order; 'fill' is recorded by the general_prep test. */
  stages: DebugErrorsStage[];
  select: jest.Mock;
  selectDistinct: jest.Mock;
};

/**
 * Two top-level queries: the distinct wrong-answer pool (selectDistinct) and
 * the fresh-fill pool (select). The general_prep fill is stubbed on the
 * service, so `wrongRows` and `freshRows` are the two result sets.
 */
function mockDb(
  wrongRows: { id: string; topicId: string | null }[] = [],
  freshRows: string[] = [],
): { db: Db; log: DebugErrorsQueryLog } {
  const conditions: SQL[] = [];
  const distinctProjections: object[] = [];
  const limits: number[] = [];
  const stages: DebugErrorsStage[] = [];

  const wrongLimit = jest.fn((count: number) => {
    limits.push(count);
    stages.push('wrong');
    return Promise.resolve(wrongRows);
  });
  const wrongWhere = jest.fn((condition: SQL) => {
    conditions.push(condition);
    return { limit: wrongLimit };
  });
  const wrongJoin2 = jest.fn(() => ({ where: wrongWhere }));
  const wrongJoin1 = jest.fn(() => ({ innerJoin: wrongJoin2 }));
  const wrongFrom = jest.fn(() => ({ innerJoin: wrongJoin1 }));

  const freshLimit = jest.fn((count: number) => {
    limits.push(count);
    stages.push('fresh');
    return Promise.resolve(freshRows.map((id) => ({ id })));
  });
  const freshOrderBy = jest.fn(() => ({ limit: freshLimit }));
  const freshWhere = jest.fn((condition: SQL) => {
    conditions.push(condition);
    return { orderBy: freshOrderBy };
  });
  const freshFrom = jest.fn(() => ({ where: freshWhere }));

  const selectDistinct = jest.fn((projection: object) => {
    distinctProjections.push(projection);
    return { from: wrongFrom };
  });
  const select = jest.fn(() => ({ from: freshFrom }));

  return {
    db: { select, selectDistinct } as unknown as Db,
    log: {
      conditions,
      distinctProjections,
      limits,
      stages,
      select,
      selectDistinct,
    },
  };
}

type DebugErrorsInternals = {
  selectDebugErrors(dto: DtoWithCounts, studentId: string): Promise<string[]>;
  selectGeneralPrep: jest.Mock;
};

function makeService(db: Db): DebugErrorsInternals {
  const service = new ExamsService(db);
  const internals = service as unknown as DebugErrorsInternals;
  internals.selectGeneralPrep = jest.fn().mockResolvedValue([]);
  return internals;
}

describe('ExamsService debug_errors selection', () => {
  it('starts from the distinct wrong-answer pool of this student, limited to the total', async () => {
    const { db, log } = mockDb([
      { id: 'w-1', topicId: TOPIC_A },
      { id: 'w-2', topicId: TOPIC_B },
      { id: 'w-3', topicId: TOPIC_A },
    ]);
    const internals = makeService(db);

    const ids = await internals.selectDebugErrors(
      makeDto({ counts: { easy: 2, normal: 1, hard: 0 } }),
      STUDENT_ID,
    );

    expect(ids.sort()).toEqual(['w-1', 'w-2', 'w-3']);
    // The wrong pool is a distinct projection of question id + topicId.
    expect(log.selectDistinct).toHaveBeenCalledTimes(1);
    expect(Object.keys(log.distinctProjections[0]).sort()).toEqual([
      'id',
      'topicId',
    ]);
    // Wrong pool filled the total: no other stage runs.
    expect(log.select).not.toHaveBeenCalled();
    expect(log.limits).toEqual([3]);
    expect(log.stages).toEqual(['wrong']);
    expect(internals.selectGeneralPrep).not.toHaveBeenCalled();

    const { sql: text, params } = dialect.sqlToQuery(log.conditions[0]);
    expect(text).toContain('"response"."is_correct" =');
    expect(params).toContain(false);
    expect(text).toContain('"attempt"."student_id" =');
    expect(params).toContain(STUDENT_ID);
    // Published questions of the requested type that are not mastered yet.
    expect(text).toContain('"question"."status" =');
    expect(text).toContain('"question"."type" =');
    expect(text).toContain('NOT EXISTS');
    expect(text).toContain('question_mastery');
  });

  it('fills from error topics only, with questions the student never answered', async () => {
    const { db, log } = mockDb(
      [
        { id: 'w-1', topicId: TOPIC_A },
        { id: 'w-2', topicId: null },
        { id: 'w-3', topicId: TOPIC_B },
      ],
      ['f-1', 'f-2'],
    );
    const internals = makeService(db);

    const ids = await internals.selectDebugErrors(
      makeDto({ counts: { easy: 5, normal: 0, hard: 0 } }),
      STUDENT_ID,
    );

    // total 5 = 3 wrong + 2 fresh; no general prep needed.
    expect(ids.sort()).toEqual(['f-1', 'f-2', 'w-1', 'w-2', 'w-3']);
    expect(internals.selectGeneralPrep).not.toHaveBeenCalled();
    expect(log.stages).toEqual(['wrong', 'fresh']);
    // need = total - wrong.length
    expect(log.limits).toEqual([5, 2]);

    const { sql: text, params } = dialect.sqlToQuery(log.conditions[1]);
    // Only the topics where the student made errors; null topicIds dropped.
    expect(text).toContain('"question"."topic_id" in');
    expect(params).toContain(TOPIC_A);
    expect(params).toContain(TOPIC_B);
    expect(params).not.toContain(null);
    expect(params).not.toContain(TOPIC_C);
    // Never answered by this student (the NOT EXISTS response clause).
    expect(text).toContain('NOT EXISTS');
    expect(text).toContain('FROM response r');
    expect(text).toContain('JOIN attempt a');
    expect(text).toContain('a.student_id');
    expect(params).toContain(STUDENT_ID);
    // Published questions of the requested type only.
    expect(text).toContain('"question"."status" =');
    expect(text).toContain('"question"."type" =');
  });

  it('runs the general_prep fill last, with the remaining count as easy', async () => {
    const { db, log } = mockDb([{ id: 'w-1', topicId: TOPIC_A }], ['f-1']);
    const internals = makeService(db);
    internals.selectGeneralPrep.mockImplementation(() => {
      log.stages.push('fill');
      return Promise.resolve(['g-1', 'g-2']);
    });

    const ids = await internals.selectDebugErrors(
      makeDto({ counts: { easy: 2, normal: 1, hard: 1 } }),
      STUDENT_ID,
    );

    // total 4 = 1 wrong + 1 fresh + 2 from general prep, in that order.
    expect(ids.sort()).toEqual(['f-1', 'g-1', 'g-2', 'w-1']);
    expect(log.stages).toEqual(['wrong', 'fresh', 'fill']);
    expect(internals.selectGeneralPrep).toHaveBeenCalledTimes(1);
    expect(internals.selectGeneralPrep).toHaveBeenCalledWith(
      expect.objectContaining({ counts: { easy: 2, normal: 0, hard: 0 } }),
      STUDENT_ID,
    );
  });

  it('never returns the same question twice across the three stages', async () => {
    const { db } = mockDb([{ id: 'w-1', topicId: TOPIC_A }], ['f-1']);
    const internals = makeService(db);
    // The real general_prep query only excludes mastered questions, so it can
    // legitimately re-offer 'w-1' (published, same type, easy, not mastered).
    internals.selectGeneralPrep.mockResolvedValue(['w-1']);

    const ids = await internals.selectDebugErrors(
      makeDto({ counts: { easy: 3, normal: 0, hard: 0 } }),
      STUDENT_ID,
    );

    expect(ids.filter((id) => id === 'w-1')).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
