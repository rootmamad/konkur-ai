import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import { aiJob, aiOperation } from '../../db/schema/ai-job';
import { AI_MODELS, AIModelName, DEFAULT_AI_MODEL } from './ai-models';

/** One of the spec §12 operation labels stored in every ai_job row. */
export type AiOperation = (typeof aiOperation.enumValues)[number];

/**
 * Input shape for {@link AIService.runJob}.
 * @property operation     — which spec §12 bucket this call belongs to.
 * @property prompt        — the user-facing prompt (never written to ai_job).
 * @property modelName     — optional override; defaults to DEFAULT_AI_MODEL.
 * @property promptVersion — optional revision tag written to the row for cache-busting.
 * @property parse         — optional server-side validator; throw to reject the raw output.
 *                          The whole model call is then retried once; two parse failures
 *                          result in a BadRequestException (spec §13.3).
 */
export interface RunJobInput<T = unknown> {
  operation: AiOperation;
  prompt: string;
  modelName?: AIModelName;
  promptVersion?: string;
  parse?: (raw: string) => T;
}

@Injectable()
export class AIService {
  private readonly logger = new Logger(AIService.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
    @Inject(DB) private readonly db: Db,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API — mirrors the original generate() signature exactly.
  // ---------------------------------------------------------------------------

  /**
   * Send a prompt and receive the raw completion string.
   *
   * @param prompt    the user prompt
   * @param modelName which model (default: DEFAULT_AI_MODEL from ai-models.ts)
   */
  async generate(
    prompt: string,
    modelName: AIModelName = DEFAULT_AI_MODEL,
  ): Promise<string> {
    const { content } = await this.callModel(modelName, prompt);
    return content;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Make one HTTP round-trip to the model provider.
   *
   * Returns `{ content, inputTokens, outputTokens }`.  Tokens are `null` when
   * the provider does not supply them.  On HTTP failure the original axios
   * error is wrapped in a plain `Error` (same shape as the old `generate`),
   * logged via `Logger.error`, and re-thrown so callers always receive the
   * same shape they relied on before this refactor.
   */
  private async callModel(
    modelName: AIModelName,
    prompt: string,
  ): Promise<{
    content: string;
    inputTokens: number | null;
    outputTokens: number | null;
  }> {
    const cfg = AI_MODELS[modelName];
    if (!cfg) {
      throw new Error(`Unknown AI model: ${modelName}`);
    }

    const keys = (this.config.get<string>(cfg.apiKeysEnv) ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);

    if (keys.length === 0) {
      throw new Error(`No API key found in env: ${cfg.apiKeysEnv}`);
    }

    const key = keys[Math.floor(Math.random() * keys.length)];

    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: cfg.temperature ?? 0.2,
    };

    try {
      const raw = await firstValueFrom(
        this.http.post(`${cfg.baseUrl}/chat/completions`, body, {
          /* eslint-disable @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-member-access */
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            ...((cfg as any).extraHeaders ?? {}),
          },
          /* eslint-enable @typescript-eslint/no-unsafe-assignment */
          timeout: 60_000,
        }),
      );

      /* eslint-disable @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unnecessary-type-assertion */
      const data = (raw as any).data as any;
      return {
        content: data.choices?.[0]?.message?.content ?? '',
        inputTokens: data.usage?.prompt_tokens ?? null,
        outputTokens: data.usage?.completion_tokens ?? null,
      };
      /* eslint-enable @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unnecessary-type-assertion */
    } catch (err: unknown) {
      const axiosErr = err as {
        response?: { status?: number; data?: { error?: { message?: string } } };
      };
      const status = axiosErr?.response?.status;
      const detail =
        axiosErr?.response?.data?.error?.message ??
        (err instanceof Error ? err.message : String(err));
      this.logger.error(
        `[${modelName}] AI request failed (status=${status}): ${detail}`,
      );
      // Preserve the original error so runJob can read .response for usage tokens.
      if (err instanceof Error) {
        err.message = `AI request failed: ${detail}`;
        throw err;
      }
      throw new Error(`AI request failed: ${detail}`);
    }
  }

