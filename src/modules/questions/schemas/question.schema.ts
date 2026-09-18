import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type QuestionDocument = HydratedDocument<Question>;

export enum QuestionType {
  MULTIPLE_CHOICE = 'multiple_choice',
  TEXT_ANSWER = 'text_answer',
}

@Schema({
  timestamps: true,
})
export class Question {
  @Prop({
    required: true,
    trim: true,
  })
  text: string;

  @Prop({
    type: [String], // Array of strings for options (only for multiple choice)
    validate: {
      validator: (arr: string[]) => !arr || arr.length === 4,
      message: 'Options must be exactly 4 elements for multiple choice questions',
    },
  })
  options?: string[];

  @Prop({
    min: 0,
    max: 3,
  })
  correctOptionIndex?: number; // 0-based index of the correct option (only for multiple choice)

  @Prop({
    required: true,
    trim: true,
  })
  subject: string;

  @Prop({
    required: true,
    trim: true,
  })
  topic: string;

  @Prop({
    required: true,
    min: 1,
    max: 5,
  })
  difficulty: number; // 1: easy, 2: medium-low, 3: medium, 4: medium-high, 5: hard

  @Prop({
    trim: true,
  })
  explanation: string; // For interactive answer explanation

  @Prop({
    required: true,
    enum: QuestionType,
  })
  questionType: QuestionType;
}

export const QuestionSchema = SchemaFactory.createForClass(Question);