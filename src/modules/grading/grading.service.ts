import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNotNull } from 'drizzle-orm';

import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import { correction } from '../../db/schema/correction';
import { question } from '../../db/schema/question';
import { response } from '../../db/schema/response';
import { rubric } from '../../db/schema/rubric';
import { AIService } from '../ai/ai.service';
// The seven clauses are a single spec text (9.2, «عینا») — imported, never
// reworded or duplicated here.
import { SEVEN_CLAUSES } from '../chat/chat-ai.service';

/** Operation label (spec §12; `grade` already exists in `ai_operation`). */
export const GRADE_OPERATION = 'grade' as const;
/** Prompt revision tag for the rubric-grading prompt. */
export const GRADE_PROMPT_VERSION = 'grade-v1';
/** modelVersion written onto the correction row when grading succeeds. */
export const GRADE_MODEL_VERSION = 'grade-v1';

/** One rubric part as handed to the prompt and the parser. */
export interface GradeRubricPart {
  partKey: string;
  maxScore: number;
  order: number;
}

/** One validated per-part score the model produced. */
export interface GradePartOutput {
  partKey: string;
  score: number;
  evidence: string;
}

/** The validated model output: parts + the reviewer flag, NEVER a total. */
export interface ParsedGrade {
  parts: GradePartOutput[];
  uncertain: boolean;
}

/**
 * Server-side validation of the model's raw completion (spec 6, §13.3):
 * strict JSON — every partKey must exist in the rubric, every score must be
 * a real number inside [0, maxScore] of that part, every evidence must be
 * non-empty, and a partKey may appear at most once. Anything off throws so
 * `AIService.runJob` retries once and finally raises
 * `BadRequestException` — leaving the row at needs_review. Exported so the
 * contract is testable without a model call.
 */
export function parseGradeOutput(
  raw: string,
  rubric: Array<{ partKey: string; maxScore: number }>,
): ParsedGrade {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('grade output is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('grade output must be a JSON object');
  }
  const { parts, uncertain } = value as Record<string, unknown>;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error('grade output must carry a non-empty parts array');
  }
  if (typeof uncertain !== 'boolean') {
    throw new Error('grade output must carry a boolean uncertain flag');
  }

  const maxByKey = new Map(rubric.map((part) => [part.partKey, part.maxScore]));
  const out: GradePartOutput[] = [];
  for (const item of parts) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('each grade part must be an object');
    }
    const { partKey, score, evidence } = item as Record<string, unknown>;
    if (typeof partKey !== 'string' || !maxByKey.has(partKey)) {
      throw new Error(`unknown rubric part: ${String(partKey)}`);
    }
    const max = maxByKey.get(partKey) as number;
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      throw new Error(`score for ${partKey} must be a number`);
    }
    if (score < 0 || score > max) {
      throw new Error(`score for ${partKey} outside [0, ${max}]`);
    }
    if (typeof evidence !== 'string' || evidence.trim().length === 0) {
      throw new Error(`evidence for ${partKey} must be non-empty`);
    }
    out.push({ partKey, score, evidence: evidence.trim() });
  }
  if (new Set(out.map((part) => part.partKey)).size !== out.length) {
    throw new Error('duplicate rubric part in grade output');
  }
  return { parts: out, uncertain };
}

/**
 * Build the rubric-grading prompt (spec 6): the seven clauses verbatim, the
 * question, the rubric parts, the student's text answer, and the STRICT JSON
 * contract. The model NEVER outputs a total — the backend sums the parts
 * (spec 6: «جمع بارم‌ها و سقف نمره را بک‌اند کنترل می‌کند»). Pure and
 * exported so the assembled prompt is testable without a model call.
 */
export function buildGradePrompt(input: {
  questionText: string;
  questionType: string;
  textAnswer: string;
  rubric: GradeRubricPart[];
}): string {
  return [
    'تو تصحیح‌کننده دقیق کنکور هستی؛ پاسخ تشریحی دانش‌آموز را فقط بر اساس بارم زیر نمره بده.',
    '',
    'قواعد زیر را عینا در همه پاسخ‌ها رعایت کن:',
    SEVEN_CLAUSES,
    '',
    'صورت سؤال:',
    input.questionText,
    `نوع سؤال: ${input.questionType}`,
    '',
    'بارم (بخش‌های نمره‌دهی):',
    ...input.rubric
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((part) => `- ${part.partKey}: حداکثر ${part.maxScore}`),
    '',
    'پاسخ دانش‌آموز:',
    input.textAnswer,
    '',
    'فقط و فقط یک JSON معتبر برگردان، بدون هیچ متن اضافه:',
    '{"parts":[{"partKey":"<یکی از بخش‌های بارم بالا>","score":<عدد در بازه [0، سقف همان بخش]>,"evidence":"<نقل‌قول یا ارجاع کوتاه به پاسخ دانش‌آموز>"}],"uncertain":false}',
    '',
    'هر partKey باید دقیقاً با یکی از بخش‌های بارم بالا برابر باشد؛ score همیشه عدد (نه رشته) و در بازه [0، سقف همان بخش]؛ evidence غیرخالی. مجموع کل (total) را برنگردان — جمع بارم‌ها را سرور حساب می‌کند. اگر در نمره‌دادن هر بخش مطمئن نیستی، uncertain را true بگذار.',
  ].join('\n');
}

