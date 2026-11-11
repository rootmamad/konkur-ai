import { NotFoundException } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Db } from '../../db/db.module';
import { UsersService } from './users.service';

const USER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const TOPIC_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';

type Row = Record<string, unknown>;

const dialect = new PgDialect();

/** One profile row exactly as the account+student join select returns it. */
function profileRow(overrides: Row = {}): Row {
  return {
    id: USER_ID,
    mobile: '09120000000',
    firstName: 'علی',
    lastName: 'رضایی',
    isAdmin: false,
    isActive: true,
    accountCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
    accountUpdatedAt: new Date('2026-01-02T00:00:00.000Z'),
    xp: 10,
    level: 2,
    streak: 3,
    studiedTopicIds: [TOPIC_ID],
    inviteCode: 'AB12CD34',
    ...overrides,
  };
}

/**
 * Fluent mock of the two chain shapes UsersService uses:
 *   select(...).from(account).leftJoin(student, ...).$dynamic().where(c).limit(1)
 *   update(student).set(v).where(c).returning(sel)
 *
 * Captured conditions are kept so tests can render the real SQL with
 * `dialect.sqlToQuery` instead of inspecting Drizzle internals.
 */
function makeDb(options: { profile?: Row | null; returning?: Row[] } = {}) {
  const conditions: SQL[] = [];
  const sets: Row[] = [];

  const update = jest.fn(() => ({
    set: (values: Row) => {
      sets.push(values);
      return {
        where: (condition: SQL) => {
          conditions.push(condition);
          return {
            returning: () => Promise.resolve(options.returning ?? []),
          };
        },
      };
    },
  }));

  const select = jest.fn(() => {
    const chain = {
      leftJoin: () => chain,
      $dynamic: () => chain,
      where: (condition: SQL) => {
        conditions.push(condition);
        return chain;
      },
      limit: () => Promise.resolve(options.profile ? [options.profile] : []),
      then: (resolve: (rows: Row[]) => void) =>
        resolve(options.profile ? [options.profile] : []),
    };
    return { from: () => chain };
  });

  const db = { select, update } as unknown as Db;
  return { db, log: { conditions, sets, select, update } };
}

function build(options?: { profile?: Row | null; returning?: Row[] }) {
  const { db, log } = makeDb(options);
  const service = new UsersService(db);
  return { service, log };
}

describe('UsersService.updateStudiedTopics', () => {
  it('persists the list on the existing student row and returns it', async () => {
    const list = [TOPIC_ID];
    const { service, log } = build({ returning: [{ studiedTopicIds: list }] });

    const result = await service.updateStudiedTopics(USER_ID, list);

    expect(result).toEqual(list);
    // ONLY that column is written — no other field is touched.
    expect(log.sets).toEqual([{ studiedTopicIds: list }]);
    // Scoped to the account's own student row.
    const { sql: text, params } = dialect.sqlToQuery(log.conditions[0]);
    expect(text).toContain('"student"."account_id" =');
    expect(params).toEqual([USER_ID]);
  });

  it('an empty array clears the list (update still writes only that column)', async () => {
    const { service, log } = build({ returning: [{ studiedTopicIds: [] }] });

    const result = await service.updateStudiedTopics(USER_ID, []);

    expect(result).toEqual([]);
    expect(log.sets).toEqual([{ studiedTopicIds: [] }]);
  });

  it('throws NotFound when the student row is missing (no row is created)', async () => {
    const { service, log } = build({ returning: [] });

    await expect(
      service.updateStudiedTopics(USER_ID, [TOPIC_ID]),
    ).rejects.toBeInstanceOf(NotFoundException);
    // The write targeted only the column and matched no rows.
    expect(log.sets).toEqual([{ studiedTopicIds: [TOPIC_ID] }]);
  });
});

describe('UsersService profile mapping (findById / getMe)', () => {
  it('maps studiedTopicIds through to the user profile', async () => {
    const { service } = build({
      profile: profileRow({ studiedTopicIds: [TOPIC_ID] }),
    });

    const user = await service.findById(USER_ID);

    expect(user?.studiedTopicIds).toEqual([TOPIC_ID]);
    expect(user?.streak).toBe(3);
  });

  it('maps the student invite code through to the profile', async () => {
    const { service } = build({ profile: profileRow() });

    const user = await service.findById(USER_ID);

    expect(user?.inviteCode).toBe('AB12CD34');
  });

  it('defaults studiedTopicIds to [] when the column is null', async () => {
    const { service } = build({
      profile: profileRow({ studiedTopicIds: null }),
    });

    const user = await service.findById(USER_ID);

    expect(user?.studiedTopicIds).toEqual([]);
  });
});
