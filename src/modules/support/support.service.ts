import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';

import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import { supportTicket } from '../../db/schema/support-ticket';
import type { SupportTicket } from '../../db/schema/support-ticket';
import type { CreateSupportTicketDto } from './dto/create-support-ticket.dto';

/** Admin inbox page size when the caller does not ask for one. */
export const DEFAULT_TICKET_LIMIT = 20;
/** Hard ceiling, so a hand-written `?limit=100000` cannot dump the table. */
export const MAX_TICKET_LIMIT = 100;

/** Clamp a requested page size into [1, MAX_TICKET_LIMIT]; absent/invalid
 * values fall back to the default page. */
export function clampTicketLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_TICKET_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_TICKET_LIMIT);
}

/**
 * Support tickets (spec section 3.8): the public form writes, the admin inbox
 * reads. Tickets carry no account link and no reply thread; resolution is a
 * one-way status flip. No email is ever sent.
 */
@Injectable()
export class SupportService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Store a public submission. Status is left to the column default ('open'). */
  async createTicket(
    dto: CreateSupportTicketDto,
  ): Promise<Pick<SupportTicket, 'id'>> {
    const [created] = await this.db
      .insert(supportTicket)
      .values({
        name: dto.name,
        contact: dto.contact,
        message: dto.message,
      })
      .returning({ id: supportTicket.id });

    return created;
  }

  /**
   * Admin inbox: every ticket from every caller, newest first. Deliberately
   * NOT scoped to a user — it is a shared queue, not per-account data.
   */
  listTickets(limit?: number): Promise<SupportTicket[]> {
    return this.db
      .select()
      .from(supportTicket)
      .orderBy(desc(supportTicket.createdAt))
      .limit(clampTicketLimit(limit));
  }

  /** Mark a ticket resolved; an unknown (or never-created) id is a 404. */
  async resolveTicket(id: string): Promise<SupportTicket> {
    const [resolved] = await this.db
      .update(supportTicket)
      .set({ status: 'resolved' })
      .where(eq(supportTicket.id, id))
      .returning();

    if (!resolved) {
      throw new NotFoundException('Support ticket not found');
    }
    return resolved;
  }
}
