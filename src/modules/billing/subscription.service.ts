import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import type { DbOrTx } from '../../db/types';
import { appConfig } from '../../db/schema/app-config';
import {
  creditKind,
  creditTransaction,
  creditWallet,
  subscription,
} from '../../db/schema/billing';
import type { Subscription } from '../../db/schema/billing';
import { student } from '../../db/schema/student';
import { PurchaseDto } from './dto/purchase.dto';

export type SubscriptionPlan = 'free' | 'full' | 'advisor';
export type CreditKind = (typeof creditKind.enumValues)[number];

/**
 * Self-service purchase durations (spec §15.1.8 / §15.2). Pricing is OPEN:
 * these are documented PLACEHOLDER durations read from the active app_config
 * row (same read style as the free-quiz quota) — no hardcoded prices anywhere.
 */
const PURCHASE_FULL_DAYS_KEY = 'purchase_full_days';
const PURCHASE_FULL_DAYS_DEFAULT = 30;
const PURCHASE_ADVISOR_DAYS_KEY = 'purchase_advisor_days';
const PURCHASE_ADVISOR_DAYS_DEFAULT = 30;

const DAY_MS = 86_400_000;

export interface SubscriptionStatus {
  plan: SubscriptionPlan;
  paidAccess: boolean;
  simAccess: boolean;
}

/** One wallet-history row as the API returns it (spec 3.7 section 4). */
export interface WalletTransaction {
  id: string;
  kind: CreditKind;
  /** numeric(12,2) → string; signed delta of the transaction. */
  amount: string;
  reason: string | null;
  createdAt: Date;
}

/** GET /subscription/wallet/transactions defaults (spec 3.6 clamp style). */
export const WALLET_TRANSACTIONS_DEFAULT_LIMIT = 20;
export const WALLET_TRANSACTIONS_MAX_LIMIT = 50;

/**
 * limit: absent → default; a non-integer or < 1 → BadRequest; otherwise
 * clamped to the documented max — the study parseLimit/clampRecentLimit
 * split, kept here so the service alone enforces the contract.
 */
export function clampWalletLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return WALLET_TRANSACTIONS_DEFAULT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new BadRequestException('limit must be a positive integer');
  }
  return Math.min(limit, WALLET_TRANSACTIONS_MAX_LIMIT);
}

/**
 * Single source of truth for the paid-plan predicate (spec 3.7): the same
 * query previously inlined in ExamsService, now owned here — exams delegates
 * to it for every quota/sim gate (spec 3.5/10).
 *
 * Read surface + the self-service purchase write (spec §15.1.8): no wallet
 * writes, no payment gateway (later tasks).
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

  /**
   * The caller's credit balance (spec 3.7 section 4 / §11). READ-ONLY: a
   * missing wallet row is reported as '0.00' — one is NEVER created here
   * (wallet rows are born with the reward/purchase flow, a later task).
   */
  async getWalletBalance(userId: string): Promise<{ balance: string }> {
    const [row] = await this.db
      .select({ balance: creditWallet.balance })
      .from(creditWallet)
      .innerJoin(student, eq(student.id, creditWallet.studentId))
      .where(eq(student.accountId, userId))
      .limit(1);
    return { balance: row?.balance ?? '0.00' };
  }

  /**
   * The caller's credit transactions, newest first (spec 3.7 section 4).
   * READ-ONLY; scoped account→student→wallet with the same innerJoin
   * pattern as getStatus, so another student's wallet is unreachable.
   */
  async listWalletTransactions(
    userId: string,
    limit?: number,
  ): Promise<WalletTransaction[]> {
    const clamped = clampWalletLimit(limit);
    return this.db
      .select({
        id: creditTransaction.id,
        kind: creditTransaction.kind,
        amount: creditTransaction.amount,
        reason: creditTransaction.reason,
        createdAt: creditTransaction.createdAt,
      })
      .from(creditTransaction)
      .innerJoin(creditWallet, eq(creditWallet.id, creditTransaction.walletId))
      .innerJoin(student, eq(student.id, creditWallet.studentId))
      .where(eq(student.accountId, userId))
      .orderBy(desc(creditTransaction.createdAt))
      .limit(clamped);
  }

  /**
   * Self-service purchase (spec §15.1.8): ONE transaction that resolves
   * account→student (same scoping predicate as getStatus — the caller's own
   * account id, never a client param), reads the placeholder duration from
   * the active versioned settings row, and inserts a NEW subscription row.
   *
   * A purchase is ALWAYS a fresh row (`startedAt = now`): extending an
   * existing paid row is grantBonus's job (referrals); old rows are never
   * edited or expired here. 'free' is not purchasable → 400.
   */
  async purchase(userId: string, dto: PurchaseDto): Promise<Subscription> {
    // Runtime guard for direct service callers: DTO validation already
    // rejects 'free', but the service must not depend on the pipe.
    if ((dto.plan as string) === 'free') {
      throw new BadRequestException('the free plan cannot be purchased');
    }
    return this.db.transaction(async (tx) => {
      const studentId = await this.requireStudentId(tx, userId);
      const days = await this.getPurchaseDays(tx, dto.plan);

      const now = new Date();
      const [created] = await tx
        .insert(subscription)
        .values({
          studentId,
          plan: dto.plan,
          startedAt: now,
          expiresAt: new Date(now.getTime() + days * DAY_MS),
        })
        .returning();
      return created;
    });
  }

  /**
   * account→student inside the caller's transaction, scoped to the caller's
   * own account id (the getStatus predicate).
   */
  private async requireStudentId(
    executor: DbOrTx,
    userId: string,
  ): Promise<string> {
    const [row] = await executor
      .select({ id: student.id })
      .from(student)
      .where(eq(student.accountId, userId))
      .limit(1);
    if (!row) throw new NotFoundException('Student profile not found');
    return row.id;
  }

  /**
   * Purchase duration in days for the plan, from the ACTIVE app_config row —
   * the exact read style of the free-quiz quota: positive integer or the
   * documented placeholder default. Read inside the transaction so the
   * duration and the inserted row reflect one consistent snapshot.
   */
  private async getPurchaseDays(
    executor: DbOrTx,
    plan: 'full' | 'advisor',
  ): Promise<number> {
    const key =
      plan === 'full' ? PURCHASE_FULL_DAYS_KEY : PURCHASE_ADVISOR_DAYS_KEY;
    const fallback =
      plan === 'full'
        ? PURCHASE_FULL_DAYS_DEFAULT
        : PURCHASE_ADVISOR_DAYS_DEFAULT;

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
