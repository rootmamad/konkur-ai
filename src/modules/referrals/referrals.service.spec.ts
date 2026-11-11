import { Logger } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Db } from '../../db/db.module';
import { appConfig } from '../../db/schema/app-config';
import { subscription } from '../../db/schema/billing';
import { referral } from '../../db/schema/referral';
import { ReferralsService } from './referrals.service';

const INVITER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const INVITEE_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';
const DAY_MS = 86_400_000;

const dialect = new PgDialect();

type Row = Record<string, unknown>;

interface MakeDbOptions {
  /** Rows the guarded referral UPDATE ... RETURNING yields. */
  referralRows?: Row[];
  /** When true, only the FIRST referral UPDATE returns rows (retry test). */
  referralRowsOnce?: boolean;
  /** Active app_config rows. */
  configRows?: Row[];
  /** Sequential results of the paid-subscription pick (one entry per call). */
  paidRowsPerCall?: Row[][];
  /** Error injection points. */
  failOnOp?: 'milestone' | 'transition' | 'invitee-grant';
}

/**
 * Fluent mock with a STAGED-COMMIT transaction fake: writes issued inside
 * `db.transaction` are collected and only become visible in
 * `committedTxWrites` when the callback RESOLVES; a rejection discards them
 * (rollback). This is what proves the transition + grants are atomic.
 *
 * Captured conditions render to real SQL via `dialect.sqlToQuery` so tests
 * assert the actual guards, not Drizzle internals.
 */
function makeDb(options: MakeDbOptions = {}) {
  const conditions: { table: unknown; condition: SQL }[] = [];
  const sets: Row[] = [];
  /** ALL subscription inserts attempted (staged ones included). */
  const insertCalls: { table: unknown; values: Row }[] = [];
  /** ALL subscription expiry-extensions attempted. */
  const subExtendCalls: { values: Row; where: SQL }[] = [];
  const fromTables: unknown[] = [];
  /** Op labels committed with a transaction (empty after a rollback). */
  const committedTxWrites: string[] = [];
  let stagedTxWrites: string[] = [];
  let referralUpdateCalls = 0;
  let paidCallIndex = 0;

  const pickPaid = (): Row[] => {
    const rows = options.paidRowsPerCall?.[paidCallIndex] ?? [];
    paidCallIndex += 1;
    return rows;
  };

  const makeThenable = (fail: boolean, err: string) => ({
    then: (resolve: (v?: unknown) => void, reject?: (e: Error) => void) => {
      if (fail && reject) reject(new Error(err));
      else resolve();
    },
  });

  const referralUpdateChain = (label: string, insideTx: boolean) => ({
    set: (values: Row) => {
      sets.push(values);
      return {
        where: (condition: SQL) => {
          conditions.push({ table: referral, condition });
          referralUpdateCalls += 1;
          if (insideTx) stagedTxWrites.push(label);
          else committedTxWrites.push(label);
          const fail =
            (options.failOnOp === 'milestone' && !insideTx) ||
            (options.failOnOp === 'transition' && insideTx);
          if (fail) return makeThenable(true, `${label} failed`);
          const rows =
            options.referralRowsOnce && referralUpdateCalls > 1
              ? []
              : (options.referralRows ?? []);
          return { returning: () => Promise.resolve(rows) };
        },
      };
    },
  });

  const subUpdateChain = (insideTx: boolean) => ({
    set: (values: Row) => ({
      where: (condition: SQL) => {
        subExtendCalls.push({ values, where: condition });
        if (insideTx) stagedTxWrites.push('extend-sub');
        return makeThenable(false, '');
      },
    }),
  });

  const selectChain = () => ({
    from: (table: unknown) => {
      fromTables.push(table);
      const chain = {
        innerJoin: () => chain,
        where: (condition: SQL) => {
          conditions.push({ table, condition });
          return chain;
        },
        orderBy: () => chain,
        limit: () =>
          Promise.resolve(
            table === appConfig ? (options.configRows ?? []) : pickPaid(),
          ),
        then: (resolve: (rows: Row[]) => void) =>
          resolve(
            table === appConfig ? (options.configRows ?? []) : pickPaid(),
          ),
      };
      return chain;
    },
  });

  const txProxy = {
    select: jest.fn(() => selectChain()),
    update: jest.fn((table: unknown) =>
      table === referral
        ? referralUpdateChain('transition', true)
        : subUpdateChain(true),
    ),
    insert: jest.fn((table: unknown) => ({
      values: (values: Row) => {
        insertCalls.push({ table, values });
        stagedTxWrites.push('insert-sub');
        // Inject on the SECOND grant (the invitee, after the inviter).
        const fail =
          options.failOnOp === 'invitee-grant' && insertCalls.length >= 2;
        return fail
          ? makeThenable(true, 'invitee grant failed')
          : makeThenable(false, '');
      },
    })),
  };

  const db = {
    select: jest.fn(() => selectChain()),
    update: jest.fn((table: unknown) =>
      table === referral
        ? referralUpdateChain('milestone', false)
        : subUpdateChain(false),
    ),
    insert: jest.fn(() => {
      throw new Error('no writes outside a transaction');
    }),
    transaction: jest.fn(
      async (callback: (t: typeof txProxy) => Promise<unknown>) => {
        stagedTxWrites = [];
        try {
          const result = await callback(txProxy);
          committedTxWrites.push(...stagedTxWrites);
          stagedTxWrites = [];
          return result;
        } catch (err) {
          // Rollback: staged writes are discarded, nothing is committed.
          stagedTxWrites = [];
          throw err;
        }
      },
    ),
  } as unknown as Db;

  return {
    db,
    log: {
      conditions,
      sets,
      insertCalls,
      subExtendCalls,
      fromTables,
      committedTxWrites,
    },
  };
}

