import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DB } from '../db/db.module';
import type { Db } from '../db/db.module';

/**
 * Liveness probes. /health/db runs SELECT 1 to prove the
 * Postgres connection from step 1 works end to end.
 */
@Controller('health')
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  check() {
    return { status: 'ok' };
  }

  @Get('db')
  async checkDb() {
    await this.db.execute(sql`SELECT 1`);
    return { status: 'ok', database: 'reachable' };
  }
}
