// Factory mock: ai.service (imported transitively) keeps a runtime
// `require('@nestjs/axios')` via emitDecoratorMetadata; the factory mock
// avoids loading the real ESM-only package (same pattern as ai.service.spec).
jest.mock('@nestjs/axios', () => ({
  HttpService: class {
    post = jest.fn();
  },
}));

import { Logger, NotFoundException } from '@nestjs/common';

import type { Db } from '../../db/db.module';
import { answerKey } from '../../db/schema/answer-key';
import { explanation } from '../../db/schema/explanation';
import { question } from '../../db/schema/question';
import type { AIService } from './ai.service';
import type {
  HistoryContextService,
  WeakTopicContext,
} from './history-context.service';
import {
  DRAFT_PROMPT_VERSION,
  MUTATE_PROMPT_VERSION,
  QuestionDrafterService,
  VERIFY_PROMPT_VERSION,
  validateAiDrafts,
  type AiDraft,
} from './question-drafter.service';

const STUDENT_ID = '7f1a9c3e-2b40-4d5a-9c8e-1a2b3c4d5e6f';
const TOPIC_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';
const SOURCE_ID = '11111111-2222-4333-8444-555555555555';
const GENERATED_ID = '99999999-8888-4777-8666-555555555555';

/** A fully valid AI draft (passes validateAiDrafts). */
function makeDraft(overrides: Partial<AiDraft> = {}): AiDraft {
  return {
    topicId: TOPIC_ID,
    text: 'متن سوال آزمایشی درباره جمع کسرها چیست؟',
    options: ['گزینه یک', 'گزینه دو', 'گزینه سه', 'گزینه چهار'],
    correctOptionIndex: 0,
    explanation: 'توضیح کامل درباره روش حل این سوال آزمایشی',
    concepts: ['جمع کسر'],
    difficulty: 2,
    ...overrides,
  };
}

/** A weak topic as returned by HistoryContextService.buildForStudent. */
function makeWeakTopic(
  overrides: Partial<WeakTopicContext> = {},
): WeakTopicContext {
  return {
    topicId: TOPIC_ID,
    topicTitle: 'ریاضی',
    wrongCount: 3,
    distinctWrongQuestions: 2,
    lastWrongAt: new Date('2026-01-01T00:00:00Z'),
    concepts: ['جمع کسر'],
    sampleWrongTexts: ['قدیمی: متن سوال اشتباه قبلی دانش آموز در آزمون'],
    avgDifficulty: 2.4,
    ...overrides,
  };
}

/**
 * Mock DB: `select().from().leftJoin()...where().limit()` resolves
 * `sourceRows` (mutate source load); `transaction(fn)` runs fn against a
 * capturing mockTx whose `.insert(t).values(v)` pushes { table, values }.
 */
function makeDb(sourceRows: Record<string, unknown>[] = []) {
  const inserted: { table: unknown; values: Record<string, unknown> }[] = [];
  const returning = jest.fn(() => Promise.resolve([{ id: GENERATED_ID }]));

  const tx = {
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((vals: Record<string, unknown>) => {
        inserted.push({ table, values: vals });
        return { returning };
      }),
    })),
  };

  const limit = jest.fn(() => Promise.resolve(sourceRows));
  const where = jest.fn(() => ({ limit }));

  type JoinBuilder = { leftJoin: jest.Mock; where: jest.Mock };
  const ring: JoinBuilder = {
    leftJoin: jest.fn(() => ring),
    where,
  };
  const from = jest.fn(() => ring);
  const select = jest.fn(() => ({ from }));
  const transaction = jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx));

  const db = { select, transaction } as unknown as Db;
  return { db, tx, inserted, log: { select, from, where, limit, transaction } };
}

/** Mock AIService exposing only runJob. */
function makeAi() {
  const runJob = jest.fn();
  return { ai: { runJob } as unknown as AIService, runJob };
}

/** Mock HistoryContextService exposing only buildForStudent. */
function makeHistory(weakTopics: WeakTopicContext[]) {
  const buildForStudent = jest.fn().mockResolvedValue({
    studentId: STUDENT_ID,
    totalWrong: weakTopics.length,
    windowDays: 30,
    weakTopics,
  });
  return {
    history: { buildForStudent } as unknown as HistoryContextService,
    buildForStudent,
  };
}

/**
 * Wire runJob to behave like the real one for the two prompt versions:
 * the draft call parses the supplied drafts JSON; the verify call parses
 * {"answer": verifyAnswer}.
 */
function stubRunJob(
  runJob: jest.Mock,
  draftsJson: unknown,
  verifyAnswer: number,
) {
  runJob.mockImplementation(
    (input: { promptVersion: string; parse: (raw: string) => unknown }) => {
      if (
        input.promptVersion === DRAFT_PROMPT_VERSION ||
        input.promptVersion === MUTATE_PROMPT_VERSION
      ) {
        return Promise.resolve(input.parse(JSON.stringify(draftsJson)));
      }
      if (input.promptVersion === VERIFY_PROMPT_VERSION) {
        return Promise.resolve(
          input.parse(JSON.stringify({ answer: verifyAnswer })),
        );
      }
      return Promise.reject(
        new Error(`unexpected runJob call: ${input.promptVersion}`),
      );
    },
  );
}

