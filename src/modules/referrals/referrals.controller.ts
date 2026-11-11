import {
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { ReferralsService } from './referrals.service';

/**
 * ADMIN manual purchase verification (directive 2025-11-11): the MVP
 * stand-in until a payment flow exists — an admin marks an invitee as
 * purchased and the referral rewards fire exactly as the (future) payment
 * module will trigger them, via the same service method.
 */
@Controller('admin/referrals')
export class ReferralsController {
  constructor(private readonly referralsService: ReferralsService) {}

  /** Verify an invitee's purchase and grant the referral rewards. The
   * future payment flow will carry receipt/payment references in its own
   * request body; MVP verification is the admin's call. */
  @Post(':inviteeId/purchased')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  async markPurchased(
    @Param('inviteeId', ParseUUIDPipe) inviteeId: string,
  ): Promise<{ purchased: true }> {
    await this.referralsService.onInviteePurchased(inviteeId);
    return { purchased: true };
  }
}
