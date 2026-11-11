import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Db } from '../../db/db.module';
import { SubscriptionService } from './subscription.service';

const USER_ID = '9f1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const dialect = new PgDialect();

type Row = Record<string, unknown>;

interface MakeDbOptions {
  /** Rows for the status lookup (the chain WITH orderBy). */
  statusRows?: Row[];
  /** Rows for the paid predicate (the chain WITHOUT orderBy). */
  paidRows?: Row[];
}

/**
 * Fluent mock of the two chain shapes SubscriptionService uses. The two
 * selects differ only by `orderBy`, so chains are keyed by that.
 */
function makeDb(options: MakeDbOptions = {}) {
  const conditions: SQL[] = [];
  const db = {
    select: jest.fn(() => {
      let ordered = false;
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: (condition: SQL) => {
          conditions.push(condition);
          return chain;
        },
        orderBy: () => {
          ordered = true;
          return chain;
        },
        limit: () =>
          Promise.resolve(
            ordered ? (options.statusRows ?? []) : (options.paidRows ?? []),
          ),
      };
      return chain;
    }),
  } as unknown as Db;
  return { db, conditions };
}

function build(options: MakeDbOptions = {}) {
  const { db, conditions } = makeDb(options);
  return { service: new SubscriptionService(db), conditions };
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
