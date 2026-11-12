import type { ExecutionContext } from '@nestjs/common';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../users/enums/user-role.enum';
import { SupportController } from './support.controller';
import type { SupportService } from './support.service';

const TICKET_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';

function makeContext(user: Partial<AuthenticatedUser>): ExecutionContext {
  return {
    getHandler: () => 'list',
    getClass: () => SupportController,
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

/** @UseGuards/@Roles/@Get metadata lives on the method function itself. */
function methodMetadata(method: string, key: string): unknown {
  const handler = Object.getOwnPropertyDescriptor(
    SupportController.prototype,
    method,
  )?.value as object | undefined;
  return handler ? Reflect.getMetadata(key, handler) : undefined;
}

function methodPath(method: string): string {
  return methodMetadata(method, 'path') as string;
}

function guardNames(method: string): string[] {
  const guards = methodMetadata(method, '__guards__') as
    Array<{ name: string }> | undefined;
  return (guards ?? []).map((g) => g.name);
}

function build() {
  const createTicket = jest
    .fn<Promise<{ id: string }>, [unknown]>()
    .mockResolvedValue({ id: TICKET_ID });
  const listTickets = jest
    .fn<Promise<unknown[]>, [number | undefined]>()
    .mockResolvedValue([]);
  const resolveTicket = jest
    .fn<Promise<unknown>, [string]>()
    .mockResolvedValue({ id: TICKET_ID, status: 'resolved' });
  const controller = new SupportController({
    createTicket,
    listTickets,
    resolveTicket,
  } as unknown as SupportService);
  return { controller, createTicket, listTickets, resolveTicket };
}

describe('SupportController — public submission', () => {
  it('is reachable without any auth guard, rate-limited only', () => {
    expect(guardNames('create')).toEqual([ThrottlerGuard.name]);
    expect(guardNames('create')).not.toContain(JwtAuthGuard.name);
    expect(methodPath('create')).toBe('support/tickets');
  });

  it('files the ticket with no caller identity involved', async () => {
    const { controller, createTicket } = build();

    const result = await controller.create({
      name: 'مریم',
      contact: '09123456789',
      message: 'سوال دارم',
    });

    expect(createTicket).toHaveBeenCalledWith({
      name: 'مریم',
      contact: '09123456789',
      message: 'سوال دارم',
    });
    expect(result).toEqual({ id: TICKET_ID });
  });
});

describe('SupportController — admin inbox', () => {
  it('protects the list route with JWT + ADMIN', () => {
    expect(methodPath('list')).toBe('admin/support-tickets');
    expect(guardNames('list')).toEqual([JwtAuthGuard.name, RolesGuard.name]);
    expect(methodMetadata('list', ROLES_KEY)).toEqual([UserRole.ADMIN]);
  });

  it('protects the resolve route with JWT + ADMIN', () => {
    expect(methodPath('resolve')).toBe('admin/support-tickets/:id/resolve');
    expect(guardNames('resolve')).toEqual([JwtAuthGuard.name, RolesGuard.name]);
    expect(methodMetadata('resolve', ROLES_KEY)).toEqual([UserRole.ADMIN]);
  });

  it('lets an admin through the roles guard', () => {
    const guard = new RolesGuard(new Reflector());
    const getAllAndOverride = jest
      .spyOn(Reflector.prototype, 'getAllAndOverride')
      .mockReturnValue([UserRole.ADMIN]);

    expect(guard.canActivate(makeContext({ role: UserRole.ADMIN }))).toBe(true);
    expect(getAllAndOverride).toHaveBeenCalled();

    getAllAndOverride.mockRestore();
  });

  it('blocks a student with 403', () => {
    const guard = new RolesGuard(new Reflector());
    const getAllAndOverride = jest
      .spyOn(Reflector.prototype, 'getAllAndOverride')
      .mockReturnValue([UserRole.ADMIN]);

    expect(() =>
      guard.canActivate(makeContext({ role: UserRole.STUDENT })),
    ).toThrow(ForbiddenException);

    getAllAndOverride.mockRestore();
  });

  it('lists newest tickets with the default page when no limit is given', async () => {
    const { controller, listTickets } = build();

    await controller.list(undefined);

    expect(listTickets).toHaveBeenCalledWith(undefined);
  });

  it('parses a numeric limit', async () => {
    const { controller, listTickets } = build();

    await controller.list('5');

    expect(listTickets).toHaveBeenCalledWith(5);
  });

  it('rejects a non-numeric limit with 400', () => {
    const { controller } = build();

    expect(() => controller.list('abc')).toThrow(BadRequestException);
    expect(() => controller.list('0')).toThrow(BadRequestException);
  });

  it('resolves by id', async () => {
    const { controller, resolveTicket } = build();

    await controller.resolve(TICKET_ID);

    expect(resolveTicket).toHaveBeenCalledWith(TICKET_ID);
  });
});
