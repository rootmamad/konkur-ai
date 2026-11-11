import { Module } from '@nestjs/common';

import { SubscriptionController } from './subscription.controller';
import { SubscriptionService } from './subscription.service';

// Billing read surface (spec 3.7/10): the one paid predicate + status
// endpoint. Wallet/credit and the payment flow are later tasks.
@Module({
  controllers: [SubscriptionController],
  providers: [SubscriptionService],
  exports: [SubscriptionService],
})
export class BillingModule {}
