import { Module } from '@nestjs/common';

import { ReferralsModule } from '../referrals/referrals.module';
import { SubscriptionController } from './subscription.controller';
import { SubscriptionService } from './subscription.service';

// Billing (spec 3.7/10/§15.1.8): the one paid predicate + status endpoint +
// the self-service purchase write. ReferralsModule supplies the reward hook
// fired fire-and-forget after a purchase commits. Wallet/credit and the
// payment-gateway flow are later tasks.
@Module({
  imports: [ReferralsModule],
  controllers: [SubscriptionController],
  providers: [SubscriptionService],
  exports: [SubscriptionService],
})
export class BillingModule {}
