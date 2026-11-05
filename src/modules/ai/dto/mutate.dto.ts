import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class MutateQuestionDto {
  @ApiProperty({
    description: 'UUID of the source question to mutate',
    example: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  })
  @IsUUID()
  questionId: string;
}
