import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HttpModule } from '@nestjs/axios';

import { ExamAttempt, ExamAttemptSchema } from './exam-attempt.schema';
import { ExamsController } from './exams.controller';
import { ExamsService } from './exams.service';
import { AIService } from './ai.service';
import { QuestionsModule } from '../questions/questions.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: ExamAttempt.name, schema: ExamAttemptSchema }]),
    UsersModule,
    QuestionsModule,
    HttpModule,
  ],
  controllers: [ExamsController],
  providers: [ExamsService, AIService],
})
export class ExamsModule {}