import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class GenerateDraftsDto {
  @ApiProperty({
    description: 'Target student UUID (student profile, not account id)',
    example: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  })
  @IsUUID()
  studentId: string;

  @ApiProperty({
    description: 'Maximum questions to generate (1–20, capped by server at 20)',
    example: 5,
    minimum: 1,
    maximum: 20,
    required: false,
  })
  @IsInt()
  @Min(1)
  @Max(20)
  @IsOptional()
  maxQuestions?: number;
}
