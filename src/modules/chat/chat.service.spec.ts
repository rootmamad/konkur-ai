import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Db } from '../../db/db.module';
import { attempt } from '../../db/schema/attempt';
import { chatMessage, chatThread } from '../../db/schema/chat';
import { appConfig } from '../../db/schema/app-config';
import { question } from '../../db/schema/question';
import { student } from '../../db/schema/student';
import { SubscriptionService } from '../billing/subscription.service';
import { ChatAiService } from './chat-ai.service';
import { ChatService, THREAD_LIST_LIMIT } from './chat.service';

const USER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const STUDENT_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';
const THREAD_ID = '5c1f8a2e-9b3d-4c6e-8d7f-1a2b3c4d5e6f';
const QUESTION_ID = '7a9b1c3d-5e7f-4a9b-8c1d-3e5f7a9b1c3d';
const ATTEMPT_ID = '9d8c7b6a-5f4e-4d3c-2b1a-0f9e8d7c6b5a';

const dialect = new PgDialect();

type Row = Record<string, unknown>;
type Space = 'coach' | 'question' | 'exam_analysis';

/** FIFO result set per table; the student lookup repeats, so it never shifts. */
const TABLES: Record<string, unknown> = {
  student,
  chatThread,
  chatMessage,
  appConfig,
  attempt,
  question,
};

/** A question row the ref-ownership check accepts (published, in the bank). */
const publishedQuestion = { id: QUESTION_ID, status: 'published' };
/** An attempt row the ref-ownership check accepts (owned by the caller). */
const ownedAttempt = { id: ATTEMPT_ID, studentId: STUDENT_ID };

function makeDb(fixtures: Record<string, Row[][]> = {}) {
  const queues = new Map<unknown, Row[][]>();
  for (const [name, sets] of Object.entries(fixtures)) {
    const table = TABLES[name];
    if (!table) throw new Error(`Unknown table fixture: ${name}`);
    queues.set(table, [...sets]);
  }
  if (!queues.has(student)) queues.set(student, [[{ id: STUDENT_ID }]]);

  const conditions: SQL[] = [];
  const orders: SQL[][] = [];
  const limits: number[] = [];
  const inserted: Array<{ table: unknown; values: Row }> = [];

  const take = (table: unknown): Row[] => {
    const queue = queues.get(table);
    if (!queue) return [];
    return table === student ? (queue[0] ?? []) : (queue.shift() ?? []);
  };

  const makeChain = (table: unknown, result: Row[]) => {
    const chain = {
      innerJoin() {
        return chain;
      },
      where(condition: SQL) {
        if (table !== student) conditions.push(condition);
        return chain;
      },
      orderBy(...orderings: SQL[]) {
        if (table !== student) orders.push(orderings);
        return chain;
      },
      limit(count: number) {
        if (table !== student) limits.push(count);
        return Promise.resolve(result);
      },
      // Queries without `.limit` (the quota count) are awaited directly.
      then(resolve: (value: Row[]) => void) {
        resolve(result);
      },
    };
    return chain;
  };

  const select = jest.fn(() => ({
    from: jest.fn((table: unknown) => makeChain(table, take(table))),
  }));

  const insert = jest.fn((table: unknown) => ({
    values: jest.fn((values: Row) => ({
      returning: jest.fn(() => {
        inserted.push({ table, values });
        return Promise.resolve(take(table));
      }),
    })),
  }));

  const tx = { select, insert };
  const transaction = jest.fn((callback: (t: typeof tx) => unknown) =>
    Promise.resolve(callback(tx)),
  );
  const db = { select, insert, transaction } as unknown as Db;

  return { db, select, transaction, conditions, orders, limits, inserted };
}

function threadRow(overrides: Row = {}): Row {
  return {
    id: THREAD_ID,
    studentId: STUDENT_ID,
    space: 'question',
    questionId: QUESTION_ID,
    attemptId: null,
    createdAt: new Date('2026-05-01T10:00:00.000Z'),
    ...overrides,
  };
}

