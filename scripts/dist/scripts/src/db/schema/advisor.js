"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.advisor = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const account_1 = require("./account");
/**
 * Advisor profile, one-to-one with account (spec sections 2, 12).
 * Panel details live here; access to student data is granted only
 * via advisor_student rows with explicit student consent.
 */
exports.advisor = (0, pg_core_1.pgTable)('advisor', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    accountId: (0, pg_core_1.uuid)('account_id')
        .notNull()
        .unique()
        .references(() => account_1.account.id, { onDelete: 'cascade' }),
    displayName: (0, pg_core_1.text)('display_name'),
    inviteCode: (0, pg_core_1.text)('invite_code').notNull().unique(),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
