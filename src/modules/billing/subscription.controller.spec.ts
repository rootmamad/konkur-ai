import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../users/enums/user-role.enum';
import { SubscriptionController } from './subscription.controller';
import type { SubscriptionService } from './subscription.service';

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

function methodMetadata(key: string): unknown {
  const handler = Object.getOwnPropertyDescriptor(
    SubscriptionController.prototype,
    'getStatus',
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
    const controller = new SubscriptionController({
      getStatus,
    } as unknown as SubscriptionService);

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
    const methodPath = methodMetadata('path') as string;
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
