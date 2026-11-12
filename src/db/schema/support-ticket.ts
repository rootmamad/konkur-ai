import { pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Support inbox (spec section 3.8). A ticket is deliberately NOT linked to an
 * account: anyone may file one from the public form, `contact` is free text
 * (email or phone) and nothing is sent by email — the admin reads the list.
 */
export const ticketStatus = pgEnum('ticket_status', ['open', 'resolved']);

export const supportTicket = pgTable('support_ticket', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Submitter display name, 1..100. */
  name: text('name').notNull(),
  /** Free-text reachability, 1..100: an email address or a phone number. */
  contact: text('contact').notNull(),
  /** Ticket body, 1..2000. */
  message: text('message').notNull(),
  status: ticketStatus('status').notNull().default('open'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type SupportTicket = typeof supportTicket.$inferSelect;
export type NewSupportTicket = typeof supportTicket.$inferInsert;
