import type { Db } from '../../db/db.module';
import {
  groupWeakTopics,
  HistoryContextService,
  MAX_CONCEPTS_PER_TOPIC,
  MAX_SAMPLES_PER_TOPIC,
  MAX_WEAK_TOPICS,
  SAMPLE_TEXT_MAX_CHARS,
  WINDOW_DAYS,
  type WeakRow,
} from './history-context.service';

const STUDENT_ID = '7f1a9c3e-2b40-4d5a-9c8e-1a2b3c4d5e6f';

/** Build one flat weak row with sensible defaults; override any field. */
function row(overrides: Partial<WeakRow> = {}): WeakRow {
  return {
    studentId: STUDENT_ID,
    topicId: 't1',
    topicTitle: 'مبحث ۱',
    questionId: 'q1',
    questionText: 'متن سوال؟',
    concepts: ['c1'],
    difficultyAi: 3,
    isCorrect: false,
    answeredAt: new Date('2026-01-10T00:00:00.000Z'),
    ...overrides,
  };
}

/** Construction helper: direct instantiation, no Nest module (house style). */
function makeService(db: Db): HistoryContextService {
  return new HistoryContextService(db);
}

/**
 * Build a fluent mock of the Drizzle query chain used by buildForStudent:
 * select().from().innerJoin().innerJoin().leftJoin().where().orderBy().
 * `rows` is what the final `.orderBy()` resolves with.
 */
