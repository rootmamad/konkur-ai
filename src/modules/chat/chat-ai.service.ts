import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';

import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import { chatMessage } from '../../db/schema/chat';
import type { ChatMessage, ChatThread } from '../../db/schema/chat';
import { answerKey } from '../../db/schema/answer-key';
import { attempt } from '../../db/schema/attempt';
import { correction } from '../../db/schema/correction';
import { examInstance, examTemplate } from '../../db/schema/exam';
import { question } from '../../db/schema/question';
import { response } from '../../db/schema/response';
import { rubric } from '../../db/schema/rubric';
import { student } from '../../db/schema/student';
import { studyLog } from '../../db/schema/study';
import { topic } from '../../db/schema/topic';
import { AIService } from '../ai/ai.service';
import { HistoryContextService } from '../ai/history-context.service';
import type { HistoryContext } from '../ai/history-context.service';

/**
 * The seven-clause block (spec 9.2, «عینا»): VERBATIM in every chat prompt —
 * never reworded, never split.
 */
export const SEVEN_CLAUSES =
  '۱. فقط از داده داده‌شده استفاده کن؛ حدس نزن. ۲. اگر اطلاعات کافی نیست بگو و سؤال روشن‌کننده بپرس. ۳. عدد نساز؛ اعداد داده‌شده را تکرار کن، محاسبه نکن. ۴. علت قطعی برای خطا اعلام نکن؛ احتمال بده یا بپرس. ۵. راه‌حل متفاوت با پاسخ‌نامه را خودکار غلط ندان. ۶. هر جمله تحلیلی باید به یک شاهد مشخص وصل باشد؛ کلی‌گویی ممنوع. ۷. لحن همدل ولی صادق؛ ضعف را نه بپوشان نه تحقیر کن.';

/** Prompt revision tag written to every `ai_job` row for this operation. */
export const CHAT_PROMPT_VERSION = 'chat-v1';
/** Operation label (spec §12; `question_chat` already exists in the enum). */
export const CHAT_OPERATION = 'question_chat' as const;

/**
 * The three coach composer tabs (spec 9.1): every coach send is explicit
 * about which mode produced it — the prompt layers differ per mode.
 */
export const COACH_MODES = ['motivation', 'planning', 'debug'] as const;
export type CoachMode = (typeof COACH_MODES)[number];
/** Operation label for coach-space replies (exists in `ai_operation`). */
export const COACH_OPERATION = 'coach' as const;
/** Prompt revision tag for coach replies. */
export const COACH_PROMPT_VERSION = 'coach-v1';
/** Operation label for exam-analysis replies (exists in `ai_operation`). */
export const EXAM_ANALYSIS_OPERATION = 'exam_analysis' as const;
/** Prompt revision tag for exam-analysis replies. */
export const EXAM_ANALYSIS_PROMPT_VERSION = 'exam-analysis-v1';
/** Persian display label per mode (used in the prompt header). */
const COACH_MODE_LABEL: Record<CoachMode, string> = {
  motivation: 'انگیزشی',
  planning: 'برنامه‌ریزی',
  debug: 'رفع اشکال',
};

/**
 * The mode's own قواعد (spec 9.1): each mode adds one rule line on top of
 * the seven clauses — what the reply may and may not do in that mode.
 */
export const COACH_MODE_RULES: Record<CoachMode, string> = {
  motivation:
    'فقط با اعداد داده‌شده دلگرمی بساز؛ هیچ عدد یا دستاورد جدیدی نساز و فهرست ضعف‌ها را تکرار نکن.',
  planning:
    'برنامه پیشنهادی را به موضوعات ضعیف داده‌شده گره بزن؛ هیچ کمیت، ساعت یا ترتیبی از خودت نساز؛ برای هر بخش نامشخص سؤال روشن‌کننده بپرس.',
  debug:
    'تشخیص را فقط از نمونه پاسخ‌های غلط داده‌شده بساز؛ اگر از دلیل خطا مطمئن نیستی، سؤال روشن‌کننده بپرس.',
};

/**
 * Bounded lazy reads for the coach prompt (spec §13.3): the study-log window,
 * how many recent titles the planning layer keeps, and how many self-reported
 * studied-topic ids are rendered.
 */
export const COACH_ACTIVITY_WINDOW_DAYS = 7;
export const COACH_STUDY_TITLES_LIMIT = 5;
export const COACH_STUDIED_TOPICS_LIMIT = 10;

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

