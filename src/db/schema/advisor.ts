import {
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { account } from './account';

/**
 * Advisor profile, one-to-one with account (spec sections 2, 12).
 * Panel details live here; access to student data is granted only
 * via advisor_student rows with explicit student consent.
 */
export const advisor = pgTable('advisor', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id')
    .notNull()
    .unique()
    .references(() => account.id, { onDelete: 'cascade' }),
  displayName: text('display_name'),
  inviteCode: text('invite_code').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Advisor = typeof advisor.$inferSelect;
export type NewAdvisor = typeof advisor.$inferInsert;
