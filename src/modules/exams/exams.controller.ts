import {
  Controller,
  Post,
  Body,
  Param,
  Get,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ExamsService } from './exams.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../modules/users/enums/user-role.enum';
import { Request } from 'express';
import { QuestionType } from '../questions/schemas/question.schema';

@Controller('exams')
export class ExamsController {
  constructor(private readonly examsService: ExamsService) {}

  // POST /exams/start
  // Body: { questionType: 'multiple_choice' | 'text_answer', counts: { easy: number, normal: number, hard: number }, durationSeconds: number }
  @Post('start')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.STUDENT)
  async startExam(
    @Req() req: Request & { user: { userId: string } },
    @Body()
    body: {
      questionType: QuestionType;
      counts: { easy: number; normal: number; hard: number };
      durationSeconds: number;
    },
  ) {
    const userId = req['user'].userId; // Assuming CurrentUser decorator sets req.user
    return this.examsService.startExam(
      userId,
      body.questionType,
      body.counts,
      body.durationSeconds,
    );
  }

  // POST /exams/:attemptId/answers
  // Body: { questionIndex: number, answer: number | string }
  @Post(':attemptId/answers')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.STUDENT)
  async submitAnswer(
    @Param('attemptId') attemptId: string,
    @Req() req: Request & { user: { userId: string } },
    @Body()
    body: { questionIndex: number; answer: number | string },
  ) {
    const userId = req['user'].userId;
    await this.examsService.submitAnswer(
      attemptId,
      userId,
      body.questionIndex,
      body.answer,
    );
    return { message: 'Answer submitted successfully' };
  }

  // POST /exams/:attemptId/finish
  @Post(':attemptId/finish')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.STUDENT)
  async finishExam(
    @Param('attemptId') attemptId: string,
    @Req() req: Request & { user: { userId: string } },
  ) {
    const userId = req['user'].userId;
    return this.examsService.finishExam(attemptId, userId);
  }

  // GET /exams/:attemptId
  @Get(':attemptId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.STUDENT)
  async getExamAttempt(
    @Param('attemptId') attemptId: string,
    @Req() req: Request & { user: { userId: string } },
  ) {
    const userId = req['user'].userId;
    return this.examsService.getExamAttempt(attemptId, userId);
  }

  // GET /exams
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.STUDENT)
  async getUserExams(@Req() req: Request & { user: { userId: string } }) {
    const userId = req['user'].userId;
    return this.examsService.getUserExams(userId);
  }
}