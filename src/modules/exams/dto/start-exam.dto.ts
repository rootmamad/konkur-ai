import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsInt, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { QuestionType } from '../../questions/enums/question-type.enum';
import { MAX_EXAM_DURATION_SECONDS, MAX_QUESTIONS_PER_EXAM } from '../exam.constants';

export class CountsDto {
  @ApiProperty({ example: 2, minimum: 0, maximum: MAX_QUESTIONS_PER_EXAM })
  @IsInt() @Min(0) @Max(MAX_QUESTIONS_PER_EXAM)
  easy: number;

  @ApiProperty({ example: 1, minimum: 0, maximum: MAX_QUESTIONS_PER_EXAM })
  @IsInt() @Min(0) @Max(MAX_QUESTIONS_PER_EXAM)
  normal: number;

  @ApiProperty({ example: 1, minimum: 0, maximum: MAX_QUESTIONS_PER_EXAM })
  @IsInt() @Min(0) @Max(MAX_QUESTIONS_PER_EXAM)
  hard: number;
}

export class StartExamDto {
  @ApiProperty({ enum: QuestionType, example: QuestionType.MULTIPLE_CHOICE })
  @IsEnum(QuestionType)
  questionType: QuestionType;

  @ApiProperty({ type: CountsDto })
  @ValidateNested() @Type(() => CountsDto)
  counts: CountsDto;

  @ApiProperty({ example: 600, maximum: MAX_EXAM_DURATION_SECONDS })
  @IsInt() @Min(60) @Max(MAX_EXAM_DURATION_SECONDS)
  durationSeconds: number;
}