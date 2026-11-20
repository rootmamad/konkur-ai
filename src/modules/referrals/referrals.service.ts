import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';

import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import type { DbOrTx, Tx } from '../../db/types';
import { appConfig } from '../../db/schema/app-config';
import { subscription } from '../../db/schema/billing';
import { referral } from '../../db/schema/referral';

/**
 * Versioned-settings keys for the purchase bonuses. The old
 * `referral_bonus_hours` (48h no-purchase bonus) is SUPERSEDED by the lead
 * directive of 2025-11-11: rewards are now gated on purchase verification.
 */
const REFERRAL_INVITER_BONUS_DAYS_KEY = 'referral_inviter_bonus_days';
const REFERRAL_INVITER_BONUS_DAYS_DEFAULT = 7;
const REFERRAL_INVITEE_BONUS_DAYS_KEY = 'referral_invitee_bonus_days';
const REFERRAL_INVITEE_BONUS_DAYS_DEFAULT = 2;

/**
 * Monthly cap on inviter rewards (spec §11 ¶91): a per-inviter cap on
 * rewarded referrals per rolling 30 days. The spec's rationale is
 * "one 3-month subscription per month" — 10 is the documented default.
 */
const REFERRAL_INVITER_MONTHLY_CAP_KEY = 'referral_inviter_monthly_cap';
const REFERRAL_INVITER_MONTHLY_CAP_DEFAULT = 10;

const DAY_MS = 86_400_000;
/** Plans that count as paid access; 'free' never blocks or extends. */
const PAID_PLANS = ['full', 'advisor'] as const;

/**
 * Referral rewards, gated on purchase verification (lead directive
 * 2025-11-11, superseding spec §11's no-purchase 48h bonus).
 *
 * Two entry points:
 *  - onInviteeExamFinished: milestone ONLY — the guarded registered →
 *    first_exam transition, no rewards of any kind.
 *  - onInviteePurchased: THE reward trigger — guarded transition to
 *    'purchased' plus config-driven access bonuses for both sides, all in
 *    one transaction.
 *
 * The former «برای هر دستگاه فقط یکبار» once-per-device note is obsolete:
 * farming is now gated by payment instead of device identity.
 *
 * Still out of scope (later tasks): wallet/credit bookkeeping, the 15%/20%
 * purchase discounts, the expired transition and any payment-gateway
 * integration.
 */
