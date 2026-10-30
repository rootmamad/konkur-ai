import { ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { questionStatus } from '../../../db/schema/question';
import { QuestionType } from '../enums/question-type.enum';

export const MAX_RANDOM_QUESTIONS = 50;
export type QuestionStatus = (typeof questionStatus.enumValues)[number];

export class QuestionListQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  subject?: string;

  @ApiPropertyOptional({ enum: QuestionType })
  @IsOptional()
  @IsEnum(QuestionType)
  type?: QuestionType;

  /** Admin only; ignored for students (always "published"). */
  @ApiPropertyOptional({ enum: questionStatus.enumValues })
  @IsOptional()
  @IsIn(questionStatus.enumValues)
  status?: QuestionStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  topicId?: string;
}

export class RandomQuestionsQueryDto extends OmitType(QuestionListQueryDto, [
  'status',
] as const) {
  @ApiPropertyOptional({ default: 10, maximum: MAX_RANDOM_QUESTIONS })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_RANDOM_QUESTIONS)
  count: number = 10;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  difficulty?: number;
}

export class UpdateQuestionStatusDto {
  @IsIn(questionStatus.enumValues)
  status: QuestionStatus;
}
