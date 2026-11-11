import { BadRequestException } from '@nestjs/common';
import { getTableName } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Db } from '../../db/db.module';
import { UsersService } from './users.service';

const USER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const INVITER_STUDENT_ID = 'aaaa1111-2222-4333-8444-555566667777';
const NEW_ACCOUNT_ID = 'bbbb1111-2222-4333-8444-555566667777';
const NEW_STUDENT_ID = 'cccc1111-2222-4333-8444-555566667777';
const INVITE_CODE = 'AB12CD34';
const OWN_CODE = 'ZZ99YY88';

const REGISTRATION = {
  nationalId: '0012345678',
  phoneNumber: '09120000000',
  firstName: 'علی',
  lastName: 'رضایی',
};

type Row = Record<string, unknown>;
type Op = { table: string; values: Row };

const dialect = new PgDialect();

function profileRow(overrides: Row = {}): Row {
  return {
    id: NEW_ACCOUNT_ID,
    mobile: REGISTRATION.phoneNumber,
    firstName: REGISTRATION.firstName,
    lastName: REGISTRATION.lastName,
    isAdmin: false,
    isActive: true,
    accountCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
    accountUpdatedAt: new Date('2026-01-01T00:00:00.000Z'),
    xp: 0,
    level: 1,
    streak: 0,
    studiedTopicIds: [],
    inviteCode: OWN_CODE,
    ...overrides,
  };
}

/**
 * Fake db for registration: `transaction` stages writes and only "commits"
 * them when the callback resolves, so a rollback really is observable as an
 * empty committed list. Rows are chosen by table name plus the compiled WHERE
 * clause (student lookups are told apart by the invite code they ask for).
 */
function makeDb(
  options: {
    /** Student id the given invite code resolves to; null = unknown code. */
    inviterStudentId?: string | null;
    takenAccount?: boolean;
    profile?: Row | null;
    invites?: Row[];
  } = {},
) {
  const committed: Op[] = [];
  const selects: { table: string; sql: string; params: unknown[] }[] = [];
  let staged: Op[] | null = null;

  const insert = jest.fn((table: unknown) => ({
    values: (values: Row) => {
      const name = getTableName(table as never);
      if (staged) staged.push({ table: name, values });
      else committed.push({ table: name, values });
      return {
        returning: () => {
          if (name === 'account')
            return Promise.resolve([{ id: NEW_ACCOUNT_ID }]);
          if (name === 'student')
            return Promise.resolve([{ id: NEW_STUDENT_ID }]);
          return Promise.resolve([]);
        },
        then: (resolve: (value: unknown) => unknown) => resolve(undefined),
      };
    },
  }));

  const select = jest.fn(() => ({
    from: (table: unknown) => {
      let where: SQL | undefined;
      let joined = false;

      function rows(): unknown[] {
        const name = getTableName(table as never);
        if (name === 'referral') {
          const compiled = where
            ? dialect.sqlToQuery(where)
            : { sql: '', params: [] };
          selects.push({
            table: name,
            sql: compiled.sql,
            params: compiled.params,
          });
          return options.invites ?? [];
        }
        if (name === 'student') {
          const compiled = where
            ? dialect.sqlToQuery(where)
            : { sql: '', params: [] };
          selects.push({
            table: name,
            sql: compiled.sql,
            params: compiled.params,
          });
          const asked = compiled.params[0];
          if (options.inviterStudentId && asked === INVITE_CODE) {
            return [{ id: options.inviterStudentId }];
          }
          return [];
        }
        if (name === 'account' && !joined) {
          return options.takenAccount ? [{ id: 'taken' }] : [];
        }
        if (name === 'account' && joined) {
          return options.profile ? [options.profile] : [];
        }
        return [];
      }

      const chain = {
        where: (condition: SQL) => {
          where = condition;
          return chain;
        },
        leftJoin: () => {
          joined = true;
          return chain;
        },
        innerJoin: () => chain,
        $dynamic: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve(rows()),
        then: (resolve: (value: unknown[]) => unknown) => resolve(rows()),
      };
      return chain;
    },
  }));

  const db = {
    insert,
    select,
    transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      staged = [];
      try {
        const result = await fn({ insert, select });
        committed.push(...staged);
        return result;
      } finally {
        staged = null;
      }
    }),
  } as unknown as Db;

  return { db, log: { committed, selects } };
}

