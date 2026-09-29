import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { QuestionsService } from './questions.service';
import {
  CreateQuestionDto,
  UpdateQuestionDto,
} from './dto/question.dto';

@Controller('questions')
export class QuestionsController {
  constructor(private readonly questionsService: QuestionsService) {}

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.STUDENT)
  getQuestions(
    @Query() filters: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // Students never receive correct answers (spec section 13.2);
    // admins keep full detail for the review queue.
    const isAdmin = user.role === UserRole.ADMIN;
    return this.questionsService.getQuestions(filters, isAdmin);
  }

  @Get('random')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.STUDENT)
  getRandomQuestions(
    @Query('count') count = 10,
    @Query() filters: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { count: _ignored, ...filterCriteria } = filters;
    const isAdmin = user.role === UserRole.ADMIN;
    return this.questionsService.getRandomQuestions(
      Number(count),
      filterCriteria,
      isAdmin,
    );
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.STUDENT)
  getQuestionById(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const isAdmin = user.role === UserRole.ADMIN;
    return this.questionsService.getQuestionById(id, isAdmin);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  createQuestion(@Body() dto: CreateQuestionDto) {
    return this.questionsService.createQuestion(dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  updateQuestion(@Param('id') id: string, @Body() dto: UpdateQuestionDto) {
    return this.questionsService.updateQuestion(id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  async deleteQuestion(@Param('id') id: string) {
    // Questions used in an attempt are exam history: they are
    // archived, not deleted. Unused ones delete cleanly.
    const result = await this.questionsService.deleteQuestion(id);
    return result === 'archived'
      ? { message: 'Question archived: it is used in exam history' }
      : { message: 'Question deleted successfully' };
  }
}
