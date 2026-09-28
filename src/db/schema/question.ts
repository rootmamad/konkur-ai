import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { topic } from './topic';

export const questionType = pgEnum('question_type', [
  'multiple_choice',
  'true_false',
  'fill_blank',
  'descriptive',
  'multi_part',
]);

export const questionStatus = pgEnum('question_status', [
  'draft',
  'in_review',
  'published',
  'archived',
]);

/**
 * Versioned question row (spec sections 4, 12).
 * Identity/origin, content blocks (text + visual formula order kept
 * by the frontend), structure, pedagogy tags, quality state.
 * Correct answers live in answer_key, teaching notes in explanation,
 * scoring parts in rubric — never inline here.
 * Descriptive questions use type 'descriptive';
 * free-text answers are stored on response.text_answer.
 */
export const question = pgTable('question', {
  id: uuid('id').primaryKey().defaultRandom(),
  version: integer('version').notNull().default(1),
  topicId: uuid('topic_id').references(() => topic.id),
  type: questionType('type').notNull(),
  status: questionStatus('status').notNull().default('draft'),
  text: text('text').notNull(),
  contentBlocks: jsonb('content_blocks').notNull().default([]),
  options: jsonb('options').notNull().default([]),
  subject: text('subject').notNull(),
  concepts: jsonb('concepts').notNull().default([]),
  prerequisites: jsonb('prerequisites').notNull().default([]),
  hasTrap: boolean('has_trap').notNull().default(false),
  difficultyAi: integer('difficulty_ai'),
  sourceYear: integer('source_year'),
  sourceSession: text('source_session'),
  sourceMajor: text('source_major'),
  sourceLesson: text('source_lesson'),
  sourceNumber: integer('source_number'),
  sourcePage: integer('source_page'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Question = typeof question.$inferSelect;
export type NewQuestion = typeof question.$inferInsert;
