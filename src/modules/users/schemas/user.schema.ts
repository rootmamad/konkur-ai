/**
 * REMOVED — Mongoose is gone. Identity now lives in Drizzle tables:
 * account + student (+ advisor). See src/db/schema/.
 * This file stays only to fail loudly if anything still imports it.
 */
throw new Error('user.schema.ts was removed with the Mongoose migration');
