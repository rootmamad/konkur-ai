import { Module } from '@nestjs/common';

import { ReferralsController } from './referrals.controller';
import { ReferralsService } from './referrals.service';

// Referral lifecycle (spec 11, directive 2025-11-11): first_exam milestone,
// purchase-verified rewards. Registration itself writes the 'registered' row
// (users module); wallet/credit and payment-gateway integration are later
// tasks.
@Module({
  controllers: [ReferralsController],
  providers: [ReferralsService],
  exports: [ReferralsService],
})
export class ReferralsModule {}
