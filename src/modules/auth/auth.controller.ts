import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';

import { LoginDto } from './dto/login.dto';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { UserResponseDto } from '../users/dto/user-response.dto';

@ApiTags('auth')
@Controller('auth')
@UseGuards(ThrottlerGuard) // spec 3.2 + 13.5: rate-limit login/register
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  @Post('register')
  @ApiOperation({ summary: 'Register new user' })
  async register(@Body() data: CreateUserDto) {
    const user = await this.usersService.create(data);
    return UserResponseDto.fromDocument(user);
  }

  @Post('login')
  @ApiOperation({ summary: 'Login with phone number and national code' })
  @HttpCode(HttpStatus.OK)
  login(@Body() data: LoginDto) {
    return this.authService.login(data.phoneNumber, data.password);
  }
}