/** Fixed profile layer of the coach prompt (student table row, spec 9.1). */
export interface CoachStudentProfile {
  major: string | null;
  grade: string | null;
  targetYear: number | null;
  streak: number;
  studiedTopicIds: string[];
}

/** Everything one coach reply needs, resolved lazily per mode. */
export interface CoachChatPromptInput {
  mode: CoachMode;
  /** Fixed layer: profile row (null when the profile is missing). */
  profile: CoachStudentProfile | null;
  /** Summary layer from HistoryContextService (streak lives on the profile). */
  summary: HistoryContext | null;
  /** motivation only: study-log entries in the last 7 days. */
  activityCount7d: number | null;
  /** planning only: recent study-log titles, newest first. */
  studyTitles: string[] | null;
  /** ONLY the last CHAT_HISTORY_WINDOW thread messages, ascending. */
  history: ChatMessage[];
}

/**
 * Build the coach chat prompt (spec 9.1): fixed profile layer, summary
 * layer, and the mode's lazy layer — motivation carries COUNTS only (a pep
 * talk never dumps wrong-answer data), planning adds studied topics + recent
 * study titles, debug adds the weak topics' sample wrong answers. Each mode
 * adds its own rule line on top of the seven clauses (verbatim). Pure and
 * exported so the assembled prompt is testable without a model call.
 */
