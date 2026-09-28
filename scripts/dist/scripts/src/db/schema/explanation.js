"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.explanation = exports.explanationOrigin = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const question_1 = require("./question");
exports.explanationOrigin = (0, pg_core_1.pgEnum)('explanation_origin', [
    'official',
    'source_book',
    'ai_generated',
]);
/**
 * Teaching answer notes with explicit origin (spec section 4).
 * The official key, the source book solution and the AI
 * explanation are three separate origins, never merged.
 */
exports.explanation = (0, pg_core_1.pgTable)('explanation', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    questionId: (0, pg_core_1.uuid)('question_id')
        .notNull()
        .references(() => question_1.question.id, { onDelete: 'cascade' }),
    questionVersion: (0, pg_core_1.integer)('question_version').notNull(),
    origin: (0, exports.explanationOrigin)('origin').notNull(),
    body: (0, pg_core_1.text)('body').notNull(),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
