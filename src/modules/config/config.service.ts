import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/db.module';
import { DB } from '../../db/db.module';
import { appConfig } from '../../db/schema/app-config';
import { EffectiveConfigDto } from './dto/effective-config.dto';

@Injectable()
export class ConfigService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Returns the effective (active) configuration row.
   * Throws 404 if no active row exists — this is the documented
   * "no effective config yet" state per spec §10/13.4.
   */
  async getEffective(): Promise<EffectiveConfigDto> {
    const [row] = await this.db
      .select({
        version: appConfig.version,
        quotas: appConfig.quotas,
        notes: appConfig.notes,
      })
      .from(appConfig)
      .where(eq(appConfig.isActive, true))
      .orderBy(desc(appConfig.version))
      .limit(1);

    if (!row) {
      throw new NotFoundException('No effective configuration found');
    }

    return {
      version: row.version,
      quotas: row.quotas as Record<string, unknown>,
      notes: row.notes ?? undefined,
    };
  }
}
