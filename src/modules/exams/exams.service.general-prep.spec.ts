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
    kind: 'general_prep',
    counts: { easy: 0, normal: 0, hard: 0 },
    durationSeconds: 600,
    ...overrides,
  };
}

/** Records the WHERE clause and limit of every bucket/topic query. */
function mockDb() {
  const conditions: SQL[] = [];
  const limits: number[] = [];

  const select = jest.fn(() => ({
    from: jest.fn(() => ({
      where: jest.fn((condition: SQL) => {
        conditions.push(condition);
        return {
          orderBy: jest.fn(() => ({
            limit: jest.fn((count: number) => {
              limits.push(count);
              const query = limits.length - 1;
              return Promise.resolve(
                Array.from({ length: count }, (_, index) => ({
                  id: `q${query}-${index}`,
                })),
              );
            }),
          })),
        };
      }),
    })),
  }));

  return { db: { select } as unknown as Db, conditions, limits };
}

function callSelectGeneralPrep(
  service: ExamsService,
  dto: DtoWithCounts,
  studentId: string,
): Promise<string[]> {
  const privateService = service as unknown as {
    selectGeneralPrep(dto: DtoWithCounts, studentId: string): Promise<string[]>;
  };
  return privateService.selectGeneralPrep(dto, studentId);
}

describe('ExamsService general_prep balanced coverage', () => {
  it('splits a bucket evenly across the selected topics', async () => {
    const { db, conditions, limits } = mockDb();
    const service = new ExamsService(db);

    const ids = await callSelectGeneralPrep(
      service,
      makeDto({
        counts: { easy: 6, normal: 0, hard: 0 },
        topicIds: [TOPIC_A, TOPIC_B, TOPIC_C],
      }),
      STUDENT_ID,
    );

    expect(ids).toHaveLength(6);
    expect(limits).toEqual([2, 2, 2]);
    expect(conditions).toHaveLength(3);

    for (const [index, condition] of conditions.entries()) {
      const { sql: text, params } = dialect.sqlToQuery(condition);
      expect(text).toContain('"question"."topic_id" =');
      expect(params).toContain([TOPIC_A, TOPIC_B, TOPIC_C][index]);
      // Existing filters are untouched.
      expect(text).toContain('"question"."status" =');
      expect(text).toContain('"question"."type" =');
      expect(text).toContain('"question"."difficulty_ai" =');
      expect(text).toContain('NOT EXISTS');
      expect(params).toContain(STUDENT_ID);
    }
  });

  it('gives the remainder to the first topics (2/2/1 for five)', async () => {
    const { db, limits } = mockDb();
    const service = new ExamsService(db);

    await callSelectGeneralPrep(
      service,
      makeDto({
        counts: { easy: 5, normal: 0, hard: 0 },
        topicIds: [TOPIC_A, TOPIC_B, TOPIC_C],
      }),
      STUDENT_ID,
    );

    expect(limits).toEqual([2, 2, 1]);
  });

  it('splits every difficulty bucket independently', async () => {
    const { db, limits } = mockDb();
    const service = new ExamsService(db);

    const ids = await callSelectGeneralPrep(
      service,
      makeDto({
        counts: { easy: 4, normal: 2, hard: 0 },
        topicIds: [TOPIC_A, TOPIC_B],
      }),
      STUDENT_ID,
    );

    expect(limits).toEqual([2, 2, 1, 1]);
    expect(ids).toHaveLength(6);
  });

  it('keeps the single random query when no topics are selected', async () => {
    const { db, conditions, limits } = mockDb();
    const service = new ExamsService(db);

    const ids = await callSelectGeneralPrep(
      service,
      makeDto({ counts: { easy: 6, normal: 0, hard: 0 } }),
      STUDENT_ID,
    );

    expect(ids).toHaveLength(6);
    expect(limits).toEqual([6]);
    expect(dialect.sqlToQuery(conditions[0]).sql).not.toContain('topic_id');
  });

  it('deduplicates repeated topic ids before splitting', async () => {
    const { db, limits } = mockDb();
    const service = new ExamsService(db);

    await callSelectGeneralPrep(
      service,
      makeDto({
        counts: { easy: 5, normal: 0, hard: 0 },
        topicIds: [TOPIC_A, TOPIC_A, TOPIC_B],
      }),
      STUDENT_ID,
    );

    expect(limits).toEqual([3, 2]);
  });

  it('ignores topicIds for other quiz kinds', async () => {
    const { db, conditions, limits } = mockDb();
    const service = new ExamsService(db);

    const ids = await callSelectGeneralPrep(
      service,
      makeDto({
        kind: 'speed',
        counts: { easy: 3, normal: 0, hard: 0 },
        topicIds: [TOPIC_A, TOPIC_B],
      }),
      STUDENT_ID,
    );

    expect(ids).toHaveLength(3);
    expect(limits).toEqual([3]);
    expect(dialect.sqlToQuery(conditions[0]).sql).not.toContain('topic_id');
  });
});
