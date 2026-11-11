import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../users/enums/user-role.enum';
import { ReferralsController } from './referrals.controller';
import type { ReferralsService } from './referrals.service';

const INVITEE_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';

function makeContext(user: Partial<AuthenticatedUser>): ExecutionContext {
  return {
    getHandler: () => 'markPurchased',
    getClass: () => ReferralsController,
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

/** Metadata set by @Roles/@UseGuards/@Post lives on the method function
 * itself (Nest defines it on descriptor.value); read it from there instead
 * of grabbing the method reference (which would be an unbound method). */
function methodMetadata(key: string): unknown {
  const handler = Object.getOwnPropertyDescriptor(
    ReferralsController.prototype,
    'markPurchased',
  )?.value as object | undefined;
  return handler ? Reflect.getMetadata(key, handler) : undefined;
}

describe('ReferralsController — ADMIN purchase verification', () => {
  it('delegates to onInviteePurchased for the given invitee', async () => {
    const onInviteePurchased = jest
      .fn<Promise<void>, [string]>()
      .mockResolvedValue(undefined);
    const controller = new ReferralsController({
      onInviteePurchased,
    } as unknown as ReferralsService);

    const result = await controller.markPurchased(INVITEE_ID);

    expect(onInviteePurchased).toHaveBeenCalledTimes(1);
    expect(onInviteePurchased).toHaveBeenCalledWith(INVITEE_ID);
    expect(result).toEqual({ purchased: true });
  });

  it('requires the ADMIN role on the verification route', () => {
    expect(methodMetadata(ROLES_KEY)).toEqual([UserRole.ADMIN]);

    const controllerPath = Reflect.getMetadata(
      'path',
      ReferralsController,
    ) as string;
    const methodPath = methodMetadata('path') as string;
    expect(`${controllerPath}/${methodPath}`).toBe(
      'admin/referrals/:inviteeId/purchased',
    );
  });

  it('lets an admin through the roles guard', () => {
    const guard = new RolesGuard(new Reflector());
    const getAllAndOverride = jest
      .spyOn(Reflector.prototype, 'getAllAndOverride')
      .mockReturnValue([UserRole.ADMIN]);

    const canActivate = guard.canActivate(
      makeContext({ role: UserRole.ADMIN }),
    );

    expect(canActivate).toBe(true);
    expect(getAllAndOverride).toHaveBeenCalled();
  });

  it('blocks a non-admin (student) with 403', () => {
    const guard = new RolesGuard(new Reflector());
    jest
      .spyOn(Reflector.prototype, 'getAllAndOverride')
      .mockReturnValue([UserRole.ADMIN]);

    expect(() =>
      guard.canActivate(makeContext({ role: UserRole.STUDENT })),
    ).toThrow(ForbiddenException);
  });

  it('carries both auth guards on the verification route', () => {
    const guards = methodMetadata('__guards__') as
      | Array<{
          name: string;
        }>
      | undefined;
    expect(guards?.map((g) => g.name)).toEqual([
      JwtAuthGuard.name,
      RolesGuard.name,
    ]);
  });
});
