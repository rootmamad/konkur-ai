import {
  boolean,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Identity root (spec section 2, 12).
 * Exactly one row per human. Roles (student, advisor, admin)
 * are attached to this row, never in a separate admin table.
 * Login with national code is dev-only for now (spec section 2).
 */
export const account = pgTable('account', {
  id: uuid('id').primaryKey().defaultRandom(),
  mobile: text('mobile').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  firstName: text('first_name').notNull().default(''),
  lastName: text('last_name').notNull().default(''),
  isAdmin: boolean('is_admin').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Account = typeof account.$inferSelect;
export type NewAccount = typeof account.$inferInsert;