function messageRow(overrides: Row = {}): Row {
  return {
    id: 'd1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a',
    threadId: THREAD_ID,
    role: 'user',
    body: 'این سوال را متوجه نشدم',
    createdAt: new Date('2026-05-01T10:01:00.000Z'),
    ...overrides,
  };
}

/** Optional ChatAiService stub plus its reply spy, for pipeline tests. */
function makeChatAi(reply: () => Promise<string>) {
  const replyFn = jest.fn<Promise<string>, [unknown, string]>(reply);
  return { chatAi: { reply: replyFn } as unknown as ChatAiService, replyFn };
}

/** SubscriptionService stub around one hasPaidPlan answer. */
function makeSubscription(paid: boolean) {
  const hasPaidPlan = jest
    .fn<Promise<boolean>, [string]>()
    .mockResolvedValue(paid);
  return {
    service: { hasPaidPlan } as unknown as SubscriptionService,
    hasPaidPlan,
  };
}

const text = (condition: SQL | undefined): string =>
  condition ? dialect.sqlToQuery(condition).sql.toLowerCase() : '';
const params = (condition: SQL | undefined): unknown[] =>
  condition ? dialect.sqlToQuery(condition).params : [];

describe('ChatService — get-or-create (spec 9.1)', () => {
  it('returns the existing thread for the exact key without inserting', async () => {
    const existing = threadRow();
    const { db, transaction, conditions, inserted } = makeDb({
      question: [[publishedQuestion]],
      chatThread: [[existing]],
    });
    const service = new ChatService(db);

    const result = await service.getOrCreateThread(
      USER_ID,
      'question',
      QUESTION_ID,
    );

    expect(result).toEqual(existing);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(0);
    const threadWhere = conditions.find((condition) =>
      text(condition).includes('"chat_thread"."question_id"'),
    );
    const where = text(threadWhere);
    expect(where).toContain('"chat_thread"."student_id" =');
    expect(where).toContain('"chat_thread"."space" =');
    expect(where).toContain('"chat_thread"."question_id" =');
    expect(params(conditions[0])).toContain('published');
    expect(params(threadWhere)).toContain('question');
    expect(params(threadWhere)).toContain(QUESTION_ID);
  });

  it('creates the thread inside ONE transaction when the key is new', async () => {
    const created = threadRow({ id: 'new-thread' });
    const { db, transaction, inserted } = makeDb({
      attempt: [[ownedAttempt]],
      question: [[publishedQuestion]],
      chatThread: [[], [created]],
    });
    const service = new ChatService(db);

    const result = await service.getOrCreateThread(
      USER_ID,
      'question',
      QUESTION_ID,
      ATTEMPT_ID,
    );

    expect(result).toEqual(created);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].table).toBe(chatThread);
    expect(inserted[0].values).toEqual({
      studentId: STUDENT_ID,
      space: 'question',
      questionId: QUESTION_ID,
      attemptId: ATTEMPT_ID,
    });
  });

  it('is idempotent per key — the same call shape never inserts twice', async () => {
    // Second call: the row created by the first call is found.
    const created = threadRow();
    const { db, inserted } = makeDb({
      question: [[publishedQuestion]],
      chatThread: [[created]],
    });
    const service = new ChatService(db);

    await expect(
      service.getOrCreateThread(USER_ID, 'question', QUESTION_ID),
    ).resolves.toEqual(created);
    expect(inserted).toHaveLength(0);
  });

  it('treats NULL refs exactly — a coach key matches only ref-less rows', async () => {
    const { db, conditions } = makeDb({ chatThread: [[threadRow()]] });
    const service = new ChatService(db);

    await service.getOrCreateThread(USER_ID, 'coach');

    const where = text(conditions[0]);
    expect(where).toContain('"chat_thread"."question_id" is null');
    expect(where).toContain('"chat_thread"."attempt_id" is null');
  });

  it('keys an exam_analysis thread by attempt and empty question ref', async () => {
    const { db, conditions } = makeDb({
      attempt: [[ownedAttempt]],
      chatThread: [[threadRow()]],
    });
    const service = new ChatService(db);

    await service.getOrCreateThread(
      USER_ID,
      'exam_analysis',
      undefined,
      ATTEMPT_ID,
    );

    const threadWhere = conditions.find((condition) =>
      text(condition).includes('"chat_thread"."attempt_id"'),
    );
    expect(text(threadWhere)).toContain('"chat_thread"."attempt_id" =');
    expect(text(threadWhere)).toContain('"chat_thread"."question_id" is null');
    expect(params(threadWhere)).toContain(ATTEMPT_ID);
  });
});

