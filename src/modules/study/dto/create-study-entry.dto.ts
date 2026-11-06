import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { studyActivity, studyFeeling } from '../../../db/schema/study';

export type StudyActivity = (typeof studyActivity.enumValues)[number];
export type StudyFeeling = (typeof studyFeeling.enumValues)[number];

/**
 * Short-form study entry (spec section 3.6). The full interactive planner is
 * out of MVP scope, so this form is the only way a student records studying.
 *
 * `source` is deliberately absent: it is set server-side (`form` here,
 * `repeat_yesterday` for the repeat endpoint) so a client can never forge the
 * provenance of an entry.
 */
export class CreateStudyEntryDto {
  @ApiProperty({ example: 'ریاضی دوازدهم — مشتق', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  lesson: string;

  @ApiProperty({ enum: studyActivity.enumValues, example: 'learning' })
  @IsIn(studyActivity.enumValues)
  activity: StudyActivity;

  @ApiProperty({ example: 45, minimum: 1, maximum: 600 })
  @IsInt()
  @Min(1)
  @Max(600)
  minutes: number;

  @ApiProperty({ example: 'قاعده زنجیره‌ای', required: false, maxLength: 200 })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  topic?: string;

  @ApiProperty({ example: 12, minimum: 0, maximum: 10000, required: false })
  @IsInt()
  @IsOptional()
  @Min(0)
  @Max(10000)
  exerciseCount?: number;

  @ApiProperty({ enum: studyFeeling.enumValues, required: false })
  @IsIn(studyFeeling.enumValues)
  @IsOptional()
  feeling?: StudyFeeling;

  @ApiProperty({
    example: 'تمرین ۳ را نتوانستم',
    required: false,
    maxLength: 1000,
  })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  note?: string;

  @ApiProperty({
    example: '2026-01-05T09:30:00.000Z',
    description: 'ISO-8601; clamped to now when in the future',
    required: false,
  })
  @IsISO8601()
  @IsOptional()
  doneAt?: string;
}
