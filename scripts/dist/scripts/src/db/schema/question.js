"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.question = exports.questionStatus = exports.questionType = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const topic_1 = require("./topic");
exports.questionType = (0, pg_core_1.pgEnum)('question_type', [
    'multiple_choice',
    'true_false',
    'fill_blank',
    'descriptive',
    'multi_part',
]);
exports.questionStatus = (0, pg_core_1.pgEnum)('question_status', [
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
 */
exports.question = (0, pg_core_1.pgTable)('question', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    version: (0, pg_core_1.integer)('version').notNull().default(1),
    topicId: (0, pg_core_1.uuid)('topic_id').references(() => topic_1.topic.id),
    type: (0, exports.questionType)('type').notNull(),
    status: (0, exports.questionStatus)('status').notNull().default('draft'),
    text: (0, pg_core_1.text)('text').notNull(),
    contentBlocks: (0, pg_core_1.jsonb)('content_blocks').notNull().default([]),
    options: (0, pg_core_1.jsonb)('options').notNull().default([]),
    subject: (0, pg_core_1.text)('subject').notNull(),
    concepts: (0, pg_core_1.jsonb)('concepts').notNull().default([]),
    prerequisites: (0, pg_core_1.jsonb)('prerequisites').notNull().default([]),
    hasTrap: (0, pg_core_1.boolean)('has_trap').notNull().default(false),
    difficultyAi: (0, pg_core_1.integer)('difficulty_ai'),
    sourceYear: (0, pg_core_1.integer)('source_year'),
    sourceSession: (0, pg_core_1.text)('source_session'),
    sourceMajor: (0, pg_core_1.text)('source_major'),
    sourceLesson: (0, pg_core_1.text)('source_lesson'),
    sourceNumber: (0, pg_core_1.integer)('source_number'),
    sourcePage: (0, pg_core_1.integer)('source_page'),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
