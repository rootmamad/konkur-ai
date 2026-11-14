import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Db } from '../../db/db.module';
import {
  answerKey,
  attempt,
  chatMessage,
  correction,
  question,
  response,
  rubric,
} from '../../db/schema';
import type { ChatMessage, ChatThread } from '../../db/schema';
import type { HistoryContext } from '../ai/history-context.service';
import {
  CHAT_HISTORY_WINDOW,
  CHAT_PROMPT_VERSION,
  SEVEN_CLAUSES,
  buildQuestionChatPrompt,
  parseChatReply,
  ChatAiService,
} from './chat-ai.service';

const STUDENT_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';
const THREAD_ID = '5c1f8a2e-9b3d-4c6e-8d7f-1a2b3c4d5e6f';
const QUESTION_ID = '7a9b1c3d-5e7f-4a9b-8c1d-3e5f7a9b1c3d';
const ATTEMPT_ID = '9d8c7b6a-5f4e-4d3c-2b1a-0f9e8d7c6b5a';
const RESPONSE_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

const dialect = new PgDialect();

type Row = Record<string, unknown>;

/** FIFO result set per table; terminal `.limit(n)` slices the set. */
const TABLES: Record<string, unknown> = {
  question,
  answerKey,
  rubric,
  response,
  correction,
  chatMessage,
  attempt,
};

function makeDb(fixtures: Record<string, Row[][]> = {}) {
  const queues = new Map<unknown, Row[][]>();
  for (const [name, sets] of Object.entries(fixtures)) {
    const table = TABLES[name];
    if (!table) throw new Error(`Unknown table fixture: ${name}`);
    queues.set(table, [...sets]);
  }

  const conditions: SQL[] = [];
  const limits: number[] = [];

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
      orderBy() {
        return chain;
      },
      limit(count: number) {
        limits.push(count);
        // The real queries always bound their reads; mirror that.
        return Promise.resolve(result.slice(0, count));
      },
      // Queries without `.limit` (the rubric read) are awaited directly.
      then(resolve: (value: Row[]) => void) {
        resolve(result);
      },
    };
    return chain;
  };

  const select = jest.fn(() => ({
    from: jest.fn((table: unknown) => makeChain(table, take(table))),
  }));

  return { db: { select } as unknown as Db, conditions, limits };
}

function weakTopic(overrides: Partial<HistoryContext['weakTopics'][0]> = {}) {
  return {
    topicId: 'topic-1',
    topicTitle: 'دینامیک',
    wrongCount: 5,
    distinctWrongQuestions: 3,
    lastWrongAt: new Date('2026-05-01T00:00:00.000Z'),
    concepts: ['نیرو'],
    sampleWrongTexts: [],
    avgDifficulty: 3,
    ...overrides,
  };
}

function historyStub(overrides: Partial<HistoryContext> = {}): HistoryContext {
  return {
    studentId: STUDENT_ID,
    totalWrong: 12,
    windowDays: 30,
    weakTopics: [weakTopic()],
    ...overrides,
  };
}

function threadRow(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: THREAD_ID,
    studentId: STUDENT_ID,
    space: 'question',
    questionId: QUESTION_ID,
    attemptId: ATTEMPT_ID,
    createdAt: new Date('2026-05-01T10:00:00.000Z'),
    ...overrides,
  };
}

