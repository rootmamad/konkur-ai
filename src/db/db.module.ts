import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema';

export const DB = 'DB';
export type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Global Drizzle/Postgres connection (migration step 1).
 * Reads DATABASE_URL only; SSL stays off for local dev and is
 * enabled for hosted deploys (e.g. Cloudflare) via DB_SSL=true.
 * Fail-fast on missing URL so misconfiguration never boots silently.
 */
@Global()
@Module({
  providers: [
    {
      provide: DB,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.getOrThrow<string>('DATABASE_URL');
        const ssl = config.get<string>('DB_SSL') === 'true';
        const client = postgres(url, ssl ? { ssl: 'require' } : {});
        return drizzle(client, { schema });
      },
    },
  ],
  exports: [DB],
})
export class DbModule {}
