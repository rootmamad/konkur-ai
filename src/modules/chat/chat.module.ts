import { Module } from '@nestjs/common';

import { BillingModule } from '../billing/billing.module';
import { ChatAiService } from './chat-ai.service';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

// Chat foundation (spec 9.1/9.2): threads + user-message history for the
// three spaces; the question space additionally gets a live AI reply
// (ChatAiService; AIService/HistoryContextService arrive from the global
// AIModule). Free-plan AI quota per spec §10 rides on the shared paid
// predicate from BillingModule.
@Module({
  imports: [BillingModule],
  controllers: [ChatController],
  providers: [ChatService, ChatAiService],
})
export class ChatModule {}
