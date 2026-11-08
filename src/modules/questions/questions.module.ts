import { Module } from '@nestjs/common';

import { QuestionsController } from './questions.controller';
import { QuestionsService } from './questions.service';
import { ExplanationService } from './explanation.service';

// TODO(rewrite): provide Drizzle-backed QuestionsService against
// question + answer_key + explanation + rubric + topic.
@Module({
  controllers: [QuestionsController],
  providers: [QuestionsService, ExplanationService],
  exports: [QuestionsService, ExplanationService],
})
export class QuestionsModule {}
