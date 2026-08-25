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