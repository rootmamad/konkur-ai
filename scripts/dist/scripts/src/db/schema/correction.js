"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.correction = exports.correctionStatus = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const response_1 = require("./response");
exports.correctionStatus = (0, pg_core_1.pgEnum)('correction_status', [
    'graded',
    'needs_review',
    'grading',
]);
/**
 * Rubric-based grading result of one descriptive response
 * (spec sections 6, 12). Stores per-part scores with evidence
 * quotes, the model version used, and the review state.
 * Ambiguous answers become needs_review, never an auto zero.
 */
exports.correction = (0, pg_core_1.pgTable)('correction', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    responseId: (0, pg_core_1.uuid)('response_id')
        .notNull()
        .references(() => response_1.response.id, { onDelete: 'cascade' }),
    partScores: (0, pg_core_1.jsonb)('part_scores').notNull().default([]),
    totalScore: (0, pg_core_1.numeric)('total_score', { precision: 5, scale: 2 }),
    status: (0, exports.correctionStatus)('status').notNull().default('grading'),
    modelVersion: (0, pg_core_1.text)('model_version'),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
