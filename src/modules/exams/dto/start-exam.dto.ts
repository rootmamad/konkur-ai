import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { QuestionType } from '../../questions/enums/question-type.enum';
import { examTemplateKind } from '../../../db/schema/exam';
import {
  MAX_EXAM_DURATION_SECONDS,
  MAX_QUESTIONS_PER_EXAM,
} from '../exam.constants';

export type ExamKind = (typeof examTemplateKind.enumValues)[number];

export class CountsDto {
  @ApiProperty({ example: 2, minimum: 0, maximum: MAX_QUESTIONS_PER_EXAM })
  @IsInt()
  @Min(0)
  @Max(MAX_QUESTIONS_PER_EXAM)
  easy: number;

  @ApiProperty({ example: 1, minimum: 0, maximum: MAX_QUESTIONS_PER_EXAM })
  @IsInt()
  @Min(0)
  @Max(MAX_QUESTIONS_PER_EXAM)
  normal: number;

  @ApiProperty({ example: 1, minimum: 0, maximum: MAX_QUESTIONS_PER_EXAM })
  @IsInt()
  @Min(0)
  @Max(MAX_QUESTIONS_PER_EXAM)
  hard: number;
}

export class StartExamDto {
  @ApiProperty({ enum: QuestionType, example: QuestionType.MULTIPLE_CHOICE })
  @IsEnum(QuestionType)
  questionType: QuestionType;

  @ApiProperty({ enum: examTemplateKind.enumValues, example: 'general_prep' })
  @IsEnum(examTemplateKind)
  kind: ExamKind;

  @ApiProperty({ type: CountsDto, required: false })
  @ValidateNested()
  @Type(() => CountsDto)
  @IsOptional()
  counts?: CountsDto;

  @ApiProperty({
    example: 600,
    maximum: MAX_EXAM_DURATION_SECONDS,
    required: false,
  })
  @IsInt()
  @Min(60)
  @Max(MAX_EXAM_DURATION_SECONDS)
  @IsOptional()
  durationSeconds?: number;

  /**
   * Studied topic for `quiz_after_study` (spec §5: the quiz must cover the
   * main concepts of the chosen topic). Required for that kind only; ignored
   * by every other quiz kind.
   */
  @ApiProperty({
    example: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    description: 'Required for quiz_after_study; ignored by other kinds',
    required: false,
  })
  @IsUUID()
  @IsOptional()
  topicId?: string;

  /**
   * Selected topics for `general_prep` (spec §5: balanced coverage of the
   * chosen topics). Questions are split evenly across these topics per
   * difficulty bucket; empty/omitted keeps the random-across-all-topics
   * behaviour. Ignored by every other quiz kind.
   */
  @ApiProperty({
    type: [String],
    example: ['3fa85f64-5717-4562-b3fc-2c963f66afa6'],
    description:
      'Balanced-coverage topics for general_prep; ignored by other kinds',
    required: false,
  })
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  topicIds?: string[];
}
