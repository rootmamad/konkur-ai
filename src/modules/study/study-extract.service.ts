import { Injectable, Logger } from '@nestjs/common';

import { studyActivity, studyFeeling } from '../../db/schema/study';
import { AIService } from '../ai/ai.service';
// The seven clauses are a single spec text (9.2, «عینا») — imported from the
// chat module's single source, never reworded or duplicated here.
import { SEVEN_CLAUSES } from '../chat/chat-ai.service';

/** Operation label (spec §12; `study_extract` already exists in the enum). */
export const STUDY_EXTRACT_OPERATION = 'study_extract' as const;
/** Prompt revision tag for the study-extraction prompt. */
export const STUDY_EXTRACT_PROMPT_VERSION = 'study-extract-v1';

/** Field rules of `CreateStudyEntryDto`, restated for the model (spec 3.6). */
const LESSON_MAX = 200;
const TOPIC_MAX = 200;
const NOTE_MAX = 1000;
const MINUTES_MIN = 1;
const MINUTES_MAX = 600;
const EXERCISES_MIN = 0;
const EXERCISES_MAX = 10000;

/** The one-line preview shown to the student before any confirmation. */
export interface StudyExtractPreview {
  lesson: string;
  topic?: string;
  activity: (typeof studyActivity.enumValues)[number];
  minutes: number;
  exerciseCount?: number;
  feeling?: (typeof studyFeeling.enumValues)[number];
  note?: string;
  /** True when the model is unsure; the UI flags it, nothing is auto-saved. */
  uncertain: boolean;
}

/** Chat-envelope shape: a preview, or a notice when the AI is unavailable. */
export interface StudyExtractResult {
  preview: StudyExtractPreview | null;
  notice?: 'ai_unavailable';
}

function isEnumValue(
  value: unknown,
  values: readonly string[],
): value is string {
  return typeof value === 'string' && values.includes(value);
}

/**
 * Server-side validation of the model's raw completion: every field is held
 * to the exact `CreateStudyEntryDto` rules (lesson non-empty ≤ 200, minutes
 * an integer in [1, 600], activity/feeling within their enums, the optional
 * ints and text lengths in range, `uncertain` a boolean). Unknown extra
 * fields are dropped, never forwarded. Any violation throws so
 * `AIService.runJob` retries once and finally raises `BadRequestException`.
 * Exported so the contract is testable without a model call.
 */
export function parseStudyExtract(raw: string): StudyExtractPreview {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('study extract output is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('study extract output must be a JSON object');
  }
  const o = value as Record<string, unknown>;

  if (typeof o.lesson !== 'string' || o.lesson.trim().length === 0) {
    throw new Error('lesson must be a non-empty string');
  }
  const lesson = o.lesson.trim();
  if (lesson.length > LESSON_MAX) {
    throw new Error(`lesson must be at most ${LESSON_MAX} characters`);
  }

  let topic: string | undefined;
  if (o.topic !== undefined && o.topic !== null) {
    if (typeof o.topic !== 'string') {
      throw new Error('topic must be a string');
    }
    topic = o.topic.trim();
    if (topic.length > TOPIC_MAX) {
      throw new Error(`topic must be at most ${TOPIC_MAX} characters`);
    }
  }

  if (!isEnumValue(o.activity, studyActivity.enumValues)) {
    throw new Error(
      `activity must be one of ${studyActivity.enumValues.join(' | ')}`,
    );
  }
  const activity = o.activity as StudyExtractPreview['activity'];

  if (
    typeof o.minutes !== 'number' ||
    !Number.isInteger(o.minutes) ||
    o.minutes < MINUTES_MIN ||
    o.minutes > MINUTES_MAX
  ) {
    throw new Error(
      `minutes must be an integer in [${MINUTES_MIN}, ${MINUTES_MAX}]`,
    );
  }
  const minutes = o.minutes;

  let exerciseCount: number | undefined;
  if (o.exerciseCount !== undefined && o.exerciseCount !== null) {
    if (
      typeof o.exerciseCount !== 'number' ||
      !Number.isInteger(o.exerciseCount) ||
      o.exerciseCount < EXERCISES_MIN ||
      o.exerciseCount > EXERCISES_MAX
    ) {
      throw new Error(
        `exerciseCount must be an integer in [${EXERCISES_MIN}, ${EXERCISES_MAX}]`,
      );
    }
    exerciseCount = o.exerciseCount;
  }

  let feeling: StudyExtractPreview['feeling'];
  if (o.feeling !== undefined && o.feeling !== null) {
    if (!isEnumValue(o.feeling, studyFeeling.enumValues)) {
      throw new Error(
        `feeling must be one of ${studyFeeling.enumValues.join(' | ')}`,
      );
    }
    feeling = o.feeling as StudyExtractPreview['feeling'];
  }

  let note: string | undefined;
  if (o.note !== undefined && o.note !== null) {
    if (typeof o.note !== 'string') {
      throw new Error('note must be a string');
    }
    note = o.note.trim();
    if (note.length > NOTE_MAX) {
      throw new Error(`note must be at most ${NOTE_MAX} characters`);
    }
  }

  if (typeof o.uncertain !== 'boolean') {
    throw new Error('uncertain must be a boolean');
  }
  const uncertain = o.uncertain;

  const preview: StudyExtractPreview = { lesson, activity, minutes, uncertain };
  if (topic) preview.topic = topic;
  if (exerciseCount !== undefined) preview.exerciseCount = exerciseCount;
  if (feeling !== undefined) preview.feeling = feeling;
  if (note) preview.note = note;
  return preview;
}

