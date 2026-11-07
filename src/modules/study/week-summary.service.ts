import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, lt } from 'drizzle-orm';

import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import { chatMessage, chatThread } from '../../db/schema/chat';
import { studyLog } from '../../db/schema/study';
import type { StudyLog } from '../../db/schema/study';
import { AIService } from '../ai/ai.service';
import { StudyService } from './study.service';

/** Chat space that hosts the student's coach conversation (spec §9). */
const COACH_SPACE = 'coach' as const;
/** Prompt revision tag written to every `ai_job` row for this operation. */
export const WEEK_SUMMARY_PROMPT_VERSION = 'week-v1';
/** Operation label from spec §12; the enum already carries `study_extract`. */
export const WEEK_SUMMARY_OPERATION = 'study_extract' as const;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Context bounds: the model never sees more than this many entries. */
export const WEEK_CONTEXT_MAX_ROWS = 50;
/** Notes are truncated before they reach the prompt (history-context hygiene). */
export const NOTE_MAX_CHARS = 200;

/** Output contract bounds enforced by `parseWeekSummary`. */
export const SUMMARY_MIN_CHARS = 50;
export const SUMMARY_MAX_CHARS = 3000;
export const NEXT_FOCUS_MAX_CHARS = 300;

/**
 * One study entry as the model sees it: a compact row, not the DB shape.
 * Absent optional columns are omitted entirely instead of serialized as null.
 */
export interface WeekContextEntry {
  lesson: string;
  topic?: string;
  activity?: string;
  minutes: number;
  feeling?: string;
  note?: string;
}

/** Exact model output contract for the weekly summary. */
export interface WeekSummaryOutput {
  /** Persian text shown as the "خلاصه هفته من" message. */
  summary: string;
  /** Optional one-line focus for the coming week. */
  nextFocus?: string;
}

/** Latest persisted week summary, read back from the coach thread. */
export interface LatestWeekSummary {
  at: Date;
  summary: string;
}

/**
 * Validate the model's raw completion against the weekly-summary contract.
 *
 * Throws on anything unexpected so `AIService.runJob` retries the whole call
 * once and finally raises `BadRequestException` (spec §13.3). Pure and
 * exported so the contract is testable without a model call.
 */
export function parseWeekSummary(raw: string): WeekSummaryOutput {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('week summary output must be a JSON object');
  }

  const { summary, nextFocus } = parsed as {
    summary?: unknown;
    nextFocus?: unknown;
  };

  if (typeof summary !== 'string') {
    throw new Error('summary must be a string');
  }
  const text = summary.trim();
  if (text.length < SUMMARY_MIN_CHARS) {
    throw new Error(`summary must be at least ${SUMMARY_MIN_CHARS} characters`);
  }
  if (text.length > SUMMARY_MAX_CHARS) {
    throw new Error(`summary must be at most ${SUMMARY_MAX_CHARS} characters`);
  }

  const result: WeekSummaryOutput = { summary: text };

  if (nextFocus !== undefined && nextFocus !== null) {
    if (typeof nextFocus !== 'string') {
      throw new Error('nextFocus must be a string');
    }
    const focus = nextFocus.trim();
    if (focus.length > NEXT_FOCUS_MAX_CHARS) {
      throw new Error(
        `nextFocus must be at most ${NEXT_FOCUS_MAX_CHARS} characters`,
      );
    }
    if (focus.length > 0) result.nextFocus = focus;
  }

  return result;
}

/**
 * Build the coach prompt: the compact entry list plus the strict output
 * contract. Only the mapped rows are serialized, so no raw study_log columns
 * (ids, timestamps, source, status) ever reach the model.
 */
export function buildWeekSummaryPrompt(context: WeekContextEntry[]): string {
  return [
    'تو مربی کنکور هستی. فهرست کوتاه جلسات مطالعه این هفته را ببین و «خلاصه هفته من» را بنویس.',
    '',
    'قواعد:',
    '- فارسی روان و انگیزشی؛ حداکثر دو پاراگراف یا چند بولت کوتاه.',
    '- فقط بر پایه همین فهرست استدلال کن؛ هیچ جلسه، درس یا عددی از خودت نساز.',
    '- به حجم مطالعه، تنوع درس‌ها و جلسات با حس مبهم (vague) اشاره کن.',
    '- اگر جلسه‌ای نبود، صادقانه بگو که این هفته ثبت نشده و یک قدم کوچک پیشنهاد بده.',
    '',
    'فهرست جلسات (JSON):',
    JSON.stringify(context),
    '',
    'قرارداد خروجی: فقط و فقط یک آبجکت JSON با این کلیدها، بدون هیچ متن اضافه:',
    '{"summary": "...", "nextFocus": "..."}',
    `- summary: متن فارسی بین ${SUMMARY_MIN_CHARS} تا ${SUMMARY_MAX_CHARS} کاراکتر.`,
    `- nextFocus: اختیاری، حداکثر ${NEXT_FOCUS_MAX_CHARS} کاراکتر، یک تمرکز برای هفته آینده.`,
  ].join('\n');
}

/**
 * Weekly study summary (spec §3.6 "خلاصه هفته من" + §12).
 *
 * Same two-phase shape as the dashboard's overall analysis: the model call runs
 * OUTSIDE any transaction and persistence happens only after it resolves, in a
 * single transaction that appends the coach message and flips exactly the
 * consumed `pending` rows of that week to `summarized`. A failed job therefore
 * never marks rows as read, so they are retried on the next attempt.
 */
