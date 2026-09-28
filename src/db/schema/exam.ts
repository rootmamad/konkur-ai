import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Reusable exam blueprints and frozen built copies
 * (spec sections 3.5, 5, 12).
 * An instance freezes the question order plus the exact
 * settings version used at build time.
 */
export const examTemplateKind = pgEnum('exam_template_kind', [
  'quiz_after_study',
  'debug_errors',
  'due_review',
  'speed',
  'trap_finder',
  'general_prep',
  'smart_mix',
  'diagnostic',
  'konkur_sim',
  'final_sim',
]);

export const examTemplate = pgTable('exam_template', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: examTemplateKind('kind').notNull(),
  title: text('title').notNull(),
  config: jsonb('config').notNull().default({}),
  settingsVersion: integer('settings_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const examInstance = pgTable('exam_instance', {
  id: uuid('id').primaryKey().defaultRandom(),
  templateId: uuid('template_id').references(() => examTemplate.id),
  questionOrder: jsonb('question_order').notNull().default([]),
  settingsSnapshot: jsonb('settings_snapshot').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ExamTemplate = typeof examTemplate.$inferSelect;
export type NewExamTemplate = typeof examTemplate.$inferInsert;
export type ExamInstance = typeof examInstance.$inferSelect;
export type NewExamInstance = typeof examInstance.$inferInsert;
