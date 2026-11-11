import { Module } from '@nestjs/common';

import { ReferralsService } from './referrals.service';

// Invite progression (spec 11): first_exam transition + 48h bonus. The
// purchased/expired transitions, wallet/credit and purchase discounts are
// later tasks; registration itself writes the 'registered' row (users module).
@Module({
  providers: [ReferralsService],
  exports: [ReferralsService],
})
export class ReferralsModule {}