export function buildCoachChatPrompt(input: CoachChatPromptInput): string {
  const { mode, profile, summary } = input;
  const lines: string[] = [
    'تو دبیر باتجربه کنکور هستی و در چتِ مربی به دانش‌آموز پاسخ می‌دهی.',
    `حالت این پاسخ: ${COACH_MODE_LABEL[mode]}`,
    '',
    'قواعد زیر را عینا در همه پاسخ‌ها رعایت کن:',
    SEVEN_CLAUSES,
    '',
    'قواعد مخصوص این حالت:',
    `- ${COACH_MODE_RULES[mode]}`,
    '',
  ];

  // Fixed layer — strand/grade/target-year + streak (one profile read).
  lines.push(
    'پروفایل دانش‌آموز:',
    `- رشته: ${profile?.major ?? 'نامشخص'}`,
    `- پایه: ${profile?.grade ?? 'نامشخص'}`,
    `- سال هدف کنکور: ${profile?.targetYear ?? 'نامشخص'}`,
    `- استریک فعلی: ${profile?.streak ?? 0} روز`,
    '',
  );

  // Summary layer — rendered per mode (spec 9.1: lazily, per operation).
  lines.push('خلاصه سابقه دانش‌آموز:');
  if (mode === 'motivation') {
    // COUNTS only: no topic titles, no samples (a pep talk dumps no data).
    lines.push(
      `- مجموع خطاهای اخیر: ${summary?.totalWrong ?? 0}`,
      `- موضوعات نیازمند تمرین: ${summary?.weakTopics.length ?? 0} موضوع`,
      `- مطالعات ثبت‌شده در ۷ روز گذشته: ${input.activityCount7d ?? 0} مورد`,
    );
  } else if (summary && summary.weakTopics.length > 0) {
    for (const topic of summary.weakTopics.slice(0, CHAT_SUMMARY_WEAK_TOPICS)) {
      lines.push(
        `- ${topic.topicTitle ?? 'مبحث نامشخص'}: ${topic.wrongCount} خطا`,
      );
      // debug only: the retained sample wrong-answer texts (already capped
      // by HistoryContextService at 300 chars each).
      if (mode === 'debug') {
        for (const sample of topic.sampleWrongTexts) {
          lines.push(`  · نمونه: ${sample}`);
        }
      }
    }
    lines.push(`مجموع خطاهای اخیر: ${summary.totalWrong}`);
  } else {
    lines.push('- موضوع ضعیفی در بازه اخیر ثبت نشده است.');
  }
  if (mode === 'planning') {
    const studied = (profile?.studiedTopicIds ?? []).slice(
      0,
      COACH_STUDIED_TOPICS_LIMIT,
    );
    if (studied.length > 0) {
      lines.push(`موضوعات مطالعه‌شده (خوداعلامی): ${studied.join('، ')}`);
    }
    if (input.studyTitles && input.studyTitles.length > 0) {
      lines.push(
        'مطالعات اخیر (۷ روز گذشته):',
        ...input.studyTitles.map((title) => `- ${title}`),
      );
    }
  }
  lines.push('');

  // History window: same last-10 rule as the question chat, ascending.
  if (input.history.length > 0) {
    lines.push(
      'تاریخچه گفتگو (آخرین پیام‌ها):',
      ...input.history.map((message) =>
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

/** Attempt + exam header row for the exam-analysis prompt (one read). */
export interface ExamAttemptMeta {
  status: string;
  totalScore: number | null;
  startedAt: Date | null;
  submittedAt: Date | null;
  examKind: string | null;
  examTitle: string | null;
  /** Frozen question order of the instance — its length counts the blanks. */
  questionOrder: unknown;
}

/** One attempt-scoped response row joined to its question's topic. */
export interface ExamTopicRow {
  topicTitle: string | null;
  selectedOption: number | null;
  textAnswer: string | null;
  isCorrect: boolean | null;
  activeSeconds: number;
}

/** Everything one exam-analysis reply needs, all scoped to THAT attempt. */
export interface ExamAnalysisPromptInput {
  meta: ExamAttemptMeta | null;
  topicRows: ExamTopicRow[];
  /** ONLY the last CHAT_HISTORY_WINDOW thread messages, ascending. */
  history: ChatMessage[];
}

const hasAnswer = (row: ExamTopicRow): boolean =>
  (row.selectedOption !== null && row.selectedOption !== undefined) ||
  (row.textAnswer?.trim().length ?? 0) > 0;

/**
 * Build the exam-analysis chat prompt (spec 9.1): ONLY this attempt's real
 * numbers (clause 3 — the model repeats them, never invents), the per-topic
 * correct/wrong/blank breakdown, and the weakest topics of this attempt as
 * suggestions. All counts are computed HERE in JS from the attempt-scoped
 * rows; the model only repeats them. Pure and exported so the assembled
 * prompt is testable without a model call.
 */
export function buildExamAnalysisPrompt(
  input: ExamAnalysisPromptInput,
): string {
  const { meta, topicRows, history } = input;
  const lines: string[] = [
    'تو دبیر باتجربه کنکور هستی و در چتِ تحلیل آزمون به دانش‌آموز پاسخ می‌دهی.',
    '',
    'قواعد زیر را عینا در همه پاسخ‌ها رعایت کن:',
    SEVEN_CLAUSES,
    '',
    'تمام اعداد زیر واقعی و مربوط به همین آزمون‌اند؛ هیچ عدد یا نتیجه‌ای از خودت نساز.',
    '',
  ];

  if (!meta) {
    lines.push(
      'مشخصات آزمون: (در دسترس نیست؛ درباره جزئیات آزمون از دانش‌آموز بپرس.)',
      '',
    );
  } else {
    const answered = topicRows.filter(hasAnswer).length;
    const totalQuestions = Array.isArray(meta.questionOrder)
      ? meta.questionOrder.length
      : null;
    const blank =
      totalQuestions === null ? null : Math.max(totalQuestions - answered, 0);
    const graded = topicRows.filter(
      (row) => row.isCorrect === true || row.isCorrect === false,
    );
    const correct = graded.filter((row) => row.isCorrect === true).length;
    const totalActive = topicRows.reduce(
      (sum, row) => sum + (row.activeSeconds ?? 0),
      0,
    );

    lines.push('مشخصات آزمون:');
    lines.push(`- عنوان: ${meta.examTitle ?? 'نامشخص'}`);
    lines.push(`- نوع آزمون: ${meta.examKind ?? 'نامشخص'}`);
    lines.push(`- وضعیت: ${meta.status}`);
    lines.push(
      `- شروع: ${meta.startedAt ? meta.startedAt.toISOString() : 'نامشخص'}`,
    );
    lines.push(
      `- ارسال: ${meta.submittedAt ? meta.submittedAt.toISOString() : 'ارسال نشده'}`,
    );
    lines.push(`- نمره کل: ${meta.totalScore ?? 'هنوز محاسبه نشده'}`);
    if (graded.length > 0) {
      lines.push(
        `- درصد درست از پاسخ‌های تصحیح‌شده: ${Math.round(
          (100 * correct) / graded.length,
        )}`,
      );
    }
    lines.push(`- پاسخ داده‌شده: ${answered} سؤال`);
    if (blank !== null) lines.push(`- سفید: ${blank} سؤال`);
    lines.push(`- زمان فعال: ${totalActive} ثانیه`, '');

    // Per-topic breakdown — grouped from THIS attempt's rows only.
    type Acc = { total: number; correct: number; wrong: number; blank: number };
    const byTopic = new Map<string, Acc>();
    for (const row of topicRows) {
      const key = row.topicTitle ?? 'موضوع نامشخص';
      const acc = byTopic.get(key) ?? {
        total: 0,
        correct: 0,
        wrong: 0,
        blank: 0,
      };
      acc.total += 1;
      if (row.isCorrect === true) acc.correct += 1;
      else if (row.isCorrect === false) acc.wrong += 1;
      if (!hasAnswer(row)) acc.blank += 1;
      byTopic.set(key, acc);
    }
    if (byTopic.size > 0) {
      lines.push('تفکیک موضوعی:');
      for (const [title, acc] of byTopic) {
        lines.push(
          `- ${title}: ${acc.total} سؤال — ${acc.correct} درست، ${acc.wrong} غلط، ${acc.blank} سفید`,
        );
      }
      lines.push('');
      // Suggestions: this attempt's weakest topics (most wrong answers).
      const weakest = [...byTopic.entries()]
        .filter(([, acc]) => acc.wrong > 0)
        .sort((a, b) => b[1].wrong - a[1].wrong)
        .slice(0, CHAT_SUMMARY_WEAK_TOPICS);
      if (weakest.length > 0) {
        lines.push(
          'موضوعات پیشنهادی برای تمرین (بیشترین خطا در همین آزمون):',
          ...weakest.map(([title, acc]) => `- ${title} (${acc.wrong} خطا)`),
          '',
        );
      }
    }
  }

  // History window: same last-10 rule as the other chat paths, ascending.
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
 * AI side of the chat spaces (spec 9.1/9.2): question chat, coach
 * three-mode chat, and exam-analysis chat. Each path assembles its lazily
 * scoped context layers + the trimmed history window, then runs ONE logged
 * model call with its own operation/promptVersion. Storage/quota stay
 * outside — the caller (ChatService) persists around the call and owns the
 * failure path.
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
   * One AI reply for a coach-space thread (spec 9.1): fixed profile layer +
   * summary layer + the mode's lazy layer → prompt → ONE logged model call
   * (`coach`, `coach-v1`). Same contract as {@link reply}: throws on
   * failure; the caller keeps the stored user message and reports
   * `ai_unavailable`. The free-plan quota is the caller's concern.
   */
  async replyCoach(
    thread: ChatThread,
    studentId: string,
    mode: CoachMode,
  ): Promise<string> {
    const profile = await this.loadCoachProfile(studentId);
    const summary = await this.historyContext.buildForStudent(studentId);
    const history = await this.loadRecentMessages(thread.id);

    // Lazy layer — only what THIS mode consumes (spec §13.3).
    const activityCount7d =
      mode === 'motivation' ? await this.countRecentStudyLog(studentId) : null;
    const studyTitles =
      mode === 'planning' ? await this.loadRecentStudyTitles(studentId) : null;

    const prompt = buildCoachChatPrompt({
      mode,
      profile,
      summary,
      activityCount7d,
      studyTitles,
      history,
    });

    return this.aiService.runJob<string>({
      operation: COACH_OPERATION,
      promptVersion: COACH_PROMPT_VERSION,
      prompt,
      parse: parseChatReply,
    });
  }

  /**
   * One AI reply for an exam_analysis thread (spec 9.1): the context is
   * THAT attempt only (its ref was ownership-verified at thread creation,
   * and both reads below re-scope by the caller's student id anyway).
   * Counts and percentages are computed HERE from the attempt's real rows —
   * the model only repeats them (clause 3). Same contract as the other
   * paths: throws on failure; the caller owns persistence and the
   * failure envelope. The free-plan quota never applies to this space.
   */
  async replyExamAnalysis(
    thread: ChatThread,
    studentId: string,
  ): Promise<string> {
    if (!thread.attemptId) {
      // exam_analysis threads always carry an attempt (validated matrix);
      // this guard only keeps the types honest.
      throw new Error('exam_analysis thread without attemptId');
    }

    const meta = await this.loadAttemptMeta(thread.attemptId, studentId);
    const topicRows = await this.loadAttemptTopicRows(thread.attemptId);
    const history = await this.loadRecentMessages(thread.id);

    const prompt = buildExamAnalysisPrompt({ meta, topicRows, history });

    return this.aiService.runJob<string>({
      operation: EXAM_ANALYSIS_OPERATION,
      promptVersion: EXAM_ANALYSIS_PROMPT_VERSION,
      prompt,
      parse: parseChatReply,
    });
  }

  /**
   * The attempt header + exam kind/title, scoped to THIS attempt AND the
   * caller (defense in depth, spec 15.5). `questionOrder` gives the blank
   * count its denominator. Null when the attempt is not the caller's.
   */
  private async loadAttemptMeta(
    attemptId: string,
    studentId: string,
  ): Promise<ExamAttemptMeta | null> {
    const [row] = await this.db
      .select({
        status: attempt.status,
        totalScore: attempt.totalScore,
        startedAt: attempt.startedAt,
        submittedAt: attempt.submittedAt,
        examKind: examTemplate.kind,
        examTitle: examTemplate.title,
        questionOrder: examInstance.questionOrder,
      })
      .from(attempt)
      .innerJoin(examInstance, eq(examInstance.id, attempt.examInstanceId))
      .leftJoin(examTemplate, eq(examTemplate.id, examInstance.templateId))
      .where(and(eq(attempt.id, attemptId), eq(attempt.studentId, studentId)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Every response of THIS attempt with its topic — correct/wrong/blank are
   * grouped in JS from these real rows. Bounded by the attempt's own
   * question count (one row per question, unique index), so no limit.
   */
  private async loadAttemptTopicRows(
    attemptId: string,
  ): Promise<ExamTopicRow[]> {
    return this.db
      .select({
        topicTitle: topic.title,
        selectedOption: response.selectedOption,
        textAnswer: response.textAnswer,
        isCorrect: response.isCorrect,
        activeSeconds: response.activeSeconds,
      })
      .from(response)
      .innerJoin(question, eq(question.id, response.questionId))
      .leftJoin(topic, eq(topic.id, question.topicId))
      .where(eq(response.attemptId, attemptId));
  }

  /** Fixed layer: strand/grade/target-year + streak + studied topics. */
  private async loadCoachProfile(
    studentId: string,
  ): Promise<CoachStudentProfile | null> {
    const [row] = await this.db
      .select({
        major: student.major,
        grade: student.grade,
        targetYear: student.targetYear,
        streak: student.streak,
        studiedTopicIds: student.studiedTopicIds,
      })
      .from(student)
      .where(eq(student.id, studentId))
      .limit(1);
    if (!row) return null;
    return {
      major: row.major,
      grade: row.grade,
      targetYear: row.targetYear,
      streak: row.streak,
      studiedTopicIds: Array.isArray(row.studiedTopicIds)
        ? row.studiedTopicIds
        : [],
    };
  }

  /** Motivation layer: how many study-log entries the last 7 days hold. */
  private async countRecentStudyLog(studentId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(studyLog)
      .where(
        and(
          eq(studyLog.studentId, studentId),
          sql`${studyLog.doneAt} >= now() - interval '${sql.raw(
            String(COACH_ACTIVITY_WINDOW_DAYS),
          )} days'`,
        ),
      );
    return row?.count ?? 0;
  }

  /** Planning layer: recent study-log titles, newest first, capped. */
  private async loadRecentStudyTitles(studentId: string): Promise<string[]> {
    const rows = await this.db
      .select({ lesson: studyLog.lesson, topic: studyLog.topic })
      .from(studyLog)
      .where(
        and(
          eq(studyLog.studentId, studentId),
          sql`${studyLog.doneAt} >= now() - interval '${sql.raw(
            String(COACH_ACTIVITY_WINDOW_DAYS),
          )} days'`,
        ),
      )
      .orderBy(desc(studyLog.doneAt))
      .limit(COACH_STUDY_TITLES_LIMIT);
    return rows.map((row) =>
      row.topic ? `${row.lesson} — ${row.topic}` : row.lesson,
    );
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
    // Defense in depth (spec 15.5): never trust the thread's attemptId ref
    // alone — attempt-scoped response/correction data is read only when the
    // attempt is verified to belong to THIS student; anything else degrades
    // to the caller-scoped latest-response read, so no cross-student exam
    // data can enter a prompt.
    const ownedAttemptId =
      thread.attemptId &&
      (await this.attemptOwnedBy(thread.attemptId, studentId))
        ? thread.attemptId
        : null;
    const resp = ownedAttemptId
      ? await this.findResponseInAttempt(ownedAttemptId, thread.questionId)
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

  /** True only when the attempt exists AND belongs to this student (15.5). */
  private async attemptOwnedBy(
    attemptId: string,
    studentId: string,
  ): Promise<boolean> {
    const [row] = await this.db
      .select({ id: attempt.id })
      .from(attempt)
      .where(and(eq(attempt.id, attemptId), eq(attempt.studentId, studentId)))
      .limit(1);
    return row !== undefined;
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