describe('ChatService — per-space validation matrix (spec 9.1)', () => {
  const invalid: Array<[Space, string | undefined, string | undefined]> = [
    ['coach', QUESTION_ID, undefined], // coach must carry no refs
    ['coach', undefined, ATTEMPT_ID], // …not even an attempt
    ['question', undefined, undefined], // questionId REQUIRED
    ['exam_analysis', undefined, undefined], // attemptId REQUIRED
    ['exam_analysis', QUESTION_ID, ATTEMPT_ID], // questionId must be absent
  ];

  it.each(invalid)(
    'rejects space=%s questionId=%s attemptId=%s with 400',
    async (space, questionId, attemptId) => {
      const { db, select, transaction } = makeDb();
      const service = new ChatService(db);

      await expect(
        service.getOrCreateThread(USER_ID, space, questionId, attemptId),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Validation runs before any query.
      expect(select).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  const valid: Array<[Space, string | undefined, string | undefined]> = [
    ['coach', undefined, undefined],
    ['question', QUESTION_ID, undefined],
    ['question', QUESTION_ID, ATTEMPT_ID],
    ['exam_analysis', undefined, ATTEMPT_ID],
  ];

  it.each(valid)(
    'accepts space=%s questionId=%s attemptId=%s',
    async (space, questionId, attemptId) => {
      const { db } = makeDb({
        chatThread: [[threadRow({ space })]],
        // Ref checks only run for the spaces that carry those refs.
        ...(attemptId
          ? { attempt: [[{ id: attemptId, studentId: STUDENT_ID }]] }
          : {}),
        ...(questionId
          ? { question: [[{ id: questionId, status: 'published' }]] }
          : {}),
      });
      const service = new ChatService(db);

      await expect(
        service.getOrCreateThread(USER_ID, space, questionId, attemptId),
      ).resolves.toBeDefined();
    },
  );
});

describe('ChatService — thread list', () => {
  it('lists the caller’s threads newest first, capped at 100', async () => {
    const rows = [
      threadRow({ id: THREAD_ID, createdAt: new Date('2026-05-02T09:00:00Z') }),
      threadRow({
        id: 'older-thread',
        questionId: null,
        space: 'coach',
        createdAt: new Date('2026-05-01T09:00:00Z'),
      }),
    ];
    const { db, conditions, orders, limits } = makeDb({
      chatThread: [rows],
    });
    const service = new ChatService(db);

    const result = await service.listThreads(USER_ID);

    expect(result).toEqual(rows);
    expect(text(conditions[0])).toContain('"chat_thread"."student_id" =');
    expect(text(orders[0][0])).toContain('desc');
    expect(limits).toEqual([THREAD_LIST_LIMIT]);
  });

  it('filters by space when one is given', async () => {
    const { db, conditions } = makeDb({ chatThread: [[]] });
    const service = new ChatService(db);

    await service.listThreads(USER_ID, 'question');

    expect(text(conditions[0])).toContain('"chat_thread"."space" =');
    expect(params(conditions[0])).toContain('question');
  });
});

describe('ChatService — messages', () => {
  it('returns ascending messages with the default page of 50', async () => {
    const rows = [
      messageRow({ createdAt: new Date('2026-05-01T10:01:00Z') }),
      messageRow({
        id: 'later-message',
        createdAt: new Date('2026-05-01T10:02:00Z'),
      }),
    ];
    const { db, conditions, orders, limits } = makeDb({
      chatThread: [[threadRow()]],
      chatMessage: [rows],
    });
    const service = new ChatService(db);

    const result = await service.getMessages(USER_ID, THREAD_ID);

    expect(result).toEqual(rows);
    // Ownership lookup, then the message read.
    expect(text(conditions[0])).toContain('"chat_thread"."student_id" =');
    expect(text(conditions[1])).toContain('"chat_message"."thread_id" =');
    expect(text(orders[0][0])).toContain('asc');
    expect(limits).toEqual([1, 50]);
  });

  it('clamps the requested page into [1, 200]', async () => {
    const oversized = makeDb({
      chatThread: [[threadRow()]],
      chatMessage: [[]],
    });
    await new ChatService(oversized.db).getMessages(USER_ID, THREAD_ID, 300);
    expect(oversized.limits).toEqual([1, 200]);

    const tiny = makeDb({
      chatThread: [[threadRow()]],
      chatMessage: [[]],
    });
    await new ChatService(tiny.db).getMessages(USER_ID, THREAD_ID, 1);
    expect(tiny.limits).toEqual([1, 1]);
  });

  it("404s another student's thread instead of leaking it (spec 15.5)", async () => {
    const { db, inserted } = makeDb({ chatThread: [[]] });
    const service = new ChatService(db);

    await expect(
      service.getMessages(USER_ID, THREAD_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.addMessage(USER_ID, THREAD_ID, 'سلام'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(inserted).toHaveLength(0);
  });

  it('stores the caller message with role user and returns the envelope', async () => {
    const stored = messageRow({ body: 'سلام' });
    const { db, inserted } = makeDb({
      appConfig: [[]], // no active row → documented default limit
      chatThread: [[threadRow()]],
      chatMessage: [[{ count: 0 }], [stored]], // quota count, then the insert
    });
    const service = new ChatService(db); // no ChatAiService → storage-only

    const result = await service.addMessage(USER_ID, THREAD_ID, 'سلام');

    expect(result).toEqual({
      userMessage: stored,
      assistantMessage: null,
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].table).toBe(chatMessage);
    expect(inserted[0].values).toEqual({
      threadId: THREAD_ID,
      role: 'user',
      body: 'سلام',
    });
  });
});

describe('ChatService — caller resolution', () => {
  it('404s when the account has no student profile', async () => {
    const { db } = makeDb({ student: [[]] });
    const service = new ChatService(db);

    await expect(service.getOrCreateThread(USER_ID, 'coach')).rejects.toThrow(
      'Student profile not found',
    );
  });
});

describe('ChatService — AI reply pipeline (spec 9.1/9.2)', () => {
  /** These tests target the AI path; the quota is bypassed via a paid plan. */
  const paidSub = () => makeSubscription(true).service;

  it('persists the assistant row with role assistant on question threads', async () => {
    const userStored = messageRow({ body: 'چرا این غلطه؟' });
    const assistantStored = messageRow({
      id: 'assistant-row',
      role: 'assistant',
      body: 'پاسخ دستیار',
      createdAt: new Date('2026-05-01T10:01:01.000Z'),
    });
    const { db, inserted } = makeDb({
      chatThread: [[threadRow()]],
      chatMessage: [[userStored], [assistantStored]],
    });
    const { chatAi, replyFn } = makeChatAi(() =>
      Promise.resolve('پاسخ دستیار'),
    );
    const service = new ChatService(db, chatAi, paidSub());

    const result = await service.addMessage(
      USER_ID,
      THREAD_ID,
      'چرا این غلطه؟',
    );

    expect(result).toEqual({
      userMessage: userStored,
      assistantMessage: assistantStored,
    });
    expect(replyFn).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(2);
    expect(inserted[0].values).toMatchObject({ role: 'user' });
    expect(inserted[1].values).toEqual({
      threadId: THREAD_ID,
      role: 'assistant',
      body: 'پاسخ دستیار',
    });
  });

  it('keeps the user message and reports ai_unavailable when the AI fails', async () => {
    const userStored = messageRow({ body: 'چرا این غلطه؟' });
    const { db, inserted } = makeDb({
      chatThread: [[threadRow()]],
      chatMessage: [[userStored]],
    });
    const { chatAi } = makeChatAi(() =>
      Promise.reject(new Error('model down')),
    );
    const service = new ChatService(db, chatAi, paidSub());

    const result = await service.addMessage(
      USER_ID,
      THREAD_ID,
      'چرا این غلطه؟',
    );

    expect(result).toEqual({
      userMessage: userStored,
      assistantMessage: null,
      notice: 'ai_unavailable',
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].values).toMatchObject({ role: 'user' });
  });

  it('never calls the AI for exam_analysis threads', async () => {
    const userStored = messageRow();
    const { db, inserted } = makeDb({
      chatThread: [
        [
          threadRow({
            space: 'exam_analysis',
            questionId: null,
            attemptId: ATTEMPT_ID,
          }),
        ],
      ],
      chatMessage: [[userStored]],
    });
    const { chatAi, replyFn } = makeChatAi(() =>
      Promise.resolve('نباید صدا شود'),
    );
    const service = new ChatService(db, chatAi, paidSub());

    const result = await service.addMessage(USER_ID, THREAD_ID, 'سلام');

    expect(replyFn).not.toHaveBeenCalled();
    expect(result).toEqual({ userMessage: userStored, assistantMessage: null });
    expect('notice' in result).toBe(false);
    expect(inserted).toHaveLength(1);
  });
});

describe('ChatService — coach AI replies (spec 9.1)', () => {
  /** Optional ChatAiService stub with a replyCoach spy. */
  function makeCoachAi(replyCoach: () => Promise<string>) {
    const replyCoachFn = jest.fn<Promise<string>, [unknown, string, string]>(
      replyCoach,
    );
    return {
      chatAi: {
        reply: jest.fn(() => Promise.resolve('نباید صدا شود')),
        replyCoach: replyCoachFn,
      } as unknown as ChatAiService,
      replyCoachFn,
    };
  }

  function coachThread(): Row {
    return threadRow({ space: 'coach', questionId: null, attemptId: null });
  }

  it('400s a coach send without a mode and stores nothing', async () => {
    const { db, inserted } = makeDb({ chatThread: [[coachThread()]] });
    const { chatAi, replyCoachFn } = makeCoachAi(() =>
      Promise.resolve('پاسخ مربی'),
    );
    const service = new ChatService(db, chatAi, makeSubscription(true).service);

    await expect(
      service.addMessage(USER_ID, THREAD_ID, 'حالم خوب نیست'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(replyCoachFn).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it.each(['question', 'exam_analysis'] as const)(
    '400s a mode on a %s thread',
    async (space) => {
      const { db, inserted } = makeDb({
        chatThread: [
          [
            space === 'question'
              ? threadRow()
              : threadRow({
                  space,
                  questionId: null,
                  attemptId: ATTEMPT_ID,
                }),
          ],
        ],
      });
      const service = new ChatService(db);

      await expect(
        service.addMessage(USER_ID, THREAD_ID, 'سلام', 'motivation'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(inserted).toHaveLength(0);
    },
  );

  it('persists the assistant row through the coach path with the mode', async () => {
    const userStored = messageRow({ body: 'حالم خوب نیست' });
    const assistantStored = messageRow({
      id: 'coach-assistant',
      role: 'assistant',
      body: 'پاسخ مربی',
    });
    const { db, inserted } = makeDb({
      chatThread: [[coachThread()]],
      chatMessage: [[userStored], [assistantStored]],
    });
    const { chatAi, replyCoachFn } = makeCoachAi(() =>
      Promise.resolve('پاسخ مربی'),
    );
    const service = new ChatService(db, chatAi, makeSubscription(true).service);

    const result = await service.addMessage(
      USER_ID,
      THREAD_ID,
      'حالم خوب نیست',
      'motivation',
    );

    expect(result).toEqual({
      userMessage: userStored,
      assistantMessage: assistantStored,
    });
    expect(replyCoachFn).toHaveBeenCalledTimes(1);
    expect(replyCoachFn.mock.calls[0][2]).toBe('motivation');
    expect(inserted).toHaveLength(2);
    expect(inserted[1].values).toEqual({
      threadId: THREAD_ID,
      role: 'assistant',
      body: 'پاسخ مربی',
    });
  });

  it('keeps the user message and reports ai_unavailable when the coach AI fails', async () => {
    const userStored = messageRow({ body: 'حالم خوب نیست' });
    const { db, inserted } = makeDb({
      chatThread: [[coachThread()]],
      chatMessage: [[userStored]],
    });
    const { chatAi } = makeCoachAi(() =>
      Promise.reject(new Error('model down')),
    );
    const service = new ChatService(db, chatAi, makeSubscription(true).service);

    const result = await service.addMessage(
      USER_ID,
      THREAD_ID,
      'حالم خوب نیست',
      'planning',
    );

    expect(result).toEqual({
      userMessage: userStored,
      assistantMessage: null,
      notice: 'ai_unavailable',
    });
    expect(inserted).toHaveLength(1);
  });

  it('free quota still gates coach sends at the limit', async () => {
    const { db, inserted } = makeDb({
      appConfig: [[]], // no active row → documented default of 5
      chatThread: [[coachThread()]],
      chatMessage: [[{ count: 5 }]], // shared pool already full
    });
    const { chatAi, replyCoachFn } = makeCoachAi(() =>
      Promise.resolve('نباید صدا شود'),
    );
    const service = new ChatService(
      db,
      chatAi,
      makeSubscription(false).service,
    );

    await expect(
      service.addMessage(USER_ID, THREAD_ID, 'حالم خوب نیست', 'debug'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(replyCoachFn).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });
});

describe('ChatService — free-plan AI quota (spec §10)', () => {
  /** The shared-pool count condition (role, spaces, rolling window). */
  function countWhere(conditions: SQL[]): SQL | undefined {
    return conditions.find((condition) =>
      text(condition).includes('"chat_message"."role"'),
    );
  }

  it('403s a free user at the shared limit and stores NOTHING', async () => {
    const { db, inserted } = makeDb({
      appConfig: [[]], // no active row → documented default of 5
      chatThread: [[threadRow()]],
      chatMessage: [[{ count: 5 }]], // at the limit
    });
    const { service: subscription } = makeSubscription(false);
    const { chatAi, replyFn } = makeChatAi(() =>
      Promise.resolve('نباید صدا شود'),
    );
    const service = new ChatService(db, chatAi, subscription);

    await expect(
      service.addMessage(USER_ID, THREAD_ID, 'سلام'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // A blocked send leaves no message row and no ai_job row (spec 15.5).
    expect(inserted).toHaveLength(0);
    expect(replyFn).not.toHaveBeenCalled();
  });

  it('counts the SHARED pool across coach + question in a 7-day window', async () => {
    const { db, conditions } = makeDb({
      appConfig: [[]],
      chatThread: [[threadRow()]],
      chatMessage: [[{ count: 5 }]],
    });
    const { service: subscription } = makeSubscription(false);
    const service = new ChatService(
      db,
      {
        reply: jest.fn(),
      } as unknown as ChatAiService,
      subscription,
    );

    await expect(
      service.addMessage(USER_ID, THREAD_ID, 'سلام'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const where = text(countWhere(conditions));
    expect(where).toContain('"chat_thread"."student_id" =');
    expect(where).toContain('"chat_message"."role" =');
    expect(where).toContain('"chat_thread"."space" in (');
    expect(where).toContain(">= now() - interval '7 days'");
    const countParams = params(countWhere(conditions));
    expect(countParams).toContain('coach');
    expect(countParams).toContain('question');
    expect(countParams).not.toContain('exam_analysis');
  });

  it('stores and replies when the free user is under the limit', async () => {
    const userStored = messageRow({ body: 'سوال بعدی' });
    const assistantStored = messageRow({
      id: 'assistant-row',
      role: 'assistant',
      body: 'پاسخ دستیار',
    });
    const { db, inserted } = makeDb({
      appConfig: [[]],
      chatThread: [[threadRow()]],
      chatMessage: [[{ count: 4 }], [userStored], [assistantStored]],
    });
    const { service: subscription } = makeSubscription(false);
    const { chatAi, replyFn } = makeChatAi(() =>
      Promise.resolve('پاسخ دستیار'),
    );
    const service = new ChatService(db, chatAi, subscription);

    const result = await service.addMessage(USER_ID, THREAD_ID, 'سوال بعدی');

    expect(result).toEqual({
      userMessage: userStored,
      assistantMessage: assistantStored,
    });
    expect(replyFn).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(2);
  });

  it('never blocks or counts a paid user, at any volume', async () => {
    const userStored = messageRow();
    const assistantStored = messageRow({
      id: 'assistant-row',
      role: 'assistant',
      body: 'پاسخ دستیار',
    });
    const { db, inserted, conditions } = makeDb({
      chatThread: [[threadRow()]],
      // No appConfig read, no count query — the quota is skipped entirely.
      chatMessage: [[userStored], [assistantStored]],
    });
    const { service: subscription, hasPaidPlan } = makeSubscription(true);
    const { chatAi, replyFn } = makeChatAi(() =>
      Promise.resolve('پاسخ دستیار'),
    );
    const service = new ChatService(db, chatAi, subscription);

    const result = await service.addMessage(USER_ID, THREAD_ID, 'سلام');

    expect(hasPaidPlan).toHaveBeenCalledWith(USER_ID);
    expect(result).toEqual({
      userMessage: userStored,
      assistantMessage: assistantStored,
    });
    expect(replyFn).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(2);
    expect(countWhere(conditions)).toBeUndefined();
  });

  it('never counts or blocks exam_analysis — outside the shared pool', async () => {
    const userStored = messageRow();
    const { db, inserted, conditions } = makeDb({
      chatThread: [
        [
          threadRow({
            space: 'exam_analysis',
            questionId: null,
            attemptId: ATTEMPT_ID,
          }),
        ],
      ],
      // No count set: the exam_analysis space is not quota-metered at all.
      chatMessage: [[userStored]],
    });
    const { service: subscription } = makeSubscription(false); // free user
    const service = new ChatService(
      db,
      {
        reply: jest.fn(),
      } as unknown as ChatAiService,
      subscription,
    );

    const result = await service.addMessage(USER_ID, THREAD_ID, 'سلام');

    expect(result).toEqual({ userMessage: userStored, assistantMessage: null });
    expect(inserted).toHaveLength(1);
    expect(countWhere(conditions)).toBeUndefined();
  });

  it('uses the configured free_chat_weekly value as the limit', async () => {
    // Configured limit 2: two prior messages already exhaust the pool.
    const atConfigured = makeDb({
      appConfig: [[{ quotas: { free_chat_weekly: 2 } }]],
      chatThread: [[threadRow()]],
      chatMessage: [[{ count: 2 }]],
    });
    await expect(
      new ChatService(
        atConfigured.db,
        { reply: jest.fn() } as unknown as ChatAiService,
        makeSubscription(false).service,
      ).addMessage(USER_ID, THREAD_ID, 'سلام'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // One prior message is still under the configured limit.
    const underConfigured = makeDb({
      appConfig: [[{ quotas: { free_chat_weekly: 2 } }]],
      chatThread: [[threadRow()]],
      chatMessage: [[{ count: 1 }], [messageRow()]],
    });
    const result = await new ChatService(
      underConfigured.db,
      { reply: jest.fn() } as unknown as ChatAiService,
      makeSubscription(false).service,
    ).addMessage(USER_ID, THREAD_ID, 'سلام');
    expect(result.userMessage).toBeDefined();
  });

  it.each([
    ['missing config row', { quotas: {} }],
    ['invalid value (string)', { quotas: { free_chat_weekly: '5' } }],
  ])('falls back to 5 on %s', async (_name, quotas) => {
    const atDefault = makeDb({
      appConfig: [[quotas]],
      chatThread: [[threadRow()]],
      chatMessage: [[{ count: 5 }]],
    });
    await expect(
      new ChatService(
        atDefault.db,
        { reply: jest.fn() } as unknown as ChatAiService,
        makeSubscription(false).service,
      ).addMessage(USER_ID, THREAD_ID, 'سلام'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const underDefault = makeDb({
      appConfig: [[quotas]],
      chatThread: [[threadRow()]],
      chatMessage: [[{ count: 4 }], [messageRow()]],
    });
    const result = await new ChatService(
      underDefault.db,
      { reply: jest.fn() } as unknown as ChatAiService,
      makeSubscription(false).service,
    ).addMessage(USER_ID, THREAD_ID, 'سلام');
    expect(result.userMessage).toBeDefined();
  });

  it('keeps history readable after exhaustion — reads never check the quota', async () => {
    const rows = [messageRow(), messageRow({ id: 'second' })];
    const { db } = makeDb({
      chatThread: [[threadRow()]],
      chatMessage: [rows],
    });
    const { service: subscription } = makeSubscription(false);
    const service = new ChatService(
      db,
      {
        reply: jest.fn(),
      } as unknown as ChatAiService,
      subscription,
    );

    // Free user, quota exhausted elsewhere — reads stay open (spec 15.5).
    await expect(service.getMessages(USER_ID, THREAD_ID)).resolves.toEqual(
      rows,
    );
  });
});

describe('ChatService — context-ref ownership (spec 15.5)', () => {
  it('rejects a foreign attemptId at creation with 404 and stores nothing', async () => {
    // No attempt visible to THIS student — unknown and foreign read alike.
    const { db, inserted } = makeDb({ attempt: [[]] });
    const service = new ChatService(db);

    await expect(
      service.getOrCreateThread(
        USER_ID,
        'exam_analysis',
        undefined,
        ATTEMPT_ID,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(inserted).toHaveLength(0);
  });

  it('rejects an unknown questionId at creation with 404 and stores nothing', async () => {
    const { db, inserted } = makeDb({ question: [[]] });
    const service = new ChatService(db);

    await expect(
      service.getOrCreateThread(USER_ID, 'question', QUESTION_ID),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(inserted).toHaveLength(0);
  });

  it('creates the thread only past the ownership + published checks', async () => {
    const created = threadRow({
      space: 'question',
      attemptId: ATTEMPT_ID,
    });
    const { db, inserted, conditions } = makeDb({
      attempt: [[ownedAttempt]],
      question: [[publishedQuestion]],
      chatThread: [[], [created]],
    });
    const service = new ChatService(db);

    const result = await service.getOrCreateThread(
      USER_ID,
      'question',
      QUESTION_ID,
      ATTEMPT_ID,
    );

    expect(result).toEqual(created);
    expect(inserted).toHaveLength(1);
    // The attempt guard is scoped to the CALLER's student id.
    const attemptGuard = conditions.find((condition) =>
      text(condition).includes('"attempt"."student_id"'),
    );
    expect(params(attemptGuard)).toContain(ATTEMPT_ID);
    expect(params(attemptGuard)).toContain(STUDENT_ID);
    // The question guard requires a PUBLISHED bank row.
    const questionGuard = conditions.find((condition) =>
      text(condition).includes('"question"."status"'),
    );
    expect(params(questionGuard)).toContain(QUESTION_ID);
    expect(params(questionGuard)).toContain('published');
  });

  it('checks refs before any thread read — a foreign ref never reaches the key', async () => {
    const { db, conditions, inserted } = makeDb({ attempt: [[]] });
    const service = new ChatService(db);

    await expect(
      service.getOrCreateThread(
        USER_ID,
        'exam_analysis',
        undefined,
        ATTEMPT_ID,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    // No chat_thread query ran at all: the guard fired first.
    expect(
      conditions.some((condition) => text(condition).includes('"chat_thread"')),
    ).toBe(false);
    expect(inserted).toHaveLength(0);
  });
});
