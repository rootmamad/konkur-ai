import { BadRequestException } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Db } from '../../db/db.module';
import { QuestionType } from '../questions/enums/question-type.enum';
import type { CountsDto, StartExamDto } from './dto/start-exam.dto';
import { ExamsService } from './exams.service';

const STUDENT_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';
const TOPIC = '11111111-1111-4111-8111-111111111111';

const dialect = new PgDialect();

type DtoWithCounts = StartExamDto & {
  counts: CountsDto;
  durationSeconds: number;
};

function makeDto(overrides: Partial<DtoWithCounts> = {}): DtoWithCounts {
  return {
    questionType: QuestionType.MULTIPLE_CHOICE,
    kind: 'quiz_after_study',
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

/** One result set per difficulty-bucket query, in call order. */
function mockDb(rowsPerQuery: string[][] = []): { db: Db; log: QueryLog } {
  const conditions: SQL[] = [];
  const limits: number[] = [];
  let call = 0;

  const limit = jest.fn((count: number) => {
    limits.push(count);
    return Promise.resolve((rowsPerQuery[call++] ?? []).map((id) => ({ id })));
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

function callSelectAfterStudy(
  service: ExamsService,
  dto: DtoWithCounts,
  studentId: string,
): Promise<string[]> {
  const privateService = service as unknown as {
    selectAfterStudy(dto: DtoWithCounts, studentId: string): Promise<string[]>;
  };
  return privateService.selectAfterStudy(dto, studentId);
}

describe('ExamsService quiz_after_study selection', () => {
  it('rejects a missing topicId before touching the database', async () => {
    const { db, log } = mockDb();
    const service = new ExamsService(db);

    await expect(
      callSelectAfterStudy(
        service,
        makeDto({ counts: { easy: 2, normal: 1, hard: 1 } }),
        STUDENT_ID,
      ),
    ).rejects.toThrow(
      new BadRequestException(
        'topicId is required for quiz_after_study (select the studied topic)',
      ),
    );

    expect(log.select).not.toHaveBeenCalled();
  });

  it('scopes every bucket query to the topic, question type and difficulty, excluding mastered questions', async () => {
    const { db, log } = mockDb([['q-e1'], ['q-n1'], ['q-h1']]);
    const service = new ExamsService(db);

    const ids = await callSelectAfterStudy(
      service,
      makeDto({ topicId: TOPIC, counts: { easy: 1, normal: 1, hard: 1 } }),
      STUDENT_ID,
    );

    expect(ids.sort()).toEqual(['q-e1', 'q-h1', 'q-n1']);
    // One query per non-empty bucket, each limited to its bucket count.
    expect(log.select).toHaveBeenCalledTimes(3);
    expect(log.limits).toEqual([1, 1, 1]);

    log.conditions.forEach((condition, index) => {
      const { sql: text, params } = dialect.sqlToQuery(condition);
      // Published questions of the requested type from the studied topic only.
      expect(text).toContain('"question"."status" =');
      expect(text).toContain('"question"."type" =');
      expect(text).toContain('"question"."topic_id" =');
      expect(params).toContain(TOPIC);
      // One difficulty bucket per query: levels 1, 2, 3 in call order.
      expect(params).toContain(index + 1);
      // Mastered questions are excluded via the question_mastery subquery.
      expect(text).toContain('NOT EXISTS');
      expect(text).toContain('question_mastery');
      expect(params).toContain(STUDENT_ID);
    });
  });

  it('issues no query for a difficulty bucket whose count is zero', async () => {
    const { db, log } = mockDb([
      ['q-e1', 'q-e2'],
      ['q-h1', 'q-h2', 'q-h3'],
    ]);
    const service = new ExamsService(db);

    const ids = await callSelectAfterStudy(
      service,
      makeDto({ topicId: TOPIC, counts: { easy: 2, normal: 0, hard: 3 } }),
      STUDENT_ID,
    );

    expect(ids.sort()).toEqual(['q-e1', 'q-e2', 'q-h1', 'q-h2', 'q-h3']);
    // Only the easy (level 1) and hard (level 3) buckets were queried.
    expect(log.select).toHaveBeenCalledTimes(2);
    expect(log.limits).toEqual([2, 3]);
    expect(dialect.sqlToQuery(log.conditions[0]).params).toContain(1);
    expect(dialect.sqlToQuery(log.conditions[1]).params).toContain(3);
  });

  it('returns a partial selection as-is instead of padding with filler', async () => {
    const { db, log } = mockDb([['q-1']]);
    const service = new ExamsService(db);
    const internals = service as unknown as { selectGeneralPrep: jest.Mock };
    internals.selectGeneralPrep = jest.fn();

    const ids = await callSelectAfterStudy(
      service,
      makeDto({ topicId: TOPIC, counts: { easy: 3, normal: 0, hard: 0 } }),
      STUDENT_ID,
    );

    // The topic only had one question: it is returned alone (spec §5 allows a
    // partial result for a small topic; the caller rejects an empty one).
    expect(ids).toEqual(['q-1']);
    expect(log.select).toHaveBeenCalledTimes(1);
    expect(internals.selectGeneralPrep).not.toHaveBeenCalled();
  });
});
