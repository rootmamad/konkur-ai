import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { chatSpace } from '../../db/schema/chat';
import { MAX_MESSAGE_LIMIT, ChatService } from './chat.service';
import type { ChatSpaceKind } from './dto/create-thread.dto';
import { CreateThreadDto } from './dto/create-thread.dto';
import { CreateMessageDto } from './dto/create-message.dto';

/**
 * Chat storage foundation (spec 9.1). Every route is scoped to the caller:
 * the controller resolves nothing itself — the service maps the JWT account
 * to the student profile and keys/owns all rows by it.
 */
@ApiTags('chat')
@ApiBearerAuth('access-token')
@Controller('chat')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.STUDENT)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('threads')
  @ApiOperation({
    summary:
      "Get or create the caller's thread for a space (per-space ref matrix)",
  })
  createThread(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateThreadDto,
  ) {
    return this.chatService.getOrCreateThread(
      user.userId,
      dto.space,
      dto.questionId,
      dto.attemptId,
    );
  }

  @Get('threads')
  @ApiOperation({ summary: "The caller's chat threads, newest first" })
  @ApiQuery({
    name: 'space',
    required: false,
    description: `Filter by space (${chatSpace.enumValues.join(' | ')})`,
  })
  listThreads(
    @CurrentUser() user: AuthenticatedUser,
    @Query('space') space?: string,
  ) {
    return this.chatService.listThreads(user.userId, parseSpace(space));
  }

  @Get('threads/:id/messages')
  @ApiOperation({
    summary: "The caller's thread messages, ascending (owner-only)",
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: `Page size (default 50, max ${MAX_MESSAGE_LIMIT})`,
  })
  getMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
  ) {
    return this.chatService.getMessages(
      user.userId,
      id,
      limit === undefined ? undefined : parsePositiveInt(limit, 'limit'),
    );
  }

  @Post('threads/:id/messages')
  @ApiOperation({
    summary:
      "Append the caller's user message to a thread (owner-only; coach sends take a mode)",
  })
  addMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMessageDto,
  ) {
    return this.chatService.addMessage(user.userId, id, dto.body, dto.mode);
  }
}

/** `space` must be a `chat_space` enum value when present. */
function parseSpace(raw: string | undefined): ChatSpaceKind | undefined {
  if (raw === undefined) return undefined;
  if (!(chatSpace.enumValues as readonly string[]).includes(raw)) {
    throw new BadRequestException(
      `space must be one of: ${chatSpace.enumValues.join(', ')}`,
    );
  }
  return raw as ChatSpaceKind;
}

/** `limit` must be a positive integer; the service clamps it to the max. */
function parsePositiveInt(raw: string, name: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BadRequestException(`${name} must be a positive integer`);
  }
  return parsed;
}
