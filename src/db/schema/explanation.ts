import {
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
} from 'drizzle-orm/pg-core';

import { question } from './question';

export const explanationOrigin = pgEnum('explanation_origin', [
  'official',
  'source_book',
  'ai_generated',
]);

/**
 * Teaching answer notes with explicit origin (spec section 4).
 * The official key, the source book solution and the AI
 * explanation are three separate origins, never merged.
 */
export const explanation = pgTable('explanation', {
  id: uuid('id').primaryKey().defaultRandom(),
  questionId: uuid('question_id')
    .notNull()
    .references(() => question.id, { onDelete: 'cascade' }),
  questionVersion: integer('question_version').notNull(),
  origin: explanationOrigin('origin').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Explanation = typeof explanation.$inferSelect;
export type NewExplanation = typeof explanation.$inferInsert;
