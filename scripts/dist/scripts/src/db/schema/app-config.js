"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.appConfig = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
/**
 * Central versioned settings (spec section 10).
 * Every quota/price/cap value the backend enforces lives here.
 * The frontend fetches effective values from the API and keeps
 * no independent numbers. New version row per change, never
 * an in-place edit of the active row.
 */
exports.appConfig = (0, pg_core_1.pgTable)('app_config', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    version: (0, pg_core_1.integer)('version').notNull().unique(),
    isActive: (0, pg_core_1.boolean)('is_active').notNull().default(false),
    quotas: (0, pg_core_1.jsonb)('quotas').notNull().default({}),
    notes: (0, pg_core_1.text)('notes'),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
