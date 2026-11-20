import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { ReferralsService } from '../referrals/referrals.service';
import { PurchaseDto } from './dto/purchase.dto';
import { SubscriptionService } from './subscription.service';

/** Read-only subscription status, always scoped to the signed-in caller
 * (spec 3.7). Same guard wiring as the dashboard controller. */
@Controller('subscription')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.STUDENT)
export class SubscriptionController {
  private readonly logger = new Logger(SubscriptionController.name);

  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly referralsService: ReferralsService,
  ) {}

  @Get('status')
  getStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.subscriptionService.getStatus(user.userId);
  }

  /**
   * Self-service purchase (spec §15.1.8): the purchase transaction commits
   * FIRST, then the referral reward hook fires once, fire-and-forget AFTER
   * the commit (study summarizeWeek pattern) — its failure must never fail
   * the purchase and is only logged.
   */
  @Post('purchase')
  @ApiOperation({
    summary: 'Buy a plan (placeholder durations from versioned settings)',
  })
  async purchase(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: PurchaseDto,
  ) {
    const created = await this.subscriptionService.purchase(user.userId, body);

    void this.referralsService
      .onInviteePurchased(created.studentId)
      .catch((error: unknown) => {
        this.logger.warn(
          `referral purchase hook failed for student ${created.studentId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });

    return created;
  }

  // Both wallet reads below are read-only views of the SAME caller's wallet
  // (spec 3.7 section 4 / §11): no wallet row is ever created here.
  @Get('wallet')
  getWallet(@CurrentUser() user: AuthenticatedUser) {
    return this.subscriptionService.getWalletBalance(user.userId);
  }

  @Get('wallet/transactions')
  listWalletTransactions(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
  ) {
    return this.subscriptionService.listWalletTransactions(
      user.userId,
      limit === undefined ? undefined : parseWalletLimit(limit),
    );
  }
}

function parseWalletLimit(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BadRequestException('limit must be a positive integer');
  }
  return parsed;
}