function messageRow(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 10)}`,
    threadId: THREAD_ID,
    role: 'user',
    body: 'سلام',
    createdAt: new Date('2026-05-01T10:01:00.000Z'),
    ...overrides,
  };
}

function build(
  fixtures: Record<string, Row[][]>,
  options: { history?: HistoryContext; runJob?: () => Promise<string> } = {},
) {
  const { db, conditions, limits } = makeDb(fixtures);
  const historyContext = {
    buildForStudent: jest
      .fn<Promise<HistoryContext>, [string]>()
      .mockResolvedValue(options.history ?? historyStub()),
  };
  const runJob = jest
    .fn<Promise<string>, [unknown]>()
    .mockImplementation(
      options.runJob ?? (() => Promise.resolve('پاسخ دستیار')),
    );
  const service = new ChatAiService(
    db,
    { runJob } as never,
    historyContext as never,
  );
  return { service, runJob, conditions, limits, historyContext };
}

describe('ChatAiService — prompt assembly (spec 9.2)', () => {
  it('sends the seven clauses verbatim, the answer key and the real answer', async () => {
    const { service, runJob } = build({
      question: [
        [
          {
            id: QUESTION_ID,
            version: 2,
            text: 'در شکل روبه‌رو کدام قانون حاکم است؟',
            type: 'multiple_choice',
            options: [
              { index: 0, text: 'قانون اول نیوتن' },
              { index: 1, text: 'قانون دوم نیوتن' },
            ],
          },
        ],
      ],
      answerKey: [[{ correctOptionIndex: 1, correctText: 'قانون دوم نیوتن' }]],
      rubric: [[{ partKey: 'گام اول', maxScore: '1.50', order: 0 }]],
      response: [
        [
          {
            id: RESPONSE_ID,
            selectedOption: 0,
            textAnswer: null,
            isCorrect: false,
            activeSeconds: 45,
          },
        ],
      ],
      correction: [
        [
          {
            partScores: [{ partKey: 'گام اول', score: 0 }],
            totalScore: '0.50',
            status: 'needs_review',
          },
        ],
      ],
      chatMessage: [[messageRow({ body: 'سلام، این سوال را بلد نیستم' })]],
    });

    const reply = await service.reply(threadRow(), STUDENT_ID);

    expect(reply).toBe('پاسخ دستیار');
    expect(runJob).toHaveBeenCalledTimes(1);
    const input = runJob.mock.calls[0][0] as {
      operation: string;
      promptVersion: string;
      prompt: string;
    };
    expect(input.operation).toBe('question_chat');
    expect(input.promptVersion).toBe(CHAT_PROMPT_VERSION);

    const prompt = input.prompt;
    // The seven clauses, VERBATIM (spec 9.2 «عینا»).
    expect(prompt).toContain(SEVEN_CLAUSES);
    // Question layer.
    expect(prompt).toContain('در شکل روبه‌رو کدام قانون حاکم است؟');
    expect(prompt).toContain('- 2) قانون دوم نیوتن');
    // Answer-key layer (stays on the server; prompt only).
    expect(prompt).toContain('پاسخ درست: قانون دوم نیوتن');
    expect(prompt).toContain('گام اول: حداکثر 1.50');
    // The student's REAL response + its correction.
    expect(prompt).toContain('گزینه 1: قانون اول نیوتن');
    expect(prompt).toContain('نتیجه ثبت‌شده: غلط');
    expect(prompt).toContain('needs_review');
    expect(prompt).toContain('0.50');
    // Summary layer.
    expect(prompt).toContain('دینامیک');
    expect(prompt).toContain('مجموع خطاهای اخیر: 12');
  });

  it('sends only the last 10 thread messages, never the full history', async () => {
    // DB order is newest-first (DESC); index 0 = the newest message.
    const window: Row[][] = [
      Array.from({ length: 11 }, (_, i) =>
        messageRow({
          body:
            i === 0
              ? 'KEPT-NEWEST'
              : i === 1
                ? 'KEPT-EDGE'
                : i === 10
                  ? 'DROPPED-OLDEST'
                  : `older-${i}`,
          createdAt: new Date(Date.UTC(2026, 4, 1, 10, 0, 11 - i)),
        }),
      ),
    ];
    const { service, runJob, limits } = build({
      question: [
        [
          {
            id: QUESTION_ID,
            version: 1,
            text: 'سؤال',
            type: 'multiple_choice',
            options: [],
          },
        ],
      ],
      response: [[]],
      chatMessage: window,
    });

    await service.reply(threadRow({ attemptId: null }), STUDENT_ID);

    const prompt = (runJob.mock.calls[0][0] as { prompt: string }).prompt;
    expect(limits).toContain(CHAT_HISTORY_WINDOW);
    expect(limits).not.toContain(11);
    expect(prompt).toContain('KEPT-NEWEST');
    expect(prompt).toContain('KEPT-EDGE');
    expect(prompt).not.toContain('DROPPED-OLDEST');
  });

  it('falls back to the latest response row when the thread has no attempt', async () => {
    const { service, runJob, conditions } = build({
      question: [
        [
          {
            id: QUESTION_ID,
            version: 1,
            text: 'سؤال',
            type: 'descriptive',
            options: [],
          },
        ],
      ],
      response: [
        [
          {
            id: RESPONSE_ID,
            selectedOption: null,
            textAnswer: 'پاسخ نوشتاری من',
            isCorrect: null,
            activeSeconds: 120,
          },
        ],
      ],
      chatMessage: [[]],
    });

    await service.reply(threadRow({ attemptId: null }), STUDENT_ID);

    const prompt = (runJob.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain('پاسخ نوشتاری من');
    // The fallback query is scoped to the CALLER's attempts, not any attempt.
    const where = conditions.map((condition) =>
      dialect.sqlToQuery(condition).sql.toLowerCase(),
    );
    expect(where.join('\n')).toContain('"attempt"."student_id" =');
  });

  it('still replies when the question row is gone (degraded layers)', async () => {
    const { service, runJob } = build({
      question: [[]],
      response: [[]],
      chatMessage: [[]],
    });

    const reply = await service.reply(threadRow(), STUDENT_ID);

    expect(reply).toBe('پاسخ دستیار');
    const prompt = (runJob.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain('در دسترس نیست');
    expect(prompt).toContain('در بانک سؤال ثبت نشده است');
  });
});

describe('buildQuestionChatPrompt / parseChatReply — pure contract', () => {
  it('lists history lines in ascending order with role prefixes', () => {
    const prompt = buildQuestionChatPrompt({
      context: {
        question: null,
        answerKey: null,
        rubric: null,
        userResponse: null,
        correction: null,
        summary: null,
      },
      history: [
        messageRow({ role: 'user', body: 'اولین پیام' }),
        messageRow({ role: 'assistant', body: 'پاسخ اول' }),
      ],
    });

    const historyIndex = prompt.indexOf('تاریخچه گفتگو');
    expect(historyIndex).toBeGreaterThan(0);
    expect(prompt.indexOf('دانش‌آموز: اولین پیام')).toBeGreaterThan(
      historyIndex,
    );
    expect(prompt.indexOf('دستیار: پاسخ اول')).toBeGreaterThan(
      prompt.indexOf('دانش‌آموز: اولین پیام'),
    );
    expect(prompt).toContain(SEVEN_CLAUSES);
  });

  it('trims the reply and rejects an empty one', () => {
    expect(parseChatReply('  پاسخ دستیار  ')).toBe('پاسخ دستیار');
    expect(() => parseChatReply('')).toThrow();
    expect(() => parseChatReply('   ')).toThrow();
  });
});
