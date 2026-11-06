import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';

import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import { chatMessage, chatThread } from '../../db/schema/chat';
import type { NewChatMessage } from '../../db/schema/chat';
import { AIService } from '../ai/ai.service';
import { DashboardService } from './dashboard.service';
import type { DashboardSummary, TrendPoint } from './dashboard.service';

/** Chat space that stores the student's overall-analysis history (spec §9). */
const ANALYSIS_SPACE = 'exam_analysis' as const;
/** Prompt revision tag written to every `ai_job` row for this operation. */
export const ANALYSIS_PROMPT_VERSION = 'overall-v1';
/** Operation label from spec §12 used for `ai_job` attribution. */
export const ANALYSIS_OPERATION = 'overall_analysis' as const;

/** Output contract bounds enforced by `parseOverallAnalysis`. */
export const NARRATIVE_MIN_CHARS = 50;
export const NARRATIVE_MAX_CHARS = 4000;
export const EMPHASIS_MAX_CHARS = 300;

/** Exact model output contract for the overall analysis. */
export interface OverallAnalysis {
  /** Persian markdown narrative shown on the "تحلیل کلی" card. */
  narrative: string;
  /** One-line focus for the coming days. */
  emphasis: string;
}

/** Latest persisted analysis, read back from the exam_analysis thread. */
export interface LatestAnalysis extends OverallAnalysis {
  at: Date;
}

/** The exact rule-based snapshot handed to the model (no raw rows). */
export interface OverallSnapshot {
  summary: DashboardSummary;
  trend: TrendPoint[];
}

/**
 * Validate the model's raw completion against the overall-analysis contract.
 *
 * Throws on anything unexpected so `AIService.runJob` retries the whole call
 * once and finally raises `BadRequestException` (spec §13.3). Kept as a pure
 * exported function so the contract is testable without a model call.
 */
export function parseOverallAnalysis(raw: string): OverallAnalysis {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('analysis output must be a JSON object');
  }

  const { narrative, emphasis } = parsed as {
    narrative?: unknown;
    emphasis?: unknown;
  };

  if (typeof narrative !== 'string') {
    throw new Error('narrative must be a string');
  }
  const text = narrative.trim();
  if (text.length < NARRATIVE_MIN_CHARS) {
    throw new Error(
      `narrative must be at least ${NARRATIVE_MIN_CHARS} characters`,
    );
  }
  if (text.length > NARRATIVE_MAX_CHARS) {
    throw new Error(
      `narrative must be at most ${NARRATIVE_MAX_CHARS} characters`,
    );
  }

  if (typeof emphasis !== 'string') {
    throw new Error('emphasis must be a string');
  }
  const focus = emphasis.trim();
  if (focus.length > EMPHASIS_MAX_CHARS) {
    throw new Error(
      `emphasis must be at most ${EMPHASIS_MAX_CHARS} characters`,
    );
  }

  return { narrative: text, emphasis: focus };
}

/**
 * Build the coach prompt: the rule-based snapshot plus the strict output
 * contract. The snapshot is serialized as-is, so the model only ever sees the
 * small card payload — never raw answers or the student's history.
 */
export function buildOverallAnalysisPrompt(snapshot: OverallSnapshot): string {
  return [
    'تو مربی کنکور هستی. بر اساس اسنپ‌شات عملکرد زیر، یک «تحلیل کلی» کوتاه، دقیق و قابل اجرا بنویس.',
    '',
    'قواعد:',
    '- فارسی روان؛ حداکثر سه پاراگراف یا چند بولت کوتاه.',
    '- فقط بر پایه همین داده‌ها استدلال کن؛ هیچ عدد یا سابقه‌ای از خودت نساز.',
    '- به ضعیف‌ترین مباحث، روند پاسخ‌ها، دقایق مطالعه و سهمیه آزمونک اشاره کن.',
    '- در پایان دقیقاً یک تمرکز اصلی برای روزهای آینده انتخاب کن.',
    '',
    'اسنپ‌شات (JSON):',
    JSON.stringify(snapshot),
    '',
    'قرارداد خروجی: فقط و فقط یک آبجکت JSON با این دو کلید، بدون هیچ متن اضافه:',
    '{"narrative": "...", "emphasis": "..."}',
    `- narrative: متن فارسی مارک‌داون بین ${NARRATIVE_MIN_CHARS} تا ${NARRATIVE_MAX_CHARS} کاراکتر.`,
    `- emphasis: یک جمله حداکثر ${EMPHASIS_MAX_CHARS} کاراکتری درباره مهم‌ترین تمرکز.`,
  ].join('\n');
}

