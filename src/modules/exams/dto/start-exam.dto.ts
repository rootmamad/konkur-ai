import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsInt, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { QuestionType } from '../../questions/schemas/question.schema';

export class CountsDto {
  @ApiProperty({ example: 2, description: 'Number of easy questions', minimum: 0 })
  @IsInt()
  @Min(0)
  easy: number;

  @ApiProperty({ example: 1, description: 'Number of normal questions', minimum: 0 })
  @IsInt()
  @Min(0)
  normal: number;

  @ApiProperty({ example: 1, description: 'Number of hard questions', minimum: 0 })
  @IsInt()
  @Min(0)
  hard: number;
}

export class StartExamDto {
  @ApiProperty({
    enum: QuestionType,
    example: QuestionType.MULTIPLE_CHOICE,
    description: 'multiple_choice or text_answer',
  })
  @IsEnum(QuestionType)
  questionType: QuestionType;

  @ApiProperty({ type: CountsDto })
  @ValidateNested()
  @Type(() => CountsDto)
  counts: CountsDto;

  @ApiProperty({ example: 600, description: 'Duration in seconds' })
  @IsInt()
  @Min(1)
  durationSeconds: number;
}