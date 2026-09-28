/**
 * REMOVED — Mongoose is gone. Questions now live in Drizzle tables:
 * question + answer_key + explanation + rubric + topic.
 * See src/db/schema/. This file stays only to fail loudly if
 * anything still imports it.
 */
throw new Error('question.schema.ts was removed with the Mongoose migration');