function mockDb(rows: WeakRow[]): {
  db: Db;
  log: {
    select: jest.Mock;
    from: jest.Mock;
    where: jest.Mock;
    orderBy: jest.Mock;
  };
} {
  const orderBy = jest.fn(() => Promise.resolve(rows));
  const where = jest.fn((): { orderBy: jest.Mock } => ({ orderBy }));

  type JoinBuilder = {
    innerJoin: jest.Mock;
    leftJoin: jest.Mock;
    where: jest.Mock;
  };
  const ring: JoinBuilder = {
    innerJoin: jest.fn(() => ring),
    leftJoin: jest.fn(() => ring),
    where,
  };
  const from = jest.fn(() => ring);
  const select = jest.fn(() => ({ from }));

  return {
    db: { select } as unknown as Db,
    log: { select, from, where, orderBy },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HistoryContextService.groupWeakTopics (pure)', () => {
  it('a) empty history produces an empty weakTopics list', () => {
    expect(groupWeakTopics([])).toEqual([]);
  });

  it('b) groups by topicId, ranks by wrongCount desc, caps at 5 topics', () => {
    const rows: WeakRow[] = [
      // t1 — 3 answers, only 2 distinct questions.
      row({
        topicId: 't1',
        topicTitle: 'T1',
        questionId: 'q-a',
        answeredAt: new Date('2026-01-01T00:00:00Z'),
      }),
      row({
        topicId: 't1',
        topicTitle: 'T1',
        questionId: 'q-a',
        answeredAt: new Date('2026-01-02T00:00:00Z'),
      }),
      row({
        topicId: 't1',
        topicTitle: 'T1',
        questionId: 'q-b',
        answeredAt: new Date('2026-01-03T00:00:00Z'),
      }),
      // t2 — 5 answers (top).
      row({ topicId: 't2', topicTitle: 'T2', questionId: 'q-c' }),
      row({ topicId: 't2', topicTitle: 'T2', questionId: 'q-d' }),
      row({ topicId: 't2', topicTitle: 'T2', questionId: 'q-e' }),
      row({ topicId: 't2', topicTitle: 'T2', questionId: 'q-f' }),
      row({ topicId: 't2', topicTitle: 'T2', questionId: 'q-g' }),
      // t3 — 2 answers.
      row({ topicId: 't3', topicTitle: 'T3', questionId: 'q-h' }),
      row({ topicId: 't3', topicTitle: 'T3', questionId: 'q-i' }),
      // t4 — 1 answer (smallest → dropped by the cap).
      row({ topicId: 't4', topicTitle: 'T4', questionId: 'q-j' }),
      // t5 — 2 answers.
      row({ topicId: 't5', topicTitle: 'T5', questionId: 'q-k' }),
      row({ topicId: 't5', topicTitle: 'T5', questionId: 'q-l' }),
      // t6 — 4 answers (kept, above t3/t5).
      row({ topicId: 't6', topicTitle: 'T6', questionId: 'q-m' }),
      row({ topicId: 't6', topicTitle: 'T6', questionId: 'q-n' }),
      row({ topicId: 't6', topicTitle: 'T6', questionId: 'q-o' }),
      row({ topicId: 't6', topicTitle: 'T6', questionId: 'q-p' }),
    ];

    const topics = groupWeakTopics(rows);

    // Kept: t2(5), t6(4), t1(3), t3(2), t5(2). Dropped: t4(1).
    expect(topics).toHaveLength(MAX_WEAK_TOPICS);
    expect(topics.map((t) => t.topicId)).toEqual([
      't2',
      't6',
      't1',
      't3',
      't5',
    ]);
    expect(topics.map((t) => t.wrongCount)).toEqual([5, 4, 3, 2, 2]);

    // Distinct question counting: t1 had 3 answers across 2 distinct questions.
    const t1 = topics.find((t) => t.topicId === 't1');
    expect(t1?.distinctWrongQuestions).toBe(2);
    expect(t1?.lastWrongAt).toEqual(new Date('2026-01-03T00:00:00Z'));
  });

  it('c) null-topic rows are excluded from weakTopics', () => {
    const topics = groupWeakTopics([
      row({ topicId: null, topicTitle: null, questionId: 'q-null-1' }),
      row({ topicId: null, topicTitle: null, questionId: 'q-null-2' }),
      row({ topicId: 't1', questionId: 'q-real' }),
    ]);

    expect(topics.map((t) => t.topicId)).toEqual(['t1']);
    // The null-topic wrong answers are still visible to the caller via
    // HistoryContext.totalWrong (asserted in the integration test).
    expect(topics[0]?.wrongCount).toBe(1);
  });

  it('d) de-duplicates concepts, caps and truncates samples', () => {
    const longText = 'س'.repeat(SAMPLE_TEXT_MAX_CHARS + 50);

    // Most recent 5 rows (encountered first) supply the samples; row order in
    // the array mirrors buildForStudent's answeredAt DESC ordering.
    const rows: WeakRow[] = [
      row({
        questionId: 'q-s1',
        questionText: `x${longText}`,
        concepts: ['a', 'b'],
      }),
      row({
        questionId: 'q-s2',
        questionText: 'short text 2',
        concepts: ['b', 'c'],
      }),
      row({
        questionId: 'q-s3',
        questionText: 'short text 3',
        concepts: ['c', 'a'],
      }),
      row({
        questionId: 'q-s4',
        questionText: 'short text 4',
        concepts: ['a'],
      }),
      row({
        questionId: 'q-s5',
        questionText: 'short text 5',
        concepts: ['d'],
      }),
    ];

    const [topic] = groupWeakTopics(rows);

    // Concepts: union de-duped across all rows (still under the cap here).
    expect(topic.concepts).toEqual(['a', 'b', 'c', 'd']);

    // Samples: capped at 5, first 5 in DESC order, truncated to 300 chars.
    expect(topic.sampleWrongTexts).toHaveLength(MAX_SAMPLES_PER_TOPIC);
    expect(topic.sampleWrongTexts[0]).toBe(
      `x${longText}`.slice(0, SAMPLE_TEXT_MAX_CHARS),
    );
    expect(topic.sampleWrongTexts[0].length).toBe(SAMPLE_TEXT_MAX_CHARS);
    expect(topic.sampleWrongTexts[1]).toBe('short text 2');
  });

  it('d2) caps the concept union at MAX_CONCEPTS_PER_TOPIC', () => {
    const manyConcepts = Array.from(
      { length: MAX_CONCEPTS_PER_TOPIC + 3 },
      (_, i) => `concept-${i}`,
    );
    const [topic] = groupWeakTopics([
      row({ questionId: 'q-cap-1', concepts: manyConcepts }),
      row({ questionId: 'q-cap-2', concepts: ['x', 'y'] }),
    ]);

    expect(topic.concepts).toHaveLength(MAX_CONCEPTS_PER_TOPIC);
    expect(topic.concepts).toEqual([
      'concept-0',
      'concept-1',
      'concept-2',
      'concept-3',
      'concept-4',
      'concept-5',
      'concept-6',
      'concept-7',
      'concept-8',
      'concept-9',
    ]);
    // Once the cap is full, later rows' new concepts are discarded.
    expect(topic.concepts).not.toContain('x');
    expect(topic.concepts).not.toContain('concept-10');
  });

  it('e) averages non-null difficultyAi rounded to 1 decimal; null when all null', () => {
    const mixed = groupWeakTopics([
      row({ questionId: 'q1', difficultyAi: 1 }),
      row({ questionId: 'q2', difficultyAi: 2 }),
      row({ questionId: 'q3', difficultyAi: 4 }),
      row({ questionId: 'q4', difficultyAi: null }),
    ]);
    expect(mixed[0]?.avgDifficulty).toBe(2.3); // (1+2+4)/3 = 2.333…

    const allNull = groupWeakTopics([
      row({ questionId: 'q1', difficultyAi: null }),
      row({ questionId: 'q2', difficultyAi: null }),
    ]);
    expect(allNull[0]?.avgDifficulty).toBeNull();
  });
});

