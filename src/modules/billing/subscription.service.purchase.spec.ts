import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Db } from '../../db/db.module';
import { subscription } from '../../db/schema/billing';
import { appConfig } from '../../db/schema/app-config';
import { student } from '../../db/schema/student';
import { SubscriptionService } from './subscription.service';

const USER_ID = '9f1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const STUDENT_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';
const DAY_MS = 86_400_000;

const dialect = new PgDialect();

type Row = Record<string, unknown>;

interface MakeDbOptions {
  /** Rows for the account→student resolution inside the tx. */
  studentRows?: Row[];
  /** Active app_config rows for the duration read. */
  configRows?: Row[];
  /** Row the insert ... RETURNING yields. */
  returningRow?: Row;
  /** Error injection points. */
  failOnOp?: 'resolve' | 'insert';
}

/**
 * Fluent mock with a STAGED-COMMIT transaction fake (referrals pattern):
 * writes issued inside `db.transaction` are collected and only become
 * visible in `committedInserts` when the callback RESOLVES; a rejection
 * discards them (rollback). Captured conditions render to real SQL via
 * `dialect.sqlToQuery` so tests assert the actual guards.
 */
function makeDb(options: MakeDbOptions = {}) {
  const conditions: { table: unknown; condition: SQL }[] = [];
  const orderings: SQL[] = [];
  const stagedTxWrites: string[] = [];
  const committedTxWrites: string[] = [];
  const stagedInserts: { table: unknown; values: Row }[] = [];
  const committedInserts: { table: unknown; values: Row }[] = [];

  const resolveSelect = (table: unknown): Row[] => {
    if (table === student) {
      return options.studentRows ?? [{ id: STUDENT_ID }];
    }
    if (table === appConfig) {
      return options.configRows ?? [];
    }
    return [];
  };

  const selectChain = () => {
    let table: unknown = null;
    const chain = {
      from: (t: unknown) => {
        table = t;
        return chain;
      },
      innerJoin: () => chain,
      where: (condition: SQL) => {
        conditions.push({ table, condition });
        return chain;
      },
      orderBy: (ordering: SQL) => {
        orderings.push(ordering);
        return chain;
      },
      limit: () => {
        if (table === student && options.failOnOp === 'resolve') {
          return Promise.reject(new Error('resolve failed'));
        }
        return Promise.resolve(resolveSelect(table));
      },
    };
    return chain;
  };

  const txProxy = {
    select: jest.fn(() => selectChain()),
    insert: jest.fn((table: unknown) => ({
      values: (values: Row) => {
        stagedInserts.push({ table, values });
        stagedTxWrites.push('insert-sub');
        return {
          returning: () =>
            options.failOnOp === 'insert'
              ? Promise.reject(new Error('insert failed'))
              : Promise.resolve([
                  options.returningRow ?? { id: 'sub-1', ...values },
                ]),
        };
      },
    })),
  };

  const db = {
    select: jest.fn(() => {
      throw new Error('no reads outside a transaction');
    }),
    insert: jest.fn(() => {
      throw new Error('no writes outside a transaction');
    }),
    transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      try {
        const result = await cb(txProxy);
        committedTxWrites.push(...stagedTxWrites);
        committedInserts.push(...stagedInserts);
        stagedTxWrites.length = 0;
        stagedInserts.length = 0;
        return result;
      } catch (err) {
        stagedTxWrites.length = 0;
        stagedInserts.length = 0;
        throw err;
      }
    }),
  } as unknown as Db;

  return {
    db,
    conditions,
    orderings,
    committedTxWrites,
    committedInserts,
  };
}

function build(options: MakeDbOptions = {}) {
  const { db, conditions, orderings, committedTxWrites, committedInserts } =
    makeDb(options);
  return {
    service: new SubscriptionService(db),
    conditions,
    orderings,
    committedTxWrites,
    committedInserts,
  };
}

/** Expiry is `startedAt + days`, with a small timing allowance. */
function expectExpiryDelta(values: Row, days: number): void {
  const startedAt = values.startedAt as Date;
  const expiresAt = values.expiresAt as Date;
  const delta = expiresAt.getTime() - startedAt.getTime();
  expect(delta).toBeGreaterThanOrEqual(days * DAY_MS);
  expect(delta).toBeLessThan(days * DAY_MS + 5_000);
}

