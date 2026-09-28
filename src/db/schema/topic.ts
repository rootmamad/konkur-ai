import {
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Topic tree for the question bank (spec sections 4, 12).
 * Self-referencing parent keeps the hierarchy; tagging uses only
 * controlled-list values enforced at the application layer.
 */
export const topic = pgTable('topic', {
  id: uuid('id').primaryKey().defaultRandom(),
  parentId: uuid('parent_id'),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Topic = typeof topic.$inferSelect;
export type NewTopic = typeof topic.$inferInsert;
