import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, Schema as MongooseSchema } from 'mongoose';

export type ExamAttemptDocument = HydratedDocument<ExamAttempt>;

export enum QuestionType {
  MULTIPLE_CHOICE = 'multiple_choice',
  TEXT_ANSWER = 'text_answer',
}

@Schema({ _id: false }) 
export class AnswerRecord {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Question', required: true })
  questionId: Types.ObjectId;

  @Prop({ type: String, enum: QuestionType, required: true })
  questionType: QuestionType;

  @Prop({ type: Number, min: 0, max: 3 })
  selectedOption?: number;

  @Prop({ type: String })
  textAnswer?: string;

  @Prop({ type: Boolean })
  isCorrect?: boolean;

  @Prop({ type: Number, min: 0, max: 1 })
  aiScore?: number;

  @Prop({ type: Date })
  answeredAt?: Date;
}
export const AnswerRecordSchema = SchemaFactory.createForClass(AnswerRecord);


@Schema({ timestamps: true })
export class ExamAttempt {
  @Prop({ required: true, ref: 'User' })
  userId: Types.ObjectId;

  @Prop({ type: [AnswerRecordSchema], default: [] })
  answers: AnswerRecord[];

  @Prop({ required: true })
  startTime: Date;

  @Prop({ required: true })
  durationSeconds: number;

  @Prop({ type: Date })
  submittedAt: Date;

  @Prop({ type: Number, min: 0 })
  totalScore: number;

  @Prop({ type: String })
  aiAnalysis: string;
}

export const ExamAttemptSchema = SchemaFactory.createForClass(ExamAttempt);