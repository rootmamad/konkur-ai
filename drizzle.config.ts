import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit reads DATABASE_URL from the environment.
 * Provide it inline when running: DATABASE_URL=... npm run db:generate
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
