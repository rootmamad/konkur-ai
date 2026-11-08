// `explanation.service` -> `ai.service` imports the ESM-only @nestjs/axios
// package; the fake AIService below never uses HTTP, so intercept it here.
jest.mock('@nestjs/axios', () => ({
  HttpService: class {},
}));

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Db } from '../../db/db.module';
import { answerKey } from '../../db/schema/answer-key';
import { explanation } from '../../db/schema/explanation';
import { question } from '../../db/schema/question';
import { response } from '../../db/schema/response';
import { student } from '../../db/schema/student';
import { UserRole } from '../users/enums/user-role.enum';
import type { AIService, RunJobInput } from '../ai/ai.service';
import { ExplanationService, parseExplanation } from './explanation.service';
import type { ExplanationOutput } from './explanation.service';

const QUESTION_ID = '5b7f5c62-0d2e-4d1f-9a3b-8c6e2f4a1d09';
const STUDENT_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';
const USER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

const VERSION = 3;
const STEM = 'مشتق تابع f(x)=x² در نقطه x=2 چند است؟';
const OPTIONS = [
  { index: 0, text: '۲' },
  { index: 1, text: '۴' },
];
const KEY = { correctOptionIndex: 1, correctText: null };

const BODY =
  'مشتق تابع x² برابر 2x است؛ با جای‌گذاری x=2 مقدار ۴ به دست می‌آید. ' +
  'دام رایج این تست جای‌گذاری در خود تابع به‌جای مشتق آن است.';

type Row = Record<string, unknown>;

const dialect = new PgDialect();

interface MakeDbData {
  /** Rows of the `question` lookup. */
  questions?: Row[];
  /** Rows of the `answer_key` lookup. */
  keys?: Row[];
  /** Rows of the `explanation` lookup (all origins). */
  explanations?: Row[];
  /** Rows of the `response` join (non-empty = the student answered). */
  responses?: Row[];
  /** Rows of the account -> student lookup. */
  students?: Row[];
}

/**
 * Fluent mock of the chains used by ExplanationService:
 *   select(...).from(t).where(c).limit(n)
 *   select(...).from(t).where(c)              (explanation list)
 *   select(...).from(response).innerJoin(...).where(c).limit(n)
 *   insert(t).values(v)
 *
 * Captured conditions keep their table so tests can render real SQL with
 * `dialect.sqlToQuery` instead of inspecting Drizzle internals. Inserted
 * explanation rows are appended to the store, so a second call sees the cache.
 */
function makeDb(data: MakeDbData = {}, events: string[] = []) {
  const tables = new Map<unknown, Row[]>([
    [question, [...(data.questions ?? [])]],
    [answerKey, [...(data.keys ?? [])]],
    [explanation, [...(data.explanations ?? [])]],
    [response, [...(data.responses ?? [])]],
    [student, [...(data.students ?? [])]],
  ]);

  const conditions: { table: unknown; condition: SQL }[] = [];
  const inserts: { table: unknown; values: Row }[] = [];

  const select = jest.fn(() => ({
    from: (table: unknown) => {
      const source = (): Row[] => tables.get(table) ?? [];

      const chain = {
        innerJoin: () => chain,
        where: (condition: SQL) => {
          conditions.push({ table, condition });
          return chain;
        },
        orderBy: () => chain,
        limit: (count: number) => Promise.resolve(source().slice(0, count)),
        then: (resolve: (value: Row[]) => void) => resolve(source()),
      };
      return chain;
    },
  }));

  const insert = jest.fn((table: unknown) => ({
    values: (values: Row) => {
      events.push('insert');
      inserts.push({ table, values });
      tables.get(table)?.push(values);
      return { then: (resolve: (value: unknown) => void) => resolve([]) };
    },
  }));

  const db = { select, insert } as unknown as Db;

  return {
    db,
    log: {
      conditions,
      inserts,
      select,
      insert,
      /** Conditions captured for one table, in call order. */
      conditionsFor: (table: unknown) =>
        conditions.filter((item) => item.table === table),
    },
  };
}

