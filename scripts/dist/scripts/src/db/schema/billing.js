"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.creditTransaction = exports.creditWallet = exports.referral = exports.quotaUsage = exports.subscription = exports.creditKind = exports.referralStage = exports.subscriptionPlan = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const student_1 = require("./student");
exports.subscriptionPlan = (0, pg_core_1.pgEnum)('subscription_plan', [
    'free',
    'full',
    'advisor',
]);
exports.referralStage = (0, pg_core_1.pgEnum)('referral_stage', [
    'registered',
    'first_quiz',
    'purchased',
    'expired',
]);
exports.creditKind = (0, pg_core_1.pgEnum)('credit_kind', [
    'invite_reward',
    'purchase_discount',
    'gift_access',
]);
/**
 * Plans, quota consumption, referrals and wallet
 * (spec sections 10, 11, 12). Quota limits live in versioned
 * app_config rows, never as code constants.
 */
exports.subscription = (0, pg_core_1.pgTable)('subscription', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    studentId: (0, pg_core_1.uuid)('student_id')
        .notNull()
        .references(() => student_1.student.id, { onDelete: 'cascade' }),
    plan: (0, exports.subscriptionPlan)('plan').notNull().default('free'),
    startedAt: (0, pg_core_1.timestamp)('started_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    expiresAt: (0, pg_core_1.timestamp)('expires_at', { withTimezone: true }),
});
exports.quotaUsage = (0, pg_core_1.pgTable)('quota_usage', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    studentId: (0, pg_core_1.uuid)('student_id')
        .notNull()
        .references(() => student_1.student.id, { onDelete: 'cascade' }),
    operation: (0, pg_core_1.text)('operation').notNull(),
    amount: (0, pg_core_1.integer)('amount').notNull().default(1),
    windowStart: (0, pg_core_1.timestamp)('window_start', { withTimezone: true }).notNull(),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
exports.referral = (0, pg_core_1.pgTable)('referral', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    inviterStudentId: (0, pg_core_1.uuid)('inviter_student_id').references(() => student_1.student.id),
    inviteeStudentId: (0, pg_core_1.uuid)('invitee_student_id').references(() => student_1.student.id),
    inviteCodeUsed: (0, pg_core_1.text)('invite_code_used').notNull(),
    stage: (0, exports.referralStage)('stage').notNull().default('registered'),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
exports.creditWallet = (0, pg_core_1.pgTable)('credit_wallet', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    studentId: (0, pg_core_1.uuid)('student_id')
        .notNull()
        .unique()
        .references(() => student_1.student.id, { onDelete: 'cascade' }),
    balance: (0, pg_core_1.numeric)('balance', { precision: 12, scale: 2 })
        .notNull()
        .default('0'),
});
exports.creditTransaction = (0, pg_core_1.pgTable)('credit_transaction', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    walletId: (0, pg_core_1.uuid)('wallet_id')
        .notNull()
        .references(() => exports.creditWallet.id, { onDelete: 'cascade' }),
    kind: (0, exports.creditKind)('kind').notNull(),
    amount: (0, pg_core_1.numeric)('amount', { precision: 12, scale: 2 }).notNull(),
    reason: (0, pg_core_1.text)('reason'),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
