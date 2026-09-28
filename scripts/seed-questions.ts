/**
 * DISABLED — the old Mongoose seed cannot run: Mongoose is removed.
 * The rewrite step will add a Drizzle-based seed against
 * question + answer_key + explanation tables.
 * This stub keeps `nest build` (which compiles scripts/) green.
 */
async function seed(): Promise<void> {
  throw new Error('Seed is disabled until the Postgres rewrite lands');
}

seed().catch((err) => {
  console.error('Seed disabled:', (err as Error).message);
  process.exit(1);
});
