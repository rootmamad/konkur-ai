import { BadRequestException } from '@nestjs/common';
import { validate } from 'class-validator';

import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../users/enums/user-role.enum';
import { CHAT_MESSAGE_MAX_LENGTH, ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { CreateMessageDto } from './dto/create-message.dto';
import { CreateThreadDto } from './dto/create-thread.dto';

const USER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const THREAD_ID = '5c1f8a2e-9b3d-4c6e-8d7f-1a2b3c4d5e6f';
const QUESTION_ID = '7a9b1c3d-5e7f-4a9b-8c1d-3e5f7a9b1c3d';
const ATTEMPT_ID = '9d8c7b6a-5f4e-4d3c-2b1a-0f9e8d7c6b5a';

const user = { userId: USER_ID } as never;

function methodMetadata(method: string, key: string): unknown {
  const handler = Object.getOwnPropertyDescriptor(
    ChatController.prototype,
    method,
  )?.value as object | undefined;
  return handler ? Reflect.getMetadata(key, handler) : undefined;
}

function methodPath(method: string): string {
  return methodMetadata(method, 'path') as string;
}

function classMetadata(key: string): unknown {
  return Reflect.getMetadata(key, ChatController);
}

function classGuardNames(): string[] {
  const guards = classMetadata('__guards__') as
    Array<{ name: string }> | undefined;
  return (guards ?? []).map((g) => g.name);
}

const METHODS = ['createThread', 'listThreads', 'getMessages', 'addMessage'];

function build() {
  const getOrCreateThread = jest
    .fn<Promise<unknown>, [string, string, string?, string?]>()
    .mockResolvedValue({ id: THREAD_ID });
  const listThreads = jest
    .fn<Promise<unknown[]>, [string, string?]>()
    .mockResolvedValue([]);
  const getMessages = jest
    .fn<Promise<unknown[]>, [string, string, number?]>()
    .mockResolvedValue([]);
  const addMessage = jest
    .fn<Promise<unknown>, [string, string, string]>()
    .mockResolvedValue({
      userMessage: { id: 'msg-1', role: 'user', body: 'سلام' },
      assistantMessage: null,
    });
  const controller = new ChatController({
    getOrCreateThread,
    listThreads,
    getMessages,
    addMessage,
  } as unknown as ChatService);
  return {
    controller,
    getOrCreateThread,
    listThreads,
    getMessages,
    addMessage,
  };
}

describe('ChatController — guards and routes', () => {
  it('sits behind JWT + roles with ADMIN and STUDENT allowed', () => {
    expect(classGuardNames()).toEqual([JwtAuthGuard.name, RolesGuard.name]);
    expect(classMetadata(ROLES_KEY)).toEqual([
      UserRole.ADMIN,
      UserRole.STUDENT,
    ]);
    expect(classMetadata('path')).toBe('chat');
  });

  it.each(METHODS)('%s adds no route-level guard overrides', (method) => {
    // No method-level metadata: every route inherits the class guards, so no
    // route can accidentally drop JWT/Roles.
    expect(methodMetadata(method, '__guards__')).toBeUndefined();
    expect(methodMetadata(method, ROLES_KEY)).toBeUndefined();
  });

  it('maps each handler to its route path', () => {
    expect(methodPath('createThread')).toBe('threads');
    expect(methodPath('listThreads')).toBe('threads');
    expect(methodPath('getMessages')).toBe('threads/:id/messages');
    expect(methodPath('addMessage')).toBe('threads/:id/messages');
  });
});

describe('ChatController — delegation', () => {
  it('creates a thread with the caller identity and the dto fields', async () => {
    const { controller, getOrCreateThread } = build();

    const dto = new CreateThreadDto();
    dto.space = 'question';
    dto.questionId = QUESTION_ID;
    dto.attemptId = ATTEMPT_ID;

    const result = await controller.createThread(user, dto);

    expect(getOrCreateThread).toHaveBeenCalledWith(
      USER_ID,
      'question',
      QUESTION_ID,
      ATTEMPT_ID,
    );
    expect(result).toEqual({ id: THREAD_ID });
  });

  it('lists threads with an optional validated space filter', async () => {
    const { controller, listThreads } = build();

    await controller.listThreads(user, undefined);
    expect(listThreads).toHaveBeenLastCalledWith(USER_ID, undefined);

    await controller.listThreads(user, 'coach');
    expect(listThreads).toHaveBeenLastCalledWith(USER_ID, 'coach');

    expect(() => controller.listThreads(user, 'mentor')).toThrow(
      BadRequestException,
    );
  });

  it('parses the message page size or rejects invalid values', async () => {
    const { controller, getMessages } = build();

    await controller.getMessages(user, THREAD_ID, undefined);
    expect(getMessages).toHaveBeenLastCalledWith(USER_ID, THREAD_ID, undefined);

    await controller.getMessages(user, THREAD_ID, '25');
    expect(getMessages).toHaveBeenLastCalledWith(USER_ID, THREAD_ID, 25);

    expect(() => controller.getMessages(user, THREAD_ID, '0')).toThrow(
      BadRequestException,
    );
    expect(() => controller.getMessages(user, THREAD_ID, 'abc')).toThrow(
      BadRequestException,
    );
  });

  it('appends the caller message body to the owned thread', async () => {
    const { controller, addMessage } = build();

    const dto = new CreateMessageDto();
    dto.body = 'سلام';

    const result = await controller.addMessage(user, THREAD_ID, dto);

    expect(addMessage).toHaveBeenCalledWith(USER_ID, THREAD_ID, 'سلام');
    expect(result).toEqual({
      userMessage: { id: 'msg-1', role: 'user', body: 'سلام' },
      assistantMessage: null,
    });
  });
});

describe('CreateMessageDto limits', () => {
  it('accepts a body of exactly CHAT_MESSAGE_MAX_LENGTH characters', async () => {
    const dto = new CreateMessageDto();
    dto.body = 'x'.repeat(CHAT_MESSAGE_MAX_LENGTH);

    expect(CHAT_MESSAGE_MAX_LENGTH).toBe(2000);
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects an empty or oversized body and a non-string body', async () => {
    const empty = new CreateMessageDto();
    empty.body = '';
    await expect(validate(empty)).resolves.not.toHaveLength(0);

    const oversized = new CreateMessageDto();
    oversized.body = 'x'.repeat(CHAT_MESSAGE_MAX_LENGTH + 1);
    await expect(validate(oversized)).resolves.not.toHaveLength(0);

    const nonString = new CreateMessageDto();
    (nonString as unknown as { body: number }).body = 123;
    await expect(validate(nonString)).resolves.not.toHaveLength(0);
  });
});

describe('CreateThreadDto field rules', () => {
  it('rejects an unknown space and a non-uuid reference', async () => {
    const badSpace = new CreateThreadDto();
    (badSpace as unknown as { space: string }).space = 'mentor';
    await expect(validate(badSpace)).resolves.not.toHaveLength(0);

    const badUuid = new CreateThreadDto();
    badUuid.space = 'question';
    badUuid.questionId = 'not-a-uuid';
    await expect(validate(badUuid)).resolves.not.toHaveLength(0);
  });

  it('accepts a valid question-space thread and a bare coach thread', async () => {
    const question = new CreateThreadDto();
    question.space = 'question';
    question.questionId = QUESTION_ID;
    await expect(validate(question)).resolves.toHaveLength(0);

    const coach = new CreateThreadDto();
    coach.space = 'coach';
    await expect(validate(coach)).resolves.toHaveLength(0);
  });
});
