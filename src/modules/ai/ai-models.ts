
export interface AIModelConfig {
  model: string;
  baseUrl: string;
  apiKeysEnv: string;
  label?: string;
  extraHeaders?: Record<string, string>;
  temperature?: number;
  maxTokens?: number;
}

export const AI_MODELS = {
  gemini: {
    label: 'Gemini 3.6 Flash',
    model: 'gemini-3.6-flash',                 // ← اسم دقیق مدل رو اینجا بذار
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeysEnv: 'GEMINI_API_KEYS',
    temperature: 0.3,
  },

  openrouter: {
    label: 'OpenRouter (Claude)',
    model: 'anthropic/claude-3.5-sonnet',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeysEnv: 'OPENROUTER_API_KEYS',
    extraHeaders: {
      'HTTP-Referer': 'https://konkur-ai.local',
      'X-Title': 'Konkur AI',
    },
    temperature: 0.3,
  },
} as const satisfies Record<string, AIModelConfig>;

export type AIModelName = keyof typeof AI_MODELS;

export const DEFAULT_AI_MODEL: AIModelName = 'gemini';