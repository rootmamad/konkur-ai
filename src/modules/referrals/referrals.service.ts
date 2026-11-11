import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import { appConfig } from '../../db/schema/app-config';
import { subscription } from '../../db/schema/billing';
import { referral } from '../../db/schema/referral';

/** Versioned-settings key for the «پاداش شروع بدون خرید» bonus (spec 11). */
const REFERRAL_BONUS_HOURS_KEY = 'referral_bonus_hours';
const REFERRAL_BONUS_HOURS_DEFAULT = 48;

const HOUR_MS = 3_600_000;
/** Paid plans whose active access must never be extended or stacked (spec 11). */
const PAID_PLANS = ['full', 'advisor'] as const;

/**
 * Referral progression (spec §11): when an invitee finishes their FIRST
 * quizlet, the referral moves registered → first_exam and BOTH sides get a
 * config-driven window of full access.
 *
 * Deferred to later tasks (spec §11): the «پاداش خرید» purchased/expired
 * transitions, wallet/credit bookkeeping and the 15%/20% purchase rules.
 * ALSO deferred: the «برای هر دستگاه فقط یکبار» once-per-device guard —
 * no device identifier exists anywhere in the schema yet, so farming many
 * accounts from one device is currently unguarded.
 */
@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Progress the invitee's referral to first_exam and grant the 48h bonus.
   *
   * Fire-and-forget safe: this method logs and swallows its own errors so it
   * can never break the exam finish that triggers it. Callers may still add
   * a `.catch` of their own.
   *
   * The transition is a SINGLE status-guarded UPDATE: zero updated rows means
   * there is no referral for this invitee, or it already progressed — in both
   * cases a pure no-op. The status guard makes repeated and concurrent finish
   * calls safe, so the grant can never fire twice.
   */
  async onInviteeExamFinished(inviteeStudentId: string): Promise<void> {
    try {
      await this.progressAndGrant(inviteeStudentId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[referral] first_exam progression for ${inviteeStudentId} skipped: ${msg}`,
      );
    }
  }

  private async progressAndGrant(inviteeStudentId: string): Promise<void> {
    // Atomic transition (spec 11): one guarded UPDATE; RETURNING tells us
    // whether THIS call won the transition.
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

    if (!transitioned) return; // no referral row, or already progressed

    const hours = await this.getReferralBonusHours();
    // One absolute expiry instant shared by both grants.
    const expiresAt = new Date(Date.now() + hours * HOUR_MS);

    for (const studentId of [transitioned.inviterId, inviteeStudentId]) {
      // Existing paid access is never extended or stacked (spec 11).
      if (await this.hasActivePaidSubscription(studentId)) continue;
      await this.db.insert(subscription).values({
        studentId,
        plan: 'full',
        expiresAt,
      });
    }
  }

  /**
   * True when the student currently holds PAID access: plan 'full'/'advisor'
   * with no expiry, or an expiry still in the future. A 'free' plan, an
   * expired row or a non-paid plan never blocks a fresh referral grant.
   */
  private async hasActivePaidSubscription(studentId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: subscription.id })
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
      .limit(1);
    return row !== undefined;
  }

  /**
   * Bonus hours from the active versioned settings row (spec 11.2), read
   * exactly like the other app_config quotas; positive integer or the
   * documented default of 48.
   */
  private async getReferralBonusHours(): Promise<number> {
    const [row] = await this.db
      .select({ quotas: appConfig.quotas })
      .from(appConfig)
      .where(eq(appConfig.isActive, true))
      .orderBy(desc(appConfig.version))
      .limit(1);

    const quotas = row?.quotas as Record<string, unknown> | null | undefined;
    const value = quotas?.[REFERRAL_BONUS_HOURS_KEY];
    return typeof value === 'number' && Number.isInteger(value) && value > 0
      ? value
      : REFERRAL_BONUS_HOURS_DEFAULT;
  }
}
