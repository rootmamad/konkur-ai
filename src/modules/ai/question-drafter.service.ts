import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import { answerKey } from '../../db/schema/answer-key';
import { explanation } from '../../db/schema/explanation';
import { question } from '../../db/schema/question';
import { topic } from '../../db/schema/topic';
import { AIService } from './ai.service';
import {
  HistoryContextService,
  type WeakTopicContext,
} from './history-context.service';

// ---------------------------------------------------------------------------
// Prompt versioning and batch caps (spec §13.3 — three distinct promptVersions
// keep the per-call ai_job rows separable; VERIFY reuses operation
// 'question_draft').
// ---------------------------------------------------------------------------

export const DRAFT_PROMPT_VERSION = 'draft-v1';
export const MUTATE_PROMPT_VERSION = 'mutate-v1';
export const VERIFY_PROMPT_VERSION = 'verify-v1';
export const DRAFT_MAX_BATCH = 20;

// ---------------------------------------------------------------------------
// AI top-up config (fire-and-forget, never blocks exam start)
// ---------------------------------------------------------------------------

/**
 * Cooldown window (hours) after publishing an AI-generated question for a
 * weak topic before we allow another top-up for that same topic.
 * Candidate for app_config override later (spec §10).
 */
export const TOP_UP_COOLDOWN_HOURS = 2;

// ---------------------------------------------------------------------------
// Validated draft shape
// ---------------------------------------------------------------------------

/** One validated AI question draft (spec §5, §13.3). */
export interface AiDraft {
  topicId: string;
  text: string;
  options: string[];
  correctOptionIndex: 0 | 1 | 2 | 3;
  explanation: string;
  concepts: string[];
  difficulty: 1 | 2 | 3;
}

// ---------------------------------------------------------------------------
// Pure validator (exported for direct unit-testing)
// ---------------------------------------------------------------------------

/**
 * Strict validator for AI-generated question drafts.
 *
 * Accepts a JSON array of draft objects, or a bare single JSON object
 * (normalized to a one-element array — used by the mutate flow).
 *
 * Per item, STRICT:
 * - topicId must be in `allowedTopicIds`
 * - text 10–1000 chars
 * - options: exactly 4 non-empty strings
 * - correctOptionIndex: integer 0–3
 * - explanation: 10–600 chars
 * - concepts: string[] with ≤ 10 items
 * - difficulty: exactly 1 | 2 | 3
 *
 * Additionally rejects verbatim sample duplicates (first-50-char prefix
 * match against `sampleTexts`) and in-batch duplicate texts.
 *
 * ANY violation throws, which makes AIService.runJob retry the whole model
 * call once server-side before surfacing a BadRequestException (spec §13.3).
 */
