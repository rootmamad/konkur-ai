import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import { chatMessage, chatThread } from '../../db/schema/chat';
import type { ChatMessage, ChatThread } from '../../db/schema/chat';
import { appConfig } from '../../db/schema/app-config';
import { attempt } from '../../db/schema/attempt';
import { question } from '../../db/schema/question';
import { student } from '../../db/schema/student';
import type { DbOrTx } from '../../db/types';
// Value import (not `import type`): design:paramtypes must carry the real
// class for Nest to inject the optional dependency in production.
import { SubscriptionService } from '../billing/subscription.service';
import { ChatAiService } from './chat-ai.service';
import type { CoachMode } from './chat-ai.service';
import type { ChatSpaceKind } from './dto/create-thread.dto';

/** Chat message length cap (spec 9.1): a user message is 1..2000 chars. */
export const CHAT_MESSAGE_MAX_LENGTH = 2000;
/** Message page size when the caller does not ask for one. */
export const DEFAULT_MESSAGE_LIMIT = 50;
/** Hard ceiling per read, so a huge `?limit` cannot dump a whole thread. */
export const MAX_MESSAGE_LIMIT = 200;
/** Fixed cap on the thread list (threads accumulate per opened question). */
export const THREAD_LIST_LIMIT = 100;

/**
 * Free-plan AI-message quota (spec §10): «مجمعا ۵ درخواست مشترک مربی و چت
 * شناور در هر ۷ روز». The shared pool counts USER messages of the coach +
 * question spaces only; exam_analysis is outside the quota by the spec's
 * wording. The authoritative number lives in the active app_config row
 * (`free_chat_weekly`); 5 is the documented fallback.
 */
export const FREE_CHAT_WEEKLY_KEY = 'free_chat_weekly';
export const FREE_CHAT_WEEKLY_DEFAULT = 5;
export const FREE_CHAT_QUOTA_EXHAUSTED =
  'سهمیه پیام AI پلن رایگان تمام شده است';

/** Spaces that consume the shared free AI quota (exam_analysis excluded). */
const QUOTA_SPACES = ['coach', 'question'] as const;

/** Clamp a requested message page size into [1, MAX_MESSAGE_LIMIT]. */
export function clampMessageLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_MESSAGE_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_MESSAGE_LIMIT);
}

/**
 * Envelope of POST /chat/threads/:id/messages. Only an AI failure adds
 * `notice`; storage-only spaces (coach/exam_analysis) return a null
 * assistantMessage without a notice.
 */
export interface AddMessageResult {
  userMessage: ChatMessage;
  assistantMessage: ChatMessage | null;
  /** Present only when the AI reply failed AFTER the user message was stored. */
  notice?: 'ai_unavailable';
}

/**
 * Per-space reference matrix (spec 9.1):
 *   coach         — dashboard tab; NO context refs allowed.
 *   question      — floating chat; questionId REQUIRED, attemptId optional.
 *   exam_analysis — result page; attemptId REQUIRED, questionId absent.
 */
function validateThreadRefs(
  space: ChatSpaceKind,
  questionId?: string,
  attemptId?: string,
): void {
  if (space === 'coach') {
    if (questionId !== undefined || attemptId !== undefined) {
      throw new BadRequestException(
        'coach threads must not reference a question or attempt',
      );
    }
    return;
  }
  if (space === 'question') {
    if (questionId === undefined) {
      throw new BadRequestException('question threads require a questionId');
    }
    return;
  }
  // exam_analysis: attemptId required, questionId absent.
  if (questionId !== undefined) {
    throw new BadRequestException(
      'exam_analysis threads must not reference a question',
    );
  }
  if (attemptId === undefined) {
    throw new BadRequestException('exam_analysis threads require an attemptId');
  }
}

