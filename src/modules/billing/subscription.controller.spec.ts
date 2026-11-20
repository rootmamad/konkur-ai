import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException, RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../users/enums/user-role.enum';
import { SubscriptionController } from './subscription.controller';
import type { SubscriptionService } from './subscription.service';
import type { ReferralsService } from '../referrals/referrals.service';

const USER_ID = '9f1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const STATUS = { plan: 'full', paidAccess: true, simAccess: true } as const;

function makeContext(role: string): ExecutionContext {
  return {
    getHandler: () => 'getStatus',
    getClass: () => SubscriptionController,
    switchToHttp: () => ({
      getRequest: () => ({ user: { userId: USER_ID, role } }),
    }),
  } as unknown as ExecutionContext;
}

/** Guard/role metadata is wired at CLASS level (dashboard pattern); route
 * metadata for @Get lives on the method function (descriptor.value). */
function classMetadata(key: string): unknown {
  return Reflect.getMetadata(key, SubscriptionController);
}

function methodMetadata(method: string, key: string): unknown {
  const handler = Object.getOwnPropertyDescriptor(
    SubscriptionController.prototype,
    method,
  )?.value as object | undefined;
  return handler ? Reflect.getMetadata(key, handler) : undefined;
}

describe('SubscriptionController — GET /subscription/status (spec 3.7)', () => {
  it('returns the status of the CALLER only', async () => {
    const getStatus = jest
      .fn<
        Promise<{ plan: string; paidAccess: boolean; simAccess: boolean }>,
        [string]
      >()
      .mockResolvedValue({ ...STATUS });
    const controller = new SubscriptionController(
      {
        getStatus,
      } as unknown as SubscriptionService,
      {} as unknown as ReferralsService,
    );

    const result = await controller.getStatus({
      userId: USER_ID,
      role: UserRole.STUDENT,
    });

    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(getStatus).toHaveBeenCalledWith(USER_ID); // own id, never a param
    expect(result).toEqual(STATUS);
  });

  it('is wired to both auth guards with ADMIN and STUDENT roles', () => {
    expect(classMetadata(ROLES_KEY)).toEqual([
      UserRole.ADMIN,
      UserRole.STUDENT,
    ]);
    const guards = classMetadata('__guards__') as Array<{ name: string }>;
    expect(guards.map((g) => g.name)).toEqual([
      JwtAuthGuard.name,
      RolesGuard.name,
    ]);

    const controllerPath = classMetadata('path') as string;
    const methodPath = methodMetadata('getStatus', 'path') as string;
    expect(`${controllerPath}/${methodPath}`).toBe('subscription/status');
  });

  it('lets a student read their own status', () => {
    const guard = new RolesGuard(new Reflector());
    jest
      .spyOn(Reflector.prototype, 'getAllAndOverride')
      .mockReturnValue([UserRole.ADMIN, UserRole.STUDENT]);

    expect(guard.canActivate(makeContext(UserRole.STUDENT))).toBe(true);
  });

  it('blocks a role outside ADMIN/STUDENT with 403', () => {
    const guard = new RolesGuard(new Reflector());
    jest
      .spyOn(Reflector.prototype, 'getAllAndOverride')
      .mockReturnValue([UserRole.ADMIN, UserRole.STUDENT]);

    expect(() => guard.canActivate(makeContext('advisor'))).toThrow(
      ForbiddenException,
    );
  });
});

describe('SubscriptionController — GET /subscription/wallet (spec 3.7 section 4)', () => {
  it('both wallet routes are GET and sit behind the class guards', () => {
    const controllerPath = classMetadata('path') as string;
    for (const [method, route] of [
      ['getWallet', 'wallet'],
      ['listWalletTransactions', 'wallet/transactions'],
    ] as const) {
      expect(methodMetadata(method, 'path')).toBe(route);
      expect(methodMetadata(method, 'method')).toBe(RequestMethod.GET);
      // No route-level guard override: the class JWT + roles apply, so a
      // non-owner (unauthenticated or another account) can never reach it.
      expect(methodMetadata(method, '__guards__')).toBeUndefined();
      expect(methodMetadata(method, ROLES_KEY)).toBeUndefined();
      expect(`${controllerPath}/${route}`).toBe(`subscription/${route}`);
    }
  });

  it('getWallet reads the caller balance only', async () => {
    const getWalletBalance = jest
      .fn<Promise<{ balance: string }>, [string]>()
      .mockResolvedValue({ balance: '1250.50' });
    const controller = new SubscriptionController(
      {
        getWalletBalance,
      } as unknown as SubscriptionService,
      {} as unknown as ReferralsService,
    );

    const result = await controller.getWallet({
      userId: USER_ID,
      role: UserRole.STUDENT,
    });

    expect(getWalletBalance).toHaveBeenCalledTimes(1);
    expect(getWalletBalance).toHaveBeenCalledWith(USER_ID); // own id, never a param
    expect(result).toEqual({ balance: '1250.50' });
  });

  it('listWalletTransactions forwards the optional limit to the service', async () => {
    const listWalletTransactions = jest
      .fn<Promise<unknown[]>, [string, number | undefined]>()
      .mockResolvedValue([]);
    const controller = new SubscriptionController(
      {
        listWalletTransactions,
      } as unknown as SubscriptionService,
      {} as unknown as ReferralsService,
    );

    await controller.listWalletTransactions({
      userId: USER_ID,
      role: UserRole.STUDENT,
    });
    expect(listWalletTransactions).toHaveBeenLastCalledWith(USER_ID, undefined);

    await controller.listWalletTransactions(
      { userId: USER_ID, role: UserRole.STUDENT },
      '25',
    );
    expect(listWalletTransactions).toHaveBeenLastCalledWith(USER_ID, 25);
  });
});
