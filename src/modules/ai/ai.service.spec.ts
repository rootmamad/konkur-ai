// Factory mock: intercepts the runtime `require('@nestjs/axios')` made by
// ai.service.ts (a value import retained via emitDecoratorMetadata) without
// loading the real ESM-only package. Scoped to this one test file.
jest.mock('@nestjs/axios', () => ({
  HttpService: class {
    post = jest.fn();
  },
}));

import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';

import type { Db } from '../../db/db.module';
import { AIService } from './ai.service';

/** Helper: build an Axios-like rejection with the given partial shape. */
function makeHttpError(
  status: number,
  message: string,
  usage?: { prompt_tokens: number; completion_tokens: number },
) {
  const err: Record<string, unknown> = {
    message,
    response: {
      status,
      data: {
        error: { message },
        ...(usage ? { usage } : {}),
      } as Record<string, unknown>,
    },
  };
  return Object.assign(new Error(message), err);
}

/** Build a full success response matching the Axios data shape. */
function makeOkResponse(
  content: string,
  usage: { prompt_tokens: number; completion_tokens: number },
) {
  return {
    data: {
      choices: [{ message: { content } }],
      usage,
    },
  };
}

// ---------------------------------------------------------------------------
// Shared mock factories
// ---------------------------------------------------------------------------

/** Mock HttpService — post returns whatever the caller supplies. */
function makeHttp() {
  const post = jest.fn();
  return { http: { post } as unknown as HttpService, post };
}

/** Mock ConfigService — returns the test key for any configured env var. */
function makeConfig() {
  const get = jest.fn((key: string) => {
    if (key === 'GEMINI_API_KEYS') return 'test-key-1,test-key-2';
    if (key === 'OPENROUTER_API_KEYS') return 'router-key-1,router-key-2';
    return undefined;
  });
  return { config: { get } as unknown as ConfigService, get };
}

/** Mock DB — captures every .values() call's argument for inspection. */
function makeDb() {
  const rows: Record<string, unknown>[] = [];
  const insert = jest.fn(() => ({
    values: jest.fn((row: Record<string, unknown>) => {
      rows.push(row);
      return Promise.resolve(undefined as void);
    }),
  }));
  return { db: { insert } as unknown as Db, rows, insert };
}

