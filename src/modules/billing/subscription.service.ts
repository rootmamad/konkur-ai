import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import { subscription } from '../../db/schema/billing';
import { student } from '../../db/schema/student';

export type SubscriptionPlan = 'free' | 'full' | 'advisor';

export interface SubscriptionStatus {
  plan: SubscriptionPlan;
  paidAccess: boolean;
  simAccess: boolean;
}

/**
 * Single source of truth for the paid-plan predicate (spec 3.7): the same
 * query previously inlined in ExamsService, now owned here — exams delegates
 * to it for every quota/sim gate (spec 3.5/10).
 *
 * Read-only: no wallet, no payment code (later tasks).
 */
@Injectable()
export class SubscriptionService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * True when the account holds PAID access: plan 'full'/'advisor' with no
   * expiry (unlimited) or an expiry still in the future. A 'free' plan or an
   * expired row is not paid access. Predicate moved verbatim from
   * ExamsService — do not fork it again.
   */
  async hasPaidPlan(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ plan: subscription.plan })
      .from(subscription)
      .innerJoin(student, eq(student.id, subscription.studentId))
      .where(
        and(
          eq(student.accountId, userId),
          inArray(subscription.plan, ['full', 'advisor']),
          or(
            isNull(subscription.expiresAt),
            sql`${subscription.expiresAt} > now()`,
          ),
        ),
      )
      .limit(1);
    return !!row;
  }

  /**
   * Status of the CALLER (spec 3.7): `plan` is the latest subscription row's
   * plan ('free' when none — an expired paid row still reports its plan,
   * while `paidAccess` correctly reports false); `paidAccess` = hasPaidPlan;
   * `simAccess` = paidAccess, because both simulators are paid-only
   * (spec 3.5).
   */
  async getStatus(userId: string): Promise<SubscriptionStatus> {
    const [row] = await this.db
      .select({ plan: subscription.plan })
      .from(subscription)
      .innerJoin(student, eq(student.id, subscription.studentId))
      .where(eq(student.accountId, userId))
      .orderBy(desc(subscription.startedAt))
      .limit(1);

    const paidAccess = await this.hasPaidPlan(userId);
    return { plan: row?.plan ?? 'free', paidAccess, simAccess: paidAccess };
  }
}
