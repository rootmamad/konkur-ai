import { Controller,Get,Post,Body, UseGuards, UnauthorizedException } from '@nestjs/common';
import { UsersService } from './users.service';
import {CreateUserDto} from './dto/create-user.dto';
import {UserResponseDto} from './dto/user-response.dto'
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from './enums/user-role.enum';
import {  CurrentUser } from 'src/common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';



@Controller('users')
export class UsersController {
    constructor(private readonly usersService:UsersService) {}
    @Post()
    async create(@Body() data: CreateUserDto) {
      const user = await this.usersService.create(data);
      return UserResponseDto.fromDocument(user);
  }
  
    @Get()
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    findAll() {
        return this.usersService.findAll();
    }
@Get('me')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN, UserRole.STUDENT)
    async getMe(@CurrentUser() user: AuthenticatedUser) {
        const currentUser = await this.usersService.findById(user.userId);
        if (!currentUser) {
            throw new UnauthorizedException('User not found');
        }
        return UserResponseDto.fromDocument(currentUser);
    }
}