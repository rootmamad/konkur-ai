import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import { attempt } from '../../db/schema/attempt';
import { question } from '../../db/schema/question';
import { response } from '../../db/schema/response';
import { topic } from '../../db/schema/topic';

/**
 * How many calendar days of wrong answers back the per-student context
 * considers (spec §13.3: lazily-scoped, operation-tailored context — never
 * the student's whole history).
 */
export const WINDOW_DAYS = 30;

/**
 * The context never proposes more than this many weak topics as AI targets.
 * MVP default; candidate for an app_config override later (spec §10).
 */
export const MAX_WEAK_TOPICS = 5;

/** Per-topic cap for the de-duplicated concept union across wrong answers. */
export const MAX_CONCEPTS_PER_TOPIC = 10;

/** Per-topic cap for how many sample question texts are kept as style refs. */
export const MAX_SAMPLES_PER_TOPIC = 5;

/** Hard length cap for each retained sample question text. */
export const SAMPLE_TEXT_MAX_CHARS = 300;

/**
 * Defensively coerce a jsonb value (DB gives `unknown`) into a list of
 * strings, discarding any non-string members.
 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
  }
  return out;
}

/**
 * Shape of a per-topic slice of a student's recent wrong-answer history.
 * It exists to give the future prompt a topic target and style/level
 * reference — never the full history (spec §5, §13.3).
 */
export interface WeakTopicContext {
  topicId: string | null;
  topicTitle: string | null;
  wrongCount: number;
  distinctWrongQuestions: number;
  lastWrongAt: Date | null;
  concepts: string[];
  sampleWrongTexts: string[];
  avgDifficulty: number | null;
}

/**
 * The per-student, operation-scoped history payload handed to AI generation.
 */
export interface HistoryContext {
  studentId: string;
  totalWrong: number;
  windowDays: number;
  weakTopics: WeakTopicContext[];
}

/**
 * One raw joined row produced by {@link HistoryContextService.buildForStudent}.
 * Kept as a plain exported interface so {@link groupWeakTopics} is testable
 * without a database (spec §13.3 — grouping happens in JS, not SQL).
 */
export interface WeakRow {
  studentId: string;
  topicId: string | null;
  topicTitle: string | null;
  questionId: string;
  questionText: string;
  /** raw jsonb → normalized to string[] inside groupWeakTopics */
  concepts: unknown;
  difficultyAi: number | null;
  isCorrect: boolean | null;
  answeredAt: Date | null;
}

/**
 * Build the "متناسب با سابقه" (appropriate-to-history) context that future AI
 * question generation consumes.
 *
 * Student identity note: `studentId` is the **STUDENT profile** primary key
 * (from the `student` table), NOT the `account` id. Callers must resolve the
 * account → student mapping themselves (e.g. via the users/student service)
 * before calling this service.
 */
@Injectable()
export class HistoryContextService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Assemble the recent-weakness context for one student.
   *
   * Query plan (bounded, per spec §13.3):
   * - responses of this student's attempts, joined to the answered question
   *   (topic, title, concepts, difficultyAi, text);
   * - only wrong answers (`isCorrect = false`) inside the last
   *   {@link WINDOW_DAYS} days;
   * - only questions the student has NOT mastered yet (question_mastery absent
   *   or `mastered_at IS NULL`) — a weakness already fixed must not drive
   *   generation;
   * - no `question.status` filter on purpose: an archived question's wrong
   *   answer is still real evidence about that topic (documented choice);
   * - grouping/ranking/caps are all done in JS by {@link groupWeakTopics}.
   *
   * @param studentId the STUDENT profile id (not the account id).
   */
  async buildForStudent(studentId: string): Promise<HistoryContext> {
    const rows = await this.db
      .select({
        studentId: attempt.studentId,
        topicId: question.topicId,
        topicTitle: topic.title,
        questionId: question.id,
        questionText: question.text,
        concepts: question.concepts,
        difficultyAi: question.difficultyAi,
        isCorrect: response.isCorrect,
        answeredAt: response.answeredAt,
      })
      .from(response)
      .innerJoin(attempt, eq(attempt.id, response.attemptId))
      .innerJoin(question, eq(question.id, response.questionId))
      .leftJoin(topic, eq(topic.id, question.topicId))
      .where(
        and(
          eq(attempt.studentId, studentId),
          eq(response.isCorrect, false),
          sql`${response.answeredAt} >= now() - interval '30 days'`,
          // Not mastered: no mastery row at all, or one that is not yet mastered.
          sql`NOT EXISTS (
            SELECT 1 FROM question_mastery qm
            WHERE qm.student_id = ${attempt.studentId}
              AND qm.question_id = ${question.id}
              AND qm.mastered_at IS NOT NULL
          )`,
        ),
      )
      .orderBy(sql`${response.answeredAt} DESC`);

    return {
      studentId,
      totalWrong: rows.length,
      windowDays: WINDOW_DAYS,
      weakTopics: groupWeakTopics(rows),
    };
  }
}

