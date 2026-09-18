import {
  Controller, Post, Body, Param, Get, UseGuards, Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { ExamsService } from './exams.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../modules/users/enums/user-role.enum';
import { Request } from 'express';
import { StartExamDto } from './dto/start-exam.dto';
import { SubmitAnswerDto } from './dto/submit-answer.dto';

@ApiTags('exams')
@ApiBearerAuth('access-token')
@Controller('exams')
export class ExamsController {
  constructor(private readonly examsService: ExamsService) {}

  @Post('start')
  @ApiOperation({ summary: 'Start a new exam attempt' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.STUDENT)
  async startExam(
    @Req() req: Request & { user: { userId: string } },
    @Body() body: StartExamDto,
  ) {
    const userId = req.user.userId;
    return this.examsService.startExam(
      userId,
      body.questionType,
      body.counts,
      body.durationSeconds,
    );
  }

  @Post(':attemptId/answers')
  @ApiOperation({ summary: 'Submit an answer to a question' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.STUDENT)
  async submitAnswer(
    @Param('attemptId') attemptId: string,
    @Req() req: Request & { user: { userId: string } },
    @Body() body: SubmitAnswerDto,
  ) {
    const userId = req.user.userId;
    await this.examsService.submitAnswer(
      attemptId,
      userId,
      body.questionIndex,
      body.answer,
    );
    return { message: 'Answer submitted successfully' };
  }

  @Post(':attemptId/finish')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.STUDENT)
  async finishExam(
    @Param('attemptId') attemptId: string,
    @Req() req: Request & { user: { userId: string } },
  ) {
    return this.examsService.finishExam(attemptId, req.user.userId);
  }

  @Get(':attemptId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.STUDENT)
  async getExamAttempt(
    @Param('attemptId') attemptId: string,
    @Req() req: Request & { user: { userId: string } },
  ) {
    return this.examsService.getExamAttempt(attemptId, req.user.userId);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.STUDENT)
  async getUserExams(@Req() req: Request & { user: { userId: string } }) {
    return this.examsService.getUserExams(req.user.userId);
  }
}