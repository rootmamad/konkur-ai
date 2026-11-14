import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';

import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import { chatMessage } from '../../db/schema/chat';
import type { ChatMessage, ChatThread } from '../../db/schema/chat';
import { answerKey } from '../../db/schema/answer-key';
import { attempt } from '../../db/schema/attempt';
import { correction } from '../../db/schema/correction';
import { question } from '../../db/schema/question';
import { response } from '../../db/schema/response';
import { rubric } from '../../db/schema/rubric';
import { AIService } from '../ai/ai.service';
import { HistoryContextService } from '../ai/history-context.service';

/**
 * The seven-clause block (spec 9.2, «عینا»): VERBATIM in every chat prompt —
 * never reworded, never split.
 */
export const SEVEN_CLAUSES =
  '۱. فقط از داده داده‌شده استفاده کن؛ حدس نزن. ۲. اگر اطلاعات کافی نیست بگو و سؤال روشن‌کننده بپرس. ۳. عدد نساز؛ اعداد داده‌شده را تکرار کن، محاسبه نکن. ۴. علت قطعی برای خطا اعلام نکن؛ احتمال بده یا بپرس. ۵. راه‌حل متفاوت با پاسخ‌نامه را خودکار غلط ندان. ۶. هر جمله تحلیلی باید به یک شاهد مشخص وصل باشد؛ کلی‌گویی ممنوع. ۷. لحن همدلی ولی صادق؛ ضعف را نپوشان نه تحقیر کن.';

/** Prompt revision tag written to every `ai_job` row for this operation. */
export const CHAT_PROMPT_VERSION = 'chat-v1';
/** Operation label (spec §12; `question_chat` already exists in the enum). */
export const CHAT_OPERATION = 'question_chat' as const;

/**
 * Spec 9.1: «تمام تاریخچه در هر درخواست ارسال نمی‌شود» — only the LAST this
 * many thread messages are sent to the model, never the full history.
 */
export const CHAT_HISTORY_WINDOW = 10;
/** Weak topics kept in the summary layer (trimmed to what fits). */
export const CHAT_SUMMARY_WEAK_TOPICS = 3;

/**
 * Validate the model's raw completion for the chat reply: plain Persian text,
 * non-empty. Throws so `AIService.runJob` retries once and finally raises
 * `BadRequestException` (spec §13.3). Pure and exported so the contract is
 * testable without a model call.
 */
export function parseChatReply(raw: string): string {
  const reply = raw.trim();
  if (!reply) throw new Error('chat reply must not be empty');
  return reply;
}

/** Everything the question-space prompt needs, resolved lazily per reply. */
export interface ChatQuestionContext {
  /** Question layer: body, type, options (null when the row is gone). */
  question: {
    id: string;
    version: number;
    text: string;
    type: string;
    options: Array<{ index: number; text: string }>;
  } | null;
  /** Answer key layer: correct option/text for this question version. */
  answerKey: {
    correctOptionIndex: number | null;
    correctText: string | null;
  } | null;
  /** Rubric parts when the question is scored by parts (spec §6). */
  rubric: Array<{ partKey: string; maxScore: string; order: number }> | null;
  /**
   * The student's REAL response for this question: attempt-scoped when the
   * thread carries an attemptId, else their latest response row.
   */
  userResponse: {
    selectedOption: number | null;
    textAnswer: string | null;
    isCorrect: boolean | null;
    activeSeconds: number;
  } | null;
  /** Correction result of that response, when one exists (spec §6). */
  correction: {
    partScores: unknown;
    totalScore: string | null;
    status: string;
  } | null;
  /** Summary layer from HistoryContextService (weak topics + total wrong). */
  summary: {
    totalWrong: number;
    weakTopics: Array<{ title: string | null; wrongCount: number }>;
  } | null;
}

/** Stored options are `{ index, text }`; ignore anything else. */
function normalizeOptions(
  raw: unknown,
): Array<{ index: number; text: string }> {
  if (!Array.isArray(raw)) return [];
  const options: Array<{ index: number; text: string }> = [];
  raw.forEach((item, position) => {
    const option = item as { index?: unknown; text?: unknown };
    if (typeof option?.text !== 'string') return;
    options.push({
      index: typeof option.index === 'number' ? option.index : position,
      text: option.text,
    });
  });
  return options;
}

