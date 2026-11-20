import { BadRequestException } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Db } from '../../db/db.module';
import { creditTransaction, creditWallet } from '../../db/schema/billing';
import { SubscriptionService } from './subscription.service';

const USER_ID = '9f1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const dialect = new PgDialect();

type Row = Record<string, unknown>;

interface MakeDbOptions {
  /** Rows for the status lookup (the chain WITH orderBy). */
  statusRows?: Row[];
  /** Rows for the paid predicate (the chain WITHOUT orderBy). */
  paidRows?: Row[];
  /** Rows for the wallet balance lookup. */
  walletRows?: Row[];
  /** Rows for the transaction list (the chain WITH orderBy). */
  transactionRows?: Row[];
}

/**
 * Fluent mock of every chain SubscriptionService uses. Chains are keyed by
 * the source table: the wallet balance query and the paid predicate are both
 * unordered, so they cannot share a queue. `orderBy` and `limit` are
 * recorded so the spec can assert desc + clamp.
 */
function makeDb(options: MakeDbOptions = {}) {
  const conditions: SQL[] = [];
  const orderings: SQL[] = [];
  const limits: number[] = [];
  const insert = jest.fn();

  const select = jest.fn(() => {
    let ordered = false;
    let table: unknown = null;

    const resolve = (): Row[] =>
      table === creditWallet
        ? (options.walletRows ?? [])
        : table === creditTransaction
          ? (options.transactionRows ?? [])
          : ordered
            ? (options.statusRows ?? [])
            : (options.paidRows ?? []);

    const chain = {
      from: (t: unknown) => {
        table = t;
        return chain;
      },
      innerJoin: () => chain,
      where: (condition: SQL) => {
        conditions.push(condition);
        return chain;
      },
      orderBy: (ordering: SQL) => {
        ordered = true;
        orderings.push(ordering);
        return chain;
      },
      limit: (count: number) => {
        limits.push(count);
        return Promise.resolve(resolve());
      },
    };
    return chain;
  });

  const db = { select, insert } as unknown as Db;
  return { db, conditions, orderings, limits, insert };
}

function build(options: MakeDbOptions = {}) {
  const { db, conditions, orderings, limits, insert } = makeDb(options);
  return {
    service: new SubscriptionService(db),
    conditions,
    orderings,
    limits,
    insert,
  };
}

describe('SubscriptionService.hasPaidPlan — the one paid predicate', () => {
  it('full plan with future expiry -> paid', async () => {
    const { service } = build({ paidRows: [{ plan: 'full' }] });

    await expect(service.hasPaidPlan(USER_ID)).resolves.toBe(true);
  });

  it('advisor plan with NULL expiry (unlimited) -> paid', async () => {
    const { service } = build({ paidRows: [{ plan: 'advisor' }] });

    await expect(service.hasPaidPlan(USER_ID)).resolves.toBe(true);
  });

  it('expired paid row -> not paid', async () => {
    // The `expires_at > now()` clause excludes the row; nothing matches.
    const { service } = build({ paidRows: [] });

    await expect(service.hasPaidPlan(USER_ID)).resolves.toBe(false);
  });

  it('free plan -> not paid', async () => {
    const { service } = build({ paidRows: [] });

    await expect(service.hasPaidPlan(USER_ID)).resolves.toBe(false);
  });

  it('queries exactly the spec predicate, keyed by account id', async () => {
    const { service, conditions } = build({ paidRows: [] });

    await service.hasPaidPlan(USER_ID);

    expect(conditions).toHaveLength(1);
    const { sql: text } = dialect.sqlToQuery(conditions[0]);
    expect(text).toContain('"student"."account_id" =');
    expect(text).toContain('"subscription"."plan" in');
    expect(text).toContain('"subscription"."expires_at" is null');
    expect(text).toContain('"subscription"."expires_at" > now()');
  });
});

