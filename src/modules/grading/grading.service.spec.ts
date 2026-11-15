import { BadRequestException } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Db } from '../../db/db.module';
import { correction, question, response, rubric } from '../../db/schema';
import { AIService } from '../ai/ai.service';
import {
  buildGradePrompt,
  GRADE_MODEL_VERSION,
  GRADE_PROMPT_VERSION,
  parseGradeOutput,
  GradingService,
} from './grading.service';
import { SEVEN_CLAUSES } from '../chat/chat-ai.service';

const ATTEMPT_ID = '9d8c7b6a-5f4e-4d3c-2b1a-0f9e8d7c6b5a';
const RESPONSE_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const QUESTION_ID = '7a9b1c3d-5e7f-4a9b-8c1d-3e5f7a9b1c3d';

const dialect = new PgDialect();

const text = (condition: SQL | undefined): string =>
  condition ? dialect.sqlToQuery(condition).sql.toLowerCase() : '';
const params = (condition: SQL | undefined): unknown[] =>
  condition ? dialect.sqlToQuery(condition).params : [];

type Row = Record<string, unknown>;

const TABLES: Record<string, unknown> = {
  response,
  question,
  correction,
  rubric,
};

const RUBRIC_ROW = [
  { partKey: 'گام اول', maxScore: '1.50', order: 1 },
  { partKey: 'گام دوم', maxScore: '2.50', order: 0 },
];

function makeDb(fixtures: Record<string, Row[][]> = {}) {
  const queues = new Map<unknown, Row[][]>();
  for (const [name, sets] of Object.entries(fixtures)) {
    const table = TABLES[name];
    if (!table) throw new Error(`Unknown table fixture: ${name}`);
    queues.set(table, [...sets]);
  }

  const conditions: SQL[] = [];
  const updated: Array<{ table: unknown; values: Row; condition: SQL }> = [];

  const take = (table: unknown): Row[] => queues.get(table)?.shift() ?? [];

  const makeChain = (table: unknown, result: Row[]) => {
    const chain = {
      innerJoin() {
        return chain;
      },
      where(condition: SQL) {
        conditions.push(condition);
        return chain;
      },
      // Reads without `.limit` are awaited directly.
      then(resolve: (value: Row[]) => void) {
        resolve(result);
      },
    };
    return chain;
  };

  const select = jest.fn(() => ({
    from: jest.fn((table: unknown) => makeChain(table, take(table))),
  }));

  const update = jest.fn((table: unknown) => ({
    set: jest.fn((values: Row) => ({
      where: jest.fn((condition: SQL) => {
        updated.push({ table, values, condition });
        return Promise.resolve();
      }),
    })),
  }));

  return {
    db: { select, update } as unknown as Db,
    conditions,
    updated,
  };
}