  /**
   * Persist one ai_job row (spec §12 / §13.3).
   *
   * The insert is wrapped in try/catch so a logging failure never masks the
   * caller's primary result or the primary error that triggered the row.
   *
   * @param operation      — the ai_operation enum value.
   * @param model         — the provider model string, e.g. "gemini-3.6-flash".
   * @param promptVersion — nullable; written as-is so callers can track revisions.
   * @param row           — the measured telemetry for this single attempt.
   */
  private async logRow(
    operation: AiOperation,
    model: string,
    promptVersion: string | null,
    row: {
      inputTokens: number | null;
      outputTokens: number | null;
      latencyMs: number;
      error: string | null;
    },
  ): Promise<void> {
    try {
      await this.db.insert(aiJob).values({
        operation,
        model,
        promptVersion,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        latencyMs: row.latencyMs,
        error: row.error,
        costMicroUsd: null,
      });
    } catch (logErr: unknown) {
      const msg = logErr instanceof Error ? logErr.message : String(logErr);
      this.logger.warn(`[${operation}] Failed to write ai_job log row: ${msg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Run a logged, optionally validated model call.
  // ---------------------------------------------------------------------------

  /**
   * Run one model call attributed to a specific operation.
   *
   * **Retry semantics** (spec §13.3):
   * - If `parse` is supplied and throws, the whole model call is retried **once**
   *   before a `BadRequestException('AI output failed schema validation')` is raised.
   * - HTTP / network failures are **not** retried; an error row is written and the
   *   original error is re-thrown unchanged.
   *
   * **Row semantics**:
   * - One row is written **per attempt** (maximum 2 rows).
   * - `latencyMs` is measured around the HTTP call (including key rotation).
   * - Prompt text and API keys are never written to the row.
   */
  async runJob<T>(input: RunJobInput<T>): Promise<T> {
    const modelName = input.modelName ?? DEFAULT_AI_MODEL;
    const cfg = AI_MODELS[modelName];
    if (!cfg) {
      throw new Error(`Unknown AI model: ${modelName}`);
    }

    // The maximum number of model-call attempts: parse supplied → 2, else 1.
    const maxAttempts = input.parse ? 2 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startedAt = Date.now();

      let content: string;
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;

      try {
        const res = await this.callModel(modelName, input.prompt);
        content = res.content;
        inputTokens = res.inputTokens;
        outputTokens = res.outputTokens;
      } catch (err: unknown) {
        // HTTP / network failure — log the error row and re-throw the original
        // error unchanged so callers receive exactly the shape they relied on.
        const latencyMs = Date.now() - startedAt;
        const axiosErr = err as {
          response?: {
            data?: {
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
          };
        };
        // Tokens can be present in the upstream error body on e.g. 429 responses.
        const errInputTokens: number | null =
          typeof axiosErr?.response?.data?.usage?.prompt_tokens === 'number'
            ? axiosErr.response.data.usage.prompt_tokens
            : null;
        const errOutputTokens: number | null =
          typeof axiosErr?.response?.data?.usage?.completion_tokens === 'number'
            ? axiosErr.response.data.usage.completion_tokens
            : null;
        const errMsg = err instanceof Error ? err.message : String(err);

        await this.logRow(
          input.operation,
          cfg.model,
          input.promptVersion ?? null,
          {
            inputTokens: errInputTokens,
            outputTokens: errOutputTokens,
            latencyMs,
            error: errMsg,
          },
        );
        throw err;
      }

      const latencyMs = Date.now() - startedAt;

      // --- No structured-output validator: return raw content as-is ----------------
      if (!input.parse) {
        await this.logRow(
          input.operation,
          cfg.model,
          input.promptVersion ?? null,
          {
            inputTokens,
            outputTokens,
            latencyMs,
            error: null,
          },
        );
        return content as T;
      }

      // --- Structured-output validation ----------------------------------------
      try {
        const value = input.parse(content);
        await this.logRow(
          input.operation,
          cfg.model,
          input.promptVersion ?? null,
          {
            inputTokens,
            outputTokens,
            latencyMs,
            error: null,
          },
        );
        return value;
      } catch (parseErr: unknown) {
        const parseMsg =
          parseErr instanceof Error ? parseErr.message : String(parseErr);
        await this.logRow(
          input.operation,
          cfg.model,
          input.promptVersion ?? null,
          {
            inputTokens,
            outputTokens,
            latencyMs,
            error: parseMsg,
          },
        );
        // Retry once if this is the first parse failure.
        if (attempt < maxAttempts) {
          continue;
        }
        // Second parse failure is a client-facing schema error.
        throw new BadRequestException('AI output failed schema validation');
      }
    }

    // Unreachable: the loop returns or throws inside; satisfy TS.
    throw new Error(
      'AIService.runJob: exhausted all attempts without a result',
    );
  }
}
