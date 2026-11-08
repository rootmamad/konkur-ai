import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import { answerKey } from '../../db/schema/answer-key';
import { attempt } from '../../db/schema/attempt';
import { explanation } from '../../db/schema/explanation';
import { question } from '../../db/schema/question';
import { response } from '../../db/schema/response';
import { student } from '../../db/schema/student';
import { AIService } from '../ai/ai.service';
import { UserRole } from '../users/enums/user-role.enum';

/** Prompt revision tag written to every `ai_job` row for this operation. */
export const EXPLANATION_PROMPT_VERSION = 'explain-v1';
/** Operation label from spec §12 (`ai_operation` already carries `explain`). */
export const EXPLANATION_OPERATION = 'explain' as const;

/** Output contract bounds enforced by {@link parseExplanation}. */
export const EXPLANATION_MIN_CHARS = 50;
export const EXPLANATION_MAX_CHARS = 2000;

/** Spec §4: the three origins are separate rows and are never merged. */
export type ExplanationOrigin = 'official' | 'source_book' | 'ai_generated';

/**
 * Read priority. Trusted human sources beat the generated text, so a question
 * that later gets an official note stops serving the cached AI one.
 */
export const EXPLANATION_ORIGIN_PRIORITY: readonly ExplanationOrigin[] = [
  'official',
  'source_book',
  'ai_generated',
];

/** Exact model output contract for one AI explanation. */
export interface ExplanationOutput {
  /** Persian teaching note; reveals the reasoning behind the correct answer. */
  body: string;
}

/** Who is reading, resolved from the access token by the controller. */
export interface ExplanationViewer {
  role: UserRole;
  userId: string;
}

/** An explanation as served to a client. */
export interface ServedExplanation {
  origin: ExplanationOrigin;
  body: string;
}

/** Question plus everything the prompt needs, resolved once per request. */
export interface ResolvedQuestion {
  id: string;
  version: number;
  text: string;
  type: string;
  options: Array<{ index: number; text: string }>;
  /** Correct choice text (`answer_key`), or null while the key is missing. */
  correctAnswer: string | null;
}

/**
 * Validate the model's raw completion against the explanation contract.
 *
 * Throws on anything unexpected so `AIService.runJob` retries the whole call
 * once and finally raises `BadRequestException` (spec §13.3). Pure and
 * exported so the contract is testable without a model call.
 */
export function parseExplanation(raw: string): ExplanationOutput {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('explanation output must be a JSON object');
  }

  const { body } = parsed as { body?: unknown };
  if (typeof body !== 'string') {
    throw new Error('body must be a string');
  }
  const text = body.trim();
  if (text.length < EXPLANATION_MIN_CHARS) {
    throw new Error(
      `body must be at least ${EXPLANATION_MIN_CHARS} characters`,
    );
  }
  if (text.length > EXPLANATION_MAX_CHARS) {
    throw new Error(`body must be at most ${EXPLANATION_MAX_CHARS} characters`);
  }

  return { body: text };
}

/**
 * Build the Persian teaching-note prompt: stem, options and the correct choice
 * are all passed in, so the model explains an answer it can see instead of
 * guessing one (§4: answer keys never leave the server).
 */
export function buildExplanationPrompt(resolved: ResolvedQuestion): string {
  const optionLines = resolved.options.length
    ? resolved.options.map((option) => `- ${option.index + 1}) ${option.text}`)
    : ['- (این سؤال گزینه ندارد؛ پاسخ تشریحی است.)'];

  return [
    'تو دبیر باتجربه کنکور هستی و برای دانش‌آموز توضیح آموزشی می‌نویسی.',
    '',
    'صورت سؤال:',
    resolved.text,
    '',
    'گزینه‌ها:',
    ...optionLines,
    '',
    `پاسخ درست: ${resolved.correctAnswer ?? 'در بانک سؤال ثبت نشده است؛ با استدلال علمی خودت پاسخ درست را مشخص کن.'}`,
    '',
    'قواعد:',
    '- فارسی روان و دانش‌آموزی؛ بدون مقدمه‌چینی و بدون تکرار صورت سؤال.',
    '- بگو چرا پاسخ درست درست است و چرا گزینه‌های نادرست رد می‌شوند.',
    '- مفهوم پایه و دام رایج این تست را کوتاه توضیح بده.',
    '- هیچ عدد یا واقعیتی از خودت نساز؛ فقط بر پایه صورت سؤال و پاسخ درست استدلال کن.',
    `- طول متن بین ${EXPLANATION_MIN_CHARS} تا ${EXPLANATION_MAX_CHARS} کاراکتر.`,
    '',
    'قرارداد خروجی: فقط و فقط یک آبجکت JSON با این کلید، بدون هیچ متن اضافه:',
    '{"body": "..."}',
  ].join('\n');
}

/** Pick the highest-priority origin present for this version. */
function pickBest(rows: ServedExplanation[]): ServedExplanation | null {
  for (const origin of EXPLANATION_ORIGIN_PRIORITY) {
    const match = rows.find((row) => row.origin === origin);
    if (match) return match;
  }
  return null;
}

/**
 * Per-question explanations with a one-time AI fallback (spec §4, §13.2,
 * step-4 "توضیح با کش").
 *
 * The cache key is `(question_id, question_version, origin)`, so a new question
 * version never serves a stale note. The AI row is written only AFTER the model
 * call resolves — a failed job leaves the cache empty and is retried next time,
 * with the error logged on the `ai_job` row.
 *
 * §13.2 gate: explanations reveal the answer, so a STUDENT is served nothing —
 * not even the AI text — before a `response` row exists for that question
 * (i.e. after `submitAnswer`). Admins always read the best origin.
 */
