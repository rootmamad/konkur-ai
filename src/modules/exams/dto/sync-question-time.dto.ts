import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

export class SyncQuestionTimeDto {
  @ApiProperty({ example: 0, minimum: 0 })
  @IsInt()
  @Min(0)
  questionIndex: number;

  /**
   * Cumulative active seconds spent on this question (spec 8). Absolute, not a
   * delta, so a repeated periodic report — or one followed by the answer
   * submission — cannot double-count.
   */
  @ApiProperty({
    example: 42,
    minimum: 0,
    description: 'Cumulative active seconds on this question (absolute)',
  })
  @IsInt()
  @Min(0)
  activeSeconds: number;
}
