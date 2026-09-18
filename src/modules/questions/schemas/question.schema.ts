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
    type: [String],
    default: undefined,  
    validate: {
      validator: function (this: Question, arr: string[] | undefined) {
        if (this.questionType === QuestionType.TEXT_ANSWER) {
          return !arr || arr.length === 0;
        }
        return Array.isArray(arr) && arr.length === 4;
      },
      message: 'Multiple choice questions must have exactly 4 options',
    },
  })
  options?: string[];

  @Prop({
    min: 0,
    max: 3,
    required: function (this: Question) {
      return this.questionType === QuestionType.MULTIPLE_CHOICE;
    },
  })
  correctOptionIndex?: number;

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
  difficulty: number;

  @Prop({
    trim: true,
  })
  explanation: string;

  @Prop({
    required: true,
    enum: QuestionType,
  })
  questionType: QuestionType;
}

export const QuestionSchema = SchemaFactory.createForClass(Question);