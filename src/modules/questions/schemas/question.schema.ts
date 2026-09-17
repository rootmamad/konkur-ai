import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type QuestionDocument = HydratedDocument<Question>;

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
    required: true,
    type: [String], // Array of strings for options
    validate: {
      validator: (arr: string[]) => arr.length === 4, // Assuming 4 options for multiple choice
      message: 'Question must have exactly 4 options',
    },
  })
  options: string[];

  @Prop({
    required: true,
    min: 0,
    max: 3,
  })
  correctOptionIndex: number; // 0-based index of the correct option

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
}

export const QuestionSchema = SchemaFactory.createForClass(Question);