@Injectable()
export class WeekSummaryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly study: StudyService,
    private readonly aiService: AIService,
  ) {}

  /**
   * Generate one week summary and persist it, then flip the week's pending
   * rows. Rejects on model/parse failure and — in that case — writes nothing.
   */
  async generateWeekSummary(userId: string, weekStart: Date): Promise<void> {
    const studentId = await this.study.resolveStudentId(userId);

    const context = await this.buildWeekContext(studentId, weekStart);

    // Model call first, connection-free: no transaction is held across it.
    const result = await this.aiService.runJob<WeekSummaryOutput>({
      operation: WEEK_SUMMARY_OPERATION,
      promptVersion: WEEK_SUMMARY_PROMPT_VERSION,
      prompt: buildWeekSummaryPrompt(context),
      parse: parseWeekSummary,
    });

    await this.persist(studentId, weekStart, result.summary);
  }

  /**
   * Compact, prompt-safe view of the week's not-yet-summarised entries.
   *
   * Only `status = 'pending'` rows inside `[weekStart, weekStart + 7d)` are
   * selected (rows of previous weeks or already summarised rows never leak in
   * twice), newest first, capped at {@link WEEK_CONTEXT_MAX_ROWS}. Notes are
   * truncated to {@link NOTE_MAX_CHARS} characters.
   */
  async buildWeekContext(
    studentId: string,
    weekStart: Date,
  ): Promise<WeekContextEntry[]> {
    const weekEnd = new Date(weekStart.getTime() + WEEK_MS);

    const rows = await this.db
      .select({
        lesson: studyLog.lesson,
        topic: studyLog.topic,
        activity: studyLog.activity,
        minutes: studyLog.minutes,
        feeling: studyLog.feeling,
        note: studyLog.note,
      })
      .from(studyLog)
      .where(
        and(
          eq(studyLog.studentId, studentId),
          eq(studyLog.status, 'pending'),
          gte(studyLog.doneAt, weekStart),
          lt(studyLog.doneAt, weekEnd),
        ),
      )
      .orderBy(desc(studyLog.doneAt))
      .limit(WEEK_CONTEXT_MAX_ROWS);

    return rows.map((row) => toContextEntry(row));
  }

  /** Latest week summary for the student's coach thread, or 404. */
  async getLatestWeekSummary(userId: string): Promise<LatestWeekSummary> {
    const studentId = await this.study.resolveStudentId(userId);

    const [row] = await this.db
      .select({ body: chatMessage.body, createdAt: chatMessage.createdAt })
      .from(chatMessage)
      .innerJoin(chatThread, eq(chatThread.id, chatMessage.threadId))
      .where(
        and(
          eq(chatThread.studentId, studentId),
          eq(chatThread.space, COACH_SPACE),
          eq(chatMessage.role, 'assistant'),
        ),
      )
      .orderBy(desc(chatMessage.createdAt))
      .limit(1);

    if (!row) throw new NotFoundException('no week summary yet');

    return { at: row.createdAt, summary: row.body };
  }

  /**
   * Append the summary to the student's single coach thread and consume the
   * week's pending rows in one transaction.
   *
   * Thread lookup happens before the transaction; inside it only inserts and
   * the status flip run — never a model call.
   */
  private async persist(
    studentId: string,
    weekStart: Date,
    summary: string,
  ): Promise<void> {
    const existingThreadId = await this.findThreadId(studentId);
    const weekEnd = new Date(weekStart.getTime() + WEEK_MS);

    await this.db.transaction(async (tx) => {
      let threadId = existingThreadId;
      if (!threadId) {
        const [created] = await tx
          .insert(chatThread)
          .values({ studentId, space: COACH_SPACE })
          .returning({ id: chatThread.id });
        threadId = created.id;
      }

      await tx
        .insert(chatMessage)
        .values({ threadId, role: 'assistant', body: summary });

      // Flip exactly the rows this run summarised: pending, this student and
      // inside the same week window. Already-summarised rows are untouched.
      await tx
        .update(studyLog)
        .set({ status: 'summarized' })
        .where(
          and(
            eq(studyLog.studentId, studentId),
            eq(studyLog.status, 'pending'),
            gte(studyLog.doneAt, weekStart),
            lt(studyLog.doneAt, weekEnd),
          ),
        );
    });
  }

  /** One coach thread per student, reused across summaries and chats. */
  private async findThreadId(studentId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: chatThread.id })
      .from(chatThread)
      .where(
        and(
          eq(chatThread.studentId, studentId),
          eq(chatThread.space, COACH_SPACE),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }
}

/** Drop null columns and truncate the note so the prompt stays compact. */
function toContextEntry(
  row: Pick<
    StudyLog,
    'lesson' | 'topic' | 'activity' | 'minutes' | 'feeling' | 'note'
  >,
): WeekContextEntry {
  const note = row.note?.trim();
  return {
    lesson: row.lesson,
    topic: row.topic ?? undefined,
    activity: row.activity ?? undefined,
    minutes: row.minutes,
    feeling: row.feeling ?? undefined,
    note:
      note === undefined || note.length === 0
        ? undefined
        : note.length > NOTE_MAX_CHARS
          ? note.slice(0, NOTE_MAX_CHARS)
          : note,
  };
}
