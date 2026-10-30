import {
  boolean,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { student } from './student';
import { question } from './question';

export const questionMastery = pgTable(
  'question_mastery',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => student.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id')
      .notNull()
      .references(() => question.id, { onDelete: 'cascade' }),
    currentStreak: integer('current_streak').notNull().default(0),
    totalAttempts: integer('total_attempts').notNull().default(0),
    totalCorrect: integer('total_correct').notNull().default(0),
    lastIsCorrect: boolean('last_is_correct'),
    lastAnsweredAt: timestamp('last_answered_at', { withTimezone: true }),
    masteredAt: timestamp('mastered_at', { withTimezone: true }),
    nextDueAt: timestamp('next_due_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('question_mastery_student_question_uq').on(
      t.studentId,
      t.questionId,
    ),
    index('qm_not_mastered_idx')
      .on(t.studentId)
      .where(sql`${t.masteredAt} IS NULL`),
    index('qm_mastered_idx')
      .on(t.studentId, t.masteredAt)
      .where(sql`${t.masteredAt} IS NOT NULL`),
    index('qm_due_idx')
      .on(t.studentId, t.nextDueAt)
      .where(sql`${t.nextDueAt} IS NOT NULL AND ${t.masteredAt} IS NULL`),
  ],
);

export type QuestionMastery = typeof questionMastery.$inferSelect;
export type NewQuestionMastery = typeof questionMastery.$inferInsert;
