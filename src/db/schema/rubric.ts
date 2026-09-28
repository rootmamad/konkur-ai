import {
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { question } from './question';

/**
 * Scoring parts of one question (spec sections 4, 6, 12).
 * The backend sums part scores and enforces the question cap.
 */
export const rubric = pgTable('rubric', {
  id: uuid('id').primaryKey().defaultRandom(),
  questionId: uuid('question_id')
    .notNull()
    .references(() => question.id, { onDelete: 'cascade' }),
  partKey: text('part_key').notNull(),
  maxScore: numeric('max_score', { precision: 5, scale: 2 }).notNull(),
  order: integer('order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Rubric = typeof rubric.$inferSelect;
export type NewRubric = typeof rubric.$inferInsert;
