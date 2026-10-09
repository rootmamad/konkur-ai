import { BadRequestException, Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { isUUID } from 'class-validator';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { ExamsService } from './exams.service';
import { StartExamDto } from './dto/start-exam.dto';
import { SubmitAnswerDto } from './dto/submit-answer.dto';

@ApiTags('exams')
@ApiBearerAuth('access-token')
@Controller('exams')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.STUDENT)
export class ExamsController {
  constructor(private readonly examsService: ExamsService) {}

  @Post('start')
  @ApiOperation({ summary: 'Start (or safely retry starting) an exam attempt' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Client-generated UUID, reused on retries of the same start' })
  startExam(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: StartExamDto,
  ) {
    if (!idempotencyKey || !isUUID(idempotencyKey)) {
      throw new BadRequestException('Idempotency-Key header must be a UUID');
    }
    return this.examsService.startExam(user.userId, body, idempotencyKey);
  }

  @Post(':attemptId/answers')
  @ApiOperation({ summary: 'Save (or overwrite) the answer to one question' })
  async submitAnswer(
    @Param('attemptId', ParseUUIDPipe) attemptId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SubmitAnswerDto,
  ) {
    await this.examsService.submitAnswer(attemptId, user.userId, body.questionIndex, body.answer);
    return { message: 'Answer saved' };
  }

  @Post(':attemptId/finish')
  finishExam(@Param('attemptId', ParseUUIDPipe) attemptId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.examsService.finishExam(attemptId, user.userId);
  }

  @Get(':attemptId')
  getExamAttempt(@Param('attemptId', ParseUUIDPipe) attemptId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.examsService.getExamAttempt(attemptId, user.userId);
  }

  @Get()
  getUserExams(@CurrentUser() user: AuthenticatedUser) {
    return this.examsService.getUserExams(user.userId);
  }
}
