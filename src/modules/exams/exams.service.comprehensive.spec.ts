import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Db } from '../../db/db.module';
import { appConfig } from '../../db/schema/app-config';
import { questionMastery } from '../../db/schema/question-mastery';
import { response } from '../../db/schema/response';
import {
  MAX_QUESTIONS_PER_EXAM,
  SIM_QUESTION_COUNT_DEFAULT,
  SIM_TOPIC_CAP,
} from './exam.constants';
import { ExamsService } from './exams.service';

const STUDENT_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';

const KONKUR_MIN_YEAR = 1398;
const FINAL_MIN_YEAR = 1402;

type Query = { sql: string; params: unknown[]; limit?: number };

type PoolRow = { topicId: string; available: number };

type FakeDbConfig = {
  /** Value stored under app_config.quotas.sim_question_count. */
  quotas?: unknown;
  answeredIds?: string[];
  viewedIds?: string[];
  weakTopics?: string[];
  pool?: PoolRow[];
  rowsByTopic?: Record<string, string[]>;
};

type Chain = {
  limit(count: number): Promise<unknown[]>;
  orderBy(): Chain;
  groupBy(): Chain;
  then(resolve: (value: unknown[]) => unknown): unknown;
};

/**
 * A recording fake for every query `selectComprehensive` can issue. Rows are
 * picked by the table plus the compiled WHERE clause, which is also what the
 * assertions inspect, so a missing filter cannot pass silently: it would pick
 * the wrong pool and the test would see the wrong rows.
 */
function comprehensiveDb(config: FakeDbConfig): {
  db: Db;
  queries: Query[];
} {
  const dialect = new PgDialect();
  const queries: Query[] = [];

  const rowsFor = (
    source: unknown,
    joined: boolean,
    text: string,
    params: unknown[],
  ) => {
    if (source === appConfig) {
      return [{ quotas: { sim_question_count: config.quotas } }];
    }
    if (source === response) {
      return (config.answeredIds ?? []).map((questionId) => ({ questionId }));
    }
    if (source === questionMastery && joined) {
      return (config.weakTopics ?? []).map((topicId) => ({ topicId }));
    }
    if (source === questionMastery) {
      return (config.viewedIds ?? []).map((questionId) => ({ questionId }));
    }
    if (text.includes('"question"."topic_id" =')) {
      const rowsByTopic = config.rowsByTopic ?? {};
      const topicId = params.find(
        (param) => typeof param === 'string' && param in rowsByTopic,
      );
      return (rowsByTopic[String(topicId)] ?? []).map((id) => ({ id }));
    }
    return config.pool ?? [];
  };

  const select = jest.fn(() => ({
    from: (source: unknown) => {
      let joined = false;
      const builder = {
        innerJoin: () => {
          joined = true;
          return builder;
        },
        where: (condition?: SQL) => {
          const compiled = condition
            ? dialect.sqlToQuery(condition)
            : { sql: '', params: [] };
          const query: Query = { sql: compiled.sql, params: compiled.params };
          queries.push(query);

          const rows = rowsFor(source, joined, compiled.sql, compiled.params);
          const chain: Chain = {
            limit: (count: number) => {
              query.limit = count;
              return Promise.resolve(rows);
            },
            orderBy: () => chain,
            groupBy: () => chain,
            then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
          };
          return chain;
        },
      };
      return builder;
    },
  }));

  return { db: { select } as unknown as Db, queries };
}

type PrivateService = {
  selectComprehensive(
    studentId: string,
    mode: 'konkur' | 'final',
  ): Promise<string[]>;
  getSimQuestionCount(mode: 'konkur' | 'final'): Promise<number>;
  allocateComprehensiveTopics(
    pool: PoolRow[],
    total: number,
    weakTopicIds: ReadonlySet<string>,
  ): { topicId: string; count: number }[];
};

function privateOf(service: ExamsService): PrivateService {
  return service as unknown as PrivateService;
}

function countsById(
  allocations: { topicId: string; count: number }[],
): Record<string, number> {
  return Object.fromEntries(
    allocations.map((allocation) => [allocation.topicId, allocation.count]),
  );
}

