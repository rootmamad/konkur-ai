import { Logger, RequestMethod } from '@nestjs/common';

import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../users/enums/user-role.enum';
import { SubscriptionController } from './subscription.controller';
import type { SubscriptionService } from './subscription.service';
import type { ReferralsService } from '../referrals/referrals.service';

const USER_ID = '9f1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const STUDENT_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';

const user = { userId: USER_ID, role: UserRole.STUDENT } as never;

const CREATED_ROW = {
  id: 'sub-1',
  studentId: STUDENT_ID,
  plan: 'full',
  startedAt: new Date(),
  expiresAt: new Date(),
};

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

function build(options: { hookError?: Error } = {}) {
  const purchase = jest
    .fn<Promise<unknown>, [string, unknown]>()
    .mockResolvedValue({ ...CREATED_ROW });
  const onInviteePurchased = jest
    .fn<Promise<void>, [string]>()
    .mockReturnValue(
      options.hookError ? Promise.reject(options.hookError) : Promise.resolve(),
    );
  const controller = new SubscriptionController(
    { purchase } as unknown as SubscriptionService,
    { onInviteePurchased } as unknown as ReferralsService,
  );
  return { controller, purchase, onInviteePurchased };
}

describe('SubscriptionController — POST /subscription/purchase (spec §15.1.8)', () => {
  it('sits behind the class guards; the route adds no overrides', () => {
    const guards = classMetadata('__guards__') as Array<{ name: string }>;
    expect(guards.map((g) => g.name)).toEqual([
      JwtAuthGuard.name,
      RolesGuard.name,
    ]);
    expect(classMetadata(ROLES_KEY)).toEqual([
      UserRole.ADMIN,
      UserRole.STUDENT,
    ]);

    // Route metadata: path + method only, no guard/role override.
    expect(methodMetadata('purchase', 'path')).toBe('purchase');
    expect(methodMetadata('purchase', 'method')).toBe(RequestMethod.POST);
    expect(methodMetadata('purchase', '__guards__')).toBeUndefined();
    expect(methodMetadata('purchase', ROLES_KEY)).toBeUndefined();
  });

  it('calls the referral hook exactly once with the studentId', async () => {
    const { controller, onInviteePurchased } = build();

    await controller.purchase(user, { plan: 'full' });
    // Fire-and-forget: let the queued hook settle before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    expect(onInviteePurchased).toHaveBeenCalledTimes(1);
    expect(onInviteePurchased).toHaveBeenCalledWith(STUDENT_ID);
  });

  it('fires the referral hook only AFTER the purchase commits', async () => {
    const { controller, purchase, onInviteePurchased } = build();

    await controller.purchase(user, { plan: 'full' });
    await new Promise((resolve) => setImmediate(resolve));

    // The purchase was invoked (and resolved) before the hook fired.
    expect(purchase.mock.invocationCallOrder[0]).toBeLessThan(
      onInviteePurchased.mock.invocationCallOrder[0],
    );
  });

  it('a failing referral hook never fails the purchase (logged)', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const { controller, onInviteePurchased } = build({
      hookError: new Error('referral db down'),
    });

    // The purchase still resolves and returns the created row.
    await expect(controller.purchase(user, { plan: 'full' })).resolves.toEqual(
      CREATED_ROW,
    );
    // The fire-and-forget catch swallowed the rejection.
    await new Promise((resolve) => setImmediate(resolve));
    expect(onInviteePurchased).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('returns the created row from the service', async () => {
    const { controller, purchase } = build();

    const result = await controller.purchase(user, { plan: 'full' });

    expect(purchase).toHaveBeenCalledWith(USER_ID, { plan: 'full' });
    expect(result).toEqual(CREATED_ROW);
  });
});