@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Milestone (spec §11): the invitee finished their first quizlet, so their
   * referral moves registered → first_exam.
   *
   * REWARD-FREE by directive 2025-11-11: a single status-guarded UPDATE and
   * nothing else — no subscription row is ever written on this path. Zero
   * updated rows (no referral, or already progressed) is a pure no-op. The
   * status guard makes repeated and concurrent finish calls safe.
   *
   * Fire-and-forget safe: logs and swallows its own errors so it can never
   * break the exam finish that triggers it.
   */
  async onInviteeExamFinished(inviteeStudentId: string): Promise<void> {
    try {
      const [transitioned] = await this.db
        .update(referral)
        .set({ status: 'first_exam', updatedAt: new Date() })
        .where(
          and(
            eq(referral.inviteeId, inviteeStudentId),
            eq(referral.status, 'registered'),
          ),
        )
        .returning({ inviterId: referral.inviterId });

      if (transitioned) {
        this.logger.log(
          `referral milestone: invitee ${inviteeStudentId} reached first_exam (inviter ${transitioned.inviterId})`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[referral] first_exam milestone for ${inviteeStudentId} skipped: ${msg}`,
      );
    }
  }

  /**
   * THE reward trigger (directive 2025-11-11): the invitee's purchase was
   * verified — transition the referral to 'purchased' and grant BOTH sides
   * their bonus, all-or-nothing in one transaction.
   *
   * Reachable directly from 'registered' (a purchase without any exam), so
   * the guard accepts both 'registered' and 'first_exam'. Zero updated rows
   * (no referral, or already purchased) is a pure no-op: the grant runs only
   * for the call that wins the transition — once per invitee, retry- and
   * concurrency-safe. A failure anywhere rolls the transition back, so a
   * retry re-runs the whole thing.
   *
   * MVP stand-in until a payment flow exists: the payment module will call
   * this same method.
   */
  async onInviteePurchased(inviteeStudentId: string): Promise<void> {
    try {
      await this.transitionAndGrant(inviteeStudentId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[referral] purchased rewards for ${inviteeStudentId} skipped: ${msg}`,
      );
    }
  }

  private async transitionAndGrant(inviteeStudentId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Atomic guarded transition: one UPDATE decides whether THIS call wins.
      const [transitioned] = await tx
        .update(referral)
        .set({ status: 'purchased', updatedAt: new Date() })
        .where(
          and(
            eq(referral.inviteeId, inviteeStudentId),
            inArray(referral.status, ['registered', 'first_exam']),
          ),
        )
        .returning({ inviterId: referral.inviterId });

      if (!transitioned) return; // no referral row, or already purchased

      // Reads ride inside the transaction: consistent snapshot for the
      // grants, and a no-op never pays for them.
      const inviterDays = await this.getBonusDays(
        tx,
        REFERRAL_INVITER_BONUS_DAYS_KEY,
        REFERRAL_INVITER_BONUS_DAYS_DEFAULT,
      );
      const inviteeDays = await this.getBonusDays(
        tx,
        REFERRAL_INVITEE_BONUS_DAYS_KEY,
        REFERRAL_INVITEE_BONUS_DAYS_DEFAULT,
      );

      // Check monthly cap on inviter rewards (spec §11 ¶91). The count
      // excludes the current purchase: "prior rewards in the window".
      const monthlyCap = await this.getMonthlyCap(tx);
      const rewardedCount = await this.countInviterRewardedInWindow(
        tx,
        transitioned.inviterId,
        inviteeStudentId,
      );

      const now = new Date();

      // Grant inviter bonus only if under cap (spec §11 ¶91).
      if (rewardedCount < monthlyCap) {
        await this.grantBonus(tx, transitioned.inviterId, inviterDays, now);
      } else {
        this.logger.log(
          `referral cap reached: inviter ${transitioned.inviterId} has ${rewardedCount} rewarded referrals in the last 30 days (cap: ${monthlyCap}), skipping inviter bonus`,
        );
      }

      // Always grant invitee bonus.
      await this.grantBonus(tx, inviteeStudentId, inviteeDays, now);
    });
  }

  /**
   * Count the inviter's ALREADY-rewarded referrals BEFORE this purchase,
   * within the rolling 30-day window: status is 'purchased' and its
   * updatedAt (when it transitioned to purchased) is within the last 30
   * days. The current invitee's own row is EXCLUDED — the guarded
   * transition above already flipped it to 'purchased' with updatedAt=now,
   * so without the exclusion it would count itself and the cap-th purchase
   * would be wrongly skipped. inviteeId is unique in the referral table, so
   * excluding it removes exactly the current purchase: purchases #1..cap
   * are rewarded and skipping starts with purchase cap+1. Reads through the
   * given executor (inside the transaction).
   */
  private async countInviterRewardedInWindow(
    executor: DbOrTx,
    inviterId: string,
    currentInviteeId: string,
  ): Promise<number> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS);
    const [row] = await executor
      .select({ count: sql<number>`count(*)::int` })
      .from(referral)
      .where(
        and(
          eq(referral.inviterId, inviterId),
          eq(referral.status, 'purchased'),
          sql`${referral.updatedAt} >= ${thirtyDaysAgo}`,
          // Exclude the row THIS call just transitioned (see doc comment).
          ne(referral.inviteeId, currentInviteeId),
        ),
      );
    return row?.count ?? 0;
  }

  /**
   * Monthly cap on inviter rewards from the active app_config row.
   * Positive integer or the documented default (10).
   * Reads through the given executor (inside the transaction).
   */
  private async getMonthlyCap(executor: DbOrTx): Promise<number> {
    const [row] = await executor
      .select({ quotas: appConfig.quotas })
      .from(appConfig)
      .where(eq(appConfig.isActive, true))
      .orderBy(desc(appConfig.version))
      .limit(1);

    const quotas = row?.quotas as Record<string, unknown> | null | undefined;
    const value = quotas?.[REFERRAL_INVITER_MONTHLY_CAP_KEY];
    return typeof value === 'number' && Number.isInteger(value) && value > 0
      ? value
      : REFERRAL_INVITER_MONTHLY_CAP_DEFAULT;
  }

  /**
   * Give `days` of full access to `studentId`, inside the caller's
   * transaction: extend their furthest active paid row from ITS expiry
   * (never from now, never shortened); an unlimited (NULL-expiry) paid row
   * means nothing to extend. Without paid access, insert a fresh
   * `{ plan: 'full', expiresAt: now + days }` row.
   */
  private async grantBonus(
    tx: Tx,
    studentId: string,
    days: number,
    now: Date,
  ): Promise<void> {
    // Furthest expiry first; a NULL-expiry (unlimited) row must win the pick.
    const [active] = await tx
      .select({ id: subscription.id, expiresAt: subscription.expiresAt })
      .from(subscription)
      .where(
        and(
          eq(subscription.studentId, studentId),
          inArray(subscription.plan, [...PAID_PLANS]),
          or(
            isNull(subscription.expiresAt),
            sql`${subscription.expiresAt} > now()`,
          ),
        ),
      )
      .orderBy(sql`${subscription.expiresAt} desc nulls first`)
      .limit(1);

    if (active && active.expiresAt == null) return; // unlimited: nothing to add

    if (active) {
      const extended = new Date(
        (active.expiresAt as Date).getTime() + days * DAY_MS,
      );
      await tx
        .update(subscription)
        .set({ expiresAt: extended })
        .where(eq(subscription.id, active.id));
      return;
    }

    await tx.insert(subscription).values({
      studentId,
      plan: 'full',
      expiresAt: new Date(now.getTime() + days * DAY_MS),
    });
  }

  /**
   * Bonus days from the active versioned settings row, read exactly like the
   * other app_config quotas: positive integer or the documented default.
   * Reads through the given executor — inside the caller's transaction when
   * granting, so the amounts reflect one consistent snapshot.
   */
  private async getBonusDays(
    executor: DbOrTx,
    key: string,
    fallback: number,
  ): Promise<number> {
    const [row] = await executor
      .select({ quotas: appConfig.quotas })
      .from(appConfig)
      .where(eq(appConfig.isActive, true))
      .orderBy(desc(appConfig.version))
      .limit(1);

    const quotas = row?.quotas as Record<string, unknown> | null | undefined;
    const value = quotas?.[key];
    return typeof value === 'number' && Number.isInteger(value) && value > 0
      ? value
      : fallback;
  }
}