/** Read the `emphasis` back out of a persisted snapshot row, if possible. */
function readEmphasis(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed === null || typeof parsed !== 'object') return '';
    const value = (parsed as { emphasis?: unknown }).emphasis;
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/**
 * Async overall analysis (spec §3.7 "تحلیل کلی").
 *
 * The generation path is deliberately never awaited on a request: the
 * controller fires it and returns `{ queued: true }`. The model call runs
 * OUTSIDE any transaction and persistence happens only after it resolves, in a
 * single insert-only transaction (same two-phase shape as question-drafter).
 *
 * The snapshot comes from {@link DashboardService}'s public read endpoints, so
 * the AI never re-interprets raw answers and the rule engine stays the single
 * source of truth.
 */
@Injectable()
export class AnalysisService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly dashboard: DashboardService,
    private readonly aiService: AIService,
  ) {}

  /**
   * Generate one overall analysis and append it to the student's
   * `exam_analysis` thread. Rejects on model/parse failure and — in that case —
   * writes nothing at all.
   */
  async generateOverallAnalysis(userId: string): Promise<void> {
    const studentId = await this.dashboard.resolveStudentId(userId);

    const summary = await this.dashboard.getSummary(userId);
    const trend = await this.dashboard.getTrend(userId, 7);
    const snapshot: OverallSnapshot = { summary, trend };

    // Model call first, connection-free: no transaction is held across it.
    const result = await this.aiService.runJob<OverallAnalysis>({
      operation: ANALYSIS_OPERATION,
      promptVersion: ANALYSIS_PROMPT_VERSION,
      prompt: buildOverallAnalysisPrompt(snapshot),
      parse: parseOverallAnalysis,
    });

    await this.persist(studentId, snapshot, result);
  }

  /**
   * Latest analysis for the student: the newest assistant message of the
   * `exam_analysis` thread together with the emphasis recorded with it.
   */
  async getLatestAnalysis(userId: string): Promise<LatestAnalysis> {
    const studentId = await this.dashboard.resolveStudentId(userId);

    const rows = await this.db
      .select({
        role: chatMessage.role,
        body: chatMessage.body,
        createdAt: chatMessage.createdAt,
      })
      .from(chatMessage)
      .innerJoin(chatThread, eq(chatThread.id, chatMessage.threadId))
      .where(
        and(
          eq(chatThread.studentId, studentId),
          eq(chatThread.space, ANALYSIS_SPACE),
        ),
      )
      .orderBy(desc(chatMessage.createdAt))
      .limit(2);

    const assistant = rows.find((row) => row.role === 'assistant');
    if (!assistant) throw new NotFoundException('no analysis yet');

    const emphasis = readEmphasis(
      rows.find((row) => row.role === 'user')?.body ?? '',
    );

    return {
      at: assistant.createdAt,
      narrative: assistant.body,
      emphasis,
    };
  }

  /**
   * Append the exchange to the student's single `exam_analysis` thread.
   *
   * Thread lookup happens before the transaction; the transaction itself is
   * insert-only (thread on first use + both messages together), so a failure
   * can never leave a half-written analysis.
   *
   * The user row keeps the request payload (snapshot + emphasis) as compact
   * JSON for product memory; the assistant row is the narrative itself.
   */
  private async persist(
    studentId: string,
    snapshot: OverallSnapshot,
    result: OverallAnalysis,
  ): Promise<void> {
    const existingThreadId = await this.findThreadId(studentId);

    const userBody = JSON.stringify({
      emphasis: result.emphasis,
      snapshot,
    });

    await this.db.transaction(async (tx) => {
      let threadId = existingThreadId;
      if (!threadId) {
        const [created] = await tx
          .insert(chatThread)
          .values({ studentId, space: ANALYSIS_SPACE })
          .returning({ id: chatThread.id });
        threadId = created.id;
      }

      const messages: NewChatMessage[] = [
        { threadId, role: 'user', body: userBody },
        { threadId, role: 'assistant', body: result.narrative },
      ];
      await tx.insert(chatMessage).values(messages);
    });
  }

  /** One analysis thread per student, reused across generations. */
  private async findThreadId(studentId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: chatThread.id })
      .from(chatThread)
      .where(
        and(
          eq(chatThread.studentId, studentId),
          eq(chatThread.space, ANALYSIS_SPACE),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }
}
