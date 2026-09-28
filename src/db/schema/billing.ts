import {
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { student } from './student';

export const subscriptionPlan = pgEnum('subscription_plan', [
  'free',
  'full',
  'advisor',
]);

export const referralStage = pgEnum('referral_stage', [
  'registered',
  'first_quiz',
  'purchased',
  'expired',
]);

export const creditKind = pgEnum('credit_kind', [
  'invite_reward',
  'purchase_discount',
  'gift_access',
]);

/**
 * Plans, quota consumption, referrals and wallet
 * (spec sections 10, 11, 12). Quota limits live in versioned
 * app_config rows, never as code constants.
 */
export const subscription = pgTable('subscription', {
  id: uuid('id').primaryKey().defaultRandom(),
  studentId: uuid('student_id')
    .notNull()
    .references(() => student.id, { onDelete: 'cascade' }),
  plan: subscriptionPlan('plan').notNull().default('free'),
  startedAt: timestamp('started_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
});

export const quotaUsage = pgTable('quota_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  studentId: uuid('student_id')
    .notNull()
    .references(() => student.id, { onDelete: 'cascade' }),
  operation: text('operation').notNull(),
  amount: integer('amount').notNull().default(1),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const referral = pgTable('referral', {
  id: uuid('id').primaryKey().defaultRandom(),
  inviterStudentId: uuid('inviter_student_id').references(
    () => student.id,
  ),
  inviteeStudentId: uuid('invitee_student_id').references(
    () => student.id,
  ),
  inviteCodeUsed: text('invite_code_used').notNull(),
  stage: referralStage('stage').notNull().default('registered'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const creditWallet = pgTable('credit_wallet', {
  id: uuid('id').primaryKey().defaultRandom(),
  studentId: uuid('student_id')
    .notNull()
    .unique()
    .references(() => student.id, { onDelete: 'cascade' }),
  balance: numeric('balance', { precision: 12, scale: 2 })
    .notNull()
    .default('0'),
});

export const creditTransaction = pgTable('credit_transaction', {
  id: uuid('id').primaryKey().defaultRandom(),
  walletId: uuid('wallet_id')
    .notNull()
    .references(() => creditWallet.id, { onDelete: 'cascade' }),
  kind: creditKind('kind').notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Subscription = typeof subscription.$inferSelect;
export type NewSubscription = typeof subscription.$inferInsert;
export type QuotaUsage = typeof quotaUsage.$inferSelect;
export type NewQuotaUsage = typeof quotaUsage.$inferInsert;
export type Referral = typeof referral.$inferSelect;
export type NewReferral = typeof referral.$inferInsert;
export type CreditWallet = typeof creditWallet.$inferSelect;
export type NewCreditWallet = typeof creditWallet.$inferInsert;
export type CreditTransaction = typeof creditTransaction.$inferSelect;
export type NewCreditTransaction = typeof creditTransaction.$inferInsert;
