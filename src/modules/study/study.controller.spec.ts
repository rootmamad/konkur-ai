import { RequestMethod } from '@nestjs/common';
import { validate } from 'class-validator';

import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../users/enums/user-role.enum';
import { CreateStudyEntryDto } from './dto/create-study-entry.dto';
import { ExtractPreviewDto } from './dto/extract-preview.dto';
import { StudyController } from './study.controller';

const USER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

const user = { userId: USER_ID } as never;

function methodMetadata(method: string, key: string): unknown {
  const handler = Object.getOwnPropertyDescriptor(
    StudyController.prototype,
    method,
  )?.value as object | undefined;
  return handler ? Reflect.getMetadata(key, handler) : undefined;
}

function methodPath(method: string): string {
  return methodMetadata(method, 'path') as string;
}

function methodGuardNames(method: string): string[] {
  const guards = methodMetadata(method, '__guards__') as
    Array<{ name: string }> | undefined;
  return (guards ?? []).map((g) => g.name);
}

function classMetadata(key: string): unknown {
  return Reflect.getMetadata(key, StudyController);
}

function classGuardNames(): string[] {
  const guards = classMetadata('__guards__') as
    Array<{ name: string }> | undefined;
  return (guards ?? []).map((g) => g.name);
}

describe('StudyController — guards and routes (spec 3.6 path 1)', () => {
  it('sits behind JWT + roles with ADMIN and STUDENT allowed', () => {
    expect(classGuardNames()).toEqual([JwtAuthGuard.name, RolesGuard.name]);
    expect(classMetadata(ROLES_KEY)).toEqual([
      UserRole.ADMIN,
      UserRole.STUDENT,
    ]);
    expect(classMetadata('path')).toBe('study');
  });

  it('extract-preview is POST and additionally throttled for abuse', () => {
    expect(methodPath('extractPreview')).toBe('extract-preview');
    expect(methodMetadata('extractPreview', 'method')).toBe(RequestMethod.POST);
    // Method-level guard list: JWT + roles are inherited from the class, so
    // this route is authed AND throttled. Deliberately NOT the chat quota —
    // §10 names only coach + floating chat for message quotas.
    expect(methodGuardNames('extractPreview')).toEqual(['ThrottlerGuard']);
  });

  it('entries/from-chat is POST and inherits only the class guards', () => {
    expect(methodPath('createEntryFromChat')).toBe('entries/from-chat');
    expect(methodMetadata('createEntryFromChat', 'method')).toBe(
      RequestMethod.POST,
    );
    // No method-level metadata: every route guard is the class JWT + roles,
    // so a non-owner (another account, unauthenticated) can never reach it.
    expect(methodGuardNames('createEntryFromChat')).toEqual([]);
    expect(methodMetadata('createEntryFromChat', ROLES_KEY)).toBeUndefined();
  });
});

describe('StudyController — delegation', () => {
  function build() {
    const createStudyEntry = jest
      .fn<Promise<unknown>, [string, CreateStudyEntryDto]>()
      .mockResolvedValue({ id: 'entry-form' });
    const createStudyEntryFromChat = jest
      .fn<Promise<unknown>, [string, CreateStudyEntryDto]>()
      .mockResolvedValue({ id: 'entry-chat', source: 'chat' });
    const extractPreview = jest
      .fn<Promise<unknown>, [string, string]>()
      .mockResolvedValue({ preview: { lesson: 'ریاضی', minutes: 45 } });
    const controller = new StudyController(
      { createStudyEntry, createStudyEntryFromChat } as never,
      {} as never,
      { extractPreview } as never,
    );
    return {
      controller,
      createStudyEntry,
      createStudyEntryFromChat,
      extractPreview,
    };
  }

  it('extract-preview passes the caller identity and the free text', async () => {
    const { controller, extractPreview } = build();

    const dto = new ExtractPreviewDto();
    dto.text = 'امروز ۴۵ دقیقه مشتق خوندم';

    const result = await controller.extractPreview(user, dto);

    expect(extractPreview).toHaveBeenCalledWith(
      USER_ID,
      'امروز ۴۵ دقیقه مشتق خوندم',
    );
    expect(result).toEqual({ preview: { lesson: 'ریاضی', minutes: 45 } });
  });

  it('entries/from-chat confirms through the dedicated chat source path', async () => {
    const { controller, createStudyEntryFromChat, createStudyEntry } = build();

    const dto = new CreateStudyEntryDto();
    dto.lesson = 'ریاضی — مشتق';
    dto.activity = 'learning';
    dto.minutes = 45;

    const result = await controller.createEntryFromChat(user, dto);

    expect(createStudyEntryFromChat).toHaveBeenCalledWith(USER_ID, dto);
    expect(createStudyEntry).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'entry-chat', source: 'chat' });
  });
});

describe('ExtractPreviewDto limits', () => {
  it('accepts a non-empty text of at most 1000 characters', async () => {
    const dto = new ExtractPreviewDto();
    dto.text = 'متن نمونه';
    await expect(validate(dto)).resolves.toHaveLength(0);

    const max = new ExtractPreviewDto();
    max.text = 'م'.repeat(1000);
    await expect(validate(max)).resolves.toHaveLength(0);
  });

  it('rejects an empty, oversized, or non-string text', async () => {
    const empty = new ExtractPreviewDto();
    empty.text = '';
    await expect(validate(empty)).resolves.not.toHaveLength(0);

    const oversized = new ExtractPreviewDto();
    oversized.text = 'م'.repeat(1001);
    await expect(validate(oversized)).resolves.not.toHaveLength(0);

    const nonString = new ExtractPreviewDto();
    (nonString as unknown as { text: number }).text = 42;
    await expect(validate(nonString)).resolves.not.toHaveLength(0);
  });
});
