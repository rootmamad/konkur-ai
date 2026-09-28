"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiJob = exports.aiOperation = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
/**
 * Log of every model call: operation, tokens, cost, latency,
 * errors and prompt version (spec sections 12, 13.3).
 * Powers per-operation cost tracking and bad-output debugging.
 */
exports.aiOperation = (0, pg_core_1.pgEnum)('ai_operation', [
    'explain',
    'question_chat',
    'coach',
    'grade',
    'exam_analysis',
    'overall_analysis',
    'study_extract',
]);
exports.aiJob = (0, pg_core_1.pgTable)('ai_job', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    operation: (0, exports.aiOperation)('operation').notNull(),
    model: (0, pg_core_1.text)('model').notNull(),
    promptVersion: (0, pg_core_1.text)('prompt_version'),
    inputTokens: (0, pg_core_1.integer)('input_tokens'),
    outputTokens: (0, pg_core_1.integer)('output_tokens'),
    costMicroUsd: (0, pg_core_1.integer)('cost_micro_usd'),
    latencyMs: (0, pg_core_1.integer)('latency_ms'),
    error: (0, pg_core_1.text)('error'),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
