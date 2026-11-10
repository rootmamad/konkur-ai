import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { account } from './account';

/**
 * Student profile, one-to-one with account (spec sections 2, 12).
 * Holds invite code, gamification counters (XP only, no public
 * ranking per spec section 1.2) and onboarding goal fields.
 * studiedTopicIds is the self-reported studied-topic list from
 * onboarding (spec section 3.2), consumed by the diagnostic (3.3).
 */
export const student = pgTable('student', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id')
    .notNull()
    .unique()
    .references(() => account.id, { onDelete: 'cascade' }),
  inviteCode: text('invite_code').notNull().unique(),
  major: text('major'),
  grade: text('grade'),
  targetYear: integer('target_year'),
  xp: integer('xp').notNull().default(0),
  level: integer('level').notNull().default(1),
  streak: integer('streak').notNull().default(0),
  studiedTopicIds: text('studied_topic_ids').array().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Student = typeof student.$inferSelect;
export type NewStudent = typeof student.$inferInsert;