/**
 * Group flat {@link WeakRow}s into ranked weak topics.
 *
 * Pure function (no DB access) so it can be unit-tested directly.
 * - Groups by `topicId`; null-topic rows are excluded from `weakTopics` but
 *   still counted in `totalWrong` (the future prompt needs a topic target).
 * - Ranks groups by `wrongCount` descending and keeps the top
 *   {@link MAX_WEAK_TOPICS}.
 * - `concepts` is a de-duplicated union across the topic's wrong questions,
 *   capped at {@link MAX_CONCEPTS_PER_TOPIC}.
 * - `sampleWrongTexts` keeps up to {@link MAX_SAMPLES_PER_TOPIC} question
 *   texts, each truncated to {@link SAMPLE_TEXT_MAX_CHARS} characters.
 * - `avgDifficulty` is the mean of non-null `difficultyAi`, rounded to 1
 *   decimal; `null` when the topic has no difficulty data.
 */
export function groupWeakTopics(rows: WeakRow[]): WeakTopicContext[] {
  type Acc = {
    ctx: WeakTopicContext;
    seenQuestions: Set<string>;
    seenConcepts: Set<string>;
  };
  // Topics are finalized once their cap on sample texts is reached; we keep
  // wrongCount/difficulty running regardless (they never cap).
  const acc = new Map<string, Acc>();

  for (const row of rows) {
    // Null-topic rows contribute to totalWrong but never to weakTopics.
    if (row.topicId == null) continue;

    let entry = acc.get(row.topicId);
    if (!entry) {
      entry = {
        ctx: {
          topicId: row.topicId,
          topicTitle: row.topicTitle,
          wrongCount: 0,
          distinctWrongQuestions: 0,
          lastWrongAt: null,
          concepts: [],
          sampleWrongTexts: [],
          avgDifficulty: null,
        },
        seenQuestions: new Set(),
        seenConcepts: new Set(),
      };
      acc.set(row.topicId, entry);
    }

    const ctx = entry.ctx;
    ctx.wrongCount += 1;

    // lastWrongAt: latest answeredAt across the topic's rows (rows come DESC,
    // but stay robust to any input order).
    if (row.answeredAt != null) {
      if (ctx.lastWrongAt == null || row.answeredAt > ctx.lastWrongAt) {
        ctx.lastWrongAt = row.answeredAt;
      }
    }

    // Distinct answered questions within the topic.
    if (!entry.seenQuestions.has(row.questionId)) {
      entry.seenQuestions.add(row.questionId);
      ctx.distinctWrongQuestions += 1;
    }

    // De-duplicated concept union, capped per topic.
    for (const concept of toStringArray(row.concepts)) {
      if (entry.seenConcepts.has(concept)) continue;
      if (ctx.concepts.length >= MAX_CONCEPTS_PER_TOPIC) break;
      entry.seenConcepts.add(concept);
      ctx.concepts.push(concept);
    }

    // Sample question texts (truncated), capped per topic.
    if (ctx.sampleWrongTexts.length < MAX_SAMPLES_PER_TOPIC) {
      const sample =
        row.questionText.length > SAMPLE_TEXT_MAX_CHARS
          ? row.questionText.slice(0, SAMPLE_TEXT_MAX_CHARS)
          : row.questionText;
      ctx.sampleWrongTexts.push(sample);
    }
  }

  // Compute avgDifficulty per topic after collecting all rows.
  const difficulties = new Map<string, { sum: number; count: number }>();
  for (const row of rows) {
    if (row.topicId == null || row.difficultyAi == null) continue;
    const d = difficulties.get(row.topicId) ?? { sum: 0, count: 0 };
    d.sum += row.difficultyAi;
    d.count += 1;
    difficulties.set(row.topicId, d);
  }

  for (const [topicId, entry] of acc) {
    const d = difficulties.get(topicId);
    entry.ctx.avgDifficulty =
      d && d.count > 0 ? Math.round((d.sum / d.count) * 10) / 10 : null;
  }

  const groups = [...acc.values()].map((e) => e.ctx);
  groups.sort((a, b) => b.wrongCount - a.wrongCount);
  return groups.slice(0, MAX_WEAK_TOPICS);
}