describe('ExamsService comprehensive simulation selection (spec 3.5)', () => {
  describe('allocation', () => {
    const service = new ExamsService({} as unknown as Db);
    const allocate = (pool: PoolRow[], total: number, weak: string[] = []) =>
      privateOf(service).allocateComprehensiveTopics(
        pool,
        total,
        new Set(weak),
      );

    it('spreads an even baseline, boosts weak topics and stays within the target', () => {
      const pool = Array.from({ length: 8 }, (_, index) => ({
        topicId: `topic-${index + 1}`,
        available: 20,
      }));

      const allocations = allocate(pool, 60, ['topic-6']);

      // baseline 7, remainder 4 -> topics 1-4 get 8; topic-6 is boosted to the
      // per-topic cap of 8, funded by topic-1 giving one back.
      expect(countsById(allocations)).toEqual({
        'topic-1': 7,
        'topic-2': 8,
        'topic-3': 8,
        'topic-4': 8,
        'topic-5': 7,
        'topic-6': 8,
        'topic-7': 7,
        'topic-8': 7,
      });
      expect(allocations.reduce((sum, a) => sum + a.count, 0)).toBe(60);
    });

    it('never awards more questions than the topic has unseen', () => {
      const allocations = allocate(
        [
          { topicId: 'topic-a', available: 2 },
          { topicId: 'topic-b', available: 20 },
        ],
        10,
        ['topic-a'],
      );

      expect(countsById(allocations)).toEqual({ 'topic-a': 2, 'topic-b': 5 });
    });

    it('caps a single topic so one topic cannot fill the whole simulation', () => {
      const [allocation] = allocate(
        [{ topicId: 'topic-a', available: 100 }],
        60,
      );

      expect(allocation.count).toBe(SIM_TOPIC_CAP);
    });

    it('funds weak boosts from non-weak topics without dropping a topic', () => {
      const pool = Array.from({ length: 20 }, (_, index) => ({
        topicId: `topic-${index + 1}`,
        available: 100,
      }));
      const weak = pool.slice(0, 5).map((entry) => entry.topicId);

      const allocations = allocate(pool, 60, weak);
      const counts = countsById(allocations);
      const sum = allocations.reduce((total, a) => total + a.count, 0);

      expect(sum).toBeLessThanOrEqual(60);
      // Rule 1: every pool topic keeps at least one question.
      expect(Object.values(counts).every((count) => count >= 1)).toBe(true);
      for (const topicId of weak) expect(counts[topicId]).toBe(4);
      // The five boosts are paid for by the first non-weak topics (3 -> 2).
      expect(counts['topic-6']).toBe(2);
      expect(counts['topic-20']).toBe(3);
    });

    it('returns nothing for an empty pool or a non-positive total', () => {
      expect(allocate([], 60)).toEqual([]);
      expect(allocate([{ topicId: 'topic-a', available: 5 }], 0)).toEqual([]);
    });
  });

  describe('simulation length from app_config', () => {
    const getCount = (quotas: unknown, mode: 'konkur' | 'final') =>
      privateOf(
        new ExamsService(comprehensiveDb({ quotas }).db),
      ).getSimQuestionCount(mode);

    it('defaults to 60 konkur / 30 final and clamps to the maximum', async () => {
      await expect(getCount(undefined, 'konkur')).resolves.toBe(
        SIM_QUESTION_COUNT_DEFAULT.konkur,
      );
      await expect(getCount(undefined, 'final')).resolves.toBe(
        SIM_QUESTION_COUNT_DEFAULT.final,
      );
      await expect(getCount('lots', 'konkur')).resolves.toBe(
        SIM_QUESTION_COUNT_DEFAULT.konkur,
      );
      await expect(getCount(0, 'final')).resolves.toBe(
        SIM_QUESTION_COUNT_DEFAULT.final,
      );
      await expect(getCount(500, 'konkur')).resolves.toBe(
        MAX_QUESTIONS_PER_EXAM,
      );
    });

    it('accepts a per-kind object and a single number', async () => {
      await expect(getCount({ konkur: 12, final: 4 }, 'konkur')).resolves.toBe(
        12,
      );
      await expect(getCount({ konkur: 12, final: 4 }, 'final')).resolves.toBe(
        4,
      );
      await expect(getCount(25, 'konkur')).resolves.toBe(25);
      await expect(getCount(25, 'final')).resolves.toBe(25);
    });
  });

  describe('selection', () => {
    it('draws unseen bank questions from the konkur window only', async () => {
      const answered = 'q-seen-answered';
      const viewed = 'q-seen-viewed';
      const { db, queries } = comprehensiveDb({
        answeredIds: [answered],
        viewedIds: [viewed],
        weakTopics: ['topic-b'],
        pool: [
          { topicId: 'topic-a', available: 2 },
          { topicId: 'topic-b', available: 2 },
        ],
        rowsByTopic: {
          'topic-a': ['a-1', 'a-2'],
          'topic-b': ['b-1'],
        },
      });

      const ids = await privateOf(new ExamsService(db)).selectComprehensive(
        STUDENT_ID,
        'konkur',
      );

      expect([...ids].sort()).toEqual(['a-1', 'a-2', 'b-1']);
      expect(ids).not.toContain(answered);
      expect(ids).not.toContain(viewed);

      // The pool count: question-table filters with a non-null topic, no topic
      // equality (the WHERE text is what gets recorded, not the SELECT list).
      const poolQueries = queries.filter(
        (query) =>
          query.sql.includes('"question"."origin"') &&
          query.sql.includes('"question"."topic_id" is not null'),
      );
      expect(poolQueries).toHaveLength(1);
      const poolQuery = poolQueries[0];
      expect(poolQuery.sql).toContain('"question"."origin" =');
      expect(poolQuery.sql).toContain('"question"."source_year" >=');
      expect(poolQuery.sql).toContain(
        '"question"."source_session" is not null',
      );
      expect(poolQuery.sql).not.toContain('"question"."source_lesson"');
      expect(poolQuery.sql).toContain('"question"."id" not in');
      expect(poolQuery.params).toContain('bank');
      expect(poolQuery.params).toContain(KONKUR_MIN_YEAR);
      expect(poolQuery.params).toContain(answered);
      expect(poolQuery.params).toContain(viewed);

      // One pick per topic that still has unseen questions, each limited to its
      // allocation, and never an AI row.
      const pickQueries = queries.filter((query) =>
        query.sql.includes('"question"."topic_id" ='),
      );
      expect(pickQueries).toHaveLength(2);
      expect(pickQueries.map((query) => query.limit)).toEqual([2, 2]);
      for (const query of pickQueries) {
        expect(query.params).toContain('bank');
        expect(query.params).not.toContain('ai');
      }
    });

    it('uses the final-sim window and its lesson label', async () => {
      const { db, queries } = comprehensiveDb({
        quotas: { konkur: 8, final: 2 },
        pool: [
          { topicId: 'topic-a', available: 1 },
          { topicId: 'topic-b', available: 1 },
        ],
        rowsByTopic: { 'topic-a': ['a-1'], 'topic-b': ['b-1'] },
      });

      const ids = await privateOf(new ExamsService(db)).selectComprehensive(
        STUDENT_ID,
        'final',
      );

      expect([...ids].sort()).toEqual(['a-1', 'b-1']);

      const questionQueries = queries.filter((query) =>
        query.sql.includes('"question"."topic_id" ='),
      );
      expect(questionQueries.length).toBeGreaterThan(0);
      for (const query of questionQueries) {
        expect(query.sql).toContain('"question"."source_lesson" is not null');
        expect(query.sql).not.toContain('"question"."source_session"');
        expect(query.params).toContain(FINAL_MIN_YEAR);
        expect(query.params).not.toContain(KONKUR_MIN_YEAR);
      }
      // No seen rows at all: the exclusion list is omitted, not left empty.
      expect(
        questionQueries.some((query) =>
          query.sql.includes('"question"."id" not in'),
        ),
      ).toBe(false);
    });

    it('returns a shorter exam when the pool is shallow', async () => {
      const { db, queries } = comprehensiveDb({
        quotas: 60,
        pool: [{ topicId: 'topic-a', available: 1 }],
        rowsByTopic: { 'topic-a': ['a-1'] },
      });

      const ids = await privateOf(new ExamsService(db)).selectComprehensive(
        STUDENT_ID,
        'konkur',
      );

      expect(ids).toEqual(['a-1']);
      const picks = queries.filter((query) =>
        query.sql.includes('"question"."topic_id" ='),
      );
      expect(picks).toHaveLength(1);
      expect(picks[0].limit).toBe(1);
    });

    it('returns no questions at all when nothing unseen is left', async () => {
      const { db, queries } = comprehensiveDb({ pool: [] });

      const ids = await privateOf(new ExamsService(db)).selectComprehensive(
        STUDENT_ID,
        'konkur',
      );

      expect(ids).toEqual([]);
      expect(
        queries.some((query) => query.sql.includes('"question"."topic_id" =')),
      ).toBe(false);
    });
  });
});
