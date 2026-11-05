import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { QuestionDrafterService } from './question-drafter.service';
import { GenerateDraftsDto } from './dto/generate.dto';
import { MutateQuestionDto } from './dto/mutate.dto';
import { QueryDraftsDto } from './dto/query.dto';

@ApiTags('AI question drafts')
@ApiBearerAuth('access-token')
@Controller('ai')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AIDraftsController {
  constructor(private readonly drafter: QuestionDrafterService) {}

  @Post('drafts/generate')
  @ApiOperation({
    summary: 'Generate AI question drafts for a student',
    description:
      'Builds weak-topic context for the student, calls the model, ' +
      'validates and verifies each draft, then inserts published (verified) ' +
      'or draft (failed verification) questions.',
  })
  generateDrafts(@Body() dto: GenerateDraftsDto) {
    return this.drafter.generateDraftsForStudent(
      dto.studentId,
      dto.maxQuestions,
    );
  }

  @Post('drafts/mutate')
  @ApiOperation({
    summary: 'Create a mutated AI variant of one source question',
  })
  mutateQuestion(@Body() dto: MutateQuestionDto) {
    return this.drafter.mutateQuestion(dto.questionId);
  }

  @Get('drafts')
  @ApiOperation({
    summary: 'List AI-generated draft or published questions',
    description:
      'Returns id, status, topicId, 80-char text prefix, and createdAt.',
  })
  queryDrafts(@Query() dto: QueryDraftsDto) {
    const limit = Math.min(dto.limit ?? 20, 50);
    return this.drafter.queryDrafts(dto.status, limit);
  }
}
