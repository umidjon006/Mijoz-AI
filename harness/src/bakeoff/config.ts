/**
 * FAQAT HARNESS. Bake-off konfiguratsiyasi.
 *
 * Nomzodlar HECH QACHON kodda qattiq yozilmaydi — `harness/bakeoff.config.json`
 * dan o'qiladi. API kalitlari esa konfigda emas, faqat `harness/.env` da
 * (konfigda faqat env o'zgaruvchisining NOMI turadi).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
export const harnessRoot = resolve(here, '../..');
export const bakeoffDir = resolve(harnessRoot, 'bakeoff');
export const bakeoffOutDir = resolve(bakeoffDir, 'out');
export const configPath = resolve(harnessRoot, 'bakeoff.config.json');

export const pricePerMTokSchema = z.object({
  input: z.number().min(0),
  output: z.number().min(0),
});

export type PricePerMTok = z.infer<typeof pricePerMTokSchema>;

export const candidateSchema = z.object({
  /** Qisqa nom — natijalarda va hisobotda shu ishlatiladi. */
  label: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9_-]*$/i, "label faqat harf/raqam/-/_ bo'lishi mumkin"),
  provider: z.enum(['anthropic', 'openai-compatible']),
  model: z.string().min(1),
  /** `openai-compatible` uchun majburiy. */
  baseUrl: z.string().url().optional(),
  /** Kalit shu env o'zgaruvchisidan olinadi (kalitning o'zi emas!). */
  apiKeyEnv: z.string().min(1),
  pricePerMTok: pricePerMTokSchema,
  /** JSON rejimi: provayder qo'llamasa `prompt` (JSON-in-prompt + retry). */
  jsonMode: z.enum(['json_object', 'json_schema', 'prompt']).default('json_object'),
  maxTokens: z.number().int().min(256).max(8192).default(1024),
  enabled: z.boolean().default(true),
  _izoh: z.string().optional(),
});

export type Candidate = z.infer<typeof candidateSchema>;

export const bakeoffConfigSchema = z
  .object({
    /** Sotuvchini o'ynaydigan QAT'IY model — hamma nomzod uchun bir xil. */
    sellerModel: z.string().min(1).default('claude-sonnet-5-5'),
    sellerApiKeyEnv: z.string().min(1).default('ANTHROPIC_API_KEY'),
    defaultProfile: z.string().min(1).default('o_quv_markaz'),
    /** Domen umumiyligini tekshirish uchun ikkinchi profil. */
    secondProfile: z.string().min(1).nullable().default(null),
    secondProfileArchetype: z.string().min(1).default('negotiator'),
    repetitions: z.number().int().min(1).max(20).default(3),
    /** Bitta sessiyadagi eng ko'p sotuvchi navbati (xarajatni cheklaydi). */
    maxTurnsPerSession: z.number().int().min(2).max(30).default(8),
    /** Ko'r baholashdagi aralashtirish urug'i — takrorlanishi uchun saqlanadi. */
    shuffleSeed: z.string().min(1).default('bakeoff'),
    candidates: z.array(candidateSchema).min(1),
    _izoh: z.unknown().optional(),
    _examples: z.unknown().optional(),
  })
  .superRefine((config, ctx) => {
    const labels = config.candidates.map((c) => c.label);
    if (new Set(labels).size !== labels.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['candidates'],
        message: "nomzod `label` lari unikal bo'lishi kerak",
      });
    }
    for (const [i, candidate] of config.candidates.entries()) {
      if (candidate.provider === 'openai-compatible' && !candidate.baseUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['candidates', i, 'baseUrl'],
          message: "`openai-compatible` uchun `baseUrl` majburiy",
        });
      }
    }
  });

export type BakeoffConfig = z.infer<typeof bakeoffConfigSchema>;

export function parseBakeoffConfig(raw: unknown): BakeoffConfig {
  return bakeoffConfigSchema.parse(raw);
}

export function loadBakeoffConfig(path = configPath): BakeoffConfig {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return parseBakeoffConfig(raw);
}

/** Kaliti yo'q nomzodlarni ajratib beradi (ular o'tkazib yuboriladi). */
export function splitByKeyAvailability(candidates: readonly Candidate[]): {
  ready: Candidate[];
  missingKey: Candidate[];
} {
  const ready: Candidate[] = [];
  const missingKey: Candidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.enabled) continue;
    if (process.env[candidate.apiKeyEnv]) ready.push(candidate);
    else missingKey.push(candidate);
  }
  return { ready, missingKey };
}