describe('SubscriptionService.purchase — row insertion (spec §15.1.8)', () => {
  it('inserts a NEW row with the requested plan and placeholder 30d expiry', async () => {
    const { service, committedInserts } = build();

    const created = await service.purchase(USER_ID, { plan: 'full' });

    expect(committedInserts).toHaveLength(1);
    expect(committedInserts[0].table).toBe(subscription);
    const values = committedInserts[0].values;
    expect(values.studentId).toBe(STUDENT_ID);
    expect(values.plan).toBe('full');
    expect(values.startedAt).toBeInstanceOf(Date);
    expectExpiryDelta(values, 30);
    expect(created).toMatchObject({ id: 'sub-1', plan: 'full' });
  });

  it('advisor purchases get the placeholder 30d advisor duration', async () => {
    const { service, committedInserts } = build();

    await service.purchase(USER_ID, { plan: 'advisor' });

    expect(committedInserts).toHaveLength(1);
    expect(committedInserts[0].values.plan).toBe('advisor');
    expectExpiryDelta(committedInserts[0].values, 30);
  });

  it('a returning student with a paid row still gets a NEW row (no edits)', async () => {
    const { service, committedInserts } = build({
      returningRow: {
        id: 'sub-2',
        studentId: STUDENT_ID,
        plan: 'full',
      },
    });

    const created = await service.purchase(USER_ID, { plan: 'full' });

    // Exactly one fresh insert; no update of any old row ever happens.
    expect(committedInserts).toHaveLength(1);
    expect(created.studentId).toBe(STUDENT_ID);
  });
});

describe('SubscriptionService.purchase — duration from app_config (§15.2)', () => {
  it('respects a configured purchase_full_days override', async () => {
    const { service, committedInserts } = build({
      configRows: [{ quotas: { purchase_full_days: 90 } }],
    });

    await service.purchase(USER_ID, { plan: 'full' });

    expectExpiryDelta(committedInserts[0].values, 90);
  });

  it('respects a configured purchase_advisor_days override', async () => {
    const { service, committedInserts } = build({
      configRows: [{ quotas: { purchase_advisor_days: 14 } }],
    });

    await service.purchase(USER_ID, { plan: 'advisor' });

    expectExpiryDelta(committedInserts[0].values, 14);
  });

  it('falls back to the placeholder defaults for invalid or missing values', async () => {
    const { service, committedInserts } = build({
      configRows: [
        {
          quotas: {
            purchase_full_days: '30', // string → invalid
            purchase_advisor_days: 0, // non-positive → invalid
          },
        },
      ],
    });

    await service.purchase(USER_ID, { plan: 'full' });
    expectExpiryDelta(committedInserts[0].values, 30);

    await service.purchase(USER_ID, { plan: 'advisor' });
    expectExpiryDelta(committedInserts[1].values, 30);
  });

  it('reads only the ACTIVE app_config row, newest version first', async () => {
    const { service, conditions, orderings } = build();

    await service.purchase(USER_ID, { plan: 'full' });

    // conditions[0] = student resolution, conditions[1] = app_config read.
    const { sql: configSql } = dialect.sqlToQuery(conditions[1].condition);
    expect(configSql).toContain('"app_config"."is_active"');
    expect(orderings).toHaveLength(1);
    const orderText = dialect.sqlToQuery(orderings[0]).sql.toLowerCase();
    expect(orderText).toContain('desc');
    expect(orderText).toContain('"app_config"."version"');
  });
});

describe('SubscriptionService.purchase — validation and scoping', () => {
  it("'free' is rejected with 400 and nothing is written", async () => {
    const { service, committedInserts, conditions } = build();

    await expect(
      service.purchase(USER_ID, { plan: 'free' as never }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(committedInserts).toHaveLength(0);
    expect(conditions).toHaveLength(0);
  });

  it('is scoped to the caller account id (never a client param)', async () => {
    const { service, conditions } = build();

    await service.purchase(USER_ID, { plan: 'full' });

    const { sql: text, params } = dialect.sqlToQuery(conditions[0].condition);
    expect(text).toContain('"student"."account_id" =');
    expect(params).toContain(USER_ID);
  });

  it('unknown account → 404, nothing written', async () => {
    const { service, committedInserts } = build({ studentRows: [] });

    await expect(
      service.purchase(USER_ID, { plan: 'full' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(committedInserts).toHaveLength(0);
  });
});

describe('SubscriptionService.purchase — transaction atomicity', () => {
  it('a failing insert rolls back: no committed row, error propagates', async () => {
    const { service, committedTxWrites, committedInserts } = build({
      failOnOp: 'insert',
    });

    await expect(service.purchase(USER_ID, { plan: 'full' })).rejects.toThrow(
      'insert failed',
    );

    expect(committedTxWrites).toEqual([]);
    expect(committedInserts).toHaveLength(0);
  });

  it('a failing student resolution rolls back: no committed row', async () => {
    const { service, committedTxWrites, committedInserts } = build({
      failOnOp: 'resolve',
    });

    await expect(service.purchase(USER_ID, { plan: 'full' })).rejects.toThrow(
      'resolve failed',
    );

    expect(committedTxWrites).toEqual([]);
    expect(committedInserts).toHaveLength(0);
  });

  it('on success everything commits inside the one transaction', async () => {
    const { service, committedTxWrites, committedInserts } = build();

    await service.purchase(USER_ID, { plan: 'full' });

    expect(committedTxWrites).toEqual(['insert-sub']);
    expect(committedInserts).toHaveLength(1);
  });
});
