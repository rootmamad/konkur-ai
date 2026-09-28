"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chatMessage = exports.chatThread = exports.chatRole = exports.chatSpace = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const attempt_1 = require("./attempt");
const question_1 = require("./question");
const student_1 = require("./student");
exports.chatSpace = (0, pg_core_1.pgEnum)('chat_space', [
    'coach',
    'question',
    'exam_analysis',
]);
exports.chatRole = (0, pg_core_1.pgEnum)('chat_role', ['user', 'assistant']);
/**
 * Product memory for the three separate chat spaces
 * (spec sections 9, 12). Threads reference their context and
 * messages are the basis for AI quota counting.
 */
exports.chatThread = (0, pg_core_1.pgTable)('chat_thread', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    studentId: (0, pg_core_1.uuid)('student_id')
        .notNull()
        .references(() => student_1.student.id, { onDelete: 'cascade' }),
    space: (0, exports.chatSpace)('space').notNull(),
    questionId: (0, pg_core_1.uuid)('question_id').references(() => question_1.question.id),
    attemptId: (0, pg_core_1.uuid)('attempt_id').references(() => attempt_1.attempt.id),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
exports.chatMessage = (0, pg_core_1.pgTable)('chat_message', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    threadId: (0, pg_core_1.uuid)('thread_id')
        .notNull()
        .references(() => exports.chatThread.id, { onDelete: 'cascade' }),
    role: (0, exports.chatRole)('role').notNull(),
    body: (0, pg_core_1.text)('body').notNull(),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
