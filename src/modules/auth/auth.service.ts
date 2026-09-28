import { Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import { account } from '../../db/schema/account';
import { student } from '../../db/schema/student';
import { eq, and } from 'drizzle-orm';
import * as crypto from 'crypto';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(
    phoneNumber: string,
    nationalCode: string,
  ): Promise<{ accessToken: string }> {
    const normalizedPhone = phoneNumber.trim();
    const normalizedNationalCode = nationalCode.trim();

    const rows = await this.db
      .select()
      .from(account)
      .where(
        and(
          eq(account.mobile, normalizedPhone),
          eq(account.isActive, true),
        ),
      )
      .limit(1);

    const acct = rows[0];
    if (!acct) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Dev-only: national code used as password (spec section 2)
    // In production, replace with proper bcrypt/argon2 verification
    const expectedHash = this.hashNationalCode(normalizedNationalCode);
    if (acct.passwordHash !== expectedHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Ensure student profile exists
    const studentRows = await this.db
      .select()
      .from(student)
      .where(eq(student.accountId, acct.id))
      .limit(1);

    const studentProfile = studentRows[0];
    if (!studentProfile) {
      throw new UnauthorizedException('User profile not found');
    }

    const payload = {
      sub: acct.id,
      role: acct.isAdmin ? 'admin' : 'student',
    };

    const accessToken = await this.jwtService.signAsync(payload, {
      expiresIn: '7d',
    });

    return { accessToken };
  }

  private hashNationalCode(nationalCode: string): string {
    // Dev-only deterministic hash for national code
    // In production, use bcrypt or argon2 with salt
    return crypto
      .createHash('sha256')
      .update(`konkur-dev:${nationalCode}`)
      .digest('hex');
  }
}