function makeService(db: Db, ai: AIService, history: HistoryContextService) {
  return new QuestionDrafterService(db, ai, history);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QuestionDrafterService', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe('generateDraftsForStudent', () => {
    it('a) no weak topics -> zero AI calls and zero counts', async () => {
      const { db, log } = makeDb();
      const { ai, runJob } = makeAi();
      const { history, buildForStudent } = makeHistory([]);
      const svc = makeService(db, ai, history);

      const result = await svc.generateDraftsForStudent(STUDENT_ID);

      expect(result).toEqual({ created: 0, published: 0, deferred: 0 });
      expect(buildForStudent).toHaveBeenCalledWith(STUDENT_ID);
      expect(runJob).not.toHaveBeenCalled();
      expect(log.transaction).not.toHaveBeenCalled();
    });

    it('b) happy path: two runJob calls per draft, published with origin ai + ai_generated explanation', async () => {
      const { db, tx, inserted, log } = makeDb();
      const { ai, runJob } = makeAi();
      const draft = makeDraft();
      const { history } = makeHistory([makeWeakTopic()]);
      stubRunJob(runJob, [draft], draft.correctOptionIndex);
      const svc = makeService(db, ai, history);

      const result = await svc.generateDraftsForStudent(STUDENT_ID, 5);

      // One draft call + one verification call per draft.
      expect(runJob).toHaveBeenCalledTimes(2);
      expect(runJob).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          operation: 'question_draft',
          promptVersion: DRAFT_PROMPT_VERSION,
        }),
      );
      expect(runJob).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          operation: 'question_draft',
          promptVersion: VERIFY_PROMPT_VERSION,
        }),
      );

      expect(result).toEqual({ created: 1, published: 1, deferred: 0 });

      // One transaction for the whole batch.
      expect(log.transaction).toHaveBeenCalledTimes(1);
      expect(tx.insert).toHaveBeenCalledTimes(3);

      const [qRow, keyRow, explRow] = inserted;
      expect(qRow.table).toBe(question);
      expect(qRow.values).toMatchObject({
        status: 'published',
        origin: 'ai',
        version: 1,
        type: 'multiple_choice',
        topicId: TOPIC_ID,
        text: draft.text,
        subject: 'ریاضی',
        difficultyAi: 2,
        hasTrap: false,
      });
      expect(keyRow.table).toBe(answerKey);
      expect(keyRow.values).toMatchObject({
        questionId: GENERATED_ID,
        questionVersion: 1,
        correctOptionIndex: draft.correctOptionIndex,
      });
      expect(explRow.table).toBe(explanation);
      expect(explRow.values).toMatchObject({
        questionId: GENERATED_ID,
        questionVersion: 1,
        origin: 'ai_generated',
        body: draft.explanation,
      });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('c) verify mismatch -> status draft, warn logged, still counted created', async () => {
      const { db, inserted } = makeDb();
      const { ai, runJob } = makeAi();
      const draft = makeDraft({ correctOptionIndex: 0 });
      const { history } = makeHistory([makeWeakTopic()]);
      stubRunJob(runJob, [draft], 1); // model solves it as option 1 ≠ key 0
      const svc = makeService(db, ai, history);

      const result = await svc.generateDraftsForStudent(STUDENT_ID);

      expect(result).toEqual({ created: 1, published: 0, deferred: 1 });
      expect(inserted[0]?.values).toMatchObject({ status: 'draft' });
      expect(warnSpy).toHaveBeenCalled();
    });

    it('d) generate runJob rejects -> exception surfaces, nothing inserted', async () => {
      const { db, inserted, log } = makeDb();
      const { ai, runJob } = makeAi();
      const { history } = makeHistory([makeWeakTopic()]);
      runJob.mockRejectedValue(new Error('boom'));
      const svc = makeService(db, ai, history);

      await expect(svc.generateDraftsForStudent(STUDENT_ID)).rejects.toThrow(
        'boom',
      );
      expect(inserted).toHaveLength(0);
      expect(log.transaction).not.toHaveBeenCalled();
    });
  });

  describe('validateAiDrafts (pure)', () => {
    const allowed = new Set([TOPIC_ID]);
    const raw = (items: unknown[]) => JSON.stringify(items);

    it('accepts a valid single-item array', () => {
      const draft = makeDraft();
      const out = validateAiDrafts(raw([draft]), allowed, [], 5);
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual(draft);
    });

    it('normalizes a bare single JSON object (mutate flow)', () => {
      const draft = makeDraft();
      const out = validateAiDrafts(JSON.stringify(draft), allowed, [], 1);
      expect(out).toEqual([draft]);
    });

    it('rejects a wrong topicId', () => {
      expect(() =>
        validateAiDrafts(
          raw([makeDraft({ topicId: 'other' })]),
          allowed,
          [],
          5,
        ),
      ).toThrow(/topicId/);
    });

    it('rejects 3 or 5 options', () => {
      expect(() =>
        validateAiDrafts(
          raw([makeDraft({ options: ['a', 'b', 'c'] })]),
          allowed,
          [],
          5,
        ),
      ).toThrow(/options/);
      expect(() =>
        validateAiDrafts(
          raw([makeDraft({ options: ['a', 'b', 'c', 'd', 'e'] })]),
          allowed,
          [],
          5,
        ),
      ).toThrow(/options/);
    });

    it('rejects a bad correctOptionIndex (4, negative, non-integer)', () => {
      for (const bad of [4, -1, 1.5]) {
        expect(() =>
          validateAiDrafts(
            raw([makeDraft({ correctOptionIndex: bad as 0 })]),
            allowed,
            [],
            5,
          ),
        ).toThrow(/correctOptionIndex/);
      }
    });

    it('rejects short text', () => {
      expect(() =>
        validateAiDrafts(raw([makeDraft({ text: 'کوتاه' })]), allowed, [], 5),
      ).toThrow(/text/);
    });

    it('rejects a bad difficulty (0, 4, non-integer)', () => {
      for (const bad of [0, 4, 2.5]) {
        expect(() =>
          validateAiDrafts(
            raw([makeDraft({ difficulty: bad as 1 })]),
            allowed,
            [],
            5,
          ),
        ).toThrow(/difficulty/);
      }
    });

    it('rejects a verbatim sample duplicate (50-char prefix match)', () => {
      const sample =
        'این متن سوال نمونه است که عمدا طولانی نوشته شده تا پیشوند پنجاه کاراکتری کامل شود';
      const copy = `${sample.slice(0, 55)} و کمی تغییر`;
      expect(() =>
        validateAiDrafts(
          raw([makeDraft({ text: copy })]),
          allowed,
          [sample],
          5,
        ),
      ).toThrow(/similar/);
    });

    it('rejects in-batch duplicate texts', () => {
      const draft = makeDraft();
      expect(() =>
        validateAiDrafts(raw([draft, { ...draft }]), allowed, [], 5),
      ).toThrow(/duplicate/);
    });
  });

  describe('mutateQuestion', () => {
    const sourceRow = {
      id: SOURCE_ID,
      topicId: TOPIC_ID,
      topicTitle: 'ریاضی',
      text: 'متن سوال منبع برای جهش هوش مصنوعی',
      options: ['۱', '۲', '۳', '۴'],
      correctOptionIndex: 2,
      concepts: ['جمع کسر'],
      difficultyAi: 3,
    };

    it('missing source -> NotFound', async () => {
      const { db } = makeDb([]);
      const { ai, runJob } = makeAi();
      const { history } = makeHistory([]);
      const svc = makeService(db, ai, history);

      await expect(svc.mutateQuestion(SOURCE_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(runJob).not.toHaveBeenCalled();
    });

    it('happy path -> published with topicId fixed to source and source difficulty/concepts', async () => {
      const { db, inserted } = makeDb([sourceRow]);
      const { ai, runJob } = makeAi();
      const draft = makeDraft({
        topicId: TOPIC_ID,
        correctOptionIndex: 2,
        difficulty: 2, // validator needs 1|2|3; source override wins below
      });
      const { history } = makeHistory([]);
      stubRunJob(runJob, [draft], 2); // verify agrees with key 2
      const svc = makeService(db, ai, history);

      const result = await svc.mutateQuestion(SOURCE_ID);

      expect(result).toEqual({ created: 1, published: 1, deferred: 0 });
      expect(inserted[0]?.values).toMatchObject({
        status: 'published',
        origin: 'ai',
        topicId: TOPIC_ID, // fixed to the source topic
        difficultyAi: 3, // copied from source, not the draft's 2
        concepts: ['جمع کسر'],
        subject: 'ریاضی',
      });
    });

    it('verify mismatch -> status draft', async () => {
      const { db, inserted } = makeDb([sourceRow]);
      const { ai, runJob } = makeAi();
      const draft = makeDraft({ topicId: TOPIC_ID, correctOptionIndex: 2 });
      const { history } = makeHistory([]);
      stubRunJob(runJob, [draft], 0); // disagrees with key 2
      const svc = makeService(db, ai, history);

      const result = await svc.mutateQuestion(SOURCE_ID);

      expect(result).toEqual({ created: 1, published: 0, deferred: 1 });
      expect(inserted[0]?.values).toMatchObject({ status: 'draft' });
      expect(warnSpy).toHaveBeenCalled();
    });
  });
});
