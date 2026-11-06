import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import { CreateStudyEntryDto } from './dto/create-study-entry.dto';
import { MAX_RECENT_LIMIT, StudyService } from './study.service';

@ApiTags('study')
@ApiBearerAuth('access-token')
@Controller('study')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.STUDENT)
export class StudyController {
  constructor(private readonly studyService: StudyService) {}

  @Post('entries')
  @ApiOperation({ summary: 'Log a study entry from the short form' })
  createEntry(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateStudyEntryDto,
  ) {
    return this.studyService.createStudyEntry(user.userId, body);
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
}

function parseLimit(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BadRequestException('limit must be a positive integer');
  }
  return parsed;
}
