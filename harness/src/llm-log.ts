/**
 * FAQAT HARNESS. Har bir LLM chaqiruvi uchun BITTA log qatori:
 *
 *   [llm] stage=training.persona model=gemini-3.8-flash latency=4210ms tokens=812/430 outcome=ok
 *
 * stderr ga yoziladi (play'ning dialog chiqishi stdout'da qoladi).
 * O'chirish: `TRAINER_LLM_LOG=0`. Kalit/prompt matni HECH QACHON chiqmaydi.
 */
import type { TokenUsage } from '../../module/backend/src/training/ports.js';
import { envBool } from './env.js';

export interface LlmCallLog {
  stage: string;
  model: string;
  latencyMs: number;
  usage?: TokenUsage & { reasoningTokens?: number };
  /** ok | timeout | http_429 | invalid_json | schema | unknown */
  outcome: string;
  /** Nechanchi urinish (timeout qayta urinishi bo'lsa 2). */
  attempt?: number;
  /** Qisqa izoh (xato toifasi tavsifi). */
  detail?: string;
}

export type LlmLogSink = (line: string) => void;

export function formatLlmCallLog(entry: LlmCallLog): string {
  const parts = [
    `stage=${entry.stage}`,
    `model=${entry.model}`,
    `latency=${entry.latencyMs}ms`,
    entry.usage
      ? `tokens=${entry.usage.inputTokens}/${entry.usage.outputTokens}` +
        (entry.usage.reasoningTokens ? ` (reasoning ${entry.usage.reasoningTokens})` : '')
      : 'tokens=-',
    `outcome=${entry.outcome}`,
  ];
  if (entry.attempt && entry.attempt > 1) parts.push(`attempt=${entry.attempt}`);
  if (entry.detail) parts.push(`· ${entry.detail.replace(/\s+/g, ' ').slice(0, 200)}`);
  return `[llm] ${parts.join(' ')}`;
}

/** Default sink: stderr; `TRAINER_LLM_LOG=0` bo'lsa jim. */
export function defaultLlmLogSink(): LlmLogSink | null {
  return envBool('TRAINER_LLM_LOG', true) ? (line) => console.error(line) : null;
}
