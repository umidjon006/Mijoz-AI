/** FAQAT HARNESS. Bake-off natijalarining shakllari. */
import { z } from 'zod';

import type { TokenUsage } from '../../../module/backend/src/training/ports.js';

/** LLM adapteri har chaqiruvdan keyin shu hodisani beradi. */
export interface LlmCallEvent {
  stage: string;
  /** Nechta urinish ketdi (1 = birinchi urinishdayoq to'g'ri JSON). */
  attempts: number;
  ok: boolean;
  latencyMs: number;
  usage?: TokenUsage;
  error?: string;
}

export type LlmCallListener = (event: LlmCallEvent) => void;

export type SellerScript = 'careless' | 'skilled' | 'injection';

export const SELLER_SCRIPTS: SellerScript[] = ['careless', 'skilled', 'injection'];

export const transcriptTurnSchema = z.object({
  speaker: z.enum(['seller', 'customer']),
  text: z.string(),
});

/** Bitta sessiya natijasi — `runs.jsonl` ga shu yoziladi. */
export const sessionRunSchema = z.object({
  /** Takrorlanishni aniqlaydigan kalit (resume uchun). */
  key: z.string().min(1),
  candidate: z.string().min(1),
  model: z.string().min(1),
  archetype: z.string().min(1),
  script: z.enum(['careless', 'skilled', 'injection']),
  profile: z.string().min(1),
  rep: z.number().int().min(1),

  outcome: z.string().nullable(),
  endReason: z.string().nullable(),
  /** Sotuvchi navbatlari soni. */
  turns: z.number().int().min(0),
  guardViolations: z.number().int().min(0),

  /** Mijoz (nomzod) chaqiruvlari. */
  customerCalls: z.object({
    total: z.number().int().min(0),
    firstTryOk: z.number().int().min(0),
    afterRetryOk: z.number().int().min(0),
    failed: z.number().int().min(0),
  }),
  /** Har mijoz navbatining kechikishi (ms). */
  latenciesMs: z.array(z.number()),
  tokens: z.object({ input: z.number().int().min(0), output: z.number().int().min(0) }),
  costUsd: z.number().min(0),

  /** 30 so'zdan uzun javoblar soni. */
  tooLongReplies: z.number().int().min(0),
  /** Persona tilida bo'lmagan javoblar soni (evristik). */
  wrongLanguageReplies: z.number().int().min(0),
  /**
   * Sotuvchi (shu suhbatda) aytmagan va mijozning o'z yashirin faktlarida
   * ham yo'q narxni tilga olgan javoblar soni. Eski `runs.jsonl` da yo'q -> 0.
   */
  unsaidPriceReplies: z.number().int().min(0).default(0),
  customerReplies: z.number().int().min(0),

  transcript: z.array(transcriptTurnSchema),
  personaName: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.string(),
  durationMs: z.number().min(0),
});

export type SessionRun = z.infer<typeof sessionRunSchema>;

export function runKey(input: {
  candidate: string;
  archetype: string;
  script: SellerScript;
  profile: string;
  rep: number;
}): string {
  return `${input.candidate}|${input.archetype}|${input.script}|${input.profile}|${input.rep}`;
}
