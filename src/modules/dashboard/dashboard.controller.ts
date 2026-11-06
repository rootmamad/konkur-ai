import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { AnalysisService } from './analysis.service';
import {
  DashboardService,
  MAX_ACTIVITY_LIMIT,
  MAX_TREND_DAYS,
} from './dashboard.service';

@ApiTags('dashboard')
@ApiBearerAuth('access-token')
@Controller('dashboard')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.STUDENT)
export class DashboardController {
  private readonly logger = new Logger(DashboardController.name);

  constructor(
    private readonly dashboardService: DashboardService,
    private readonly analysisService: AnalysisService,
  ) {}

  @Get('summary')
  @ApiOperation({ summary: 'Dashboard head card: counts, quota, next action' })
  getSummary(@CurrentUser() user: AuthenticatedUser) {
    return this.dashboardService.getSummary(user.userId);
  }

  @Get('trend')
  @ApiOperation({ summary: 'Per-day answer/study trend (UTC days)' })
  @ApiQuery({
    name: 'days',
    required: false,
    description: `Number of days to include (default 7, max ${MAX_TREND_DAYS})`,
  })
  getTrend(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
  ) {
    return this.dashboardService.getTrend(
      user.userId,
      days === undefined ? undefined : parsePositiveInt(days, 'days'),
    );
  }

  @Get('activity')
  @ApiOperation({ summary: 'Merged recent activity feed' })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: `How many items to return (max ${MAX_ACTIVITY_LIMIT})`,
  })
  getActivity(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
  ) {
    return this.dashboardService.getActivity(
      user.userId,
      limit === undefined ? undefined : parsePositiveInt(limit, 'limit'),
    );
  }

  @Post('analysis')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Queue the async AI overall analysis (never blocks the client)',
  })
  requestAnalysis(@CurrentUser() user: AuthenticatedUser) {
    // Fire-and-forget: the model call and its persistence must never sit on
    // the request path, so failures are logged instead of propagated.
    void this.analysisService
      .generateOverallAnalysis(user.userId)
      .catch((err: unknown) =>
        this.logger.warn(
          `Overall analysis failed for ${user.userId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    return { queued: true };
  }

  @Get('analysis')
  @ApiOperation({ summary: 'Latest overall analysis (404 when none exists)' })
  async getAnalysis(@CurrentUser() user: AuthenticatedUser) {
    const analysis = await this.analysisService.getLatestAnalysis(user.userId);
    return {
      analysis: {
        at: analysis.at,
        narrative: analysis.narrative,
        emphasis: analysis.emphasis,
      },
    };
  }
}

function parsePositiveInt(raw: string, name: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BadRequestException(`${name} must be a positive integer`);
  }
  return parsed;
}
