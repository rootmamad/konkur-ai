"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.topic = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
/**
 * Topic tree for the question bank (spec sections 4, 12).
 * Self-referencing parent keeps the hierarchy; tagging uses only
 * controlled-list values enforced at the application layer.
 */
exports.topic = (0, pg_core_1.pgTable)('topic', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    parentId: (0, pg_core_1.uuid)('parent_id'),
    slug: (0, pg_core_1.text)('slug').notNull().unique(),
    title: (0, pg_core_1.text)('title').notNull(),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
