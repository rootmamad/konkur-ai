import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class RecommendedKindDto {
  @ApiProperty({ example: 'diagnostic' })
  @IsString()
  kind: string;

  @ApiProperty({ example: 'Diagnostic' })
  @IsString()
  title: string;

  @ApiProperty({ example: 10, minimum: 0 })
  @IsInt()
  @Min(0)
  questionCount: number;

  @ApiProperty({ example: 900, minimum: 0 })
  @IsInt()
  @Min(0)
  durationSeconds: number;

  @ApiProperty({ example: 'Newcomer: no history yet' })
  @IsString()
  reason: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  newcomer: boolean;
}

export class AlternativeKindDto {
  @ApiProperty({ example: 'smart_mix' })
  @IsString()
  kind: string;

  @ApiProperty({ example: 'Smart Mix' })
  @IsString()
  title: string;

  @ApiProperty({ example: 900, minimum: 0 })
  @IsInt()
  @Min(0)
  durationSeconds: number;

  @ApiProperty({ example: { easy: 2, normal: 1, hard: 0 } })
  @IsObject()
  counts: { easy: number; normal: number; hard: number };
}

export class RecommendationDto {
  @ApiProperty({ type: RecommendedKindDto })
  @ValidateNested()
  @Type(() => RecommendedKindDto)
  @IsObject()
  recommended: RecommendedKindDto;

  @ApiProperty({ type: [AlternativeKindDto] })
  @ValidateNested({ each: true })
  @Type(() => AlternativeKindDto)
  @IsObject({ each: true })
  alternatives: AlternativeKindDto[];
}
