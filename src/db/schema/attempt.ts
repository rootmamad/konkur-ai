import {
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { examInstance } from './exam';
import { student } from './student';

export const attemptStatus = pgEnum('attempt_status', [
  'in_progress',
  'submitted',
  'reviewed',
]);

/**
 * One exam sitting (spec sections 8, 12, 13.2).
 * Correct answers are never sent during the attempt; grading
 * links every response to the frozen question version.
 */
export const attempt = pgTable('attempt', {
  id: uuid('id').primaryKey().defaultRandom(),
  studentId: uuid('student_id')
    .notNull()
    .references(() => student.id, { onDelete: 'cascade' }),
  examInstanceId: uuid('exam_instance_id')
    .notNull()
    .references(() => examInstance.id),
  status: attemptStatus('status').notNull().default('in_progress'),
  startedAt: timestamp('started_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  totalScore: integer('total_score'),
  idempotencyKey: text('idempotency_key').unique(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Attempt = typeof attempt.$inferSelect;
export type NewAttempt = typeof attempt.$inferInsert;
