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

const dialect = new PgDialect();

type Row = Record<string, unknown>;

interface MakeDbOptions {
  /** Rows the transition UPDATE ... RETURNING yields. */
  referralRows?: Row[];
  /** Active app_config rows. */
  configRows?: Row[];
  /** Per-call results of the paid-subscription check (shifted each call). */
  paidRowsPerCall?: Row[][];
  /** Make the transition UPDATE throw (swallow test). */
  failOnUpdate?: string;
}

/**
 * Fluent mock of the three chain shapes ReferralsService uses:
 *   update(referral).set(v).where(c).returning(sel)
 *   select(...).from(t).where(c)[.orderBy(o)].limit(1)
 *   insert(subscription).values(v)
 *
 * Captured conditions are kept so tests can render the real SQL with
 * `dialect.sqlToQuery` instead of inspecting Drizzle internals.
 */
function makeDb(options: MakeDbOptions = {}) {
  const conditions: { table: unknown; condition: SQL }[] = [];
  const sets: Row[] = [];
  const inserts: { table: unknown; values: Row }[] = [];
  const fromTables: unknown[] = [];

  const update = jest.fn((table: unknown) => {
    if (options.failOnUpdate) throw new Error(options.failOnUpdate);
    return {
      set: (values: Row) => {
        sets.push(values);
        return {
          where: (condition: SQL) => {
            conditions.push({ table, condition });
            return {
              returning: () => Promise.resolve(options.referralRows ?? []),
            };
          },
        };
      },
    };
  });

  const insert = jest.fn((table: unknown) => ({
    values: (values: Row) => {
      inserts.push({ table, values });
      return { then: (resolve: (value?: unknown) => void) => resolve() };
    },
  }));

  const select = jest.fn(() => ({
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
            table === appConfig
              ? (options.configRows ?? [])
              : (options.paidRowsPerCall?.shift() ?? []),
          ),
        then: (resolve: (rows: Row[]) => void) =>
          resolve(
            table === appConfig
              ? (options.configRows ?? [])
              : (options.paidRowsPerCall?.shift() ?? []),
          ),
      };
      return chain;
    },
  }));

  const db = { select, update, insert } as unknown as Db;
  return { db, log: { conditions, sets, inserts, fromTables } };
}

function build(options: MakeDbOptions = {}) {
  const { db, log } = makeDb(options);
  const service = new ReferralsService(db);
  return { service, log };
}

const BEFORE_MS = () => Date.now();

function expectExpiryDelta(expiresAt: Date, beforeMs: number, hours: number) {
  const delta = expiresAt.getTime() - beforeMs;
  expect(delta).toBeGreaterThanOrEqual(hours * 3_600_000);
  expect(delta).toBeLessThan(hours * 3_600_000 + 5_000);
}

describe('ReferralsService.onInviteeExamFinished — transition', () => {
  it('registered -> first_exam: single guarded UPDATE, then grants', async () => {
    const { service, log } = build({
      referralRows: [{ inviterId: INVITER_ID }],
    });

    await service.onInviteeExamFinished(INVITEE_ID);

    // The transition targets the referral row itself.
    expect(log.conditions[0].table).toBe(referral);
    expect(log.sets[0]).toMatchObject({ status: 'first_exam' });
    expect(log.sets[0]?.updatedAt).toBeInstanceOf(Date);
    const { sql: text, params } = dialect.sqlToQuery(
      log.conditions[0].condition,
    );
    expect(text).toContain('"referral"."invitee_id" =');
    expect(text).toContain('"referral"."status" =');
    expect(params).toEqual([INVITEE_ID, 'registered']);
  });

  it('zero updated rows (no referral, or already progressed) -> pure no-op', async () => {
    const { service, log } = build({ referralRows: [] });

    await service.onInviteeExamFinished(INVITEE_ID);

    expect(log.inserts).toHaveLength(0);
    // Returns before reading the config: no app_config lookup at all.
    expect(log.fromTables).not.toContain(appConfig);
  });
});

describe('ReferralsService.onInviteeExamFinished — grant', () => {
  it('both sides unpaid -> two full-access subscription rows', async () => {
    const before = BEFORE_MS();
    const { service, log } = build({
      referralRows: [{ inviterId: INVITER_ID }],
    });

    await service.onInviteeExamFinished(INVITEE_ID);

    expect(log.inserts).toHaveLength(2);
    const [first, second] = log.inserts;
    expect(first.table).toBe(subscription);
    expect(first.values).toMatchObject({
      studentId: INVITER_ID,
      plan: 'full',
    });
    expect(second.table).toBe(subscription);
    expect(second.values).toMatchObject({
      studentId: INVITEE_ID,
      plan: 'full',
    });
    expectExpiryDelta(first.values.expiresAt as Date, before, 48);
  });

  it('inviter on active paid access -> only the invitee is granted', async () => {
    const { service, log } = build({
      referralRows: [{ inviterId: INVITER_ID }],
      paidRowsPerCall: [[{ id: 'sub-1' }], []],
    });

    await service.onInviteeExamFinished(INVITEE_ID);

    expect(log.inserts).toHaveLength(1);
    expect(log.inserts[0].values).toMatchObject({
      studentId: INVITEE_ID,
      plan: 'full',
    });
  });

  it('invitee on active paid access -> only the inviter is granted', async () => {
    const { service, log } = build({
      referralRows: [{ inviterId: INVITER_ID }],
      paidRowsPerCall: [[], [{ id: 'sub-2' }]],
    });

    await service.onInviteeExamFinished(INVITEE_ID);

    expect(log.inserts).toHaveLength(1);
    expect(log.inserts[0].values).toMatchObject({
      studentId: INVITER_ID,
      plan: 'full',
    });
  });

  it('the paid-check SQL excludes free plans and expired rows', async () => {
    const { service, log } = build({
      referralRows: [{ inviterId: INVITER_ID }],
    });

    await service.onInviteeExamFinished(INVITEE_ID);

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

describe('ReferralsService bonus hours (app_config)', () => {
  it('defaults to 48h when no active config row exists', async () => {
    const before = BEFORE_MS();
    const { service, log } = build({
      referralRows: [{ inviterId: INVITER_ID }],
      configRows: [],
    });

    await service.onInviteeExamFinished(INVITEE_ID);

    expectExpiryDelta(log.inserts[0].values.expiresAt as Date, before, 48);
  });

  it('applies a configured referral_bonus_hours value', async () => {
    const before = BEFORE_MS();
    const { service, log } = build({
      referralRows: [{ inviterId: INVITER_ID }],
      configRows: [{ quotas: { referral_bonus_hours: 72 } }],
    });

    await service.onInviteeExamFinished(INVITEE_ID);

    expectExpiryDelta(log.inserts[0].values.expiresAt as Date, before, 72);
  });

  it('falls back to 48h for invalid configured values', async () => {
    for (const invalid of ['48', 0, 2.5, null]) {
      const before = BEFORE_MS();
      const { service, log } = build({
        referralRows: [{ inviterId: INVITER_ID }],
        configRows: [{ quotas: { referral_bonus_hours: invalid } }],
      });

      await service.onInviteeExamFinished(INVITEE_ID);

      expectExpiryDelta(log.inserts[0].values.expiresAt as Date, before, 48);
    }
  });
});

describe('ReferralsService error containment', () => {
  it('logs and swallows its own errors instead of rejecting', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const { service } = build({ failOnUpdate: 'db down' });

    await expect(
      service.onInviteeExamFinished(INVITEE_ID),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
