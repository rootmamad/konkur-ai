import {
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { advisor } from './advisor';
import { student } from './student';

export const advisorStudentStatus = pgEnum('advisor_student_status', [
  'pending',
  'active',
  'revoked',
]);

export const advisorStudentAccess = pgEnum('advisor_student_access', [
  'report_only',
  'full',
]);

/**
 * Many-to-many link between advisors and students (spec sections 2, 12).
 * Revoking access never deletes history rows, it only flips status.
 */
export const advisorStudent = pgTable('advisor_student', {
  id: uuid('id').primaryKey().defaultRandom(),
  advisorId: uuid('advisor_id')
    .notNull()
    .references(() => advisor.id, { onDelete: 'cascade' }),
  studentId: uuid('student_id')
    .notNull()
    .references(() => student.id, { onDelete: 'cascade' }),
  status: advisorStudentStatus('status').notNull().default('pending'),
  accessLevel: advisorStudentAccess('access_level')
    .notNull()
    .default('report_only'),
  inviteCodeUsed: text('invite_code_used'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AdvisorStudent = typeof advisorStudent.$inferSelect;
export type NewAdvisorStudent = typeof advisorStudent.$inferInsert;
