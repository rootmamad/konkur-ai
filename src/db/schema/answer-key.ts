import {
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { question } from './question';

/**
 * Official test key, kept separate from the question (spec section 4).
 * One row per question version.
 */
export const answerKey = pgTable('answer_key', {
  id: uuid('id').primaryKey().defaultRandom(),
  questionId: uuid('question_id')
    .notNull()
    .references(() => question.id, { onDelete: 'cascade' }),
  questionVersion: integer('question_version').notNull(),
  correctOptionIndex: integer('correct_option_index'),
  correctText: text('correct_text'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AnswerKey = typeof answerKey.$inferSelect;
export type NewAnswerKey = typeof answerKey.$inferInsert;