export function validateAiDrafts(
  raw: string,
  allowedTopicIds: Set<string>,
  sampleTexts: string[],
  maxQuestions: number,
): AiDraft[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AI output is not valid JSON');
  }

  // A bare single object is normalized to a one-element array (mutate flow).
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];

  if (items.length === 0) {
    throw new Error('AI output array is empty');
  }
  if (items.length > maxQuestions) {
    throw new Error(
      `AI output has ${items.length} questions but max is ${maxQuestions}`,
    );
  }

  const inBatchTexts = new Set<string>();

  return items.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`Item ${index} is not an object`);
    }
    const obj = item as Record<string, unknown>;

    // topicId must be one of the allowed topics
    const topicId = obj.topicId;
    if (typeof topicId !== 'string' || !allowedTopicIds.has(topicId)) {
      throw new Error(`Item ${index}: invalid or disallowed topicId`);
    }

    // text: 10–1000 chars (typed local so narrowing survives closures)
    const text = obj.text;
    if (typeof text !== 'string' || text.length < 10 || text.length > 1000) {
      throw new Error(`Item ${index}: text must be 10–1000 characters`);
    }

    // verbatim sample duplicate check (first-50-char prefix match)
    const textPrefix = text.slice(0, 50);
    if (sampleTexts.some((s) => s.startsWith(textPrefix))) {
      throw new Error(
        `Item ${index}: text is too similar to a past wrong answer`,
      );
    }

    // in-batch duplicate text
    if (inBatchTexts.has(text)) {
      throw new Error(`Item ${index}: duplicate text within batch`);
    }
    inBatchTexts.add(text);

    // options: exactly 4 non-empty strings
    const options = obj.options;
    if (
      !Array.isArray(options) ||
      options.length !== 4 ||
      options.some((o) => typeof o !== 'string' || o.trim() === '')
    ) {
      throw new Error(
        `Item ${index}: options must be exactly 4 non-empty strings`,
      );
    }

    // correctOptionIndex: integer 0–3
    const optionIndex = obj.correctOptionIndex;
    if (
      typeof optionIndex !== 'number' ||
      !Number.isInteger(optionIndex) ||
      optionIndex < 0 ||
      optionIndex > 3
    ) {
      throw new Error(`Item ${index}: correctOptionIndex must be integer 0–3`);
    }

    // explanation: 10–600 chars
    const explanationBody = obj.explanation;
    if (
      typeof explanationBody !== 'string' ||
      explanationBody.length < 10 ||
      explanationBody.length > 600
    ) {
      throw new Error(`Item ${index}: explanation must be 10–600 characters`);
    }

    // concepts: string[] ≤ 10
    const concepts = obj.concepts;
    if (!Array.isArray(concepts) || concepts.length > 10) {
      throw new Error(
        `Item ${index}: concepts must be an array of ≤ 10 strings`,
      );
    }
    if (concepts.some((c) => typeof c !== 'string')) {
      throw new Error(`Item ${index}: all concepts must be strings`);
    }

    // difficulty: exactly 1 | 2 | 3
    const difficulty = obj.difficulty;
    if (difficulty !== 1 && difficulty !== 2 && difficulty !== 3) {
      throw new Error(`Item ${index}: difficulty must be exactly 1, 2, or 3`);
    }

    return {
      topicId,
      text,
      options: options as string[],
      correctOptionIndex: optionIndex as 0 | 1 | 2 | 3,
      explanation: explanationBody,
      concepts: concepts as string[],
      difficulty,
    };
  });
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Counts returned by the two public drafter operations. */
export interface DrafterResult {
  created: number;
  published: number;
  deferred: number;
}

/**
 * AI question pipeline: generate + mutate with an automated verification
 * gate (product decision: NO admin approval — the gate IS the standard).
 *
 * Every model call goes through {@link AIService.runJob} (per-attempt ai_job
 * rows, retry-once on parse failure). Verified drafts are published; drafts
 * that fail blind key self-verification stay 'draft' (invisible to exams)
 * with a warning log.
 */
