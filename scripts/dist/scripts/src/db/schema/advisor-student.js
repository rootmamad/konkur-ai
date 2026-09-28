"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.advisorStudent = exports.advisorStudentAccess = exports.advisorStudentStatus = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const advisor_1 = require("./advisor");
const student_1 = require("./student");
exports.advisorStudentStatus = (0, pg_core_1.pgEnum)('advisor_student_status', [
    'pending',
    'active',
    'revoked',
]);
exports.advisorStudentAccess = (0, pg_core_1.pgEnum)('advisor_student_access', [
    'report_only',
    'full',
]);
/**
 * Many-to-many link between advisors and students (spec sections 2, 12).
 * Revoking access never deletes history rows, it only flips status.
 */
exports.advisorStudent = (0, pg_core_1.pgTable)('advisor_student', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    advisorId: (0, pg_core_1.uuid)('advisor_id')
        .notNull()
        .references(() => advisor_1.advisor.id, { onDelete: 'cascade' }),
    studentId: (0, pg_core_1.uuid)('student_id')
        .notNull()
        .references(() => student_1.student.id, { onDelete: 'cascade' }),
    status: (0, exports.advisorStudentStatus)('status').notNull().default('pending'),
    accessLevel: (0, exports.advisorStudentAccess)('access_level')
        .notNull()
        .default('report_only'),
    inviteCodeUsed: (0, pg_core_1.text)('invite_code_used'),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
