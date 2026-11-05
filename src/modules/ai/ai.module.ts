import { Global, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AIService } from './ai.service';
import { HistoryContextService } from './history-context.service';
import { QuestionDrafterService } from './question-drafter.service';
import { AIDraftsController } from './ai-drafts.controller';

@Global()
@Module({
  imports: [HttpModule],
  controllers: [AIDraftsController],
  providers: [AIService, HistoryContextService, QuestionDrafterService],
  exports: [AIService, HistoryContextService, QuestionDrafterService],
})
export class AIModule {}
