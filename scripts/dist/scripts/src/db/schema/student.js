"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.student = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const account_1 = require("./account");
/**
 * Student profile, one-to-one with account (spec sections 2, 12).
 * Holds invite code, gamification counters (XP only, no public
 * ranking per spec section 1.2) and onboarding goal fields.
 */
exports.student = (0, pg_core_1.pgTable)('student', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    accountId: (0, pg_core_1.uuid)('account_id')
        .notNull()
        .unique()
        .references(() => account_1.account.id, { onDelete: 'cascade' }),
    inviteCode: (0, pg_core_1.text)('invite_code').notNull().unique(),
    major: (0, pg_core_1.text)('major'),
    grade: (0, pg_core_1.text)('grade'),
    targetYear: (0, pg_core_1.integer)('target_year'),
    xp: (0, pg_core_1.integer)('xp').notNull().default(0),
    level: (0, pg_core_1.integer)('level').notNull().default(1),
    streak: (0, pg_core_1.integer)('streak').notNull().default(0),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
