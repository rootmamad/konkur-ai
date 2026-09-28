"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.studyPlanItem = exports.studyPlanStatus = exports.studyLog = exports.studyFeeling = exports.studyActivity = exports.studyLogStatus = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const student_1 = require("./student");
exports.studyLogStatus = (0, pg_core_1.pgEnum)('study_log_status', [
    'pending',
    'summarized',
]);
exports.studyActivity = (0, pg_core_1.pgEnum)('study_activity', [
    'learning',
    'exercise',
    'test',
    'review',
    'teaching',
]);
exports.studyFeeling = (0, pg_core_1.pgEnum)('study_feeling', [
    'clear',
    'vague',
]);
/**
 * Study entries from form, chat confirm or repeat-yesterday
 * (spec sections 3.6, 12). Rows stay pending until the weekly
 * summary consumes them, then flip to summarized so they are
 * never analysed twice. A vague feeling routes the next
 * suggestion to concept review, never to a test quiz.
 */
exports.studyLog = (0, pg_core_1.pgTable)('study_log', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    studentId: (0, pg_core_1.uuid)('student_id')
        .notNull()
        .references(() => student_1.student.id, { onDelete: 'cascade' }),
    lesson: (0, pg_core_1.text)('lesson').notNull(),
    topic: (0, pg_core_1.text)('topic'),
    activity: (0, exports.studyActivity)('activity'),
    minutes: (0, pg_core_1.integer)('minutes').notNull(),
    doneAt: (0, pg_core_1.timestamp)('done_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    exerciseCount: (0, pg_core_1.integer)('exercise_count'),
    result: (0, pg_core_1.text)('result'),
    source: (0, pg_core_1.text)('source'),
    feeling: (0, exports.studyFeeling)('feeling'),
    note: (0, pg_core_1.text)('note'),
    status: (0, exports.studyLogStatus)('status').notNull().default('pending'),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
exports.studyPlanStatus = (0, pg_core_1.pgEnum)('study_plan_status', [
    'todo',
    'done',
    'skipped',
]);
/**
 * Items of the suggested template plan (spec section 12).
 * The full interactive planner is out of MVP scope.
 */
exports.studyPlanItem = (0, pg_core_1.pgTable)('study_plan_item', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    studentId: (0, pg_core_1.uuid)('student_id')
        .notNull()
        .references(() => student_1.student.id, { onDelete: 'cascade' }),
    title: (0, pg_core_1.text)('title').notNull(),
    status: (0, exports.studyPlanStatus)('status').notNull().default('todo'),
    dueAt: (0, pg_core_1.timestamp)('due_at', { withTimezone: true }),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