describe('SubscriptionService.getStatus (spec 3.7)', () => {
  it('no subscription rows -> free with no access', async () => {
    const { service } = build({ statusRows: [], paidRows: [] });

    await expect(service.getStatus(USER_ID)).resolves.toEqual({
      plan: 'free',
      paidAccess: false,
      simAccess: false,
    });
  });

  it('free plan row -> free with no access', async () => {
    const { service } = build({
      statusRows: [{ plan: 'free' }],
      paidRows: [],
    });

    await expect(service.getStatus(USER_ID)).resolves.toEqual({
      plan: 'free',
      paidAccess: false,
      simAccess: false,
    });
  });

  it('active full row -> full with paid + sim access', async () => {
    const { service } = build({
      statusRows: [{ plan: 'full' }],
      paidRows: [{ plan: 'full' }],
    });

    await expect(service.getStatus(USER_ID)).resolves.toEqual({
      plan: 'full',
      paidAccess: true,
      simAccess: true,
    });
  });

  it('active advisor row -> advisor with paid + sim access', async () => {
    const { service } = build({
      statusRows: [{ plan: 'advisor' }],
      paidRows: [{ plan: 'advisor' }],
    });

    await expect(service.getStatus(USER_ID)).resolves.toEqual({
      plan: 'advisor',
      paidAccess: true,
      simAccess: true,
    });
  });

  it('expired full row still reports plan full, but no access', async () => {
    const { service } = build({
      statusRows: [{ plan: 'full' }],
      paidRows: [],
    });

    await expect(service.getStatus(USER_ID)).resolves.toEqual({
      plan: 'full',
      paidAccess: false,
      simAccess: false,
    });
  });
});

describe('SubscriptionService.getWalletBalance (spec 3.7 section 4) — read-only', () => {
  it('no wallet row -> balance 0.00 and ZERO insert calls', async () => {
    const { service, insert } = build({ walletRows: [] });

    await expect(service.getWalletBalance(USER_ID)).resolves.toEqual({
      balance: '0.00',
    });
    // Read-only proof: the balance read never touches the DB write path.
    expect(insert).not.toHaveBeenCalled();
  });

  it('a wallet row reports its balance verbatim (numeric -> string)', async () => {
    const { service, insert } = build({
      walletRows: [{ balance: '1250.50' }],
    });

    await expect(service.getWalletBalance(USER_ID)).resolves.toEqual({
      balance: '1250.50',
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it('is scoped to the caller account id (another student is unreachable)', async () => {
    const { service, conditions, insert } = build({ walletRows: [] });

    await service.getWalletBalance(USER_ID);

    expect(conditions).toHaveLength(1);
    const { sql: text, params } = dialect.sqlToQuery(conditions[0]);
    expect(text).toContain('"student"."account_id" =');
    expect(params).toContain(USER_ID);
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('SubscriptionService.listWalletTransactions (spec §11) — read-only', () => {
  const tx3 = {
    id: 'tx-3',
    kind: 'invite_reward',
    amount: '50.00',
    reason: 'invite',
    createdAt: new Date('2026-01-07T00:00:00.000Z'),
  };
  const tx2 = {
    id: 'tx-2',
    kind: 'purchase_discount',
    amount: '-10.00',
    reason: null,
    createdAt: new Date('2026-01-05T00:00:00.000Z'),
  };
  const tx1 = {
    id: 'tx-1',
    kind: 'gift_access',
    amount: '0.00',
    reason: null,
    createdAt: new Date('2026-01-03T00:00:00.000Z'),
  };

  it('no wallet -> empty list and ZERO insert calls', async () => {
    const { service, insert } = build({ transactionRows: [] });

    await expect(service.listWalletTransactions(USER_ID)).resolves.toEqual([]);
    expect(insert).not.toHaveBeenCalled();
  });

  it('returns the rows newest-first with the default limit of 20', async () => {
    const { service, limits, insert } = build({
      transactionRows: [tx3, tx2, tx1],
    });

    await expect(service.listWalletTransactions(USER_ID)).resolves.toEqual([
      tx3,
      tx2,
      tx1,
    ]);
    expect(limits).toEqual([20]);
    expect(insert).not.toHaveBeenCalled();
  });

  it('clamps the limit to the documented max (50) and rejects invalid values', async () => {
    const { service, limits } = build({
      transactionRows: [tx3, tx2, tx1],
    });

    await service.listWalletTransactions(USER_ID, 500);
    expect(limits[0]).toBe(50);

    await expect(
      service.listWalletTransactions(USER_ID, 0),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.listWalletTransactions(USER_ID, -5),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.listWalletTransactions(USER_ID, 2.5),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is scoped to the caller account id and ordered by created_at desc', async () => {
    const { service, conditions, orderings, insert } = build({
      transactionRows: [tx3, tx2, tx1],
    });

    await service.listWalletTransactions(USER_ID, 25);

    expect(conditions).toHaveLength(1);
    const { sql: text, params } = dialect.sqlToQuery(conditions[0]);
    expect(text).toContain('"student"."account_id" =');
    expect(params).toContain(USER_ID);

    expect(orderings).toHaveLength(1);
    const orderText = dialect.sqlToQuery(orderings[0]).sql.toLowerCase();
    expect(orderText).toContain('desc');
    expect(orderText).toContain('"credit_transaction"."created_at"');
    expect(insert).not.toHaveBeenCalled();
  });
});
