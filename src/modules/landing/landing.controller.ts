import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';

import { LANDING_PLANS, REPORT_CARD_SAMPLE } from './landing.content';

/**
 * Public landing-page content (spec 1.3: «دو API عمومی نمونه کارنامه و معرفی
 * پلن‌ها»). No JWT anywhere: the caller is an anonymous visitor of the
 * landing page. Both routes serve hardcoded constants from
 * `landing.content` — no service, no database, no real user/exam data.
 * Abuse is bounded by the throttler, like the auth/support public routes.
 */
@ApiTags('landing')
@Controller()
export class LandingController {
  /** PUBLIC: no JWT. Demo report card shaped like the §3.9 result flow. */
  @Get('public/report-card-sample')
  @UseGuards(ThrottlerGuard) // spec 1.3: public landing content
  @ApiOperation({
    summary: 'Sample exam report card for the landing page (static demo)',
  })
  reportCardSample() {
    return REPORT_CARD_SAMPLE;
  }

  /** PUBLIC: no JWT. The three tiers; pricing is undecided (spec 1.3). */
  @Get('public/plans')
  @UseGuards(ThrottlerGuard) // spec 1.3: public landing content
  @ApiOperation({
    summary: 'Subscription plans for the landing page (pricing coming soon)',
  })
  plans() {
    return LANDING_PLANS;
  }
}
