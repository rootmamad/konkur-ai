import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Standalone migration runner: `npm run db:migrate`.
 * Uses its own short-lived client; never imports Nest code
 * so migrations stay runnable in CI without app bootstrap.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }
  const client = postgres(url, { max: 1 });
  await migrate(drizzle(client), { migrationsFolder: './drizzle' });
  await client.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
