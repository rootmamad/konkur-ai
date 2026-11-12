import { NotFoundException } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Db } from '../../db/db.module';
import { supportTicket } from '../../db/schema/support-ticket';
import { SupportService } from './support.service';

const TICKET_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';

const dialect = new PgDialect();

type Row = Record<string, unknown>;

interface MakeDbOptions {
  /** Row yielded by INSERT ... RETURNING. */
  insertRows?: Row[];
  /** Rows yielded by the admin list query. */
  listRows?: Row[];
  /** Row yielded by UPDATE ... RETURNING (empty = unknown id). */
  resolveRows?: Row[];
}

/**
 * Minimal Drizzle fake: captures what the service actually asked the
 * database to do (table, values, guard SQL, order, limit) instead of
 * asserting on Drizzle internals.
 */
function makeDb(options: MakeDbOptions = {}) {
  const insertCalls: { table: unknown; values: Row }[] = [];
  const updateCalls: { table: unknown; values: Row }[] = [];
  const conditions: { table: unknown; condition: SQL }[] = [];
  const listChain: {
    fromTable?: unknown;
    orderBy: SQL[];
    limit?: number;
  } = { orderBy: [] };

  const db = {
    insert: (table: unknown) => ({
      values: (values: Row) => {
        insertCalls.push({ table, values });
        return { returning: () => Promise.resolve(options.insertRows ?? []) };
      },
    }),
    select: () => ({
      from: (table: unknown) => {
        listChain.fromTable = table;
        const chain = {
          orderBy: (...orderBy: SQL[]) => {
            listChain.orderBy = orderBy;
            return chain;
          },
          limit: (limit: number) => {
            listChain.limit = limit;
            return Promise.resolve(options.listRows ?? []);
          },
        };
        return chain;
      },
    }),
    update: (table: unknown) => ({
      set: (values: Row) => {
        updateCalls.push({ table, values });
        return {
          where: (condition: SQL) => {
            conditions.push({ table, condition });
            return {
              returning: () => Promise.resolve(options.resolveRows ?? []),
            };
          },
        };
      },
    }),
  } as unknown as Db;

  return { db, log: { insertCalls, updateCalls, conditions, listChain } };
}

function build(options: MakeDbOptions = {}) {
  const { db, log } = makeDb(options);
  return { service: new SupportService(db), log };
}

describe('SupportService.createTicket', () => {
  it('persists the submission and returns the new id', async () => {
    const { service, log } = build({ insertRows: [{ id: TICKET_ID }] });

    const created = await service.createTicket({
      name: 'مریم احمدی',
      contact: 'maryam@example.com',
      message: 'نمره‌ی آزمون ثبت نشده است.',
    });

    expect(created).toEqual({ id: TICKET_ID });
    expect(log.insertCalls).toHaveLength(1);
    expect(log.insertCalls[0].table).toBe(supportTicket);
    expect(log.insertCalls[0].values).toEqual({
      name: 'مریم احمدی',
      contact: 'maryam@example.com',
      message: 'نمره‌ی آزمون ثبت نشده است.',
    });
  });

  it("leaves status to the column default instead of writing 'open' itself", async () => {
    const { service, log } = build({ insertRows: [{ id: TICKET_ID }] });

    await service.createTicket({
      name: 'علی',
      contact: '09123456789',
      message: 'سلام',
    });

    expect(log.insertCalls[0].values).not.toHaveProperty('status');
  });
});

describe('SupportService.listTickets', () => {
  it('reads every ticket newest-first with the default page size', async () => {
    const rows = [{ id: TICKET_ID, status: 'open' }];
    const { service, log } = build({ listRows: rows });

    const tickets = await service.listTickets();

    expect(tickets).toEqual(rows);
    expect(log.listChain.fromTable).toBe(supportTicket);
    expect(log.listChain.limit).toBe(20);
    const { sql: text } = dialect.sqlToQuery(log.listChain.orderBy[0]);
    expect(text).toContain('"support_ticket"."created_at" desc');
  });

  it('is caller-independent: the query is not scoped to any student', async () => {
    const { service, log } = build({ listRows: [] });

    await service.listTickets();

    // No WHERE clause at all — a shared admin inbox, not per-user data.
    expect(log.conditions).toHaveLength(0);
    const { sql: text } = dialect.sqlToQuery(log.listChain.orderBy[0]);
    expect(text).not.toContain('student_id');
  });

  it('honours a requested page size', async () => {
    const { service, log } = build({ listRows: [] });

    await service.listTickets(5);

    expect(log.listChain.limit).toBe(5);
  });

  it('clamps oversized pages to the hard maximum', async () => {
    const { service, log } = build({ listRows: [] });

    await service.listTickets(100_000);

    expect(log.listChain.limit).toBe(100);
  });
});

describe('SupportService.resolveTicket', () => {
  it("sets status to 'resolved' for that exact ticket and returns it", async () => {
    const resolved = { id: TICKET_ID, status: 'resolved' };
    const { service, log } = build({ resolveRows: [resolved] });

    const ticket = await service.resolveTicket(TICKET_ID);

    expect(ticket).toEqual(resolved);
    expect(log.updateCalls[0].table).toBe(supportTicket);
    expect(log.updateCalls[0].values).toEqual({ status: 'resolved' });
    const { sql: text, params } = dialect.sqlToQuery(
      log.conditions[0].condition,
    );
    expect(text).toContain('"support_ticket"."id" =');
    expect(params).toEqual([TICKET_ID]);
  });

  it('throws 404 when the id matches no ticket', async () => {
    const { service } = build({ resolveRows: [] });

    await expect(service.resolveTicket(TICKET_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