/** Round to the numeric(5,2) column's precision, in JS (server-owned). */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * AI rubric grading of descriptive answers (spec 6, 15.1-item 5): fills the
 * `needs_review` correction placeholders that finishExam queues. No
 * user-facing quota (spec 6: «سهمیه جدا ندارد») — cost is measured only in
 * ai_job rows. The MVP review rule (§15.2 [باز]): uncertain or invalid
 * output keeps the row at needs_review — never an auto zero, never a
 * downgrade below needs_review.
 */
@Injectable()
export class GradingService {
  private readonly logger = new Logger(GradingService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly aiService: AIService,
  ) {}

  /**
   * Grade every still-pending descriptive response of one attempt.
   * Idempotent (spec 6/15.1-item 5): the read joins correction on
   * `status = 'needs_review'`, so already-graded rows are skipped and a
   * re-finish never re-grades. Per-row failures are logged and swallowed —
   * the row simply stays needs_review; the caller is fire-and-forget.
   */
  async gradeAttempt(attemptId: string): Promise<void> {
    const rows = await this.db
      .select({
        responseId: response.id,
        questionId: response.questionId,
        textAnswer: response.textAnswer,
        questionText: question.text,
        questionType: question.type,
      })
      .from(response)
      .innerJoin(question, eq(question.id, response.questionId))
      .innerJoin(correction, eq(correction.responseId, response.id))
      .where(
        and(
          eq(response.attemptId, attemptId),
          eq(correction.status, 'needs_review'),
          isNotNull(response.textAnswer),
        ),
      );

    for (const row of rows) {
      // The SQL already filters to text answers; this local keeps the types
      // honest (the select type carries `string | null`).
      const { textAnswer } = row;
      if (textAnswer === null) continue;
      try {
        await this.gradeOne({ ...row, textAnswer });
      } catch (err: unknown) {
        // One bad row never blocks the rest; its correction row stays
        // untouched at needs_review for the human reviewer.
        this.logger.warn(
          `[${row.responseId}] AI grading failed (row left needs_review): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /** Grade ONE response: rubric → prompt → runJob → server-owned total. */
  private async gradeOne(row: {
    responseId: string;
    questionId: string;
    textAnswer: string;
    questionText: string;
    questionType: string;
  }): Promise<void> {
    const rubricParts = await this.loadRubric(row.questionId);
    if (rubricParts.length === 0) {
      // Without a rubric there is nothing to grade against; the row stays
      // needs_review for a human (never an invented or auto-zero score).
      this.logger.warn(
        `[${row.responseId}] no rubric parts; row left needs_review`,
      );
      return;
    }

    const prompt = buildGradePrompt({
      questionText: row.questionText,
      questionType: row.questionType,
      textAnswer: row.textAnswer,
      rubric: rubricParts,
    });

    const parsed = await this.aiService.runJob<ParsedGrade>({
      operation: GRADE_OPERATION,
      promptVersion: GRADE_PROMPT_VERSION,
      prompt,
      parse: (raw: string) => parseGradeOutput(raw, rubricParts),
    });

    // The server owns the total (spec 6): sum the VALIDATED part scores in
    // JS at 2-decimal precision; any model-supplied sum is ignored.
    const total = round2(
      parsed.parts.reduce((sum, part) => sum + part.score, 0),
    );

    // uncertain → the row KEEPS needs_review, but the parts + evidence are
    // stored (and the tentative server-computed sum kept) for the human
    // reviewer. Invalid output never reaches this write: runJob raised.
    await this.db
      .update(correction)
      .set({
        partScores: parsed.parts,
        totalScore: total.toFixed(2),
        status: parsed.uncertain ? 'needs_review' : 'graded',
        modelVersion: GRADE_MODEL_VERSION,
      })
      // Guarded: only a still-pending row can be written, so a concurrent
      // finish/review can never be overwritten here.
      .where(
        and(
          eq(correction.responseId, row.responseId),
          eq(correction.status, 'needs_review'),
        ),
      );
  }

  /** The rubric parts of one question, maxScore as a number. */
  private async loadRubric(questionId: string): Promise<GradeRubricPart[]> {
    const rows = await this.db
      .select({
        partKey: rubric.partKey,
        maxScore: rubric.maxScore,
        order: rubric.order,
      })
      .from(rubric)
      .where(eq(rubric.questionId, questionId));
    return rows.map((row) => ({
      partKey: row.partKey,
      maxScore: Number(row.maxScore),
      order: row.order,
    }));
  }
}
