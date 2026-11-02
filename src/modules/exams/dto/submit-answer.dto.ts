import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min, IsDefined, IsOptional } from 'class-validator';

export class SubmitAnswerDto {
  @ApiProperty({ example: 0, minimum: 0 })
  @IsInt()
  @Min(0)
  questionIndex: number;

  @ApiProperty({
    example: 2,
    description: 'Option index (0-3) for MCQ, or text for text-answer question',
  })
  @IsDefined()
  answer: number | string;

  /**
   * Cumulative active seconds spent on this question (spec 8). Absolute, not a
   * delta, so a retried submission cannot double-count; written to
   * response.active_seconds and defaults to 0 when the client sends nothing.
   */
  @ApiProperty({
    example: 42,
    minimum: 0,
    description: 'Cumulative active seconds on this question (absolute)',
    required: false,
  })
  @IsInt()
  @Min(0)
  @IsOptional()
  activeSeconds?: number;
}
