import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import {
  AI_MODELS,
  AIModelName,
  DEFAULT_AI_MODEL,
} from './ai-models';

@Injectable()
export class AIService {
  private readonly logger = new Logger(AIService.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  /**
   * یه متن بفرست، جواب بگیر.
   * @param prompt متنی که می‌خوای بفرستی
   * @param modelName کدوم مدل (پیش‌فرض: DEFAULT_AI_MODEL)
   */
  async generate(
    prompt: string,
    modelName: AIModelName = DEFAULT_AI_MODEL,
  ): Promise<string> {
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

    // اگر چند کلید داری، یکیش رو تصادفی برمی‌داریم (load balancing سبک)
    const key = keys[Math.floor(Math.random() * keys.length)];

    const body: Record<string, any> = {
      model: cfg.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: cfg.temperature ?? 0.2,
    };

    try {
      const res = await firstValueFrom(
        this.http.post(`${cfg.baseUrl}/chat/completions`, body, {
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json'
          },
          timeout: 60_000,
        }),
      );

      return res.data?.choices?.[0]?.message?.content ?? '';
    } catch (err: any) {
      const status = err?.response?.status;
      const detail = err?.response?.data?.error?.message ?? err.message;
      this.logger.error(
        `[${modelName}] AI request failed (status=${status}): ${detail}`,
      );
      throw new Error(`AI request failed: ${detail}`);
    }
  }
}