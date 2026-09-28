import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Central versioned settings (spec section 10).
 * Every quota/price/cap value the backend enforces lives here.
 * The frontend fetches effective values from the API and keeps
 * no independent numbers. New version row per change, never
 * an in-place edit of the active row.
 */
export const appConfig = pgTable('app_config', {
  id: uuid('id').primaryKey().defaultRandom(),
  version: integer('version').notNull().unique(),
  isActive: boolean('is_active').notNull().default(false),
  quotas: jsonb('quotas').notNull().default({}),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AppConfig = typeof appConfig.$inferSelect;
export type NewAppConfig = typeof appConfig.$inferInsert;
