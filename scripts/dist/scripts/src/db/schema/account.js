"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.account = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
/**
 * Identity root (spec section 2, 12).
 * Exactly one row per human. Roles (student, advisor, admin)
 * are attached to this row, never in a separate admin table.
 * Login with national code is dev-only for now (spec section 2).
 */
exports.account = (0, pg_core_1.pgTable)('account', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    mobile: (0, pg_core_1.text)('mobile').notNull().unique(),
    passwordHash: (0, pg_core_1.text)('password_hash').notNull(),
    isAdmin: (0, pg_core_1.boolean)('is_admin').notNull().default(false),
    isActive: (0, pg_core_1.boolean)('is_active').notNull().default(true),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
