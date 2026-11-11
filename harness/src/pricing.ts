/**
 * FAQAT HARNESS. Barcha narx konstantalari BIR JOYDA (USD, 1 000 000 token uchun).
 *
 * DIQQAT: Gemini narxlari 2027-01-01 dan IKKI BAROBAR oshadi — o'shanda shu
 * fayldagi raqamlarni yangilang (boshqa joyda narx yozilmagan).
 *
 * Narx faqat taxmin (log va sessiya `cost_usd` i uchun); haqiqiy hisob —
 * provayder billing sahifasida.
 */
import type { TokenUsage } from '../../module/backend/src/training/ports.js';

export interface TokenPrice {
  /** Kirish tokeni, $/1M. */
  input: number;
  /** Keshdan olingan kirish tokeni, $/1M (berilmasa `input`). */
  cachedInput?: number;
  /** Chiqish tokeni (reasoning/thinking BILAN), $/1M. */
  output: number;
}

/** Matnli LLM'lar. Kalit — model nomi (aynan provayderga yuboriladigani). */
export const LLM_PRICES: Record<string, TokenPrice> = {
  // Gemini 3.8 Flash — thinking tokenlari chiqish narxida. 2026-12-31 gacha.
  'gemini-3.8-flash': { input: 0.75, output: 3.75 },
  // OpenAI GPT-6 Luna (ixtiyoriy shaxsiy zaxira).
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, output: 0.5 },
  // Anthropic (eski default).
  'claude-haiku-5-5': { input: 1, output: 5 },
  'claude-sonnet-5-5': { input: 3, output: 15 },
};

/** Gemini TTS (gemini-3.8-flash-tts). */
export const GEMINI_TTS_PRICE = {
  /** Matn kirishi, $/1M token. */
  textInputPerM: 0.5,
  /** Audio chiqishi, $/1M token. */
  audioOutputPerM: 9.0,
  /** Hujjat: 1 soniya audio ≈ 25 token (usage kelmasa taxmin uchun). */
  audioTokensPerSecond: 25,
} as const;

/** Narxi noma'lum model uchun: 0 (taxmin qilib noto'g'ri raqam ko'rsatmaymiz). */
export function llmPriceOf(model: string | undefined): TokenPrice | null {
  return (model && LLM_PRICES[model]) || null;
}

/**
 * Bitta LLM chaqiruvining narxi. `outputTokens` thinking'ni ALLAQACHON
 * o'z ichiga oladi (adapterlar shunday to'ldiradi).
 */
export function priceCall(usage: TokenUsage): number {
  const price = llmPriceOf(usage.model);
  if (!price) return 0;
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const fresh = usage.inputTokens - cached;
  return (
    (fresh * price.input + cached * (price.cachedInput ?? price.input) + usage.outputTokens * price.output) /
    1_000_000
  );
}

/** TTS narxi: matn kirishi + audio chiqishi. */
export function priceGeminiTts(inputTokens: number, audioTokens: number): number {
  return (
    (inputTokens * GEMINI_TTS_PRICE.textInputPerM + audioTokens * GEMINI_TTS_PRICE.audioOutputPerM) / 1_000_000
  );
}
