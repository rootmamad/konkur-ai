import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, eq, or } from 'drizzle-orm';
import { randomInt } from 'crypto';

import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import type { DbOrTx } from '../../db/types';
import { isUniqueViolation } from '../../db/pg-errors';
import { account } from '../../db/schema/account';
import { student } from '../../db/schema/student';
import { hashDevCredential } from '../auth/dev-credential';

export interface UserWithProfile {
  id: string;
  nationalId: string;
  phoneNumber: string;
  firstName: string;
  lastName: string;
  role: string;
  isActive: boolean;
  xp: number;
  level: number;
  streak: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Generic on purpose: must not reveal which identifier exists (spec 3.2). */
const REGISTRATION_FAILED = 'Registration could not be completed';
const INVITE_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const INVITE_CODE_LENGTH = 8;
const INVITE_CODE_MAX_TRIES = 5;

const profileColumns = {
  id: account.id,
  mobile: account.mobile,
  firstName: account.firstName,
  lastName: account.lastName,
  isAdmin: account.isAdmin,
  isActive: account.isActive,
  accountCreatedAt: account.createdAt,
  accountUpdatedAt: account.updatedAt,
  xp: student.xp,
  level: student.level,
  streak: student.streak,
};

type ProfileRow = {
  id: string;
  mobile: string;
  firstName: string | null;
  lastName: string | null;
  isAdmin: boolean;
  isActive: boolean;
  accountCreatedAt: Date;
  accountUpdatedAt: Date;
  xp: number | null;
  level: number | null;
  streak: number | null;
};

@Injectable()
export class UsersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findAll(): Promise<UserWithProfile[]> {
    const rows = await this.baseQuery().where(eq(account.isActive, true));
    return rows.map((row) => this.toUser(row));
  }

  async findById(id: string): Promise<UserWithProfile | null> {
    const rows = await this.baseQuery()
      .where(and(eq(account.id, id), eq(account.isActive, true)))
      .limit(1);
    return rows[0] ? this.toUser(rows[0]) : null;
  }

  async findByPhoneNumber(phoneNumber: string): Promise<UserWithProfile | null> {
    const rows = await this.baseQuery()
      .where(and(eq(account.mobile, phoneNumber.trim()), eq(account.isActive, true)))
      .limit(1);
    return rows[0] ? this.toUser(rows[0]) : null;
  }

  async create(data: {
    nationalId: string;
    phoneNumber: string;
    firstName: string;
    lastName: string;
  }): Promise<UserWithProfile> {
    const mobile = data.phoneNumber.trim();
    const credentialHash = hashDevCredential(data.nationalId);

    let accountId: string;
    try {
      accountId = await this.db.transaction(async (tx) => {
        const taken = await tx
          .select({ id: account.id })
          .from(account)
          .where(or(eq(account.mobile, mobile), eq(account.passwordHash, credentialHash)))
          .limit(1);
        if (taken.length > 0) {
          throw new ConflictException(REGISTRATION_FAILED);
        }

        const [created] = await tx
          .insert(account)
          .values({
            mobile,
            passwordHash: credentialHash,
            firstName: data.firstName.trim(),
            lastName: data.lastName.trim(),
            isAdmin: false,
            isActive: true,
          })
          .returning({ id: account.id });

        await tx.insert(student).values({
          accountId: created.id,
          inviteCode: await this.generateUniqueInviteCode(tx),
        });

        return created.id;
      });
    } catch (error) {
      // Concurrent registration with the same mobile hits the unique index.
      if (isUniqueViolation(error)) {
        throw new ConflictException(REGISTRATION_FAILED);
      }
      throw error;
    }

    const user = await this.findById(accountId);
    if (!user) {
      throw new Error('Created account could not be loaded');
    }
    return user;
  }

  private baseQuery() {
    return this.db
      .select(profileColumns)
      .from(account)
      .leftJoin(student, eq(student.accountId, account.id))
      .$dynamic();
  }

  private async generateUniqueInviteCode(executor: DbOrTx): Promise<string> {
    for (let i = 0; i < INVITE_CODE_MAX_TRIES; i++) {
      const code = Array.from(
        { length: INVITE_CODE_LENGTH },
        () => INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)],
      ).join('');
      const clash = await executor
        .select({ id: student.id })
        .from(student)
        .where(eq(student.inviteCode, code))
        .limit(1);
      if (clash.length === 0) return code;
    }
    throw new Error('Could not generate a unique invite code');
  }

  private toUser(row: ProfileRow): UserWithProfile {
    return {
      id: row.id,
      nationalId: '', // never stored in plain text
      phoneNumber: row.mobile,
      firstName: row.firstName ?? '',
      lastName: row.lastName ?? '',
      role: row.isAdmin ? 'admin' : 'student',
      isActive: row.isActive,
      xp: row.xp ?? 0,
      level: row.level ?? 1,
      streak: row.streak ?? 0,
      createdAt: row.accountCreatedAt,
      updatedAt: row.accountUpdatedAt,
    };
  }
}