function makeAi(
  result: ExplanationOutput = { body: BODY },
  events: string[] = [],
) {
  /** Typed record of every runJob input, so assertions stay type-safe. */
  const calls: RunJobInput<ExplanationOutput>[] = [];
  const runJob = jest.fn((input: RunJobInput<ExplanationOutput>) => {
    calls.push(input);
    events.push('model');
    return Promise.resolve(result);
  });
  return { service: { runJob } as unknown as AIService, runJob, calls };
}

interface BuildOptions extends MakeDbData {
  aiResult?: ExplanationOutput;
}

function build(options: BuildOptions = {}) {
  const events: string[] = [];
  const { db, log } = makeDb(options, events);
  const ai = makeAi(options.aiResult, events);
  const service = new ExplanationService(db, ai.service);
  return { service, log, ai, events };
}

/** A published question with an answer key, ready for the cache lookups. */
const questionRow = (overrides: Row = {}): Row => ({
  id: QUESTION_ID,
  version: VERSION,
  text: STEM,
  type: 'multiple_choice',
  options: OPTIONS,
  status: 'published',
  ...overrides,
});

const admin = { role: UserRole.ADMIN, userId: USER_ID };
const studentViewer = { role: UserRole.STUDENT, userId: USER_ID };

const answered = (): MakeDbData => ({
  questions: [questionRow()],
  keys: [KEY],
  responses: [{ id: 'r-1' }],
  students: [{ id: STUDENT_ID }],
});

