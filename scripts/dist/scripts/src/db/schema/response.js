"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.response = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const attempt_1 = require("./attempt");
const question_1 = require("./question");
/**
 * One answer inside an attempt (spec sections 8, 12).
 * activeSeconds stores on-question presence time only, never a
 * focus claim. attemptNumber distinguishes first try on a fresh
 * question from repeats of seen ones (spec section 7).
 */
exports.response = (0, pg_core_1.pgTable)('response', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    attemptId: (0, pg_core_1.uuid)('attempt_id')
        .notNull()
        .references(() => attempt_1.attempt.id, { onDelete: 'cascade' }),
    questionId: (0, pg_core_1.uuid)('question_id')
        .notNull()
        .references(() => question_1.question.id),
    questionVersion: (0, pg_core_1.integer)('question_version').notNull(),
    selectedOption: (0, pg_core_1.integer)('selected_option'),
    textAnswer: (0, pg_core_1.text)('text_answer'),
    activeSeconds: (0, pg_core_1.integer)('active_seconds').notNull().default(0),
    attemptNumber: (0, pg_core_1.integer)('attempt_number').notNull().default(1),
    isCorrect: (0, pg_core_1.boolean)('is_correct'),
    answeredAt: (0, pg_core_1.timestamp)('answered_at', { withTimezone: true }),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
