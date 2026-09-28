"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.examInstance = exports.examTemplate = exports.examTemplateKind = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
/**
 * Reusable exam blueprints and frozen built copies
 * (spec sections 3.5, 5, 12).
 * An instance freezes the question order plus the exact
 * settings version used at build time.
 */
exports.examTemplateKind = (0, pg_core_1.pgEnum)('exam_template_kind', [
    'quiz_after_study',
    'debug_errors',
    'due_review',
    'speed',
    'trap_finder',
    'general_prep',
    'smart_mix',
    'diagnostic',
    'konkur_sim',
    'final_sim',
]);
exports.examTemplate = (0, pg_core_1.pgTable)('exam_template', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    kind: (0, exports.examTemplateKind)('kind').notNull(),
    title: (0, pg_core_1.text)('title').notNull(),
    config: (0, pg_core_1.jsonb)('config').notNull().default({}),
    settingsVersion: (0, pg_core_1.integer)('settings_version').notNull().default(1),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
exports.examInstance = (0, pg_core_1.pgTable)('exam_instance', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    templateId: (0, pg_core_1.uuid)('template_id').references(() => exports.examTemplate.id),
    questionOrder: (0, pg_core_1.jsonb)('question_order').notNull().default([]),
    settingsSnapshot: (0, pg_core_1.jsonb)('settings_snapshot').notNull().default({}),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
