import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Db } from '../../db/db.module';
import { questionMastery } from '../../db/schema/question-mastery';
import { QuestionType } from '../questions/enums/question-type.enum';
import type { CountsDto, StartExamDto } from './dto/start-exam.dto';
import { ExamsService } from './exams.service';

const STUDENT_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';

const dialect = new PgDialect();

type DtoWithCounts = StartExamDto & {
  counts: CountsDto;
  durationSeconds: number;
};

function makeDto(overrides: Partial<DtoWithCounts> = {}): DtoWithCounts {
  return {
    questionType: QuestionType.MULTIPLE_CHOICE,
    kind: 'due_review',
    counts: { easy: 0, normal: 0, hard: 0 },
    durationSeconds: 600,
    ...overrides,
  };
}

type DueReviewQueryLog = {
  conditions: SQL[];
  orderings: SQL[];
  innerJoin: jest.Mock;
  limits: number[];
  select: jest.Mock;
};

/** One result set for the single due-rows query. */
function mockDb(dueRows: string[] = []): { db: Db; log: DueReviewQueryLog } {
  const conditions: SQL[] = [];
  const orderings: SQL[] = [];
  const limits: number[] = [];

  const limit = jest.fn((count: number) => {
    limits.push(count);
    return Promise.resolve(dueRows.map((id) => ({ id })));
  });
  const orderBy = jest.fn((expression: SQL) => {
    orderings.push(expression);
    return { limit };
  });
  const where = jest.fn((condition: SQL) => {
    conditions.push(condition);
    return { orderBy };
  });
  const innerJoin = jest.fn(() => ({ where }));
  const from = jest.fn(() => ({ innerJoin }));
  const select = jest.fn(() => ({ from }));

  return {
    db: { select } as unknown as Db,
    log: { conditions, orderings, innerJoin, limits, select },
  };
}

type DueReviewInternals = {
  selectDueReview(dto: DtoWithCounts, studentId: string): Promise<string[]>;
  selectGeneralPrep: jest.Mock;
};

function makeService(db: Db): DueReviewInternals {
  const service = new ExamsService(db);
  const internals = service as unknown as DueReviewInternals;
  internals.selectGeneralPrep = jest.fn().mockResolvedValue([]);
  return internals;
}

describe('ExamsService due_review selection', () => {
  it('only selects unmastered questions whose next_due_at has passed, oldest first', async () => {
    const { db, log } = mockDb(['d-1', 'd-2']);
    const internals = makeService(db);

    const ids = await internals.selectDueReview(
      makeDto({ counts: { easy: 2, normal: 0, hard: 0 } }),
      STUDENT_ID,
    );

    expect(ids.sort()).toEqual(['d-1', 'd-2']);
    // The rows come from an inner join on this student's question_mastery rows.
    expect(log.innerJoin).toHaveBeenCalledWith(
      questionMastery,
      expect.anything(),
    );

    const { sql: text, params } = dialect.sqlToQuery(log.conditions[0]);
    expect(text).toContain('"question_mastery"."mastered_at" IS NULL');
    expect(text).toContain('"question_mastery"."next_due_at" IS NOT NULL');
    expect(text).toContain('"question_mastery"."next_due_at" <= now()');
    expect(text).toContain('"question_mastery"."student_id" =');
    expect(params).toContain(STUDENT_ID);
    // Published questions of the requested type only.
    expect(text).toContain('"question"."status" =');
    expect(text).toContain('"question"."type" =');

    const order = dialect.sqlToQuery(log.orderings[0]);
    expect(order.sql).toContain('"question_mastery"."next_due_at" ASC');
  });

  it('limits the due query to the requested total across buckets', async () => {
    const { db, log } = mockDb(['d-1', 'd-2', 'd-3', 'd-4', 'd-5', 'd-6']);
    const internals = makeService(db);

    const ids = await internals.selectDueReview(
      makeDto({ counts: { easy: 2, normal: 3, hard: 1 } }),
      STUDENT_ID,
    );

    // One query for all difficulty buckets, capped at the requested total.
    expect(log.limits).toEqual([6]);
    expect(ids).toHaveLength(6);
    expect(internals.selectGeneralPrep).not.toHaveBeenCalled();
  });

  it('fills a short result with exactly one general_prep call for the remainder', async () => {
    const { db } = mockDb(['d-1', 'd-2']);
    const internals = makeService(db);
    internals.selectGeneralPrep.mockResolvedValue(['g-1', 'g-2', 'g-3']);

    const ids = await internals.selectDueReview(
      makeDto({ counts: { easy: 3, normal: 1, hard: 1 } }),
      STUDENT_ID,
    );

    // total 5 = 2 due + 3 filled, with the whole remainder in the easy bucket.
    expect(ids.sort()).toEqual(['d-1', 'd-2', 'g-1', 'g-2', 'g-3']);
    expect(internals.selectGeneralPrep).toHaveBeenCalledTimes(1);
    expect(internals.selectGeneralPrep).toHaveBeenCalledWith(
      expect.objectContaining({ counts: { easy: 3, normal: 0, hard: 0 } }),
      STUDENT_ID,
    );
  });

  it('never returns a due question twice when the fill re-offers it', async () => {
    const { db } = mockDb(['d-1', 'd-2']);
    const internals = makeService(db);
    // The real general_prep query only excludes mastered questions, so it can
    // legitimately re-offer 'd-1' (published, same type, easy, not mastered).
    internals.selectGeneralPrep.mockResolvedValue(['d-1', 'g-1']);

    const ids = await internals.selectDueReview(
      makeDto({ counts: { easy: 2, normal: 1, hard: 1 } }),
      STUDENT_ID,
    );

    // 'd-1' is served once; the dropped fill slot is an accepted under-fill.
    expect(ids.filter((id) => id === 'd-1')).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(['d-1', 'd-2', 'g-1']);
  });

  it('never calls general_prep when the due rows already fill the total', async () => {
    const { db, log } = mockDb(['d-1', 'd-2', 'd-3', 'd-4']);
    const internals = makeService(db);

    const ids = await internals.selectDueReview(
      makeDto({ counts: { easy: 2, normal: 1, hard: 1 } }),
      STUDENT_ID,
    );

    expect(ids.sort()).toEqual(['d-1', 'd-2', 'd-3', 'd-4']);
    expect(log.select).toHaveBeenCalledTimes(1);
    expect(internals.selectGeneralPrep).not.toHaveBeenCalled();
  });
});