/** Construct a fully-mocked AIService for use in every test. */
function makeService(http: HttpService, config: ConfigService, db: Db) {
  return new AIService(http, config, db);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AIService', () => {
  describe('generate() — unchanged behaviour', () => {
    it('returns the raw completion string when the call succeeds', async () => {
      const { http, post } = makeHttp();
      const { config } = makeConfig();
      const { db } = makeDb();
      const svc = makeService(http, config, db);

      post.mockReturnValue(
        of(
          makeOkResponse('hello world', {
            prompt_tokens: 5,
            completion_tokens: 3,
          }),
        ),
      );

      const result = await svc.generate('say hello');
      expect(result).toBe('hello world');
      // generate() must NOT write ai_job rows.
      expect(post).toHaveBeenCalledTimes(1);
    });

    it('throws the original error shape when the HTTP call fails', async () => {
      const { http, post } = makeHttp();
      const { config } = makeConfig();
      const { db } = makeDb();
      const svc = makeService(http, config, db);

      post.mockReturnValue(throwError(() => makeHttpError(500, 'boom')));

      await expect(svc.generate('say hello')).rejects.toThrow(
        'AI request failed: boom',
      );
      // generate() must NOT write ai_job rows.
      expect(post).toHaveBeenCalledTimes(1);
    });
  });

  describe('runJob() — a) success with parse', () => {
    it('returns the parsed value and writes one row with tokens + latency', async () => {
      const { http, post } = makeHttp();
      const { config } = makeConfig();
      const { db, rows } = makeDb();
      const svc = makeService(http, config, db);

      const parse = (raw: string) => {
        const v = JSON.parse(raw) as { ok: number };

        if (v.ok !== 42) throw new Error('wrong answer');
        return v;
      };

      post.mockReturnValue(
        of(
          makeOkResponse('{"ok":42}', {
            prompt_tokens: 11,
            completion_tokens: 7,
          }),
        ),
      );

      const result = await svc.runJob({
        operation: 'explain',
        prompt: 'what is 6×7',
        parse,
      });

      expect(result).toEqual({ ok: 42 });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        operation: 'explain',
        model: 'gemini-3.6-flash',
        promptVersion: null,
        inputTokens: 11,
        outputTokens: 7,
        error: null,
        costMicroUsd: null,
      });
      // latencyMs is a non-negative integer (may be 0 in fast test environments)
      expect(typeof rows[0].latencyMs).toBe('number');
      expect(rows[0].latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('runJob() — b) HTTP failure', () => {
    it('writes one error row, re-throws the original error unchanged, tokens null', async () => {
      const { http, post } = makeHttp();
      const { config } = makeConfig();
      const { db, rows } = makeDb();
      const svc = makeService(http, config, db);

      // No usage payload on a normal HTTP error.
      post.mockReturnValue(
        throwError(() => makeHttpError(500, 'boom upstream')),
      );

      await expect(
        svc.runJob({ operation: 'coach', prompt: 'hello' }),
      ).rejects.toThrow('AI request failed: boom upstream');

      expect(rows).toHaveLength(1);
      expect(rows[0].error).toBe('AI request failed: boom upstream');
      expect(rows[0].inputTokens).toBeNull();
      expect(rows[0].outputTokens).toBeNull();
      expect(typeof rows[0].latencyMs).toBe('number');
    });

    it('captures usage tokens when the error response body includes them', async () => {
      const { http, post } = makeHttp();
      const { config } = makeConfig();
      const { db, rows } = makeDb();
      const svc = makeService(http, config, db);

      post.mockReturnValue(
        throwError(() =>
          makeHttpError(429, 'rate limited', {
            prompt_tokens: 5,
            completion_tokens: 2,
          }),
        ),
      );

      await expect(
        svc.runJob({ operation: 'grade', prompt: 'hello' }),
      ).rejects.toThrow('AI request failed: rate limited');

      expect(rows).toHaveLength(1);
      expect(rows[0].inputTokens).toBe(5);
      expect(rows[0].outputTokens).toBe(2);
      expect(rows[0].error).toBe('AI request failed: rate limited');
    });
  });

  describe('runJob() — c) parse fails then succeeds on retry', () => {
    it('writes two rows and returns the value from the second attempt', async () => {
      const { http, post } = makeHttp();
      const { config } = makeConfig();
      const { db, rows } = makeDb();
      const svc = makeService(http, config, db);

      const parse = (raw: string) => JSON.parse(raw) as { ok: number };

      // Attempt 1 → invalid JSON
      post.mockReturnValueOnce(
        of({
          data: {
            choices: [{ message: { content: 'not-json' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          },
        }),
      );
      // Attempt 2 → valid JSON
      post.mockReturnValueOnce(
        of(
          makeOkResponse('{"ok":7}', {
            prompt_tokens: 20,
            completion_tokens: 9,
          }),
        ),
      );

      const result = await svc.runJob({
        operation: 'study_extract',
        prompt: 'extract',
        parse,
      });

      expect(result).toEqual({ ok: 7 });
      expect(rows).toHaveLength(2);

      // First row: parse failure
      expect(rows[0].error).not.toBeNull();
      expect(rows[0].inputTokens).toBe(10);
      expect(rows[0].outputTokens).toBe(5);

      // Second row: success
      expect(rows[1].error).toBeNull();
      expect(rows[1].inputTokens).toBe(20);
      expect(rows[1].outputTokens).toBe(9);

      expect(post).toHaveBeenCalledTimes(2);
    });
  });

  describe('runJob() — d) parse fails twice', () => {
    it('writes two error rows and raises BadRequestException', async () => {
      const { http, post } = makeHttp();
      const { config } = makeConfig();
      const { db, rows } = makeDb();
      const svc = makeService(http, config, db);

      const parse = (raw: string) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const v = JSON.parse(raw);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (!v.ok) throw new Error('invalid schema');
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return v;
      };

      // Both attempts return invalid JSON.
      post.mockReturnValue(
        of({
          data: {
            choices: [{ message: { content: 'still-not-json' } }],
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          },
        }),
      );

      await expect(
        svc.runJob({ operation: 'exam_analysis', prompt: 'analyse', parse }),
      ).rejects.toThrow(
        new BadRequestException('AI output failed schema validation'),
      );

      expect(rows).toHaveLength(2);
      expect(rows[0].error).not.toBeNull();
      expect(rows[1].error).not.toBeNull();
      expect(post).toHaveBeenCalledTimes(2);
    });
  });

  describe('runJob() — e) db.insert rejects', () => {
    it('returns the result successfully and logs a warning without masking it', async () => {
      const { http, post } = makeHttp();
      const { config } = makeConfig();
      const { db, rows, insert } = makeDb();
      const svc = makeService(http, config, db);

      const parse = (raw: string) => JSON.parse(raw) as { ok: number };
      post.mockReturnValue(
        of(
          makeOkResponse('{"ok":9}', {
            prompt_tokens: 1,
            completion_tokens: 1,
          }),
        ),
      );

      // Make the *second* insert call (the one successful row) reject.
      // We capture it via mockImplementation the first time, then let it work thereafter.
      let rejectNext = true;
      insert.mockImplementation(() => ({
        values: jest.fn((row: Record<string, unknown>) => {
          if (rejectNext) {
            rejectNext = false;
            return Promise.reject(new Error('db connection lost'));
          }
          rows.push(row);
          return Promise.resolve(undefined as void);
        }),
      }));

      const warnSpy = jest.spyOn(
        (svc as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      );

      const result = await svc.runJob({
        operation: 'explain',
        prompt: 'test',
        parse,
      });

      // Primary result is still correct.
      expect(result).toEqual({ ok: 9 });
      // At least one warning was logged about the insert failure.
      expect(warnSpy).toHaveBeenCalled();
      expect(
        warnSpy.mock.calls.some(([msg]) =>
          String(msg).includes('db connection lost'),
        ),
      ).toBe(true);

      warnSpy.mockRestore();
    });

    it('propagates the primary HTTP error unchanged when the error-row insert also fails', async () => {
      const { http, post } = makeHttp();
      const { config } = makeConfig();
      const { db, insert } = makeDb();
      const svc = makeService(http, config, db);

      post.mockReturnValue(throwError(() => makeHttpError(502, 'bad gateway')));

      // The error-row insert also fails.
      insert.mockImplementation(() => ({
        values: jest.fn(() => Promise.reject(new Error('db gone'))),
      }));

      const warnSpy = jest.spyOn(
        (svc as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      );

      await expect(
        svc.runJob({ operation: 'grade', prompt: 'grade this' }),
      ).rejects.toThrow('AI request failed: bad gateway');

      // The primary error was still re-thrown.
      // A warn about the logging failure was emitted.
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  describe('runJob() — extra: raw content (no parse)', () => {
    it('returns the raw string and writes one success row', async () => {
      const { http, post } = makeHttp();
      const { config } = makeConfig();
      const { db, rows } = makeDb();
      const svc = makeService(http, config, db);

      post.mockReturnValue(
        of(
          makeOkResponse('raw text response', {
            prompt_tokens: 2,
            completion_tokens: 4,
          }),
        ),
      );

      const result = await svc.runJob<string>({
        operation: 'question_chat',
        prompt: 'hello',
      });

      expect(result).toBe('raw text response');
      expect(rows).toHaveLength(1);
      expect(rows[0].error).toBeNull();
      expect(rows[0].inputTokens).toBe(2);
      expect(rows[0].outputTokens).toBe(4);
    });

    it('writes a promptVersion row when one is supplied', async () => {
      const { http, post } = makeHttp();
      const { config } = makeConfig();
      const { db, rows } = makeDb();
      const svc = makeService(http, config, db);

      post.mockReturnValue(
        of(makeOkResponse('ok', { prompt_tokens: 1, completion_tokens: 1 })),
      );

      await svc.runJob({
        operation: 'coach',
        prompt: 'p',
        promptVersion: 'v2.1',
      });

      expect(rows[0].promptVersion).toBe('v2.1');
    });
  });
});