/**
 * Build the study-extraction prompt (spec 3.6 path 1): the seven clauses
 * verbatim, the valid enum values, the exact field rules, and the student's
 * free text. The model outputs STRICT JSON only — never a total, never
 * invented fields. Pure and exported so the assembled prompt is testable
 * without a model call.
 */
export function buildStudyExtractPrompt(input: { text: string }): string {
  return [
    'تو دستیار ثبت مطالعه هستی؛ متن آزاد دانش‌آموز را به یک رکورد ثبت مطالعه تبدیل کن.',
    '',
    'قواعد زیر را عینا در همه پاسخ‌ها رعایت کن:',
    SEVEN_CLAUSES,
    '',
    'فقط و فقط یک JSON معتبر برگردان، بدون هیچ متن اضافه:',
    '{"lesson":"<نام درس/موضوع>","topic":"<اختیاری>","activity":"<یکی از مقادیر زیر>","minutes":<عدد صحیح>,"exerciseCount":<اختیاری؛ عدد صحیح>,"feeling":"<اختیاری؛ یکی از مقادیر زیر>","note":"<اختیاری>","uncertain":false}',
    '',
    'قواعد فیلدها:',
    `- lesson: غیرخالی، حداکثر ${LESSON_MAX} نویسه.`,
    `- topic: اختیاری، حداکثر ${TOPIC_MAX} نویسه.`,
    `- activity: فقط یکی از ${studyActivity.enumValues.join(' | ')}.`,
    `- minutes: عدد صحیح بین ${MINUTES_MIN} تا ${MINUTES_MAX}.`,
    `- exerciseCount: اختیاری، عدد صحیح بین ${EXERCISES_MIN} تا ${EXERCISES_MAX}.`,
    `- feeling: اختیاری، فقط یکی از ${studyFeeling.enumValues.join(' | ')}.`,
    `- note: اختیاری، حداکثر ${NOTE_MAX} نویسه.`,
    '- uncertain: اگر در استخراج مطمئن نیستی true بگذار.',
    '- هیچ فیلدی غیر از فیلدهای بالا نساز و هیچ جمع یا عدد دیگری (مثل مجموع دقیقه‌ها) برنگردان.',
    '',
    'متن دانش‌آموز:',
    input.text,
  ].join('\n');
}

/**
 * AI study-entry extraction (spec 3.6 path 1, step 1): «کاربر می‌نویسد، AI
 * استخراج می‌کند، پیش‌نمایش یک‌خطی نشان داده می‌شود». This service is PURE —
 * it never touches the database; nothing is persisted until the student
 * confirms via POST /study/entries/from-chat («بدون تأیید چیزی ثبت
 * نمی‌شود»). No user-facing quota (§10 names only coach + floating chat).
 */
@Injectable()
export class StudyExtractService {
  private readonly logger = new Logger(StudyExtractService.name);

  constructor(private readonly aiService: AIService) {}

  /**
   * Extract the preview from the student's free text. On any model failure
   * the envelope returns `{ preview: null, notice: 'ai_unavailable' }` with
   * HTTP 200 — the chat pattern; extraction never becomes a 500.
   */
  async extractPreview(
    userId: string,
    text: string,
  ): Promise<StudyExtractResult> {
    try {
      const preview = await this.aiService.runJob<StudyExtractPreview>({
        operation: STUDY_EXTRACT_OPERATION,
        promptVersion: STUDY_EXTRACT_PROMPT_VERSION,
        prompt: buildStudyExtractPrompt({ text }),
        parse: parseStudyExtract,
      });
      return { preview };
    } catch (err: unknown) {
      this.logger.warn(
        `[${userId}] study extract failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { preview: null, notice: 'ai_unavailable' };
    }
  }
}
