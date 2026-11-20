import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsObject, IsOptional, IsString } from 'class-validator';

export class EffectiveConfigDto {
  @ApiProperty({ example: 5 })
  @IsNumber()
  version: number;

  @ApiProperty({
    example: { free_quiz_weekly: 3, free_quiz_max_questions: 10 },
  })
  @IsObject()
  quotas: Record<string, unknown>;

  @ApiProperty({ example: 'Updated free quiz limits', required: false })
  @IsOptional()
  @IsString()
  notes?: string;
}
