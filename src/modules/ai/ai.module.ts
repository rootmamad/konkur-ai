import { Global, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AIService } from './ai.service';
import { HistoryContextService } from './history-context.service';

@Global()
@Module({
  imports: [HttpModule],
  providers: [AIService, HistoryContextService],
  exports: [AIService, HistoryContextService],
})
export class AIModule {}