/**
 * Chat storage foundation (spec 9.1): thread get-or-create per space and the
 * user-message history. Storage ONLY — no AI call, no quota, no prompt
 * building (next tasks). Every query is scoped by the CALLER's student id;
 * a thread that is not the caller's is a 404, never a 403 (spec 15.5).
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() private readonly chatAi?: ChatAiService,
    @Optional() private readonly subscription?: SubscriptionService,
  ) {}

  /**
   * Get-or-create the caller's thread for the given space + context refs.
   * The lookup treats NULLs exactly (a coach thread has no refs at all), so
   * histories of different questions never mix (spec 15.4): the key is
   * (studentId, space, questionId, attemptId). The select-else-insert runs
   * inside ONE transaction.
   */
  async getOrCreateThread(
    userId: string,
    space: ChatSpaceKind,
    questionId?: string,
    attemptId?: string,
  ): Promise<ChatThread> {
    validateThreadRefs(space, questionId, attemptId);
    const studentId = await this.resolveStudentId(userId);

    return this.db.transaction(async (tx) => {
      // Context refs must exist AND belong to the caller (spec 15.5) —
      // verified before any thread is read or written, in this transaction.
      await this.requireOwnedRefs(tx, studentId, questionId, attemptId);

      const [existing] = await tx
        .select()
        .from(chatThread)
        .where(
          and(
            eq(chatThread.studentId, studentId),
            eq(chatThread.space, space),
            questionId === undefined
              ? isNull(chatThread.questionId)
              : eq(chatThread.questionId, questionId),
            attemptId === undefined
              ? isNull(chatThread.attemptId)
              : eq(chatThread.attemptId, attemptId),
          ),
        )
        .limit(1);
      if (existing) return existing;

      const [created] = await tx
        .insert(chatThread)
        .values({ studentId, space, questionId, attemptId })
        .returning();
      return created;
    });
  }

  /** The caller's threads, newest first, optionally filtered by space. */
  async listThreads(
    userId: string,
    space?: ChatSpaceKind,
  ): Promise<ChatThread[]> {
    const studentId = await this.resolveStudentId(userId);
    return this.db
      .select()
      .from(chatThread)
      .where(
        space === undefined
          ? eq(chatThread.studentId, studentId)
          : and(
              eq(chatThread.studentId, studentId),
              eq(chatThread.space, space),
            ),
      )
      .orderBy(desc(chatThread.createdAt))
      .limit(THREAD_LIST_LIMIT);
  }

  /**
   * Messages of one of the caller's threads, ASCENDING. `limit` defaults to
   * 50 and is clamped to at most 200; a thread that is not the caller's is a
   * 404 (spec 15.5).
   */
  async getMessages(
    userId: string,
    threadId: string,
    limit?: number,
  ): Promise<ChatMessage[]> {
    const studentId = await this.resolveStudentId(userId);
    await this.requireOwnedThread(threadId, studentId);

    return this.db
      .select()
      .from(chatMessage)
      .where(eq(chatMessage.threadId, threadId))
      .orderBy(asc(chatMessage.createdAt))
      .limit(clampMessageLimit(limit));
  }

  /**
   * Persist the caller's message, then run the AI reply pipeline for the
   * space (spec 9.1/9.2): question → `reply`, coach → `replyCoach(...mode)`,
   * exam_analysis → `replyExamAnalysis`. On ANY AI failure the user message
   * stays stored and the response carries `notice: 'ai_unavailable'` —
   * stored data is never lost and the request never 500s (spec 15.5).
   * Owner-only: another student's thread is a 404.
   *
   * Mode matrix (spec 9.1): the coach composer is explicit about which of
   * the three tabs produced the send, so a coach message without `mode` is
   * a 400; `mode` on any other space is a 400. Checked before the quota
   * read: a rejected send stores nothing.
   *
   * Free-plan quota (spec §10): coach/question sends consume the shared
   * 5-per-7-days pool; the exam_analysis space is NEVER counted or blocked
   * (no paid-plan read, no config read, no count query). The count and the
   * user-message insert run in ONE transaction to narrow the
   * concurrent-send race; a residual race remains (a strict fix would need
   * row locking — out of MVP scope) and a double-tap retry intentionally
   * double-counts (no client messageId yet). Paid users and exam_analysis
   * threads are never blocked; a blocked send stores nothing and never
   * reaches the AI.
   */
  async addMessage(
    userId: string,
    threadId: string,
    body: string,
    mode?: CoachMode,
  ): Promise<AddMessageResult> {
    const studentId = await this.resolveStudentId(userId);
    const thread = await this.requireOwnedThread(threadId, studentId);

    if (thread.space === 'coach' && mode === undefined) {
      throw new BadRequestException(
        'coach messages require a mode (motivation, planning or debug)',
      );
    }
    if (thread.space !== 'coach' && mode !== undefined) {
      throw new BadRequestException('mode is only valid on coach threads');
    }

    const quotaApplies =
      thread.space !== 'exam_analysis' && !(await this.hasPaidPlan(userId));
    let freeLimit = 0;
    if (quotaApplies) {
      freeLimit = await this.getFreeChatWeeklyLimit();
    }

    const userMessage = await this.db.transaction(async (tx) => {
      if (quotaApplies) {
        const used = await this.countQuotaMessages(studentId, tx);
        if (used >= freeLimit) {
          // Thrown BEFORE any insert: nothing is stored, the AI never runs,
          // and the composer keeps the student's text.
          throw new ForbiddenException(FREE_CHAT_QUOTA_EXHAUSTED);
        }
      }
      const [created] = await tx
        .insert(chatMessage)
        .values({ threadId, role: 'user', body })
        .returning();
      return created;
    });

    if (!this.chatAi) {
      return { userMessage, assistantMessage: null };
    }

    try {
      const reply =
        thread.space === 'coach'
          ? await this.chatAi.replyCoach(thread, studentId, mode as CoachMode)
          : thread.space === 'exam_analysis'
            ? await this.chatAi.replyExamAnalysis(thread, studentId)
            : await this.chatAi.reply(thread, studentId);
      const [assistantMessage] = await this.db
        .insert(chatMessage)
        .values({ threadId, role: 'assistant', body: reply })
        .returning();
      return { userMessage, assistantMessage };
    } catch (err: unknown) {
      this.logger.warn(
        `[${threadId}] ${thread.space} chat reply failed (user message kept): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { userMessage, assistantMessage: null, notice: 'ai_unavailable' };
    }
  }

  /** Paid-plan predicate via the shared SubscriptionService (spec 3.7). */
  private async hasPaidPlan(userId: string): Promise<boolean> {
    if (!this.subscription) return false;
    return this.subscription.hasPaidPlan(userId);
  }

  /**
   * Effective free-plan AI-message limit from the active versioned settings
   * row (spec §10), same read pattern as the quiz quota in exams.service.
   * A missing or invalid (non-positive/non-integer) value falls back to the
   * documented default of 5.
   */
  private async getFreeChatWeeklyLimit(): Promise<number> {
    const [row] = await this.db
      .select({ quotas: appConfig.quotas })
      .from(appConfig)
      .where(eq(appConfig.isActive, true))
      .orderBy(desc(appConfig.version))
      .limit(1);

    const quotas = row?.quotas as Record<string, unknown> | null | undefined;
    const value = quotas?.[FREE_CHAT_WEEKLY_KEY];
    return typeof value === 'number' && Number.isInteger(value) && value > 0
      ? value
      : FREE_CHAT_WEEKLY_DEFAULT;
  }

  /**
   * The caller's USER messages inside the rolling 7-day window across BOTH
   * quota spaces (coach + question share one pool; spec §10). Assistant rows
   * never count — only student requests do.
   */
  private async countQuotaMessages(
    studentId: string,
    executor: DbOrTx = this.db,
  ): Promise<number> {
    const [row] = await executor
      .select({ count: sql<number>`count(*)::int` })
      .from(chatMessage)
      .innerJoin(chatThread, eq(chatThread.id, chatMessage.threadId))
      .where(
        and(
          eq(chatThread.studentId, studentId),
          eq(chatMessage.role, 'user'),
          inArray(chatThread.space, [...QUOTA_SPACES]),
          sql`${chatMessage.createdAt} >= now() - interval '7 days'`,
        ),
      );
    return row?.count ?? 0;
  }

  /**
   * Context-ref ownership (spec 15.5): the floating chat keys to a PUBLISHED
   * bank question, and an exam_analysis thread keys to an attempt the caller
   * OWNS. Both checks run before any thread is created, so no cross-student
   * exam data can ever be keyed into a chat thread. Existence, ownership and
   * publish state all read as a 404 — a foreign ref must be
   * indistinguishable from a missing one.
   */
  private async requireOwnedRefs(
    executor: DbOrTx,
    studentId: string,
    questionId?: string,
    attemptId?: string,
  ): Promise<void> {
    if (attemptId !== undefined) {
      const [owned] = await executor
        .select({ id: attempt.id })
        .from(attempt)
        .where(and(eq(attempt.id, attemptId), eq(attempt.studentId, studentId)))
        .limit(1);
      if (!owned) throw new NotFoundException('Attempt not found');
    }
    if (questionId !== undefined) {
      const [published] = await executor
        .select({ id: question.id })
        .from(question)
        .where(
          and(eq(question.id, questionId), eq(question.status, 'published')),
        )
        .limit(1);
      if (!published) throw new NotFoundException('Question not found');
    }
  }

  /** 404 unless the thread exists AND belongs to this student (spec 15.5). */
  private async requireOwnedThread(
    threadId: string,
    studentId: string,
  ): Promise<ChatThread> {
    const [row] = await this.db
      .select()
      .from(chatThread)
      .where(
        and(eq(chatThread.id, threadId), eq(chatThread.studentId, studentId)),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Chat thread not found');
    return row;
  }

  /** Resolve the JWT subject (an account id) to the student profile id. */
  private async resolveStudentId(userId: string): Promise<string> {
    const [row] = await this.db
      .select({ id: student.id })
      .from(student)
      .where(eq(student.accountId, userId))
      .limit(1);
    if (!row) throw new NotFoundException('Student profile not found');
    return row.id;
  }
}
