import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { randomInt } from 'crypto';

import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import type { DbOrTx } from '../../db/types';
import { isUniqueViolation } from '../../db/pg-errors';
import { account } from '../../db/schema/account';
import { referral } from '../../db/schema/referral';
import type { Referral } from '../../db/schema/referral';
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
  studiedTopicIds: string[];
  inviteCode: string;
  createdAt: Date;
  updatedAt: Date;
}

/** One row of GET /users/me/invites (spec 11). */
export interface MyInvite {
  inviteeName: string;
  status: Referral['status'];
  createdAt: Date;
}

/** Generic on purpose: must not reveal which identifier exists (spec 3.2). */
const REGISTRATION_FAILED = 'Registration could not be completed';
const INVALID_INVITE_CODE = 'Invite code is not valid';
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
  studiedTopicIds: student.studiedTopicIds,
  inviteCode: student.inviteCode,
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
  studiedTopicIds: string[] | null;
  inviteCode: string | null;
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

  async findByPhoneNumber(
    phoneNumber: string,
  ): Promise<UserWithProfile | null> {
    const rows = await this.baseQuery()
      .where(
        and(eq(account.mobile, phoneNumber.trim()), eq(account.isActive, true)),
      )
      .limit(1);
    return rows[0] ? this.toUser(rows[0]) : null;
  }

  /**
   * Persist the self-reported studied-topic list (spec 3.2 onboarding).
   * Updates ONLY that column on the existing student row and returns the
   * new list; throws NotFoundException when the student row is missing
   * (no row is ever created here — registration owns student creation).
   */
  async updateStudiedTopics(
    userId: string,
    topicIds: string[],
  ): Promise<string[]> {
    const rows = await this.db
      .update(student)
      .set({ studiedTopicIds: topicIds })
      .where(eq(student.accountId, userId))
      .returning({ studiedTopicIds: student.studiedTopicIds });
    const [row] = rows;
    if (!row) throw new NotFoundException('Student profile not found');
    return row.studiedTopicIds;
  }

  /**
   * Invites sent by this user (spec 11). Scoped by the inviter's account id in
   * the WHERE clause, so a caller can only ever read their own rows.
   */
  async listMyInvites(userId: string): Promise<MyInvite[]> {
    const inviter = alias(student, 'inviter');
    const invitee = alias(student, 'invitee');

    const rows = await this.db
      .select({
        firstName: account.firstName,
        lastName: account.lastName,
        status: referral.status,
        createdAt: referral.createdAt,
      })
      .from(referral)
      .innerJoin(inviter, eq(inviter.id, referral.inviterId))
      .innerJoin(invitee, eq(invitee.id, referral.inviteeId))
      .innerJoin(account, eq(account.id, invitee.accountId))
      .where(eq(inviter.accountId, userId))
      .orderBy(desc(referral.createdAt));

    return rows.map((row) => ({
      inviteeName: [row.firstName, row.lastName]
        .filter(Boolean)
        .join(' ')
        .trim(),
      status: row.status,
      createdAt: row.createdAt,
    }));
  }

  async create(data: {
    nationalId: string;
    phoneNumber: string;
    firstName: string;
    lastName: string;
    inviteCode?: string;
  }): Promise<UserWithProfile> {
    const mobile = data.phoneNumber.trim();
    const credentialHash = hashDevCredential(data.nationalId);
    const { inviteCode } = data;

    let accountId: string;
    try {
      accountId = await this.db.transaction(async (tx) => {
        const taken = await tx
          .select({ id: account.id })
          .from(account)
          .where(
            or(
              eq(account.mobile, mobile),
              eq(account.passwordHash, credentialHash),
            ),
          )
          .limit(1);
        if (taken.length > 0) {
          throw new ConflictException(REGISTRATION_FAILED);
        }

        // Invite (spec 11): resolved before anything is written, inside this
        // transaction, so an unknown code rolls back the whole registration.
        let inviterId: string | undefined;
        if (inviteCode) {
          const [inviter] = await tx
            .select({ id: student.id })
            .from(student)
            .where(eq(student.inviteCode, inviteCode))
            .limit(1);
          if (!inviter) {
            throw new BadRequestException(INVALID_INVITE_CODE);
          }
          inviterId = inviter.id;
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

        const [createdStudent] = await tx
          .insert(student)
          .values({
            accountId: created.id,
            inviteCode: await this.generateUniqueInviteCode(tx),
          })
          .returning({ id: student.id });

        if (inviteCode && inviterId) {
          // Status stays at its 'registered' default: progression, the 48h
          // bonus and the wallet are later tasks (spec 11).
          await tx.insert(referral).values({
            inviterId,
            inviteeId: createdStudent.id,
            codeUsed: inviteCode,
          });
        }

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
      studiedTopicIds: row.studiedTopicIds ?? [],
      inviteCode: row.inviteCode ?? '',
      createdAt: row.accountCreatedAt,
      updatedAt: row.accountUpdatedAt,
    };
  }
}