describe('HistoryContextService.buildForStudent (integration / mocked DB)', () => {
  it('a) empty history returns { weakTopics: [], totalWrong: 0 }', async () => {
    const { db, log } = mockDb([]);
    const svc = makeService(db);

    const ctx = await svc.buildForStudent(STUDENT_ID);

    expect(ctx).toEqual({
      studentId: STUDENT_ID,
      totalWrong: 0,
      windowDays: WINDOW_DAYS,
      weakTopics: [],
    });
    expect(log.select).toHaveBeenCalledTimes(1);
    expect(log.from).toHaveBeenCalledTimes(1);
    expect(log.where).toHaveBeenCalledTimes(1);
    expect(log.orderBy).toHaveBeenCalledTimes(1);
  });

  it('f) composes the query path and grouping over flat DB rows, including null-topic totalWrong', async () => {
    const { db } = mockDb([
      row({ topicId: null, topicTitle: null, questionId: 'q-null-1' }),
      row({ topicId: null, topicTitle: null, questionId: 'q-null-2' }),
      row({ topicId: 't1', topicTitle: 'مبحث اول', questionId: 'q-1' }),
      row({ topicId: 't1', topicTitle: 'مبحث اول', questionId: 'q-2' }),
      row({ topicId: 't1', topicTitle: 'مبحث اول', questionId: 'q-2' }),
      row({ topicId: 't2', topicTitle: 'مبحث دوم', questionId: 'q-3' }),
    ]);
    const svc = makeService(db);

    const ctx = await svc.buildForStudent(STUDENT_ID);

    // 4 wrong answers belong to a topic; the 2 null-topic ones are counted in
    // totalWrong but never appear as a weak topic.
    expect(ctx.totalWrong).toBe(6);
    expect(ctx.weakTopics.map((t) => t.topicId)).toEqual(['t1', 't2']);
    expect(ctx.weakTopics).toHaveLength(2);

    const t1 = ctx.weakTopics.find((t) => t.topicId === 't1');
    expect(t1?.topicTitle).toBe('مبحث اول');
    expect(t1?.wrongCount).toBe(3);
    expect(t1?.distinctWrongQuestions).toBe(2);
  });
});
