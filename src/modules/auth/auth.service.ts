import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';

import { UsersService } from '../users/users.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Authenticate user with phone number and national code
   * @param phoneNumber - User's Iranian mobile number (09XXXXXXXXX)
   * @param nationalCode - User's national code used as password (10 digits)
   * @returns JWT access token if credentials are valid
   * @throws UnauthorizedException if credentials are invalid
   */
  async login(
    phoneNumber: string,
    password: string,
  ): Promise<{ accessToken: string }> {
    const user =
      await this.usersService.findByPhoneNumberWithPassword(
        phoneNumber,
      );

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordValid = await bcrypt.compare(
      password,
      user.passwordHash,
    );

    if (!passwordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const payload = {
      sub: user._id.toString(),
      role: user.role,
    };

    return {
      accessToken: await this.jwtService.signAsync(payload),
    };
  }
}