@Injectable()
export class ExplanationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly aiService: AIService,
  ) {}

  /**
   * Published question plus the version and answer key used for the cache key
   * and the prompt. 404 when the question does not exist (or is unpublished,
   * so students cannot probe drafts).
   */
  async resolveQuestion(questionId: string): Promise<ResolvedQuestion> {
    const [row] = await this.db
      .select({
        id: question.id,
        version: question.version,
        text: question.text,
        type: question.type,
        options: question.options,
      })
      .from(question)
      .where(and(eq(question.id, questionId), eq(question.status, 'published')))
      .limit(1);
    if (!row) throw new NotFoundException('Question not found');

    const [key] = await this.db
      .select({
        correctOptionIndex: answerKey.correctOptionIndex,
        correctText: answerKey.correctText,
      })
      .from(answerKey)
      .where(
        and(
          eq(answerKey.questionId, questionId),
          eq(answerKey.questionVersion, row.version),
        ),
      )
      .limit(1);

    const options = normalizeOptions(row.options);

    return {
      id: row.id,
      version: row.version,
      text: row.text,
      type: row.type,
      options,
      correctAnswer: describeCorrectAnswer(key, options),
    };
  }

  /**
   * True iff this student already has a response row for the question, i.e. the
   * question is answered and the explanation can no longer leak the key.
   */
  async viewableBy(
    studentId: string | null,
    questionId: string,
  ): Promise<boolean> {
    if (!studentId) return false;

    const [row] = await this.db
      .select({ id: response.id })
      .from(response)
      .innerJoin(attempt, eq(attempt.id, response.attemptId))
      .where(
        and(
          eq(attempt.studentId, studentId),
          eq(response.questionId, questionId),
        ),
      )
      .limit(1);

    return Boolean(row);
  }

  /** Best explanation for the current version, after the §13.2 gate. */
  async getExplanation(
    questionId: string,
    viewer: ExplanationViewer,
  ): Promise<ServedExplanation> {
    const resolved = await this.resolveQuestion(questionId);
    await this.requireViewable(resolved, viewer);

    const rows = await this.loadExplanations(resolved.id, resolved.version);
    const best = pickBest(rows);
    if (!best) throw new NotFoundException('No explanation for this question');

    return best;
  }

  /** Request-side gate so a 403 answers the request instead of a log line. */
  async assertCanView(
    questionId: string,
    viewer: ExplanationViewer,
  ): Promise<void> {
    const resolved = await this.resolveQuestion(questionId);
    await this.requireViewable(resolved, viewer);
  }

  /**
   * One-time AI generation, cached on `(question_id, question_version)`.
   *
   * No-ops when a trusted explanation already exists (official or source_book —
   * never overwritten or duplicated) and when an `ai_generated` row is already
   * cached. The model call runs outside any transaction; only on success is the
   * single `ai_generated` row inserted.
   */
  async generateExplanation(
    questionId: string,
    requester: ExplanationViewer,
  ): Promise<void> {
    const resolved = await this.resolveQuestion(questionId);
    // Same gate as reading: a student cannot warm the cache before answering.
    await this.requireViewable(resolved, requester);

    const existing = await this.loadExplanations(resolved.id, resolved.version);
    if (
      existing.some(
        (row) => row.origin === 'official' || row.origin === 'source_book',
      )
    ) {
      return; // Trusted text wins; no model call at all.
    }
    if (existing.some((row) => row.origin === 'ai_generated')) {
      return; // Cache hit.
    }

    // Model call first, connection-free: no transaction is held across it.
    const result = await this.aiService.runJob<ExplanationOutput>({
      operation: EXPLANATION_OPERATION,
      promptVersion: EXPLANATION_PROMPT_VERSION,
      prompt: buildExplanationPrompt(resolved),
      parse: parseExplanation,
    });

    await this.db.insert(explanation).values({
      questionId: resolved.id,
      questionVersion: resolved.version,
      origin: 'ai_generated',
      body: result.body,
    });
  }

  /** All origins stored for one question version. */
  private async loadExplanations(
    questionId: string,
    questionVersion: number,
  ): Promise<ServedExplanation[]> {
    const rows = await this.db
      .select({ origin: explanation.origin, body: explanation.body })
      .from(explanation)
      .where(
        and(
          eq(explanation.questionId, questionId),
          eq(explanation.questionVersion, questionVersion),
        ),
      );

    return rows.map((row) => ({
      origin: row.origin,
      body: row.body,
    }));
  }

  /** ADMIN always; STUDENT only after answering (§13.2). */
  private async requireViewable(
    resolved: ResolvedQuestion,
    viewer: ExplanationViewer,
  ): Promise<void> {
    if (viewer.role === UserRole.ADMIN) return;

    const studentId = await this.findStudentId(viewer.userId);
    if (!(await this.viewableBy(studentId, resolved.id))) {
      throw new ForbiddenException(
        'Explanation is available only after you have answered this question',
      );
    }
  }

  /** Account -> student profile; a student without a profile has no responses. */
  private async findStudentId(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: student.id })
      .from(student)
      .where(eq(student.accountId, userId))
      .limit(1);
    return row?.id ?? null;
  }
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
  key:
    | { correctOptionIndex: number | null; correctText: string | null }
    | undefined,
  options: Array<{ index: number; text: string }>,
): string | null {
  const text = key?.correctText?.trim();
  if (text) return text;

  const index = key?.correctOptionIndex;
  if (index === null || index === undefined) return null;

  const option = options.find((item) => item.index === index);
  return option ? `${index + 1}) ${option.text}` : `گزینه ${index + 1}`;
}
