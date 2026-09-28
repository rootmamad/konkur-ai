"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rubric = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const question_1 = require("./question");
/**
 * Scoring parts of one question (spec sections 4, 6, 12).
 * The backend sums part scores and enforces the question cap.
 */
exports.rubric = (0, pg_core_1.pgTable)('rubric', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    questionId: (0, pg_core_1.uuid)('question_id')
        .notNull()
        .references(() => question_1.question.id, { onDelete: 'cascade' }),
    partKey: (0, pg_core_1.text)('part_key').notNull(),
    maxScore: (0, pg_core_1.numeric)('max_score', { precision: 5, scale: 2 }).notNull(),
    order: (0, pg_core_1.integer)('order').notNull().default(0),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
