/**
 * REMOVED — Mongoose is gone. Attempts now live in Drizzle tables:
 * exam_template + exam_instance + attempt + response + correction.
 * See src/db/schema/. This file stays only to fail loudly if
 * anything still imports it.
 */
throw new Error('exam-attempt.schema.ts was removed with the Mongoose migration');
