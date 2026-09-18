import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument ,Types} from 'mongoose';
import { Question } from '../questions/schemas/question.schema';

export type ExamAttemptDocument = HydratedDocument<ExamAttempt>;

export enum QuestionType {
  MULTIPLE_CHOICE = 'multiple_choice',
  TEXT_ANSWER = 'text_answer',
}

@Schema({
  timestamps: true,
})
export class ExamAttempt {
  @Prop({
    required: true,
    ref: 'User', // Assuming we have a User model; we'll adjust later if needed
  })
  userId: Types.ObjectId;

  @Prop([
    {
      questionId: {
        type: Types.ObjectId,
        ref: 'Question',
        required: true,
      },
      questionType: {
        type: String,
        enum: QuestionType,
        required: true,
      },
      // For multiple choice: stores the selected option index (0-3)
      // For text answer: stores the user's text answer
      selectedOption: {
        type: Number,
        min: 0,
        max: 3,
      },
      textAnswer: {
        type: String,
      },
      // Whether the answer is correct (determined after evaluation)
      isCorrect: {
        type: Boolean,
      },
      // For text answers, the AI similarity score (0-1)
      aiScore: {
        type: Number,
        min: 0,
        max: 1,
      },
      // Timestamp when the answer was submitted
      answeredAt: {
        type: Date,
      },
    },
  ])
  answers: Array<{
    questionId: Types.ObjectId;
    questionType: QuestionType;
    selectedOption?: number;
    textAnswer?: string;
    isCorrect?: boolean;
    aiScore?: number;
    answeredAt?: Date;
  }>;

  @Prop({
    required: true,
  })
  startTime: Date;

  @Prop({
    required: true,
  })
  durationSeconds: number; // Total time allowed for the exam in seconds

  @Prop({
    type: Date,
  })
  submittedAt: Date;

  @Prop({
    type: Number,
    min: 0,
  })
  totalScore: number; // Percentage or raw score, depending on implementation

  @Prop({
    type: String,
  })
  aiAnalysis: string; // Result from AI analysis of the entire exam
}

export const ExamAttemptSchema = SchemaFactory.createForClass(ExamAttempt);