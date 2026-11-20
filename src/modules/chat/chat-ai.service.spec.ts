import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Db } from '../../db/db.module';
import {
  answerKey,
  attempt,
  chatMessage,
  correction,
  examInstance,
  examTemplate,
  question,
  response,
  rubric,
  student,
  studyLog,
  topic,
} from '../../db/schema';
import type { ChatMessage, ChatThread } from '../../db/schema';
import type { HistoryContext } from '../ai/history-context.service';
import {
  buildCoachChatPrompt,
  buildExamAnalysisPrompt,
  CHAT_HISTORY_WINDOW,
  CHAT_PROMPT_VERSION,
  COACH_MODE_RULES,
  EXAM_ANALYSIS_PROMPT_VERSION,
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

const text = (condition: SQL | undefined): string =>
  condition ? dialect.sqlToQuery(condition).sql.toLowerCase() : '';
const params = (condition: SQL | undefined): unknown[] =>
  condition ? dialect.sqlToQuery(condition).params : [];

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
  student,
  studyLog,
  examInstance,
  examTemplate,
  topic,
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
      leftJoin() {
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
      // The thread's attempt is owned by the caller → attempt-scoped read.
      attempt: [[{ id: ATTEMPT_ID, studentId: STUDENT_ID }]],
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

  it('reads nothing from an attempt that is not the caller’s (defense in depth)', async () => {
    // A pre-existing thread whose attemptId ref points at data this student
    // does not own: the ownership guard finds nothing, so the attempt-scoped
    // response/correction layers are skipped entirely (spec 15.5).
    const { service, runJob, conditions } = build({
      attempt: [[]], // no attempt owned by THIS student is visible
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
      chatMessage: [[]],
    });

    const reply = await service.reply(threadRow(), STUDENT_ID);

    expect(reply).toBe('پاسخ دستیار');
    // The ownership guard ran, scoped to the caller's student id.
    const guard = conditions.find((condition) => {
      const where = text(condition);
      return (
        where.includes('"attempt"."id"') &&
        where.includes('"attempt"."student_id"') &&
        !where.includes('"response"')
      );
    });
    expect(guard).toBeDefined();
    expect(params(guard)).toContain(ATTEMPT_ID);
    expect(params(guard)).toContain(STUDENT_ID);
    // The attempt-scoped response read never ran — no foreign exam data can
    // reach the prompt; only the caller-scoped latest-response fallback.
    expect(
      conditions.some((condition) =>
        text(condition).includes('"response"."attempt_id"'),
      ),
    ).toBe(false);
    expect(runJob).toHaveBeenCalledTimes(1);
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

describe('SEVEN_CLAUSES — verbatim pin (spec 9.2, «عینا»)', () => {
  it('equals the docx text character-for-character (clause 7 fixed)', () => {
    expect(SEVEN_CLAUSES).toBe(
      '۱. فقط از داده داده‌شده استفاده کن؛ حدس نزن. ۲. اگر اطلاعات کافی نیست بگو و سؤال روشن‌کننده بپرس. ۳. عدد نساز؛ اعداد داده‌شده را تکرار کن، محاسبه نکن. ۴. علت قطعی برای خطا اعلام نکن؛ احتمال بده یا بپرس. ۵. راه‌حل متفاوت با پاسخ‌نامه را خودکار غلط ندان. ۶. هر جمله تحلیلی باید به یک شاهد مشخص وصل باشد؛ کلی‌گویی ممنوع. ۷. لحن همدل ولی صادق؛ ضعف را نه بپوشان نه تحقیر کن.',
    );
    // ZWNJ (U+200C) positions: داده‌شده ×2, روشن‌کننده, راه‌حل, پاسخ‌نامه,
    // کلی‌گویی — an editor stripping them must fail CI too.
    expect((SEVEN_CLAUSES.match(/\u200C/g) ?? []).length).toBe(6);
  });
});

describe('ChatAiService — coach replies (spec 9.1)', () => {
  const PROFILE_ROW = {
    major: 'ریاضی',
    grade: 'دوازدهم',
    targetYear: 1404,
    streak: 4,
    studiedTopicIds: ['11111111-1111-4111-8111-111111111111'],
  };

  /** The history summary the service hands in, with one weak topic. */
  function weakHistory(samples: string[] = []): HistoryContext {
    return historyStub({
      weakTopics: [weakTopic({ sampleWrongTexts: samples })],
    });
  }

  function coachInput(overrides: {
    mode: 'motivation' | 'planning' | 'debug';
    activityCount7d?: number | null;
    studyTitles?: string[] | null;
  }) {
    return {
      mode: overrides.mode,
      profile: {
        major: PROFILE_ROW.major,
        grade: PROFILE_ROW.grade,
        targetYear: PROFILE_ROW.targetYear,
        streak: PROFILE_ROW.streak,
        studiedTopicIds: PROFILE_ROW.studiedTopicIds,
      },
      summary: weakHistory(
        overrides.mode === 'debug' ? ['نمونه غلط دینامیک'] : [],
      ),
      activityCount7d: overrides.activityCount7d ?? null,
      studyTitles: overrides.studyTitles ?? null,
      history: [] as ChatMessage[],
    };
  }

  it('sends operation coach / coach-v1 with the profile layer', async () => {
    const { service, runJob, historyContext } = build({
      student: [[PROFILE_ROW]],
      studyLog: [[{ count: 1 }]], // motivation reads only a COUNT
      chatMessage: [[messageRow({ body: 'حالم خوب نیست' })]],
    });

    const reply = await service.replyCoach(
      threadRow({ space: 'coach', questionId: null, attemptId: null }),
      STUDENT_ID,
      'motivation',
    );

    expect(reply).toBe('پاسخ دستیار');
    expect(historyContext.buildForStudent).toHaveBeenCalledWith(STUDENT_ID);
    expect(runJob).toHaveBeenCalledTimes(1);
    const input = runJob.mock.calls[0][0] as {
      operation: string;
      promptVersion: string;
      prompt: string;
    };
    expect(input.operation).toBe('coach');
    expect(input.promptVersion).toBe('coach-v1');

    const prompt = input.prompt;
    expect(prompt).toContain(SEVEN_CLAUSES);
    expect(prompt).toContain('حالت این پاسخ: انگیزشی');
    // Fixed layer: strand/grade/target-year + streak.
    expect(prompt).toContain('- رشته: ریاضی');
    expect(prompt).toContain('- پایه: دوازدهم');
    expect(prompt).toContain('- سال هدف کنکور: 1404');
    expect(prompt).toContain('- استریک فعلی: 4 روز');
  });

  it('motivation carries counts only — no weak-topic titles or samples', () => {
    const prompt = buildCoachChatPrompt(
      coachInput({ mode: 'motivation', activityCount7d: 3 }),
    );

    expect(prompt).toContain('- مجموع خطاهای اخیر: 12');
    expect(prompt).toContain('- موضوعات نیازمند تمرین: 1 موضوع');
    expect(prompt).toContain('- مطالعات ثبت‌شده در ۷ روز گذشته: 3 مورد');
    // The mode's own rule line rides on top of the seven clauses.
    expect(prompt).toContain(COACH_MODE_RULES.motivation);
    // A pep talk dumps no data: no titles, no samples, no study titles.
    expect(prompt).not.toContain('دینامیک');
    expect(prompt).not.toContain('نمونه');
    expect(prompt).not.toContain('مطالعات اخیر');
  });

  it('planning carries weak topics + studied topics + recent study titles', () => {
    const prompt = buildCoachChatPrompt(
      coachInput({
        mode: 'planning',
        studyTitles: ['حساب دیفرانسیل — حد', 'هندسه'],
      }),
    );

    expect(prompt).toContain('حالت این پاسخ: برنامه‌ریزی');
    expect(prompt).toContain('- دینامیک: 5 خطا');
    expect(prompt).toContain(
      'موضوعات مطالعه‌شده (خوداعلامی): 11111111-1111-4111-8111-111111111111',
    );
    expect(prompt).toContain('مطالعات اخیر (۷ روز گذشته):');
    expect(prompt).toContain('- حساب دیفرانسیل — حد');
    expect(prompt).toContain('- هندسه');
    // Debug-only and motivation-only layers stay out of the planning prompt.
    expect(prompt).not.toContain('نمونه غلط');
    expect(prompt).not.toContain('مطالعات ثبت‌شده');
  });

  it('debug carries the weak topics’ sample wrong answers', () => {
    const prompt = buildCoachChatPrompt(coachInput({ mode: 'debug' }));

    expect(prompt).toContain('حالت این پاسخ: رفع اشکال');
    expect(prompt).toContain('- دینامیک: 5 خطا');
    expect(prompt).toContain('  · نمونه: نمونه غلط دینامیک');
    // Planning-only and motivation-only layers stay out of the debug prompt.
    expect(prompt).not.toContain('موضوعات مطالعه‌شده');
    expect(prompt).not.toContain('مطالعات ثبت‌شده');
  });

  it('reads no study-log data outside the mode’s lazy layer', async () => {
    // Debug needs neither the activity count nor the study titles.
    const { service, runJob, conditions } = build({
      student: [[PROFILE_ROW]],
      studyLog: [[{ lesson: 'نباید خوانده شود', topic: null }]],
      chatMessage: [[]],
    });

    await service.replyCoach(
      threadRow({ space: 'coach', questionId: null, attemptId: null }),
      STUDENT_ID,
      'debug',
    );

    expect(
      conditions.some((condition) => text(condition).includes('"study_log"')),
    ).toBe(false);
    expect(runJob).toHaveBeenCalledTimes(1);
  });
});

describe('ChatAiService — exam_analysis replies (spec 9.1)', () => {
  const META_ROW = {
    status: 'reviewed',
    totalScore: 14,
    startedAt: new Date('2026-05-01T08:00:00.000Z'),
    submittedAt: new Date('2026-05-01T08:45:00.000Z'),
    examKind: 'konkur_sim',
    examTitle: 'آزمون جامع شماره ۳',
    // 4 questions in the frozen order; the rows below answer only 3.
    questionOrder: ['q-1', 'q-2', 'q-3', 'q-4'],
  };

  /** THIS attempt's rows (two topics, one blank answer). */
  const ATTEMPT_ROWS = [
    {
      topicTitle: 'دینامیک',
      selectedOption: 0,
      textAnswer: null,
      isCorrect: false,
      activeSeconds: 40,
    },
    {
      topicTitle: 'دینامیک',
      selectedOption: 1,
      textAnswer: null,
      isCorrect: true,
      activeSeconds: 30,
    },
    {
      topicTitle: 'مشتق',
      selectedOption: 2,
      textAnswer: null,
      isCorrect: false,
      activeSeconds: 25,
    },
    {
      topicTitle: 'مشتق',
      selectedOption: null,
      textAnswer: null,
      isCorrect: null,
      activeSeconds: 10,
    },
  ];

  /** A DIFFERENT attempt of the same student — must never surface. */
  const OTHER_ATTEMPT_ROWS = [
    {
      topicTitle: 'هندسه',
      selectedOption: 0,
      textAnswer: null,
      isCorrect: true,
      activeSeconds: 999,
    },
  ];

  it('sends only THIS attempt’s real numbers, breakdown and suggestions', async () => {
    const { service, runJob, conditions } = build({
      attempt: [[META_ROW]],
      response: [ATTEMPT_ROWS, OTHER_ATTEMPT_ROWS],
      chatMessage: [[]],
    });

    const reply = await service.replyExamAnalysis(threadRow(), STUDENT_ID);

    expect(reply).toBe('پاسخ دستیار');
    expect(runJob).toHaveBeenCalledTimes(1);
    const input = runJob.mock.calls[0][0] as {
      operation: string;
      promptVersion: string;
      prompt: string;
    };
    expect(input.operation).toBe('exam_analysis');
    expect(input.promptVersion).toBe(EXAM_ANALYSIS_PROMPT_VERSION);

    const prompt = input.prompt;
    expect(prompt).toContain(SEVEN_CLAUSES);
    // Attempt header — the REAL numbers only.
    expect(prompt).toContain('- عنوان: آزمون جامع شماره ۳');
    expect(prompt).toContain('- نوع آزمون: konkur_sim');
    expect(prompt).toContain('- وضعیت: reviewed');
    expect(prompt).toContain('- نمره کل: 14');
    // 1 correct of 3 graded → 33%.
    expect(prompt).toContain('- درصد درست از پاسخ‌های تصحیح‌شده: 33');
    expect(prompt).toContain('- پاسخ داده‌شده: 3 سؤال');
    expect(prompt).toContain('- سفید: 1 سؤال');
    expect(prompt).toContain('- زمان فعال: 105 ثانیه');
    // Per-topic breakdown rendered.
    expect(prompt).toContain('- دینامیک: 2 سؤال — 1 درست، 1 غلط، 0 سفید');
    expect(prompt).toContain('- مشتق: 2 سؤال — 0 درست، 1 غلط، 1 سفید');
    // Suggestions: weakest topics of THIS attempt.
    expect(prompt).toContain('موضوعات پیشنهادی برای تمرین');
    expect(prompt).toContain('- دینامیک (1 خطا)');
    expect(prompt).toContain('- مشتق (1 خطا)');

    // A second attempt of the same student must NOT appear anywhere.
    expect(prompt).not.toContain('هندسه');
    expect(prompt).not.toContain('999');

    // The reads are attempt-scoped (and the header caller-scoped too).
    const responseWhere = conditions.find((condition) =>
      text(condition).includes('"response"."attempt_id"'),
    );
    expect(responseWhere).toBeDefined();
    expect(params(responseWhere)).toContain(ATTEMPT_ID);
    const metaWhere = conditions.find((condition) =>
      text(condition).includes('"attempt"."student_id"'),
    );
    expect(params(metaWhere)).toContain(STUDENT_ID);
    expect(params(metaWhere)).toContain(ATTEMPT_ID);
  });

  it('still replies when the attempt header is missing (degraded)', async () => {
    const { service, runJob } = build({
      attempt: [[]],
      response: [[]],
      chatMessage: [[]],
    });

    const reply = await service.replyExamAnalysis(threadRow(), STUDENT_ID);

    expect(reply).toBe('پاسخ دستیار');
    const prompt = (runJob.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain(SEVEN_CLAUSES);
    expect(prompt).toContain('مشخصات آزمون: (در دسترس نیست');
  });

  it('keeps the exam-analysis prompt builder pure — no data, no crash', () => {
    const prompt = buildExamAnalysisPrompt({
      meta: null,
      topicRows: [],
      history: [
        messageRow({ role: 'user', body: 'اولین پیام' }),
        messageRow({ role: 'assistant', body: 'پاسخ اول' }),
      ],
    });

    expect(prompt).toContain(SEVEN_CLAUSES);
    expect(prompt).toContain('دانش‌آموز: اولین پیام');
    expect(prompt).toContain('دستیار: پاسخ اول');
    expect(prompt).not.toContain('تفکیک موضوعی');
  });
});
