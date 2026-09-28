import { Module } from '@nestjs/common';

import { ExamsController } from './exams.controller';
import { ExamsService } from './exams.service';
import { QuestionsModule } from '../questions/questions.module';
import { UsersModule } from '../users/users.module';

// TODO(rewrite): provide Drizzle-backed ExamsService against
// exam_template + exam_instance + attempt + response + correction.
@Module({
  imports: [UsersModule, QuestionsModule],
  controllers: [ExamsController],
  providers: [ExamsService],
})
export class ExamsModule {}
