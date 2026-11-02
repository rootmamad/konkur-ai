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
    kind: 'speed',
    counts: { easy: 0, normal: 0, hard: 0 },
    durationSeconds: 600,
    ...overrides,
  };
}

type PrivateService = {
  selectSpeed(dto: DtoWithCounts, studentId: string): Promise<string[]>;
  selectGeneralPrep(dto: DtoWithCounts, studentId: string): Promise<string[]>;
  getSpeedSlowThreshold(): Promise<number>;
};

/**
 * `select` serves pool 1 then the known-topic pool; `selectDistinct` serves the
 * mastery evidence query.
 */
function mockDb(
  options: {
    slow?: string[];
    known?: string[];
    topics?: string[];
  } = {},
) {
  const conditions: SQL[] = [];
  const limits: number[] = [];
  let selectCall = 0;

  const select = jest.fn(() => {
    const rows =
      selectCall === 0 ? (options.slow ?? []) : (options.known ?? []);
    selectCall += 1;
    return {
      from: jest.fn(() => ({
        where: jest.fn((condition: SQL) => {
          conditions.push(condition);
          return {
            orderBy: jest.fn(() => ({
              limit: jest.fn((count: number) => {
                limits.push(count);
                return Promise.resolve(rows.map((id) => ({ id })));
              }),
            })),
          };
        }),
      })),
    };
  });

  const selectDistinct = jest.fn(() => ({
    from: jest.fn(() => ({
      innerJoin: jest.fn(() => ({
        where: jest
          .fn()
          .mockResolvedValue(
            (options.topics ?? []).map((topicId) => ({ topicId })),
          ),
      })),
    })),
  }));

  return {
    db: { select, selectDistinct } as unknown as Db,
    conditions,
    limits,
    select,
    selectDistinct,
  };
}

describe('ExamsService speed selection', () => {
  it('fills correct-but-slow questions first, then known-topic questions', async () => {
    const { db, conditions, limits, selectDistinct } = mockDb({
      slow: ['s-1', 's-2'],
      known: ['k-1'],
      topics: ['topic-1'],
    });
    const service = new ExamsService(db);
    const priv = service as unknown as PrivateService;
    jest.spyOn(priv, 'getSpeedSlowThreshold').mockResolvedValue(90);

    const ids = await priv.selectSpeed(
      makeDto({ counts: { easy: 2, normal: 1, hard: 1 } }),
      STUDENT_ID,
    );

    expect(ids.sort()).toEqual(['k-1', 's-1', 's-2']);
    expect(selectDistinct).toHaveBeenCalledTimes(1);
    // Pool 1 gets the full request; pool 2 only the remaining capacity.
    expect(limits).toEqual([4, 2]);

    const [slowPool, knownPool] = conditions.map((condition) =>
      dialect.sqlToQuery(condition),
    );
    expect(slowPool.sql).toContain('r.is_correct = true');
    expect(slowPool.sql).toContain('r.active_seconds >');
    expect(slowPool.params).toContain(90);
    expect(slowPool.params).toContain(STUDENT_ID);
    expect(slowPool.sql).toContain('"question"."status" =');
    expect(slowPool.sql).toContain('"question"."type" =');

    expect(knownPool.sql).toContain('"question"."topic_id" in');
    // Pool 1 ids are excluded so the fallback cannot re-add them.
    expect(knownPool.sql).toContain('not in');
    expect(knownPool.sql).not.toContain('r.is_correct');
  });

  it('stops once the correct-but-slow pool fills the request', async () => {
    const { db, selectDistinct } = mockDb({ slow: ['s-1'] });
    const service = new ExamsService(db);
    const priv = service as unknown as PrivateService;
    jest.spyOn(priv, 'getSpeedSlowThreshold').mockResolvedValue(120);

    const ids = await priv.selectSpeed(
      makeDto({ counts: { easy: 1, normal: 0, hard: 0 } }),
      STUDENT_ID,
    );

    expect(ids).toEqual(['s-1']);
    expect(selectDistinct).not.toHaveBeenCalled();
  });

  it('falls back to general prep without duplicates when no topics are known', async () => {
    const { db } = mockDb({ slow: ['s-1'], topics: [] });
    const service = new ExamsService(db);
    const priv = service as unknown as PrivateService;
    jest.spyOn(priv, 'getSpeedSlowThreshold').mockResolvedValue(90);
    const selectGeneralPrep = jest
      .spyOn(priv, 'selectGeneralPrep')
      .mockResolvedValue(['s-1', 'g-1']);

    const ids = await priv.selectSpeed(
      makeDto({ counts: { easy: 1, normal: 1, hard: 1 } }),
      STUDENT_ID,
    );

    expect(ids.sort()).toEqual(['g-1', 's-1']);
    expect(selectGeneralPrep).toHaveBeenCalledWith(
      expect.objectContaining({ counts: { easy: 2, normal: 0, hard: 0 } }),
      STUDENT_ID,
    );
  });

  it('reads the slow threshold from the active config and defaults to 90', async () => {
    function serviceWithConfig(rows: unknown[]): ExamsService {
      const limit = jest.fn(() => Promise.resolve(rows));
      const orderBy = jest.fn(() => ({ limit }));
      const where = jest.fn(() => ({ orderBy }));
      const from = jest.fn(() => ({ where }));
      const select = jest.fn(() => ({ from }));
      return new ExamsService({ select } as unknown as Db);
    }

    const getThreshold = (service: ExamsService) =>
      (service as unknown as PrivateService).getSpeedSlowThreshold();

    await expect(
      getThreshold(
        serviceWithConfig([{ quotas: { speed_slow_threshold_seconds: 120 } }]),
      ),
    ).resolves.toBe(120);
    await expect(
      getThreshold(serviceWithConfig([{ quotas: {} }])),
    ).resolves.toBe(90);
    await expect(getThreshold(serviceWithConfig([]))).resolves.toBe(90);
    await expect(
      getThreshold(
        serviceWithConfig([
          { quotas: { speed_slow_threshold_seconds: '120' } },
        ]),
      ),
    ).resolves.toBe(90);
    await expect(
      getThreshold(
        serviceWithConfig([{ quotas: { speed_slow_threshold_seconds: 0 } }]),
      ),
    ).resolves.toBe(90);
    await expect(
      getThreshold(
        serviceWithConfig([{ quotas: { speed_slow_threshold_seconds: -5 } }]),
      ),
    ).resolves.toBe(90);
  });

  it('asks for nothing when no questions were requested', async () => {
    const { db, select } = mockDb();
    const service = new ExamsService(db);

    const ids = await (service as unknown as PrivateService).selectSpeed(
      makeDto(),
      STUDENT_ID,
    );

    expect(ids).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });
});
