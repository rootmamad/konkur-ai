import {
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { student } from './student';

export const studyLogStatus = pgEnum('study_log_status', [
  'pending',
  'summarized',
]);

export const studyActivity = pgEnum('study_activity', [
  'learning',
  'exercise',
  'test',
  'review',
  'teaching',
]);

export const studyFeeling = pgEnum('study_feeling', [
  'clear',
  'vague',
]);

/**
 * Study entries from form, chat confirm or repeat-yesterday
 * (spec sections 3.6, 12). Rows stay pending until the weekly
 * summary consumes them, then flip to summarized so they are
 * never analysed twice. A vague feeling routes the next
 * suggestion to concept review, never to a test quiz.
 */
export const studyLog = pgTable('study_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  studentId: uuid('student_id')
    .notNull()
    .references(() => student.id, { onDelete: 'cascade' }),
  lesson: text('lesson').notNull(),
  topic: text('topic'),
  activity: studyActivity('activity'),
  minutes: integer('minutes').notNull(),
  doneAt: timestamp('done_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  exerciseCount: integer('exercise_count'),
  result: text('result'),
  source: text('source'),
  feeling: studyFeeling('feeling'),
  note: text('note'),
  status: studyLogStatus('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const studyPlanStatus = pgEnum('study_plan_status', [
  'todo',
  'done',
  'skipped',
]);

/**
 * Items of the suggested template plan (spec section 12).
 * The full interactive planner is out of MVP scope.
 */
export const studyPlanItem = pgTable('study_plan_item', {
  id: uuid('id').primaryKey().defaultRandom(),
  studentId: uuid('student_id')
    .notNull()
    .references(() => student.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  status: studyPlanStatus('status').notNull().default('todo'),
  dueAt: timestamp('due_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type StudyLog = typeof studyLog.$inferSelect;
export type NewStudyLog = typeof studyLog.$inferInsert;
export type StudyPlanItem = typeof studyPlanItem.$inferSelect;
export type NewStudyPlanItem = typeof studyPlanItem.$inferInsert;
