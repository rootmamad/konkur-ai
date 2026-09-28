import {
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Log of every model call: operation, tokens, cost, latency,
 * errors and prompt version (spec sections 12, 13.3).
 * Powers per-operation cost tracking and bad-output debugging.
 */
export const aiOperation = pgEnum('ai_operation', [
  'explain',
  'question_chat',
  'coach',
  'grade',
  'exam_analysis',
  'overall_analysis',
  'study_extract',
]);

export const aiJob = pgTable('ai_job', {
  id: uuid('id').primaryKey().defaultRandom(),
  operation: aiOperation('operation').notNull(),
  model: text('model').notNull(),
  promptVersion: text('prompt_version'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  costMicroUsd: integer('cost_micro_usd'),
  latencyMs: integer('latency_ms'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AiJob = typeof aiJob.$inferSelect;
export type NewAiJob = typeof aiJob.$inferInsert;
