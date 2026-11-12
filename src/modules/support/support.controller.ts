import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { ThrottlerGuard } from '@nestjs/throttler';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { CreateSupportTicketDto } from './dto/create-support-ticket.dto';
import { MAX_TICKET_LIMIT, SupportService } from './support.service';

/**
 * Support tickets (spec 3.8). One controller because the two audiences share
 * nothing but the ticket: the public form (open, rate-limited like the auth
 * routes) and the admin inbox (JWT + ADMIN). Guards are per-route — a
 * controller-level JWT guard would make the public form unusable.
 */
@ApiTags('support')
@Controller()
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  /** PUBLIC: no JWT. Abuse is bounded by the global throttler window. */
  @Post('support/tickets')
  @UseGuards(ThrottlerGuard) // spec 3.8: a form anyone can post to
  @ApiOperation({ summary: 'File a support ticket (public)' })
  create(@Body() dto: CreateSupportTicketDto) {
    return this.supportService.createTicket(dto);
  }

  @Get('admin/support-tickets')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Admin inbox: all tickets, newest first' })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: `Page size (default 20, max ${MAX_TICKET_LIMIT})`,
  })
  list(@Query('limit') limit?: string) {
    return this.supportService.listTickets(
      limit === undefined ? undefined : parseLimit(limit),
    );
  }

  @Patch('admin/support-tickets/:id/resolve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Mark a ticket resolved (404 when unknown)' })
  resolve(@Param('id', ParseUUIDPipe) id: string) {
    return this.supportService.resolveTicket(id);
  }
}

/** `limit` must be a positive integer; the service clamps it to the max. */
function parseLimit(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BadRequestException('limit must be a positive integer');
  }
  return parsed;
}
