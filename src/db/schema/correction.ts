import {
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { response } from './response';

export const correctionStatus = pgEnum('correction_status', [
  'graded',
  'needs_review',
  'grading',
]);

/**
 * Rubric-based grading result of one descriptive response
 * (spec sections 6, 12). Stores per-part scores with evidence
 * quotes, the model version used, and the review state.
 * Ambiguous answers become needs_review, never an auto zero.
 */
export const correction = pgTable('correction', {
  id: uuid('id').primaryKey().defaultRandom(),
  responseId: uuid('response_id')
    .notNull()
    .references(() => response.id, { onDelete: 'cascade' }),
  partScores: jsonb('part_scores').notNull().default([]),
  totalScore: numeric('total_score', { precision: 5, scale: 2 }),
  status: correctionStatus('status').notNull().default('grading'),
  modelVersion: text('model_version'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Correction = typeof correction.$inferSelect;
export type NewCorrection = typeof correction.$inferInsert;