function build(options: MakeDbOptions = {}) {
  const { db, log } = makeDb(options);
  const service = new ReferralsService(db);
  return { service, log };
}

const beforeMs = () => Date.now();

function expectExpiryDelta(
  expiresAt: Date,
  beforeMsValue: number,
  days: number,
) {
  const delta = expiresAt.getTime() - beforeMsValue;
  expect(delta).toBeGreaterThanOrEqual(days * DAY_MS);
  expect(delta).toBeLessThan(days * DAY_MS + 5_000);
}

describe('ReferralsService.onInviteeExamFinished — milestone only', () => {
  it('moves registered -> first_exam with the guarded UPDATE', async () => {
    const { service, log } = build({
      referralRows: [{ inviterId: INVITER_ID }],
    });

    await service.onInviteeExamFinished(INVITEE_ID);

    expect(log.conditions[0].table).toBe(referral);
    expect(log.sets[0]).toMatchObject({ status: 'first_exam' });
    const { sql: text, params } = dialect.sqlToQuery(
      log.conditions[0].condition,
    );
    expect(text).toContain('"referral"."invitee_id" =');
    expect(text).toContain('"referral"."status" =');
    expect(params).toEqual([INVITEE_ID, 'registered']);
  });

  it('writes NO subscription rows on the first_exam path', async () => {
    const { service, log } = build({
      referralRows: [{ inviterId: INVITER_ID }],
    });

    await service.onInviteeExamFinished(INVITEE_ID);

    expect(log.insertCalls).toHaveLength(0);
    expect(log.subExtendCalls).toHaveLength(0);
    // The only write is the milestone UPDATE itself — never a grant, and
    // no config lookup either.
    expect(log.committedTxWrites).toEqual(['milestone']);
    expect(log.fromTables).not.toContain(appConfig);
  });

  it('zero updated rows (no referral, or already progressed) -> pure no-op', async () => {
    const { service, log } = build({ referralRows: [] });

    await service.onInviteeExamFinished(INVITEE_ID);

    expect(log.insertCalls).toHaveLength(0);
    expect(log.subExtendCalls).toHaveLength(0);
    expect(log.fromTables).not.toContain(appConfig);
  });

  it('logs and swallows its own errors (fire-and-forget safe)', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const { service } = build({ failOnOp: 'milestone' });

    await expect(
      service.onInviteeExamFinished(INVITEE_ID),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});

describe('ReferralsService.onInviteePurchased — guarded transition', () => {
  it('fires directly from registered (purchase without any exam)', async () => {
    const before = beforeMs();
    const { service, log } = build({
      referralRows: [{ inviterId: INVITER_ID }],
    });

    await service.onInviteePurchased(INVITEE_ID);

    const referralCondition = log.conditions.find(
      (c) => c.table === referral,
    )?.condition;
    expect(referralCondition).toBeDefined();
    expect(log.sets[0]).toMatchObject({ status: 'purchased' });
    const { sql: text, params } = dialect.sqlToQuery(referralCondition as SQL);
    expect(text).toContain('"referral"."invitee_id" =');
    expect(text).toContain('"referral"."status" in');
    expect(params).toEqual([INVITEE_ID, 'registered', 'first_exam']);
    // Both bonuses granted fresh.
    expect(log.insertCalls).toHaveLength(2);
    expectExpiryDelta(log.insertCalls[0].values.expiresAt as Date, before, 7);
    expectExpiryDelta(log.insertCalls[1].values.expiresAt as Date, before, 2);
  });

  it('also fires from first_exam (the guard accepts both states)', async () => {
    const { service, log } = build({
      referralRows: [{ inviterId: INVITER_ID }],
    });

    await service.onInviteePurchased(INVITEE_ID);

    const referralCondition = log.conditions.find(
      (c) => c.table === referral,
    )?.condition;
    const { params } = dialect.sqlToQuery(referralCondition as SQL);
    expect(params).toEqual([INVITEE_ID, 'registered', 'first_exam']);
    expect(log.committedTxWrites).toEqual([
      'transition',
      'insert-sub',
      'insert-sub',
    ]);
  });

  it('already purchased or no referral row -> pure no-op', async () => {
    const { service, log } = build({ referralRows: [] });

    await service.onInviteePurchased(INVITEE_ID);

    // The guarded UPDATE statement ran but matched zero rows: it commits as
    // the only write — no grant, extension or config read ever follows.
    expect(log.committedTxWrites).toEqual(['transition']);
    expect(log.insertCalls).toHaveLength(0);
    expect(log.subExtendCalls).toHaveLength(0);
    // Returns before reading the config: no app_config lookup at all.
    expect(log.fromTables).not.toContain(appConfig);
  });

  it('is retry-safe: only the first winning call grants', async () => {
    const { service, log } = build({
      referralRows: [{ inviterId: INVITER_ID }],
      referralRowsOnce: true,
    });

    await service.onInviteePurchased(INVITEE_ID);
    await service.onInviteePurchased(INVITEE_ID);

    expect(log.insertCalls).toHaveLength(2); // exactly one grant round
  });
});

describe('ReferralsService.onInviteePurchased — grants', () => {
  it('extends the inviter active paid row by 7d FROM ITS expiry; invitee fresh', async () => {
    const base = new Date('2026-02-01T00:00:00.000Z');
    const { service, log } = build({
      referralRows: [{ inviterId: INVITER_ID }],
      paidRowsPerCall: [[{ id: 'sub-1', expiresAt: base }], []],
    });

    await service.onInviteePurchased(INVITEE_ID);

    expect(log.subExtendCalls).toHaveLength(1);
    expect(dialect.sqlToQuery(log.subExtendCalls[0].where).sql).toContain(
      '"subscription"."id" =',
    );
    expect(log.subExtendCalls[0].values.expiresAt).toEqual(
      new Date(base.getTime() + 7 * DAY_MS),
    );
    // Only the invitee got a fresh row; the inviter was extended instead.
    expect(log.insertCalls).toHaveLength(1);
    expect(log.insertCalls[0].values).toMatchObject({
      studentId: INVITEE_ID,
      plan: 'full',
    });
    expect(log.committedTxWrites).toEqual([
      'transition',
      'extend-sub',
      'insert-sub',
    ]);
  });

  it('extends the invitee fresh purchase by 2d; inviter fresh 7d', async () => {
    const base = new Date('2026-03-15T12:00:00.000Z');
    const { service, log } = build({
      referralRows: [{ inviterId: INVITER_ID }],
      paidRowsPerCall: [[], [{ id: 'sub-2', expiresAt: base }]],
    });

    await service.onInviteePurchased(INVITEE_ID);

    expect(log.subExtendCalls).toHaveLength(1);
    expect(log.subExtendCalls[0].values.expiresAt).toEqual(
      new Date(base.getTime() + 2 * DAY_MS),
    );
    expect(log.insertCalls).toHaveLength(1);
    expect(log.insertCalls[0].values).toMatchObject({
      studentId: INVITER_ID,
      plan: 'full',
    });
  });

  it('an unlimited (NULL-expiry) paid row is left untouched; the other side still granted', async () => {
    const { service, log } = build({
      referralRows: [{ inviterId: INVITER_ID }],
      paidRowsPerCall: [[{ id: 'sub-0', expiresAt: null }], []],
    });

    await service.onInviteePurchased(INVITEE_ID);

    expect(log.subExtendCalls).toHaveLength(0);
    expect(log.insertCalls).toHaveLength(1);
    expect(log.insertCalls[0].values).toMatchObject({
      studentId: INVITEE_ID,
      plan: 'full',
    });
  });

  it('the paid-pick SQL excludes free plans and expired rows', async () => {
    const { service, log } = build({
      referralRows: [{ inviterId: INVITER_ID }],
    });

    await service.onInviteePurchased(INVITEE_ID);

    const paidCondition = log.conditions.find(
      (c) => c.table === subscription,
    )?.condition;
    expect(paidCondition).toBeDefined();
    const { sql: text } = dialect.sqlToQuery(paidCondition as SQL);
    expect(text).toContain('"subscription"."student_id" =');
    expect(text).toContain('"subscription"."plan" in');
    expect(text).toContain('"subscription"."expires_at" is null');
    expect(text).toContain('"subscription"."expires_at" > now()');
  });
});

describe('ReferralsService bonus days (app_config)', () => {
  it('defaults to 7d inviter / 2d invitee when no config row exists', async () => {
    const before = beforeMs();
    const { service, log } = build({
      referralRows: [{ inviterId: INVITER_ID }],
      configRows: [],
    });

    await service.onInviteePurchased(INVITEE_ID);

    expectExpiryDelta(log.insertCalls[0].values.expiresAt as Date, before, 7);
    expectExpiryDelta(log.insertCalls[1].values.expiresAt as Date, before, 2);
  });

  it('applies configured referral_inviter_bonus_days / referral_invitee_bonus_days', async () => {
    const before = beforeMs();
    const { service, log } = build({
      referralRows: [{ inviterId: INVITER_ID }],
      configRows: [
        {
          quotas: {
            referral_inviter_bonus_days: 30,
            referral_invitee_bonus_days: 5,
          },
        },
      ],
    });

    await service.onInviteePurchased(INVITEE_ID);

    expectExpiryDelta(log.insertCalls[0].values.expiresAt as Date, before, 30);
    expectExpiryDelta(log.insertCalls[1].values.expiresAt as Date, before, 5);
  });

  it('falls back to the defaults for invalid configured values', async () => {
    const before = beforeMs();
    const { service, log } = build({
      referralRows: [{ inviterId: INVITER_ID }],
      configRows: [
        {
          quotas: {
            referral_inviter_bonus_days: '30',
            referral_invitee_bonus_days: 0,
          },
        },
      ],
    });

    await service.onInviteePurchased(INVITEE_ID);

    expectExpiryDelta(log.insertCalls[0].values.expiresAt as Date, before, 7);
    expectExpiryDelta(log.insertCalls[1].values.expiresAt as Date, before, 2);
  });
});

describe('ReferralsService.onInviteePurchased — atomicity', () => {
  it('a failing grant rolls the transition back (staged-commit fake)', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const { service, log } = build({
      referralRows: [{ inviterId: INVITER_ID }],
      failOnOp: 'invitee-grant',
    });

    // Public boundary: swallowed, resolved, never rejects.
    await expect(
      service.onInviteePurchased(INVITEE_ID),
    ).resolves.toBeUndefined();

    // All-or-nothing: the winning transition was rolled back with the grants.
    expect(log.committedTxWrites).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('on success the transition and both grants commit together', async () => {
    const { service, log } = build({
      referralRows: [{ inviterId: INVITER_ID }],
    });

    await service.onInviteePurchased(INVITEE_ID);

    expect(log.committedTxWrites).toEqual([
      'transition',
      'insert-sub',
      'insert-sub',
    ]);
  });
});
