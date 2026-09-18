import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min,IsDefined } from 'class-validator';

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
}