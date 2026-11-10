import {
  Body,
  Controller,
  Get,
  Patch,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { UserResponseDto } from './dto/user-response.dto';
import { UpdateStudiedTopicsDto } from './dto/update-studied-topics.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from './enums/user-role.enum';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

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

  /**
   * Store the self-reported studied-topic list (spec 3.2 onboarding).
   * The list feeds the diagnostic (3.3); an empty array clears it.
   */
  @Patch('me/studied-topics')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.STUDENT)
  async updateStudiedTopics(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateStudiedTopicsDto,
  ) {
    const studiedTopicIds = await this.usersService.updateStudiedTopics(
      user.userId,
      dto.topicIds,
    );
    return { studiedTopicIds };
  }
}
