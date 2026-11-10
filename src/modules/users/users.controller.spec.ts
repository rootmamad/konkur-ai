import { UnauthorizedException } from '@nestjs/common';

import { UserRole } from './enums/user-role.enum';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import type { UserWithProfile } from './users.service';

const USER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const TOPIC_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';

function profile(overrides: Partial<UserWithProfile> = {}): UserWithProfile {
  return {
    id: USER_ID,
    nationalId: '',
    phoneNumber: '09120000000',
    firstName: 'علی',
    lastName: 'رضایی',
    role: 'student',
    isActive: true,
    xp: 10,
    level: 2,
    streak: 3,
    studiedTopicIds: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

function build() {
  const findById = jest
    .fn<Promise<UserWithProfile | null>, [userId: string]>()
    .mockResolvedValue(null);
  const updateStudiedTopics = jest
    .fn<Promise<string[]>, [userId: string, topicIds: string[]]>()
    .mockResolvedValue([]);
  const service = { findById, updateStudiedTopics } as unknown as UsersService;
  const controller = new UsersController(service);
  return { controller, findById, updateStudiedTopics };
}

describe('UsersController', () => {
  it('getMe maps the studied-topics column into the response', async () => {
    const { controller, findById } = build();
    findById.mockResolvedValue(profile({ studiedTopicIds: [TOPIC_ID] }));

    const me = await controller.getMe({
      userId: USER_ID,
      role: UserRole.STUDENT,
    });

    expect(findById).toHaveBeenCalledWith(USER_ID);
    expect(me.studiedTopicIds).toEqual([TOPIC_ID]);
  });

  it('forwards the body to the service and returns the stored list', async () => {
    const { controller, updateStudiedTopics } = build();
    const list = [TOPIC_ID];
    updateStudiedTopics.mockResolvedValue(list);

    const result = await controller.updateStudiedTopics(
      { userId: USER_ID, role: UserRole.STUDENT },
      { topicIds: list },
    );

    expect(updateStudiedTopics).toHaveBeenCalledWith(USER_ID, list);
    expect(result).toEqual({ studiedTopicIds: list });
  });

  it('getMe rejects with Unauthorized when the profile is missing', async () => {
    const { controller, findById } = build();
    findById.mockResolvedValue(null);

    await expect(
      controller.getMe({ userId: USER_ID, role: UserRole.STUDENT }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
