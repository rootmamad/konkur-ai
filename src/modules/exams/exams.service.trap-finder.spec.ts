import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Db } from '../../db/db.module';
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
    kind: 'trap_finder',
    counts: { easy: 0, normal: 0, hard: 0 },
    durationSeconds: 600,
    ...overrides,
  };
}

type QueryLog = {
  conditions: SQL[];
  limits: number[];
  select: jest.Mock;
};

/** One result set per trap pool, in call order. */
function mockDb(rowsPerPool: string[][] = []): { db: Db; log: QueryLog } {
  const conditions: SQL[] = [];
  const limits: number[] = [];
  let call = 0;

  const limit = jest.fn((count: number) => {
    limits.push(count);
    return Promise.resolve((rowsPerPool[call++] ?? []).map((id) => ({ id })));
  });
  const orderBy = jest.fn(() => ({ limit }));
  const where = jest.fn((condition: SQL) => {
    conditions.push(condition);
    return { orderBy };
  });
  const from = jest.fn(() => ({ where }));
  const select = jest.fn(() => ({ from }));

  return {
    db: { select } as unknown as Db,
    log: { conditions, limits, select },
  };
}

function callSelectTrapFinder(
  service: ExamsService,
  dto: DtoWithCounts,
  studentId: string,
): Promise<string[]> {
  const privateService = service as unknown as {
    selectTrapFinder(dto: DtoWithCounts, studentId: string): Promise<string[]>;
  };
  return privateService.selectTrapFinder(dto, studentId);
}

describe('ExamsService trap_finder selection', () => {
  it('fills wrong traps first, then unseen, then seen-correct', async () => {
    const { db, log } = mockDb([['w-1', 'w-2'], ['u-1'], ['c-1']]);
    const service = new ExamsService(db);

    const ids = await callSelectTrapFinder(
      service,
      makeDto({ counts: { easy: 2, normal: 1, hard: 1 } }),
      STUDENT_ID,
    );

    expect(ids.sort()).toEqual(['c-1', 'u-1', 'w-1', 'w-2']);
    expect(log.select).toHaveBeenCalledTimes(3);
    // Remaining capacity passed to each successive pool.
    expect(log.limits).toEqual([4, 2, 1]);

    const [wrong, unseen, correct] = log.conditions.map((condition) =>
      dialect.sqlToQuery(condition),
    );
    expect(wrong.sql).toContain('qm.last_is_correct = false');
    expect(unseen.sql).toContain('NOT EXISTS');
    expect(unseen.sql).not.toContain('last_is_correct');
    expect(correct.sql).toContain('qm.last_is_correct = true');

    for (const { sql: text, params } of [wrong, unseen, correct]) {
      // Only trap questions, published, of the requested type.
      expect(text).toContain('"question"."has_trap" =');
      expect(text).toContain('"question"."status" =');
      expect(text).toContain('"question"."type" =');
      expect(params).toContain(true);
      expect(params).toContain(STUDENT_ID);
    }
  });

  it('stops as soon as the requested total is filled', async () => {
    const { db, log } = mockDb([['w-1', 'w-2']]);
    const service = new ExamsService(db);

    const ids = await callSelectTrapFinder(
      service,
      makeDto({ counts: { easy: 1, normal: 1, hard: 0 } }),
      STUDENT_ID,
    );

    expect(ids.sort()).toEqual(['w-1', 'w-2']);
    expect(log.select).toHaveBeenCalledTimes(1);
    expect(log.limits).toEqual([2]);
  });

  it('returns partial results instead of padding with non-trap questions', async () => {
    const { db, log } = mockDb([['w-1'], [], ['c-1']]);
    const service = new ExamsService(db);

    const ids = await callSelectTrapFinder(
      service,
      makeDto({ counts: { easy: 1, normal: 1, hard: 1 } }),
      STUDENT_ID,
    );

    expect(ids.sort()).toEqual(['c-1', 'w-1']);
    for (const condition of log.conditions) {
      const { sql: text, params } = dialect.sqlToQuery(condition);
      expect(text).toContain('"question"."has_trap" =');
      expect(params).toContain(true);
      expect(params).not.toContain(false);
      expect(text).not.toContain('NOT ("question"."has_trap")');
    }
  });

  it('never returns the same question twice', async () => {
    const { db } = mockDb([['q-1'], ['q-1'], []]);
    const service = new ExamsService(db);

    const ids = await callSelectTrapFinder(
      service,
      makeDto({ counts: { easy: 1, normal: 1, hard: 0 } }),
      STUDENT_ID,
    );

    expect(ids).toEqual(['q-1']);
  });

  it('asks the database for nothing when no questions were requested', async () => {
    const { db, log } = mockDb();
    const service = new ExamsService(db);

    const ids = await callSelectTrapFinder(service, makeDto(), STUDENT_ID);

    expect(ids).toEqual([]);
    expect(log.select).not.toHaveBeenCalled();
  });
});
