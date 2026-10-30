import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { QuestionAudience, QuestionsService } from './questions.service';
import { CreateQuestionDto, UpdateQuestionDto } from './dto/question.dto';
import {
  QuestionListQueryDto,
  RandomQuestionsQueryDto,
  UpdateQuestionStatusDto,
} from './dto/question-query.dto';

const audienceOf = (user: AuthenticatedUser): QuestionAudience =>
  user.role === UserRole.ADMIN ? 'admin' : 'student';

@ApiTags('questions')
@ApiBearerAuth('access-token')
@Controller('questions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class QuestionsController {
  constructor(private readonly questionsService: QuestionsService) {}

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