/** Model stub: happy paths run the REAL parse; failures reject like runJob. */
function makeAi(raw?: string | Error) {
  const runJob = jest.fn(
    (input: {
      parse?: (raw: string) => unknown;
      operation?: string;
      promptVersion?: string;
      prompt?: string;
    }) => {
      if (raw instanceof Error) return Promise.reject(raw);
      if (!input.parse) {
        return Promise.reject(new Error('parse required in this test'));
      }
      try {
        return Promise.resolve(input.parse(raw as string));
      } catch (err: unknown) {
        return Promise.reject(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    },
  );
  return { service: { runJob } as unknown as AIService, runJob };
}

function pendingRow(): Row {
  return {
    responseId: RESPONSE_ID,
    questionId: QUESTION_ID,
    textAnswer: 'پاسخ من',
    questionText: 'مقدار نیرو را بیابید.',
    questionType: 'descriptive',
  };
}

describe('parseGradeOutput — server validation (spec 6)', () => {
  const rubricParts = [
    { partKey: 'گام اول', maxScore: 1.5 },
    { partKey: 'گام دوم', maxScore: 2.5 },
  ];

  it('accepts strict parts, trims evidence, and keeps the uncertain flag', () => {
    const parsed = parseGradeOutput(
      '{"parts":[{"partKey":"گام اول","score":1.5,"evidence":"  F=ma  "}],"uncertain":true}',
      rubricParts,
    );
    expect(parsed).toEqual({
      parts: [{ partKey: 'گام اول', score: 1.5, evidence: 'F=ma' }],
      uncertain: true,
    });
  });

  it.each([
    ['non-JSON', 'سلام'],
    ['non-object JSON', '[1,2]'],
    ['missing parts', '{"uncertain":false}'],
    ['empty parts', '{"parts":[],"uncertain":false}'],
    [
      'unknown partKey',
      '{"parts":[{"partKey":"نامعلوم","score":1,"evidence":"x"}],"uncertain":false}',
    ],
    [
      'score above max',
      '{"parts":[{"partKey":"گام اول","score":2,"evidence":"x"}],"uncertain":false}',
    ],
    [
      'negative score',
      '{"parts":[{"partKey":"گام اول","score":-0.5,"evidence":"x"}],"uncertain":false}',
    ],
    [
      'string score',
      '{"parts":[{"partKey":"گام اول","score":"1","evidence":"x"}],"uncertain":false}',
    ],
    [
      'empty evidence',
      '{"parts":[{"partKey":"گام اول","score":1,"evidence":"   "}],"uncertain":false}',
    ],
    [
      'duplicate partKey',
      '{"parts":[{"partKey":"گام اول","score":1,"evidence":"x"},{"partKey":"گام اول","score":0.5,"evidence":"y"}],"uncertain":false}',
    ],
    [
      'non-boolean uncertain',
      '{"parts":[{"partKey":"گام اول","score":1,"evidence":"x"}],"uncertain":"no"}',
    ],
  ])('rejects %s', (_name, raw) => {
    expect(() => parseGradeOutput(raw, rubricParts)).toThrow();
  });
});

describe('GradingService.gradeAttempt (spec 6, 15.1-item 5)', () => {
  const GOOD =
    '{"parts":[{"partKey":"گام اول","score":1.5,"evidence":"F=ma"},{"partKey":"گام دوم","score":2.25,"evidence":"جمع درست"}],"uncertain":false,"total":99}';

  it('grades the pending row: server total, model total ignored, graded', async () => {
    const { db, updated, conditions } = makeDb({
      response: [[pendingRow()]],
      rubric: [RUBRIC_ROW],
    });
    const { service: aiService, runJob } = makeAi(GOOD);
    const service = new GradingService(db, aiService);

    await service.gradeAttempt(ATTEMPT_ID);

    expect(runJob).toHaveBeenCalledTimes(1);
    const input = runJob.mock.calls[0][0] as {
      operation: string;
      promptVersion: string;
      prompt: string;
    };
    expect(input.operation).toBe('grade');
    expect(input.promptVersion).toBe(GRADE_PROMPT_VERSION);
    expect(input.prompt).toContain(SEVEN_CLAUSES);
    expect(input.prompt).toContain('مقدار نیرو را بیابید.');
    expect(input.prompt).toContain('- گام دوم: حداکثر 2.5');
    expect(input.prompt).toContain('- گام اول: حداکثر 1.5');
    expect(input.prompt).toContain('پاسخ من');

    expect(updated).toHaveLength(1);
    expect(updated[0].table).toBe(correction);
    expect(updated[0].values).toEqual({
      partScores: [
        { partKey: 'گام اول', score: 1.5, evidence: 'F=ma' },
        { partKey: 'گام دوم', score: 2.25, evidence: 'جمع درست' },
      ],
      totalScore: '3.75', // Σ parts in JS — the model's total:99 is ignored
      status: 'graded',
      modelVersion: GRADE_MODEL_VERSION,
    });
    // Guarded write: only a still-pending row can be touched.
    const where = text(updated[0].condition);
    expect(where).toContain('"correction"."response_id" =');
    expect(where).toContain('"correction"."status" =');
    expect(params(updated[0].condition)).toContain('needs_review');
    // The read itself only takes needs_review rows (idempotent re-finish).
    const readWhere = text(conditions[0]);
    expect(readWhere).toContain('"correction"."status" =');
    expect(params(conditions[0])).toContain('needs_review');
    expect(readWhere).toContain('"response"."text_answer" is not null');
  });

  it('keeps needs_review (with parts) when the model is uncertain', async () => {
    const { db, updated } = makeDb({
      response: [[pendingRow()]],
      rubric: [RUBRIC_ROW],
    });
    const { service: aiService, runJob } = makeAi(
      '{"parts":[{"partKey":"گام اول","score":1.5,"evidence":"F=ma"}],"uncertain":true}',
    );
    const service = new GradingService(db, aiService);

    await service.gradeAttempt(ATTEMPT_ID);

    expect(runJob).toHaveBeenCalledTimes(1);
    expect(updated).toHaveLength(1);
    expect(updated[0].values.status).toBe('needs_review');
    expect(updated[0].values.partScores).toEqual([
      { partKey: 'گام اول', score: 1.5, evidence: 'F=ma' },
    ]);
    expect(updated[0].values.totalScore).toBe('1.50');
    expect(updated[0].values.modelVersion).toBe(GRADE_MODEL_VERSION);
  });

  it('never writes when the model output is invalid (stays needs_review)', async () => {
    const { db, updated } = makeDb({
      response: [[pendingRow()]],
      rubric: [RUBRIC_ROW],
    });
    const { service: aiService, runJob } = makeAi(
      new BadRequestException('AI output failed schema validation'),
    );
    const service = new GradingService(db, aiService);

    await expect(service.gradeAttempt(ATTEMPT_ID)).resolves.toBeUndefined();

    expect(runJob).toHaveBeenCalledTimes(1);
    expect(updated).toHaveLength(0);
  });

  it('a job failure leaves the row untouched and does not throw', async () => {
    const { db, updated } = makeDb({
      response: [[pendingRow()]],
      rubric: [RUBRIC_ROW],
    });
    const { service: aiService, runJob } = makeAi(
      new Error('AI request failed: boom'),
    );
    const service = new GradingService(db, aiService);

    await expect(service.gradeAttempt(ATTEMPT_ID)).resolves.toBeUndefined();
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(updated).toHaveLength(0);
  });

  it('skips already-graded rows — nothing pending, nothing runs', async () => {
    const { db, updated, conditions } = makeDb({
      // The needs_review join filters them out server-side: empty result.
      response: [[]],
      rubric: [RUBRIC_ROW],
    });
    const { service: aiService, runJob } = makeAi();
    const service = new GradingService(db, aiService);

    await service.gradeAttempt(ATTEMPT_ID);

    expect(runJob).not.toHaveBeenCalled();
    expect(updated).toHaveLength(0);
    expect(text(conditions[0])).toContain('"response"."attempt_id" =');
    expect(params(conditions[0])).toContain(ATTEMPT_ID);
  });

  it('skips a response without rubric parts instead of inventing a score', async () => {
    const { db, updated } = makeDb({
      response: [[pendingRow()]],
      rubric: [[]],
    });
    const { service: aiService, runJob } = makeAi(GOOD);
    const service = new GradingService(db, aiService);

    await service.gradeAttempt(ATTEMPT_ID);

    expect(runJob).not.toHaveBeenCalled();
    expect(updated).toHaveLength(0);
  });
});

describe('buildGradePrompt — pure contract', () => {
  it('carries the clauses verbatim, rubric sorted by order, and no total request', () => {
    const prompt = buildGradePrompt({
      questionText: 'مقدار نیرو را بیابید.',
      questionType: 'descriptive',
      textAnswer: 'پاسخ من',
      rubric: RUBRIC_ROW.map((part) => ({
        partKey: part.partKey,
        maxScore: Number(part.maxScore),
        order: part.order,
      })),
    });

    expect(prompt).toContain(SEVEN_CLAUSES);
    expect(prompt.indexOf('- گام دوم: حداکثر 2.5')).toBeLessThan(
      prompt.indexOf('- گام اول: حداکثر 1.5'),
    );
    expect(prompt).toContain('پاسخ دانش‌آموز:');
    expect(prompt).toContain('مجموع کل (total) را برنگردان');
    expect(prompt).toContain('"uncertain":false');
  });
});
