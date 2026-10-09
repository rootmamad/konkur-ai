import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, eq } from 'drizzle-orm';

import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import { account } from '../../db/schema/account';
import { student } from '../../db/schema/student';
import { verifyDevCredential } from './dev-credential';

const INVALID_CREDENTIALS = 'Invalid credentials';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jwtService: JwtService,
  ) {}

  async login(
    phoneNumber: string,
    nationalCode: string,
  ): Promise<{ accessToken: string }> {
    const rows = await this.db
      .select({
        id: account.id,
        passwordHash: account.passwordHash,
        isAdmin: account.isAdmin,
        studentId: student.id,
      })
      .from(account)
      .leftJoin(student, eq(student.accountId, account.id))
      .where(
        and(eq(account.mobile, phoneNumber.trim()), eq(account.isActive, true)),
      )
      .limit(1);

    const acct = rows[0];
    // Always verify, even without an account, so timing does not
    // reveal whether the mobile exists (spec 3.2).
    const valid = verifyDevCredential(nationalCode, acct?.passwordHash ?? null);

    if (!acct || !valid || !acct.studentId) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const accessToken = await this.jwtService.signAsync({
      sub: acct.id,
      role: acct.isAdmin ? 'admin' : 'student',
    });

    return { accessToken };
  }
}
