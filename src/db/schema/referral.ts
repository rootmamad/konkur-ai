import { pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { student } from './student';

/**
 * Invite lifecycle (spec sections 11, 12). The stage progression is a later
 * task: registration only ever writes 'registered'.
 */
export const referralStatus = pgEnum('referral_status', [
  'registered',
  'first_exam',
  'purchased',
  'expired',
]);

/**
 * Referral connection (spec section 12): one row per invited student,
 * recording the inviter and the code that was accepted. inviteeId is unique,
 * so a student can be attributed to exactly one inviter.
 */
export const referral = pgTable('referral', {
  id: uuid('id').primaryKey().defaultRandom(),
  inviterId: uuid('inviter_id')
    .notNull()
    .references(() => student.id, { onDelete: 'cascade' }),
  inviteeId: uuid('invitee_id')
    .notNull()
    .unique()
    .references(() => student.id, { onDelete: 'cascade' }),
  codeUsed: text('code_used').notNull(),
  status: referralStatus('status').notNull().default('registered'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Referral = typeof referral.$inferSelect;
export type NewReferral = typeof referral.$inferInsert;
