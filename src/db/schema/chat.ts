import {
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { attempt } from './attempt';
import { question } from './question';
import { student } from './student';

export const chatSpace = pgEnum('chat_space', [
  'coach',
  'question',
  'exam_analysis',
]);

export const chatRole = pgEnum('chat_role', ['user', 'assistant']);

/**
 * Product memory for the three separate chat spaces
 * (spec sections 9, 12). Threads reference their context and
 * messages are the basis for AI quota counting.
 */
export const chatThread = pgTable('chat_thread', {
  id: uuid('id').primaryKey().defaultRandom(),
  studentId: uuid('student_id')
    .notNull()
    .references(() => student.id, { onDelete: 'cascade' }),
  space: chatSpace('space').notNull(),
  questionId: uuid('question_id').references(() => question.id),
  attemptId: uuid('attempt_id').references(() => attempt.id),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const chatMessage = pgTable('chat_message', {
  id: uuid('id').primaryKey().defaultRandom(),
  threadId: uuid('thread_id')
    .notNull()
    .references(() => chatThread.id, { onDelete: 'cascade' }),
  role: chatRole('role').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ChatThread = typeof chatThread.$inferSelect;
export type NewChatThread = typeof chatThread.$inferInsert;
export type ChatMessage = typeof chatMessage.$inferSelect;
export type NewChatMessage = typeof chatMessage.$inferInsert;