@Injectable()
export class QuestionDrafterService {
  private readonly logger = new Logger(QuestionDrafterService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly aiService: AIService,
    private readonly historyContext: HistoryContextService,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Generate question drafts targeting a student's weak topics.
   *
   * - `maxQuestions` is clamped to [1, DRAFT_MAX_BATCH].
   * - No weak topics → zeros returned and NO model call (spec §13.3).
   * - Prompt injects ONLY the bounded WeakTopicContext fields.
   * - Each validated draft runs the blind verification gate; verified →
   *   status 'published', else status 'draft' + warn.
   * - All inserts run in ONE db.transaction.
   *
   * @param studentId the STUDENT profile id (not the account id).
   */
  async generateDraftsForStudent(
    studentId: string,
    maxQuestions = 5,
  ): Promise<DrafterResult> {
    const clamped = Math.max(1, Math.min(maxQuestions, DRAFT_MAX_BATCH));

    const ctx = await this.historyContext.buildForStudent(studentId);
    if (ctx.weakTopics.length === 0) {
      return { created: 0, published: 0, deferred: 0 };
    }

    const allowedTopicIds = new Set(
      ctx.weakTopics
        .map((t) => t.topicId)
        .filter((id): id is string => id != null),
    );
    const sampleTexts = ctx.weakTopics.flatMap((t) => t.sampleWrongTexts);
    const titleByTopic = new Map(
      ctx.weakTopics
        .filter((t) => t.topicId != null)
        .map((t) => [t.topicId as string, t.topicTitle ?? 'AI']),
    );

    const prompt = this.buildDraftPrompt(ctx.weakTopics, clamped);

    const drafts = await this.aiService.runJob<AiDraft[]>({
      operation: 'question_draft',
      prompt,
      promptVersion: DRAFT_PROMPT_VERSION,
      parse: (raw) =>
        validateAiDrafts(raw, allowedTopicIds, sampleTexts, clamped),
    });

    return this.processDrafts(drafts, { titleByTopic });
  }

  /**
   * Create one mutated variant of an existing question.
   *
   * The variant tests the same concept at the same difficulty with small
   * differences (numbers, wording, option order); topicId is FIXED to the
   * source's topicId; difficultyAi and concepts are copied from the source.
   * Same verification gate and insert shape as generation.
   */
  async mutateQuestion(sourceQuestionId: string): Promise<DrafterResult> {
    const [source] = await this.db
      .select({
        id: question.id,
        topicId: question.topicId,
        topicTitle: topic.title,
        text: question.text,
        options: question.options,
        correctOptionIndex: answerKey.correctOptionIndex,
        concepts: question.concepts,
        difficultyAi: question.difficultyAi,
      })
      .from(question)
      .leftJoin(topic, eq(topic.id, question.topicId))
      .leftJoin(answerKey, eq(answerKey.questionId, question.id))
      .where(eq(question.id, sourceQuestionId))
      .limit(1);

    if (!source) {
      throw new NotFoundException(
        `Source question ${sourceQuestionId} not found`,
      );
    }
    if (source.topicId == null) {
      throw new BadRequestException(
        'Source question has no topic; cannot mutate',
      );
    }

    const prompt = this.buildMutatePrompt({
      topicId: source.topicId,
      topicTitle: source.topicTitle,
      text: source.text,
      options: source.options,
      correctOptionIndex: source.correctOptionIndex,
      difficultyAi: source.difficultyAi,
      concepts: toStringArray(source.concepts),
    });

    // topicId is FIXED to the source's topic: single-element allowed set.
    const allowedTopicIds = new Set([source.topicId]);

    const drafts = await this.aiService.runJob<AiDraft[]>({
      operation: 'question_draft',
      prompt,
      promptVersion: MUTATE_PROMPT_VERSION,
      parse: (raw) => validateAiDrafts(raw, allowedTopicIds, [], 1),
    });

    return this.processDrafts(drafts, {
      titleByTopic: new Map([[source.topicId, source.topicTitle ?? 'AI']]),
      difficultyOverride: source.difficultyAi,
      conceptsOverride: toStringArray(source.concepts),
    });
  }

  /**
   * Ops visibility: list AI-generated questions.
   * Returns id, status, topicId, an 80-char text prefix, and createdAt.
   */
  async queryDrafts(status: 'draft' | 'published' | undefined, limit: number) {
    const baseCondition = eq(question.origin, 'ai');
    const statusCondition = status ? eq(question.status, status) : undefined;

    const rows = await this.db
      .select({
        id: question.id,
        status: question.status,
        topicId: question.topicId,
        text: question.text,
        createdAt: question.createdAt,
      })
      .from(question)
      .where(
        statusCondition ? and(baseCondition, statusCondition) : baseCondition,
      )
      .orderBy(question.createdAt)
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      topicId: r.topicId,
      textPreview: r.text.slice(0, 80),
      createdAt: r.createdAt,
    }));
  }

  // ---------------------------------------------------------------------------
  // Prompt builders (bounded context only — never the full history)
  // ---------------------------------------------------------------------------

  /**
   * Build the Persian draft-generation prompt.
   * Injects ONLY the bounded WeakTopicContext fields (spec §13.3).
   */
  private buildDraftPrompt(
    topics: WeakTopicContext[],
    maxQuestions: number,
  ): string {
    const block = topics
      .map((t) => {
        const difficulty =
          t.avgDifficulty != null ? Math.round(t.avgDifficulty) : 2;
        const samples = t.sampleWrongTexts.map((s) => `  • "${s}"`).join('\n');
        return (
          `- topicId: ${t.topicId}\n` +
          `  title: ${t.topicTitle ?? 'unknown'}\n` +
          `  concepts: ${t.concepts.join(', ') || 'N/A'}\n` +
          `  difficulty: ${difficulty}\n` +
          `  recent wrong questions (do NOT reproduce verbatim):\n${samples}`
        );
      })
      .join('\n\n');

    return `You are an expert Persian-language educator. Output ONLY a JSON array — no markdown, no explanation.

Each element must be one multiple-choice question object with these exact keys:
{"topicId": "uuid", "text": "...", "options": ["...","...","...","..."], "correctOptionIndex": 0, "explanation": "...", "concepts": ["..."], "difficulty": 1}

Rules:
- Persian text. multiple_choice only; exactly 4 options; exactly one correct answer.
- One question per listed topic, targeting that topic's concepts.
- Difficulty informed by the topic's suggested difficulty (1=easy, 2=medium, 3=hard).
- NEVER reproduce the sample wrong questions verbatim.
- Maximum ${maxQuestions} items. STRICT JSON array only.

Topic data:
${block}`;
  }

  /**
   * Build the mutate prompt: same concept, same difficulty, small
   * differences (numbers, wording, option order); equivalent solution path.
   */
  private buildMutatePrompt(source: {
    topicId: string;
    topicTitle: string | null;
    text: string;
    options: unknown;
    correctOptionIndex: number | null;
    difficultyAi: number | null;
    concepts: string[];
  }): string {
    return `You are an expert Persian-language educator. Produce ONE question testing the same concept at the same difficulty with small differences (numbers, wording, order of options); keep the solution path equivalent.

Output ONLY a STRICT JSON single object:
{"topicId": "${source.topicId}", "text": "...", "options": ["...","...","...","..."], "correctOptionIndex": 0, "explanation": "...", "concepts": [...], "difficulty": ${source.difficultyAi ?? 2}}

Rules:
- Persian text. multiple_choice only; exactly 4 options; exactly one correct answer.
- topicId MUST be exactly "${source.topicId}".
- difficulty MUST be exactly ${source.difficultyAi ?? 2}.
- Use these concepts: ${JSON.stringify(source.concepts)}.
- NEVER reproduce the source text verbatim.

Source question:
  topic: ${source.topicTitle ?? 'unknown'}
  text: "${source.text}"
  options: ${JSON.stringify(source.options ?? [])}
  correctOptionIndex: ${source.correctOptionIndex}`;
  }

  // ---------------------------------------------------------------------------
  // Verification gate + persistence
  // ---------------------------------------------------------------------------

  /**
   * Blind key self-verification: a second model call must SOLVE the question
   * without being told the key. Returns the model's option index, or null
   * when the answer cannot be parsed.
   */
  private async verifyDraft(draft: AiDraft): Promise<0 | 1 | 2 | 3 | null> {
    const prompt = `Solve this multiple-choice question. Reply ONLY with a STRICT JSON object {"answer": <option index 0-3>}. No explanation, no other text.

Question: ${draft.text}
Options:
0. ${draft.options[0]}
1. ${draft.options[1]}
2. ${draft.options[2]}
3. ${draft.options[3]}`;

    try {
      const result = await this.aiService.runJob<{ answer: number }>({
        operation: 'question_draft',
        prompt,
        promptVersion: VERIFY_PROMPT_VERSION,
        parse: (raw) => {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const answer = parsed?.answer;
          if (typeof answer !== 'number' || !Number.isInteger(answer)) {
            throw new Error('answer must be an integer');
          }
          if (answer < 0 || answer > 3) {
            throw new Error(`answer index out of range: ${answer}`);
          }
          return { answer };
        },
      });
      return result.answer as 0 | 1 | 2 | 3;
    } catch (err: unknown) {
      // A failed verification call (HTTP error, unparseable output) defers
      // the draft rather than killing the whole batch (design decision).
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Verification call failed; deferring draft "${draft.text.slice(0, 80)}": ${msg}`,
      );
      return null;
    }
  }

  /**
   * Persist the batch in two phases (Task 6): first the verification gate
   * runs OUTSIDE any transaction (model calls must never hold a pooled
   * connection), then ONE db.transaction contains only the inserts — per
   * draft a question row (status per gate, origin 'ai') + answer_key +
   * explanation (origin 'ai_generated'), all-or-nothing.
   */
  private async processDrafts(
    drafts: AiDraft[],
    opts: {
      titleByTopic: Map<string, string>;
      difficultyOverride?: number | null;
      conceptsOverride?: string[];
    },
  ): Promise<DrafterResult> {
    // Phase 1 — verification gate OUTSIDE any transaction. Each verify is a
    // model call (up to two 60s HTTP round-trips per draft); holding a pooled
    // connection across them can exhaust the postgres pool under concurrent
    // admin triggers. Verified state is collected first, inserts after.
    const gated: { draft: AiDraft; isVerified: boolean }[] = [];
    for (const draft of drafts) {
      const verifiedIndex = await this.verifyDraft(draft);
      const isVerified =
        verifiedIndex !== null && verifiedIndex === draft.correctOptionIndex;

      if (!isVerified) {
        this.logger.warn(
          `Key mismatch; deferring draft "${draft.text.slice(0, 80)}"`,
        );
      }

      gated.push({ draft, isVerified });
    }

    // Phase 2 — inserts only: ONE transaction, all-or-nothing unchanged, and
    // the only awaited calls inside are DB inserts (no model/HTTP I/O).
    let published = 0;
    let deferred = 0;

    await this.db.transaction(async (tx) => {
      for (const { draft, isVerified } of gated) {
        const [inserted] = await tx
          .insert(question)
          .values({
            status: isVerified ? 'published' : 'draft',
            origin: 'ai',
            version: 1,
            type: 'multiple_choice',
            topicId: draft.topicId,
            text: draft.text,
            options: draft.options,
            subject: opts.titleByTopic.get(draft.topicId) ?? 'AI',
            concepts: opts.conceptsOverride ?? draft.concepts,
            difficultyAi:
              opts.difficultyOverride !== undefined
                ? opts.difficultyOverride
                : draft.difficulty,
            hasTrap: false,
          })
          .returning({ id: question.id });

        await tx.insert(answerKey).values({
          questionId: inserted.id,
          questionVersion: 1,
          correctOptionIndex: draft.correctOptionIndex,
        });

        await tx.insert(explanation).values({
          questionId: inserted.id,
          questionVersion: 1,
          origin: 'ai_generated',
          body: draft.explanation,
        });

        if (isVerified) published += 1;
        else deferred += 1;
      }
    });

    return { created: drafts.length, published, deferred };
  }

  /**
   * Fire-and-forget AI top-up when a smart_mix selection comes up short.
   * Never blocks exam start; safe against unhandled-rejection crashes.
   *
   * - Fetches the student's weak-topic context.
   * - Returns early if no weak topics (no model call).
   * - Throttles via stateless check: if a PUBLISHED question with origin 'ai'
   *   exists for any weak topic within the cooldown window, skip generation.
   * - Otherwise delegates to generateDraftsForStudent (which re-fetches context
   *   and runs the full verification gate).
   */
  async topUpForShortage(studentId: string): Promise<void> {
    const ctx = await this.historyContext.buildForStudent(studentId);
    if (ctx.weakTopics.length === 0) {
      return;
    }

    const weakTopicIds = ctx.weakTopics
      .map((w) => w.topicId)
      .filter((id): id is string => id != null);
    const cooldownCutoff = new Date(
      Date.now() - TOP_UP_COOLDOWN_HOURS * 60 * 60 * 1000,
    );

    // Stateless throttle: one EXISTS query, limit 1.
    const recent = await this.db
      .select({ id: question.id })
      .from(question)
      .where(
        and(
          eq(question.status, 'published'),
          eq(question.origin, 'ai'),
          inArray(question.topicId, weakTopicIds),
          sql`${question.createdAt} >= ${cooldownCutoff.toISOString()}`,
        ),
      )
      .limit(1);

    if (recent.length > 0) {
      return;
    }

    // Fire the generation; it re-fetches context and applies the verification gate.
    await this.generateDraftsForStudent(studentId);
  }
}

/**
 * Defensively coerce a jsonb value (DB gives `unknown`) into a list of
 * strings, discarding non-string members.
 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
  }
  return out;
}
