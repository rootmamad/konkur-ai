"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.answerKey = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const question_1 = require("./question");
/**
 * Official test key, kept separate from the question (spec section 4).
 * One row per question version.
 */
exports.answerKey = (0, pg_core_1.pgTable)('answer_key', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    questionId: (0, pg_core_1.uuid)('question_id')
        .notNull()
        .references(() => question_1.question.id, { onDelete: 'cascade' }),
    questionVersion: (0, pg_core_1.integer)('question_version').notNull(),
    correctOptionIndex: (0, pg_core_1.integer)('correct_option_index'),
    correctText: (0, pg_core_1.text)('correct_text'),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
