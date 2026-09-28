import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

import { QuestionType } from '../enums/question-type.enum';

export class CreateQuestionDto {
  @IsString()
  @IsNotEmpty()
  text: string;

  @IsArray()
  @IsOptional()
  @IsString({ each: true })
  options?: string[];

  @IsInt()
  @Min(0)
  @Max(3)
  @IsOptional()
  correctOptionIndex?: number;

  @IsString()
  @IsNotEmpty()
  subject: string;

  @IsString()
  @IsNotEmpty()
  topic: string;

  @IsInt()
  @Min(1)
  @Max(5)
  difficulty: number;

  @IsString()
  @IsOptional()
  explanation?: string;

  @IsEnum(QuestionType)
  questionType: QuestionType;
}

export class UpdateQuestionDto {
  @IsString()
  @IsOptional()
  text?: string;

  @IsArray()
  @IsOptional()
  @IsString({ each: true })
  options?: string[];

  @IsInt()
  @Min(0)
  @Max(3)
  @IsOptional()
  correctOptionIndex?: number;

  @IsString()
  @IsOptional()
  subject?: string;

  @IsString()
  @IsOptional()
  topic?: string;

  @IsInt()
  @Min(1)
  @Max(5)
  @IsOptional()
  difficulty?: number;

  @IsString()
  @IsOptional()
  explanation?: string;

  @IsEnum(QuestionType)
  @IsOptional()
  questionType?: QuestionType;
}