describe('ExplanationService', () => {
  it('a) getExplanation serves the best origin: official > source_book > ai_generated', async () => {
    const all: Row[] = [
      { origin: 'ai_generated', body: 'AI' },
      { origin: 'source_book', body: 'BOOK' },
      { origin: 'official', body: 'OFFICIAL' },
    ];

    const withAll = build({ ...answered(), explanations: all });
    await expect(
      withAll.service.getExplanation(QUESTION_ID, admin),
    ).resolves.toEqual({ origin: 'official', body: 'OFFICIAL' });

    const noOfficial = build({
      ...answered(),
      explanations: [{ origin: 'ai_generated', body: 'AI' }],
    });
    await expect(
      noOfficial.service.getExplanation(QUESTION_ID, admin),
    ).resolves.toEqual({ origin: 'ai_generated', body: 'AI' });

    const bookOnly = build({
      ...answered(),
      explanations: [
        { origin: 'ai_generated', body: 'AI' },
        { origin: 'source_book', body: 'BOOK' },
      ],
    });
    await expect(
      bookOnly.service.getExplanation(QUESTION_ID, admin),
    ).resolves.toEqual({ origin: 'source_book', body: 'BOOK' });

    // The cache key is (question_id, question_version) — never origin-agnostic.
    const [condition] = withAll.log.conditionsFor(explanation);
    const { sql: text, params } = dialect.sqlToQuery(condition.condition);
    expect(text).toContain('"explanation"."question_id" =');
    expect(text).toContain('"explanation"."question_version" =');
    expect(params).toEqual([QUESTION_ID, VERSION]);
  });

  it('b) STUDENT is refused until a response row exists; ADMIN always reads', async () => {
    const unanswered = build({ ...answered(), responses: [] });
    await expect(
      unanswered.service.getExplanation(QUESTION_ID, studentViewer),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      unanswered.service.getExplanation(QUESTION_ID, studentViewer),
    ).rejects.toThrow(/after you have answered/);
    // Refused means nothing was even looked up for serving.
    expect(unanswered.log.conditionsFor(explanation)).toHaveLength(0);

    const answeredOnce = build({
      ...answered(),
      explanations: [{ origin: 'ai_generated', body: 'AI' }],
    });
    await expect(
      answeredOnce.service.getExplanation(QUESTION_ID, studentViewer),
    ).resolves.toEqual({ origin: 'ai_generated', body: 'AI' });

    // The viewability query is scoped to this student and this question.
    const [viewCondition] = answeredOnce.log.conditionsFor(response);
    const { sql: viewSql, params } = dialect.sqlToQuery(
      viewCondition.condition,
    );
    expect(viewSql).toContain('"attempt"."student_id" =');
    expect(viewSql).toContain('"response"."question_id" =');
    expect(params).toEqual([STUDENT_ID, QUESTION_ID]);

    // ADMIN never needs a student profile or a response row.
    const adminView = build({
      questions: [questionRow()],
      keys: [KEY],
      explanations: [{ origin: 'official', body: 'OFFICIAL' }],
    });
    await expect(
      adminView.service.getExplanation(QUESTION_ID, admin),
    ).resolves.toEqual({ origin: 'official', body: 'OFFICIAL' });
    expect(adminView.log.conditionsFor(response)).toHaveLength(0);
    expect(adminView.log.conditionsFor(student)).toHaveLength(0);
  });

  it('c) 404 when the question is missing or no explanation is stored', async () => {
    const missing = build({ questions: [] });
    await expect(
      missing.service.getExplanation(QUESTION_ID, admin),
    ).rejects.toThrow(NotFoundException);
    await expect(
      missing.service.getExplanation(QUESTION_ID, admin),
    ).rejects.toThrow('Question not found');

    const unansweredButFound = build(answered());
    await expect(
      unansweredButFound.service.getExplanation(QUESTION_ID, studentViewer),
    ).rejects.toThrow(NotFoundException);

    const adminNoNote = build({ questions: [questionRow()], keys: [KEY] });
    await expect(
      adminNoNote.service.getExplanation(QUESTION_ID, admin),
    ).rejects.toThrow('No explanation for this question');
  });

  it('d) generate is a no-op when a trusted explanation already exists', async () => {
    for (const origin of ['official', 'source_book'] as const) {
      const { service, log, ai } = build({
        ...answered(),
        explanations: [{ origin, body: 'trusted' }],
      });

      await service.generateExplanation(QUESTION_ID, admin);

      expect(ai.runJob).not.toHaveBeenCalled();
      expect(log.inserts).toHaveLength(0);
    }
  });

  it('e) cache miss runs explain with the key, inserts exactly one ai_generated row after the call; cache hit does not call again', async () => {
    const { service, log, ai, events } = build(answered());

    await service.generateExplanation(QUESTION_ID, admin);

    expect(ai.runJob).toHaveBeenCalledTimes(1);
    const input = ai.calls[0];
    expect(input.operation).toBe('explain');
    expect(input.promptVersion).toBe('explain-v1');
    expect(typeof input.parse).toBe('function');
    // Stem AND the correct choice (from answer_key) reach the model.
    expect(input.prompt).toContain(STEM);
    expect(input.prompt).toContain('۴');
    expect(input.prompt).toContain('پاسخ درست');
    expect(input.prompt).toContain('{"body"');

    // The recorded parse is the real contract: trims the completion.
    const parsedNote = `  ${BODY}  `;
    expect(input.parse?.(JSON.stringify({ body: parsedNote }))).toEqual({
      body: BODY,
    });

    // Two-phase: the single insert happens only after the model call resolves.
    expect(events).toEqual(['model', 'insert']);
    expect(log.inserts).toHaveLength(1);
    expect(log.inserts[0].table).toBe(explanation);
    expect(log.inserts[0].values).toMatchObject({
      questionId: QUESTION_ID,
      questionVersion: VERSION,
      origin: 'ai_generated',
      body: BODY,
    });

    // Second request is a cache hit: the stored ai_generated row is reused.
    await service.generateExplanation(QUESTION_ID, admin);
    expect(ai.runJob).toHaveBeenCalledTimes(1);
    expect(log.inserts).toHaveLength(1);

    // The parse contract itself (exported pure function).
    expect(parseExplanation(JSON.stringify({ body: parsedNote }))).toEqual({
      body: BODY,
    });
    expect(() => parseExplanation('not json')).toThrow();
    expect(() => parseExplanation('[]')).toThrow(/object/);
    expect(() => parseExplanation(JSON.stringify({ body: 5 }))).toThrow(
      /string/,
    );
    expect(() => parseExplanation(JSON.stringify({ body: 'کوتاه' }))).toThrow(
      /at least/,
    );
    expect(() =>
      parseExplanation(JSON.stringify({ body: 'x'.repeat(2001) })),
    ).toThrow(/at most/);
  });

  it('f) a failed model call writes nothing and rejects the job', async () => {
    const { service, log, ai } = build(answered());
    ai.runJob.mockRejectedValueOnce(new Error('model down'));

    await expect(
      service.generateExplanation(QUESTION_ID, admin),
    ).rejects.toThrow('model down');

    expect(log.inserts).toHaveLength(0);
    expect(ai.runJob).toHaveBeenCalledTimes(1);
  });
});
