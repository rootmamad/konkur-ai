import { Controller,Get,Post,Body, UseGuards } from '@nestjs/common';
import { UsersService } from './users.service';
import {CreateUserDto} from './dto/create-user.dto';
import {UserResponseDto} from './dto/user-response.dto'
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@Controller('users')
export class UsersController {
    constructor(private readonly usersService:UsersService) {}
    @Post()
    async create(@Body() data: CreateUserDto) {
      const user = await this.usersService.create(data);
      return UserResponseDto.fromDocument(user);
  }
  
    @Get()
    @UseGuards(JwtAuthGuard)
    findAll() {
        return this.usersService.findAll();
    }
}