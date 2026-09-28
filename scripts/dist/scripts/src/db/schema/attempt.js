"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.attempt = exports.attemptStatus = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const exam_1 = require("./exam");
const student_1 = require("./student");
exports.attemptStatus = (0, pg_core_1.pgEnum)('attempt_status', [
    'in_progress',
    'submitted',
    'reviewed',
]);
/**
 * One exam sitting (spec sections 8, 12, 13.2).
 * Correct answers are never sent during the attempt; grading
 * links every response to the frozen question version.
 */
exports.attempt = (0, pg_core_1.pgTable)('attempt', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    studentId: (0, pg_core_1.uuid)('student_id')
        .notNull()
        .references(() => student_1.student.id, { onDelete: 'cascade' }),
    examInstanceId: (0, pg_core_1.uuid)('exam_instance_id')
        .notNull()
        .references(() => exam_1.examInstance.id),
    status: (0, exports.attemptStatus)('status').notNull().default('in_progress'),
    startedAt: (0, pg_core_1.timestamp)('started_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    submittedAt: (0, pg_core_1.timestamp)('submitted_at', { withTimezone: true }),
    totalScore: (0, pg_core_1.integer)('total_score'),
    idempotencyKey: (0, pg_core_1.text)('idempotency_key').unique(),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
