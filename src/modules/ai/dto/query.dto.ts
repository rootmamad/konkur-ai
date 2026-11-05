import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, Max } from 'class-validator';

export const DraftStatusValues = ['draft', 'published'] as const;
export type DraftStatus = (typeof DraftStatusValues)[number];

export class QueryDraftsDto {
  @ApiProperty({
    description: 'Filter by question status',
    enum: DraftStatusValues,
    example: 'published',
    required: false,
  })
  @IsEnum(DraftStatusValues)
  @IsOptional()
  status?: DraftStatus;

  @ApiProperty({
    description: 'Maximum number of results (≤ 50)',
    example: 20,
    minimum: 1,
    maximum: 50,
    required: false,
  })
  @IsInt()
  @Max(50)
  @IsOptional()
  limit?: number;
}
