import { Injectable, Inject } from '@nestjs/common';
import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import { account } from '../../db/schema/account';
import { student } from '../../db/schema/student';
import { eq, and } from 'drizzle-orm';
import * as crypto from 'crypto';

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

@Injectable()
export class UsersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findAll(): Promise<UserWithProfile[]> {
    const rows = await this.db
      .select({
        id: account.id,
        mobile: account.mobile,
        firstName: account.firstName,
        lastName: account.lastName,
        isAdmin: account.isAdmin,
        isActive: account.isActive,
        accountCreatedAt: account.createdAt,
        accountUpdatedAt: account.updatedAt,
        studentId: student.id,
        inviteCode: student.inviteCode,
        major: student.major,
        grade: student.grade,
        targetYear: student.targetYear,
        xp: student.xp,
        level: student.level,
        streak: student.streak,
        studentCreatedAt: student.createdAt,
        studentUpdatedAt: student.updatedAt,
      })
      .from(account)
      .leftJoin(student, eq(student.accountId, account.id))
      .where(eq(account.isActive, true));

    return rows.map(this.mapToUserWithProfile);
  }

  async findById(id: string): Promise<UserWithProfile | null> {
    const rows = await this.db
      .select({
        id: account.id,
        mobile: account.mobile,
        firstName: account.firstName,
        lastName: account.lastName,
        isAdmin: account.isAdmin,
        isActive: account.isActive,
        accountCreatedAt: account.createdAt,
        accountUpdatedAt: account.updatedAt,
        studentId: student.id,
        inviteCode: student.inviteCode,
        major: student.major,
        grade: student.grade,
        targetYear: student.targetYear,
        xp: student.xp,
        level: student.level,
        streak: student.streak,
        studentCreatedAt: student.createdAt,
        studentUpdatedAt: student.updatedAt,
      })
      .from(account)
      .leftJoin(student, eq(student.accountId, account.id))
      .where(and(eq(account.id, id), eq(account.isActive, true)))
      .limit(1);

    return rows[0] ? this.mapToUserWithProfile(rows[0]) : null;
  }

  async findByPhoneNumberWithPassword(
    phoneNumber: string,
    nationalCode: string,
  ): Promise<UserWithProfile | null> {
    const normalizedPhone = phoneNumber.trim();
    const normalizedNationalCode = nationalCode.trim();
    const expectedHash = this.hashNationalCode(normalizedNationalCode);

    const rows = await this.db
      .select({
        id: account.id,
        mobile: account.mobile,
        firstName: account.firstName,
        lastName: account.lastName,
        isAdmin: account.isAdmin,
        isActive: account.isActive,
        accountCreatedAt: account.createdAt,
        accountUpdatedAt: account.updatedAt,
        studentId: student.id,
        inviteCode: student.inviteCode,
        major: student.major,
        grade: student.grade,
        targetYear: student.targetYear,
        xp: student.xp,
        level: student.level,
        streak: student.streak,
        studentCreatedAt: student.createdAt,
        studentUpdatedAt: student.updatedAt,
      })
      .from(account)
      .leftJoin(student, eq(student.accountId, account.id))
      .where(
        and(
          eq(account.mobile, normalizedPhone),
          eq(account.passwordHash, expectedHash),
          eq(account.isActive, true),
        ),
      )
      .limit(1);

    return rows[0] ? this.mapToUserWithProfile(rows[0]) : null;
  }

  async findByPhoneNumber(phoneNumber: string): Promise<UserWithProfile | null> {
    const normalizedPhone = phoneNumber.trim();

    const rows = await this.db
      .select({
        id: account.id,
        mobile: account.mobile,
        firstName: account.firstName,
        lastName: account.lastName,
        isAdmin: account.isAdmin,
        isActive: account.isActive,
        accountCreatedAt: account.createdAt,
        accountUpdatedAt: account.updatedAt,
        studentId: student.id,
        inviteCode: student.inviteCode,
        major: student.major,
        grade: student.grade,
        targetYear: student.targetYear,
        xp: student.xp,
        level: student.level,
        streak: student.streak,
        studentCreatedAt: student.createdAt,
        studentUpdatedAt: student.updatedAt,
      })
      .from(account)
      .leftJoin(student, eq(student.accountId, account.id))
      .where(and(eq(account.mobile, normalizedPhone), eq(account.isActive, true)))
      .limit(1);

    return rows[0] ? this.mapToUserWithProfile(rows[0]) : null;
  }

  async create(data: {
    nationalId: string;
    phoneNumber: string;
    firstName: string;
    lastName: string;
  }): Promise<UserWithProfile> {
    const normalizedPhone = data.phoneNumber.trim();
    const normalizedNationalId = data.nationalId.trim();

    // Check if phone already exists
    const existing = await this.db
      .select({ id: account.id })
      .from(account)
      .where(eq(account.mobile, normalizedPhone))
      .limit(1);

    if (existing.length > 0) {
      throw new Error('Phone number already registered');
    }

    // Check if nationalId already used (by checking password hash)
    const nationalIdHash = this.hashNationalCode(normalizedNationalId);
    const existingByNationalId = await this.db
      .select({ id: account.id })
      .from(account)
      .where(eq(account.passwordHash, nationalIdHash))
      .limit(1);

    if (existingByNationalId.length > 0) {
      throw new Error('National ID already registered');
    }

    // Generate invite code (8 alphanumeric)
    const inviteCode = this.generateInviteCode();

    // Insert account (first/last name stored on account per spec rewrite)
    const accountResult = await this.db
      .insert(account)
      .values({
        mobile: normalizedPhone,
        passwordHash: nationalIdHash,
        firstName: data.firstName.trim(),
        lastName: data.lastName.trim(),
        isAdmin: false,
        isActive: true,
      })
      .returning({ id: account.id });

    const newAccountId = accountResult[0].id;

    // Insert student profile
    await this.db.insert(student).values({
      accountId: newAccountId,
      inviteCode,
      major: null,
      grade: null,
      targetYear: null,
      xp: 0,
      level: 1,
      streak: 0,
    });

    // Return the created user
    const created = await this.findById(newAccountId);
    if (!created) {
      throw new Error('Failed to create user');
    }
    return created;
  }

  private mapToUserWithProfile(row: any): UserWithProfile {
    return {
      id: row.id,
      nationalId: '', // Not stored directly for security
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

  private hashNationalCode(nationalCode: string): string {
    return crypto
      .createHash('sha256')
      .update(`konkur-dev:${nationalCode}`)
      .digest('hex');
  }

  private generateInviteCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }
}