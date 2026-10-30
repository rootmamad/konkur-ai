import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { attempt } from './attempt';
import { question } from './question';

/**
 * One answer per question inside an attempt (spec 8, 12).
 * Changing the answer mid-exam updates this row. attemptNumber is the
 * student's N-th exam attempt on this question across exams (spec 7:
 * first try on a fresh question vs repeats), not an edit counter.
 */
export const response = pgTable(
  'response',
  {
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
  },
  (t) => [
    uniqueIndex('response_attempt_question_uq').on(t.attemptId, t.questionId),
  ],
);

export type Response = typeof response.$inferSelect;
export type NewResponse = typeof response.$inferInsert;
