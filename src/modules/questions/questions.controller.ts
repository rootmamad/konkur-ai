import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { QuestionAudience, QuestionsService } from './questions.service';
import { ExplanationService } from './explanation.service';
import type { ExplanationViewer } from './explanation.service';
import { CreateQuestionDto, UpdateQuestionDto } from './dto/question.dto';
import {
  QuestionListQueryDto,
  RandomQuestionsQueryDto,
  UpdateQuestionStatusDto,
} from './dto/question-query.dto';

const audienceOf = (user: AuthenticatedUser): QuestionAudience =>
  user.role === UserRole.ADMIN ? 'admin' : 'student';

const viewerOf = (user: AuthenticatedUser): ExplanationViewer => ({
  role: user.role,
  userId: user.userId,
});

@ApiTags('questions')
@ApiBearerAuth('access-token')
@Controller('questions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class QuestionsController {
  private readonly logger = new Logger(QuestionsController.name);

  constructor(
    private readonly questionsService: QuestionsService,
    private readonly explanationService: ExplanationService,
  ) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.STUDENT)
  getQuestions(
    @Query() query: QuestionListQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.questionsService.getQuestions(query, audienceOf(user));
  }

  @Get('random')
  @Roles(UserRole.ADMIN, UserRole.STUDENT)
  getRandomQuestions(
    @Query() query: RandomQuestionsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.questionsService.getRandomQuestions(query, audienceOf(user));
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.STUDENT)
  getQuestionById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.questionsService.getQuestionById(id, audienceOf(user));
  }

  @Get(':id/explanation')
  @Roles(UserRole.ADMIN, UserRole.STUDENT)
  @ApiOperation({
    summary: 'Read the best explanation for a question',
    description:
      'Origins are never merged: official > source_book > ai_generated for the current question version. ' +
      'Spec 13.2: an explanation reveals the answer, so a STUDENT is served one only after a response row ' +
      'exists for this question (i.e. after submitAnswer) and gets 403 before that; ADMIN always reads it.',
  })
  async getExplanation(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const explanation = await this.explanationService.getExplanation(
      id,
      viewerOf(user),
    );
    return {
      explanation: { origin: explanation.origin, body: explanation.body },
    };
  }

  @Post(':id/explanation/generate')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(UserRole.ADMIN, UserRole.STUDENT)
  @ApiOperation({
    summary: 'Queue the one-time AI explanation for a question (cached)',
    description:
      'No-op when an official/source_book note exists or an ai_generated row is already cached for this ' +
      'question version. Same Spec 13.2 gate as reading: a STUDENT can only warm the cache after answering.',
  })
  async generateExplanation(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const viewer = viewerOf(user);
    // Validate before queueing: the §13.2 gate must answer the request itself.
    await this.explanationService.assertCanView(id, viewer);

    void this.explanationService
      .generateExplanation(id, viewer)
      .catch((error: unknown) => {
        this.logger.warn(
          `explanation generation failed for question ${id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });

    return { queued: true };
  }

  @Post()
  @Roles(UserRole.ADMIN)
  createQuestion(@Body() dto: CreateQuestionDto) {
    return this.questionsService.createQuestion(dto);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  updateQuestion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateQuestionDto,
  ) {
    return this.questionsService.updateQuestion(id, dto);
  }

  @Patch(':id/status')
  @Roles(UserRole.ADMIN)
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateQuestionStatusDto,
  ) {
    return this.questionsService.updateStatus(id, dto.status);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  async deleteQuestion(@Param('id', ParseUUIDPipe) id: string) {
    const result = await this.questionsService.deleteQuestion(id);
    return result === 'archived'
      ? { message: 'Question archived: it is used in exam history' }
      : { message: 'Question deleted successfully' };
  }
}
