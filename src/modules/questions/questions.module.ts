import { Module } from '@nestjs/common';

import { QuestionsController } from './questions.controller';
import { QuestionsService } from './questions.service';

// TODO(rewrite): provide Drizzle-backed QuestionsService against
// question + answer_key + explanation + rubric + topic.
@Module({
  controllers: [QuestionsController],
  providers: [QuestionsService],
  exports: [QuestionsService],
})
export class QuestionsModule {}