describe('UsersService.create — invite code (spec 11)', () => {
  it('writes exactly one registered referral for a valid code, atomically', async () => {
    const { db, log } = makeDb({
      inviterStudentId: INVITER_STUDENT_ID,
      profile: profileRow(),
    });

    const user = await new UsersService(db).create({
      ...REGISTRATION,
      inviteCode: INVITE_CODE,
    });

    const referrals = log.committed.filter((op) => op.table === 'referral');
    expect(referrals).toHaveLength(1);
    expect(referrals[0].values).toEqual({
      inviterId: INVITER_STUDENT_ID,
      inviteeId: NEW_STUDENT_ID,
      codeUsed: INVITE_CODE,
    });
    // No status is written: the column default ('registered') owns it.
    expect(referrals[0].values).not.toHaveProperty('status');
    // Account and student are written in the same committed transaction.
    expect(log.committed.map((op) => op.table)).toEqual([
      'account',
      'student',
      'referral',
    ]);
    expect(user.inviteCode).toBe(OWN_CODE);
  });

  it('rejects an unknown code with 400 and creates nothing at all', async () => {
    const { db, log } = makeDb({ inviterStudentId: null });

    await expect(
      new UsersService(db).create({ ...REGISTRATION, inviteCode: INVITE_CODE }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // The whole registration rolled back: no account, no student, no referral.
    expect(log.committed).toEqual([]);
  });

  it('resolves the inviter before writing any row', async () => {
    const { db, log } = makeDb({ inviterStudentId: null });

    await expect(
      new UsersService(db).create({ ...REGISTRATION, inviteCode: INVITE_CODE }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const lookup = log.selects.find((select) =>
      select.sql.includes('"student"."invite_code" ='),
    );
    expect(lookup?.params).toEqual([INVITE_CODE]);
  });

  it('creates no referral row when no code is supplied', async () => {
    const { db, log } = makeDb({ profile: profileRow() });

    await new UsersService(db).create(REGISTRATION);

    expect(log.committed.map((op) => op.table)).toEqual(['account', 'student']);
    // The only invite_code lookups are clash checks for the freshly generated
    // code; the supplied code is never resolved.
    const inviteLookups = log.selects.filter(
      (select) =>
        select.sql.includes('"student"."invite_code" =') &&
        select.params.includes(INVITE_CODE),
    );
    expect(inviteLookups).toEqual([]);
  });

  it('still rejects a duplicate registration before touching referrals', async () => {
    const { db, log } = makeDb({
      inviterStudentId: INVITER_STUDENT_ID,
      takenAccount: true,
    });

    await expect(
      new UsersService(db).create({ ...REGISTRATION, inviteCode: INVITE_CODE }),
    ).rejects.toThrow();

    expect(log.committed).toEqual([]);
  });
});

describe('UsersService.listMyInvites', () => {
  it('maps the joined invitee name, status and date', async () => {
    const { db } = makeDb({
      invites: [
        {
          firstName: 'مریم',
          lastName: 'احمدی',
          status: 'registered',
          createdAt: new Date('2026-02-01T10:00:00.000Z'),
        },
      ],
    });

    const invites = await new UsersService(db).listMyInvites(USER_ID);

    expect(invites).toEqual([
      {
        inviteeName: 'مریم احمدی',
        status: 'registered',
        createdAt: new Date('2026-02-01T10:00:00.000Z'),
      },
    ]);
  });

  it("only queries rows whose inviter is the caller's own account", async () => {
    const { db, log } = makeDb({ invites: [] });

    const invites = await new UsersService(db).listMyInvites(USER_ID);

    expect(invites).toEqual([]);
    // The scope lives in the SQL, not in a post-filter: the inviter is joined
    // and matched against the caller's account id.
    const [query] = log.selects;
    expect(query.sql).toContain('"inviter"."account_id" =');
    expect(query.params).toEqual([USER_ID]);
  });

  it('falls back to an empty name when both name parts are missing', async () => {
    const { db } = makeDb({
      invites: [
        {
          firstName: null,
          lastName: null,
          status: 'registered',
          createdAt: new Date('2026-02-01T10:00:00.000Z'),
        },
      ],
    });

    const [invite] = await new UsersService(db).listMyInvites(USER_ID);

    expect(invite.inviteeName).toBe('');
  });
});
