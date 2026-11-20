import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
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
import { CreateStudyEntryDto } from './dto/create-study-entry.dto';
import { ExtractPreviewDto } from './dto/extract-preview.dto';
import { StudyExtractService } from './study-extract.service';
import {
  MAX_RECENT_LIMIT,
  StudyService,
  resolveWeekStart,
} from './study.service';
import { WeekSummaryService } from './week-summary.service';

@ApiTags('study')
@ApiBearerAuth('access-token')
@Controller('study')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.STUDENT)
export class StudyController {
  private readonly logger = new Logger(StudyController.name);

  constructor(
    private readonly studyService: StudyService,
    private readonly weekSummaryService: WeekSummaryService,
    private readonly studyExtractService: StudyExtractService,
  ) {}

  @Post('entries')
  @ApiOperation({ summary: 'Log a study entry from the short form' })
  createEntry(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateStudyEntryDto,
  ) {
    return this.studyService.createStudyEntry(user.userId, body);
  }

  // Throttled for abuse only; deliberately NOT the chat quota — spec §10
  // names only coach + floating chat for message quotas.
  @Post('extract-preview')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @ApiOperation({
    summary:
      'Extract a one-line study-entry preview from free text (nothing is saved)',
  })
  extractPreview(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ExtractPreviewDto,
  ) {
    return this.studyExtractService.extractPreview(user.userId, body.text);
  }

  @Post('entries/from-chat')
  @ApiOperation({
    summary: "Confirm and store the extracted entry (source 'chat')",
  })
  createEntryFromChat(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateStudyEntryDto,
  ) {
    return this.studyService.createStudyEntryFromChat(user.userId, body);
  }

  @Post('entries/repeat-yesterday')
  @ApiOperation({ summary: "Repeat yesterday's latest study entry" })
  repeatYesterday(@CurrentUser() user: AuthenticatedUser) {
    return this.studyService.repeatYesterday(user.userId);
  }

  @Get('entries')
  @ApiOperation({ summary: 'List the most recent study entries' })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: `How many entries to return (max ${MAX_RECENT_LIMIT})`,
  })
  getRecent(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
  ) {
    return this.studyService.getRecent(
      user.userId,
      limit === undefined ? undefined : parseLimit(limit),
    );
  }

  @Get('summary/week')
  @ApiOperation({ summary: 'Aggregate one ISO week of study entries' })
  @ApiQuery({
    name: 'weekStart',
    required: false,
    description:
      'ISO date of the week start; defaults to Monday of the current ISO week',
  })
  getWeekSummary(
    @CurrentUser() user: AuthenticatedUser,
    @Query('weekStart') weekStart?: string,
  ) {
    return this.studyService.getWeekSummary(user.userId, weekStart);
  }

  @Post('summarize-week')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Queue the AI weekly summary and consume the week's entries",
  })
  @ApiQuery({
    name: 'weekStart',
    required: false,
    description:
      'ISO date of the week start; defaults to Monday of the current ISO week',
  })
  summarizeWeek(
    @CurrentUser() user: AuthenticatedUser,
    @Query('weekStart') weekStart?: string,
  ) {
    // Validate before queueing: a bad weekStart must be a 400 on the request,
    // not just a logged failure inside the background job.
    const start = resolveWeekStart(weekStart);

    void this.weekSummaryService
      .generateWeekSummary(user.userId, start)
      .catch((error: unknown) => {
        this.logger.warn(
          `weekly summary failed for user ${user.userId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });

    return { queued: true };
  }

  @Get('summaries/latest')
  @ApiOperation({ summary: 'Latest AI weekly summary from the coach thread' })
  async getLatestWeekSummary(@CurrentUser() user: AuthenticatedUser) {
    const latest = await this.weekSummaryService.getLatestWeekSummary(
      user.userId,
    );
    return { summary: { at: latest.at, text: latest.summary } };
  }
}

function parseLimit(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BadRequestException('limit must be a positive integer');
  }
  return parsed;
}
