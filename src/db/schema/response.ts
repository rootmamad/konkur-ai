import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { attempt } from './attempt';
import { question } from './question';

/**
 * One answer inside an attempt (spec sections 8, 12).
 * activeSeconds stores on-question presence time only, never a
 * focus claim. attemptNumber distinguishes first try on a fresh
 * question from repeats of seen ones (spec section 7).
 */
export const response = pgTable('response', {
  id: uuid('id').primaryKey().defaultRandom(),
  attemptId: uuid('attempt_id')
    .notNull()
    .references(() => attempt.id, { onDelete: 'cascade' }),
  questionId: uuid('question_id')
    .notNull()
    .references(() => question.id),
  questionVersion: integer('question_version').notNull(),
  selectedOption: integer('selected_option'),
  textAnswer: text('text_answer'),
  activeSeconds: integer('active_seconds').notNull().default(0),
  attemptNumber: integer('attempt_number').notNull().default(1),
  isCorrect: boolean('is_correct'),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Response = typeof response.$inferSelect;
export type NewResponse = typeof response.$inferInsert;
