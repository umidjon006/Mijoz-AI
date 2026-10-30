/**
 * FAQAT LOKAL HARNESS. `TrainerLlm` portining Anthropic SDK ustidagi
 * implementatsiyasi.
 *
 * MUHIM: provayder SDK'si FAQAT shu yerda. `module/` hech qanday SDK bilmaydi —
 * asosiy repoda host o'zining `getActiveLlm()` ini beradi.
 *
 * Env:
 *   ANTHROPIC_API_KEY — majburiy
 *   TRAINER_MODEL     — ixtiyoriy, default `claude-haiku-5-5` (tez, reasoning'siz)
 *
 * Retry siyosati: bu klient QAYTA URINMAYDI. Bitta tuzatish urinishi
 * engine'da (`takeTurn`) — shunda "bitta mijoz navbati = 1 (+1) chaqiruv"
 * qoidasi buzilmaydi va prompt ham mazmunli tuzatiladi.
 */
import Anthropic from '@anthropic-ai/sdk';

import type {
  TokenUsage,
  TrainerLlm,
  TrainerLlmRequest,
} from '../../module/backend/src/training/ports.js';
import type { LlmCallListener } from './bakeoff/types.js';

export const DEFAULT_TRAINER_MODEL = 'claude-haiku-5-5';

export interface AnthropicTrainerLlmOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  /** Har chaqiruvdan keyin chaqiriladi — `play --debug` shu orqali token ko'rsatadi. */
  onUsage?: (usage: TokenUsage & { latencyMs: number; stage: string }) => void;
  /** Bake-off o'lchovlari uchun (urinishlar soni, muvaffaqiyat, kechikish). */
  onCall?: LlmCallListener;
}

export class LlmOutputError extends Error {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.name = 'LlmOutputError';
    this.raw = raw;
  }
}

/** Matndan JSON obyektini ajratib oladi (code fence yoki ortiqcha gap bo'lsa ham). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fence?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // Oxirgi chora: matndagi eng tashqi { ... } ni olish.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new LlmOutputError('javobdan JSON ajratib olinmadi', text);
  }
}

export function createAnthropicTrainerLlm(options: AnthropicTrainerLlmOptions = {}): TrainerLlm {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY yo\'q (harness/.env ni to\'ldiring)');
  }
  const model = options.model ?? process.env.TRAINER_MODEL ?? DEFAULT_TRAINER_MODEL;
  const maxTokens = options.maxTokens ?? 1024;
  const client = new Anthropic({ apiKey });

  async function run<T>(
    req: TrainerLlmRequest<T>,
  ): Promise<{ value: T; usage: TokenUsage; latencyMs: number }> {
    const startedAt = Date.now();
    const message = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: `${req.system}\n\nReturn ONLY a single JSON object. No prose, no code fences.`,
      messages: [{ role: 'user', content: req.user }],
    });

    const text = message.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim();

    const usage: TokenUsage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      model,
    };
    const latencyMs = Date.now() - startedAt;
    options.onUsage?.({ ...usage, latencyMs, stage: req.stage });

    // Tekshiruv modulning sxemasi bilan: xato bo'lsa engine tuzatib qayta so'raydi.
    try {
      const value = req.schema.parse(extractJson(text));
      options.onCall?.({ stage: req.stage, attempts: 1, ok: true, latencyMs, usage });
      return { value, usage, latencyMs };
    } catch (err) {
      options.onCall?.({
        stage: req.stage,
        attempts: 1,
        ok: false,
        latencyMs,
        usage,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
      throw err;
    }
  }

  return {
    async completeJson<T>(req: TrainerLlmRequest<T>): Promise<T> {
      return (await run(req)).value;
    },
    async completeJsonWithUsage<T>(
      req: TrainerLlmRequest<T>,
    ): Promise<{ value: T; usage: TokenUsage }> {
      const out = await run(req);
      return { value: out.value, usage: out.usage };
    },
  };
}

/**
 * Juda sodda narxlash (USD, 1M token uchun). Faqat lokal baholash uchun —
 * asosiy repoda host o'z tariflarini beradi (`priceCall` porti).
 */
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 1, output: 5 },
  'claude-sonnet-5-5': { input: 3, output: 15 },
};

export function priceCall(usage: TokenUsage): number {
  const price = PRICE_PER_MTOK[usage.model ?? ''] ?? PRICE_PER_MTOK['claude-haiku-5-5'];
  if (!price) return 0;
  return (usage.inputTokens / 1_000_000) * price.input + (usage.outputTokens / 1_000_000) * price.output;
}