/** Prefer the key's free text, else the referenced option's text. */
function describeCorrectAnswer(
  key: { correctOptionIndex: number | null; correctText: string | null } | null,
  options: Array<{ index: number; text: string }>,
): string | null {
  const text = key?.correctText?.trim();
  if (text) return text;

  const index = key?.correctOptionIndex;
  if (index === null || index === undefined) return null;

  const option = options.find((item) => item.index === index);
  return option ? `${index + 1}) ${option.text}` : `گزینه ${index + 1}`;
}

/** The student's real answer, in their own words or as the chosen option. */
function describeUserAnswer(
  resp: {
    selectedOption: number | null;
    textAnswer: string | null;
  } | null,
  options: Array<{ index: number; text: string }>,
): string {
  if (!resp) return 'پاسخی ثبت نشده است';
  const text = resp.textAnswer?.trim();
  if (text) return text;
  if (resp.selectedOption !== null && resp.selectedOption !== undefined) {
    const option = options.find((item) => item.index === resp.selectedOption);
    return option
      ? `گزینه ${resp.selectedOption + 1}: ${option.text}`
      : `گزینه ${resp.selectedOption + 1}`;
  }
  return 'پاسخی ثبت نشده است';
}

/**
 * Build the question-space chat prompt (spec 9.1/9.2): the seven clauses
 * verbatim, the lazily-resolved context layers, and ONLY the last
 * {@link CHAT_HISTORY_WINDOW} messages of the thread. Pure and exported so
 * the assembled prompt is testable without a model call.
 */
export function buildQuestionChatPrompt(input: {
  context: ChatQuestionContext;
  history: ChatMessage[];
}): string {
  const { context, history } = input;
  const lines: string[] = [
    'تو دبیر باتجربه کنکور هستی و در چتِ صفحه سؤال به دانش‌آموز پاسخ می‌دهی.',
    '',
    'قواعد زیر را عینا در همه پاسخ‌ها رعایت کن:',
    SEVEN_CLAUSES,
    '',
  ];

  // Question layer (body, type, options).
  if (context.question) {
    lines.push('صورت سؤال:', context.question.text);
    lines.push(`نوع سؤال: ${context.question.type}`);
    if (context.question.options.length > 0) {
      lines.push(
        'گزینه‌ها:',
        ...context.question.options.map(
          (option) => `- ${option.index + 1}) ${option.text}`,
        ),
      );
    } else {
      lines.push('(این سؤال گزینه ندارد؛ پاسخ تشریحی است.)');
    }
    lines.push('');
  } else {
    lines.push(
      'صورت سؤال: (در دسترس نیست؛ درباره این را از دانش‌آموز بپرس.)',
      '',
    );
  }

  // Answer key layer (never leaves the server — prompt only).
  lines.push('پاسخ‌نامه (فقط برای تو):');
  if (context.answerKey) {
    const correct = describeCorrectAnswer(
      context.answerKey,
      context.question?.options ?? [],
    );
    lines.push(
      `پاسخ درست: ${correct ?? 'در بانک سؤال ثبت نشده است؛ با استدلال علمی خودت راهنمایی کن.'}`,
    );
  } else {
    lines.push(
      'پاسخ درست: در بانک سؤال ثبت نشده است؛ با استدلال علمی خودت راهنمایی کن.',
    );
  }
  if (context.rubric && context.rubric.length > 0) {
    lines.push(
      'بخش‌های نمره‌دهی:',
      ...context.rubric
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((part) => `- ${part.partKey}: حداکثر ${part.maxScore}`),
    );
  }
  lines.push('');

  // The student's REAL response layer.
  lines.push('پاسخ دانش‌آموز به این سؤال:');
  lines.push(
    describeUserAnswer(context.userResponse, context.question?.options ?? []),
  );
  if (context.userResponse) {
    const outcome =
      context.userResponse.isCorrect === true
        ? 'درست'
        : context.userResponse.isCorrect === false
          ? 'غلط'
          : 'هنوز تصحیح نشده';
    lines.push(`نتیجه ثبت‌شده: ${outcome}`);
    lines.push(
      `زمان فعال روی سؤال: ${context.userResponse.activeSeconds} ثانیه`,
    );
  }
  lines.push('');

  // Correction layer (rubric-based grading of descriptive answers).
  if (context.correction) {
    lines.push(
      'نتیجه تصحیح تشریحی:',
      `وضعیت: ${context.correction.status}`,
      `نمره کل: ${context.correction.totalScore ?? 'ثبت نشده'}`,
      `جزئیات بخش‌ها: ${JSON.stringify(context.correction.partScores)}`,
      '',
    );
  }

  // Summary layer (weak topics + total wrong, trimmed).
  if (context.summary && context.summary.weakTopics.length > 0) {
    lines.push(
      'خلاصه سابقه دانش‌آموز:',
      ...context.summary.weakTopics.map(
        (topic) => `- ${topic.title ?? 'مبحث نامشخص'}: ${topic.wrongCount} خطا`,
      ),
      `مجموع خطاهای اخیر: ${context.summary.totalWrong}`,
      '',
    );
  }

  // History window: ONLY the last CHAT_HISTORY_WINDOW messages, ascending.
  if (history.length > 0) {
    lines.push(
      'تاریخچه گفتگو (آخرین پیام‌ها):',
      ...history.map((message) =>
        message.role === 'user'
          ? `دانش‌آموز: ${message.body}`
          : `دستیار: ${message.body}`,
      ),
      '',
    );
  }

  lines.push(
    'به آخرین پیام دانش‌آموز پاسخ بده: فقط متن فارسی پاسخ را بده؛ بدون JSON و بدون متن اضافه.',
  );
  return lines.join('\n');
}

