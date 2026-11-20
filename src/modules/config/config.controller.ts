import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';

import { ConfigService } from './config.service';
import { EffectiveConfigDto } from './dto/effective-config.dto';

/**
 * Public configuration endpoint (spec §10, §13.4).
 * Returns the active app_config row — the single source of truth
 * for all quotas, caps, and limits. No JWT anywhere: the caller is
 * an anonymous frontend that needs the effective numbers to render
 * limits and validation. Abuse is bounded by the throttler, like
 * the landing page public routes.
 */
@ApiTags('config')
@Controller('config')
export class ConfigController {
  constructor(private readonly configService: ConfigService) {}

  @Get('effective')
  @UseGuards(ThrottlerGuard)
  @ApiOperation({
    summary: 'Get effective configuration (active app_config row)',
  })
  async getEffective(): Promise<EffectiveConfigDto> {
    return this.configService.getEffective();
  }
}