/**
 * AI side of the question-space chat (spec 9.1/9.2): assembles the lazily
 * scoped context layers + the trimmed history window, then runs ONE logged
 * model call (`question_chat`, `chat-v1`). Storage/quota stay outside — the
 * caller (ChatService) persists around this call and owns the failure path.
 */
@Injectable()
export class ChatAiService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly aiService: AIService,
    private readonly historyContext: HistoryContextService,
  ) {}

  /**
   * One AI reply for a question-space thread: context layers + last-10
   * history → prompt → `AIService.runJob`. Throws on failure; the caller
   * keeps the stored user message and reports `ai_unavailable`.
   */
  async reply(thread: ChatThread, studentId: string): Promise<string> {
    const context = await this.buildContext(thread, studentId);
    const history = await this.loadRecentMessages(thread.id);
    const prompt = buildQuestionChatPrompt({ context, history });

    return this.aiService.runJob<string>({
      operation: CHAT_OPERATION,
      promptVersion: CHAT_PROMPT_VERSION,
      prompt,
      parse: parseChatReply,
    });
  }

  /**
   * Lazy context layers (spec 9.1): only what a question-space reply needs —
   * question → key/rubric, the student's real response (attempt-scoped when
   * the thread carries an attemptId, else their latest response), its
   * correction when one exists, and the trimmed history summary.
   */
  private async buildContext(
    thread: ChatThread,
    studentId: string,
  ): Promise<ChatQuestionContext> {
    const context: ChatQuestionContext = {
      question: null,
      answerKey: null,
      rubric: null,
      userResponse: null,
      correction: null,
      summary: null,
    };
    if (!thread.questionId) return context;

    // Layer 1 — the question (no status filter on purpose: the thread
    // references this exact question and an archived row is still real data).
    const [q] = await this.db
      .select({
        id: question.id,
        version: question.version,
        text: question.text,
        type: question.type,
        options: question.options,
      })
      .from(question)
      .where(eq(question.id, thread.questionId))
      .limit(1);
    const options = normalizeOptions(q?.options);
    if (q) {
      context.question = {
        id: q.id,
        version: q.version,
        text: q.text,
        type: q.type,
        options,
      };
    }

    // Layer 2 — the answer key of exactly this question version + rubric.
    if (q) {
      const [key] = await this.db
        .select({
          correctOptionIndex: answerKey.correctOptionIndex,
          correctText: answerKey.correctText,
        })
        .from(answerKey)
        .where(
          and(
            eq(answerKey.questionId, thread.questionId),
            eq(answerKey.questionVersion, q.version),
          ),
        )
        .limit(1);
      if (key) context.answerKey = key;

      const parts = await this.db
        .select({
          partKey: rubric.partKey,
          maxScore: rubric.maxScore,
          order: rubric.order,
        })
        .from(rubric)
        .where(eq(rubric.questionId, thread.questionId));
      if (parts.length > 0) context.rubric = parts;
    }

    // Layer 3 — the student's REAL response (attempt-scoped else latest).
    const resp = thread.attemptId
      ? await this.findResponseInAttempt(thread.attemptId, thread.questionId)
      : await this.findLatestResponse(studentId, thread.questionId);
    if (resp) {
      context.userResponse = {
        selectedOption: resp.selectedOption,
        textAnswer: resp.textAnswer,
        isCorrect: resp.isCorrect,
        activeSeconds: resp.activeSeconds,
      };

      // Layer 4 — the correction result of that response, when it exists.
      const [corr] = await this.db
        .select({
          partScores: correction.partScores,
          totalScore: correction.totalScore,
          status: correction.status,
        })
        .from(correction)
        .where(eq(correction.responseId, resp.id))
        .orderBy(desc(correction.createdAt))
        .limit(1);
      if (corr) context.correction = corr;
    }

    // Layer 5 — trimmed history summary from HistoryContextService.
    const history = await this.historyContext.buildForStudent(studentId);
    context.summary = {
      totalWrong: history.totalWrong,
      weakTopics: history.weakTopics
        .slice(0, CHAT_SUMMARY_WEAK_TOPICS)
        .map((topic) => ({
          title: topic.topicTitle,
          wrongCount: topic.wrongCount,
        })),
    };
    return context;
  }

  /** The response inside the thread's attempt (spec 15.4 scoping). */
  private async findResponseInAttempt(
    attemptId: string,
    questionId: string,
  ): Promise<{
    id: string;
    selectedOption: number | null;
    textAnswer: string | null;
    isCorrect: boolean | null;
    activeSeconds: number;
  } | null> {
    const [row] = await this.db
      .select({
        id: response.id,
        selectedOption: response.selectedOption,
        textAnswer: response.textAnswer,
        isCorrect: response.isCorrect,
        activeSeconds: response.activeSeconds,
      })
      .from(response)
      .where(
        and(
          eq(response.attemptId, attemptId),
          eq(response.questionId, questionId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** The student's latest response row for the question, across attempts. */
  private async findLatestResponse(
    studentId: string,
    questionId: string,
  ): Promise<{
    id: string;
    selectedOption: number | null;
    textAnswer: string | null;
    isCorrect: boolean | null;
    activeSeconds: number;
  } | null> {
    const [row] = await this.db
      .select({
        id: response.id,
        selectedOption: response.selectedOption,
        textAnswer: response.textAnswer,
        isCorrect: response.isCorrect,
        activeSeconds: response.activeSeconds,
      })
      .from(response)
      .innerJoin(attempt, eq(attempt.id, response.attemptId))
      .where(
        and(
          eq(attempt.studentId, studentId),
          eq(response.questionId, questionId),
        ),
      )
      .orderBy(desc(response.createdAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * ONLY the last {@link CHAT_HISTORY_WINDOW} messages (spec 9.1), newest
   * first from the DB, returned in ascending conversation order.
   */
  private async loadRecentMessages(threadId: string): Promise<ChatMessage[]> {
    const rows = await this.db
      .select()
      .from(chatMessage)
      .where(eq(chatMessage.threadId, threadId))
      .orderBy(desc(chatMessage.createdAt))
      .limit(CHAT_HISTORY_WINDOW);
    return rows.reverse();
  }
}
