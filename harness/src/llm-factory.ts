/**
 * FAQAT HARNESS. Qaysi LLM ishlatilishini env bo'yicha hal qiladi.
 *
 * Env:
 *   TRAINER_PROVIDER    anthropic | openai-compatible   (default: anthropic)
 *   TRAINER_MODEL       mijoz navbati modeli
 *   TRAINER_SCORING_MODEL  baholash modeli (berilmasa TRAINER_MODEL)
 *   TRAINER_API_KEY_ENV kalit qaysi env o'zgaruvchisida (kalitning O'ZI emas)
 *   TRAINER_BASE_URL    `openai-compatible` uchun majburiy
 *   TRAINER_JSON_MODE   schema | object | prompt          (default: object)
 *   TRAINER_REASONING_EFFORT          mijoz navbati (va persona) uchun
 *   TRAINER_SCORING_REASONING_EFFORT  baholash uchun
 *                       none | minimal | low | medium | high; bo'sh — yuborilmaydi
 *                       (provayder default'i). Faqat `openai-compatible`.
 *   TRAINER_MAX_TOKENS_PARAM    auto | max_tokens | max_completion_tokens   (default auto:
 *                       api.openai.com -> max_completion_tokens, boshqalar -> max_tokens)
 *   TRAINER_TIMEOUT_MS          bitta so'rov chegarasi, mijoz/persona (default 60000)
 *   TRAINER_SCORING_TIMEOUT_MS  bitta so'rov chegarasi, baholash     (default 120000)
 *   DEMO_LLM=1          soxta (demo) LLM — faqat ANIQ so'ralganda
 *
 * Hamma joyda BO'SH qiymat = "default" (o'zgaruvchi yo'qdek).
 *
 * MUHIM: kalit yo'q bo'lsa demo LLM'ga JIM O'TILMAYDI. Yo aniq `DEMO_LLM=1`
 * qo'yiladi, yo skript tushunarli ogohlantirish bilan to'xtaydi.
 */
// ENG BIRINCHI: `.env` ni yuklaydi (import tartibi qanday bo'lsa ham).
import { envInt, envStr, harnessEnv, type EnvLoadResult } from './env.js';

import type { TrainerLlm } from '../../module/backend/src/training/ports.js';
import type { BusinessProfile } from '../../module/backend/src/training/profile-schema.js';
import { createDemoLlm } from './demo-llm.js';
import { createAnthropicTrainerLlm, DEFAULT_TRAINER_MODEL } from './llm-anthropic.js';
import {
  createOpenAiCompatibleLlm,
  resolveMaxTokensParam,
  type JsonMode,
  type MaxTokensParamSetting,
} from './llm-openai-compatible.js';

export type TrainerProvider = 'anthropic' | 'openai-compatible';

export const DEFAULT_SCORING_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_SCORING_TIMEOUT_MS = 120_000;
export const DEFAULT_JSON_MODE: JsonMode = 'object';
/** Baholash JSON'i katta (mezonlar + coaching) — 1024 token kesib qo'yardi. */
export const SCORING_MAX_TOKENS = 4096;
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ProviderConfig {
  provider: TrainerProvider;
  /** Kalit shu env o'zgaruvchisida kutiladi. */
  keyEnv: string;
  baseUrl: string | null;
  model: string;
  scoringModel: string;
  /** `DEMO_LLM=1` qo'yilganmi. */
  demoRequested: boolean;
  /** `keyEnv` to'ldirilganmi. */
  hasKey: boolean;
  jsonMode: JsonMode;
  /** `null` — yuborilmaydi (provayder default'i). */
  reasoningEffort: ReasoningEffort | null;
  scoringReasoningEffort: ReasoningEffort | null;
  timeoutMs: number;
  scoringTimeoutMs: number;
  maxTokensParam: MaxTokensParamSetting;
}

export class MissingLlmKeyError extends Error {
  readonly config: ProviderConfig;
  constructor(config: ProviderConfig) {
    super(`${config.keyEnv} env o'zgaruvchisi bo'sh yoki yo'q`);
    this.name = 'MissingLlmKeyError';
    this.config = config;
  }
}

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

/** Env'ni o'qib, qaysi provayder va qaysi model ishlatilishini aniqlaydi. */
function parseJsonMode(env: NodeJS.ProcessEnv): JsonMode {
  const raw = envStr('TRAINER_JSON_MODE', env);
  if (raw === undefined) return DEFAULT_JSON_MODE;
  // Eski nomlar ham qabul qilinadi.
  if (raw === 'schema' || raw === 'json_schema') return 'schema';
  if (raw === 'object' || raw === 'json_object') return 'object';
  if (raw === 'prompt') return 'prompt';
  throw new ProviderConfigError(
    `TRAINER_JSON_MODE "${raw}" noto'g'ri — faqat schema | object | prompt`,
  );
}

function parseMaxTokensParam(env: NodeJS.ProcessEnv): MaxTokensParamSetting {
  const raw = envStr('TRAINER_MAX_TOKENS_PARAM', env);
  if (raw === undefined) return 'auto';
  if (raw === 'auto' || raw === 'max_tokens' || raw === 'max_completion_tokens') return raw;
  throw new ProviderConfigError(
    `TRAINER_MAX_TOKENS_PARAM "${raw}" noto'g'ri — auto | max_tokens | max_completion_tokens`,
  );
}

function parseEffort(name: string, env: NodeJS.ProcessEnv): ReasoningEffort | null {
  const raw = envStr(name, env)?.toLowerCase();
  if (raw === undefined) return null;
  if ((REASONING_EFFORTS as readonly string[]).includes(raw)) return raw as ReasoningEffort;
  throw new ProviderConfigError(
    `${name} "${raw}" noto'g'ri — ${REASONING_EFFORTS.join(' | ')} yoki bo'sh`,
  );
}

function parseTimeout(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  try {
    return envInt(name, fallback, { min: 1_000, max: 600_000, env });
  } catch (err) {
    throw new ProviderConfigError(err instanceof Error ? err.message : String(err));
  }
}

export function resolveProviderConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const demoRequested = envStr('DEMO_LLM', env) === '1';
  const raw = envStr('TRAINER_PROVIDER', env) ?? 'anthropic';

  if (raw !== 'anthropic' && raw !== 'openai-compatible') {
    throw new ProviderConfigError(
      `TRAINER_PROVIDER "${raw}" noto'g'ri — faqat "anthropic" yoki "openai-compatible"`,
    );
  }
  const provider: TrainerProvider = raw;

  const keyEnv =
    envStr('TRAINER_API_KEY_ENV', env) ?? (provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : '');

  if (provider === 'openai-compatible') {
    if (!envStr('TRAINER_BASE_URL', env)) {
      throw new ProviderConfigError(
        "TRAINER_PROVIDER=openai-compatible uchun TRAINER_BASE_URL majburiy",
      );
    }
    if (!keyEnv) {
      throw new ProviderConfigError(
        "TRAINER_PROVIDER=openai-compatible uchun TRAINER_API_KEY_ENV majburiy (kalit NOMI)",
      );
    }
    if (!envStr('TRAINER_MODEL', env)) {
      throw new ProviderConfigError(
        "TRAINER_PROVIDER=openai-compatible uchun TRAINER_MODEL majburiy",
      );
    }
  }

  const model =
    envStr('TRAINER_MODEL', env) ?? (provider === 'anthropic' ? DEFAULT_TRAINER_MODEL : '');
  const scoringModel =
    envStr('TRAINER_SCORING_MODEL', env) ??
    (provider === 'anthropic' ? DEFAULT_SCORING_MODEL : model);

  return {
    provider,
    keyEnv,
    baseUrl: envStr('TRAINER_BASE_URL', env) ?? null,
    model,
    scoringModel,
    demoRequested,
    hasKey: Boolean(keyEnv && envStr(keyEnv, env)),
    jsonMode: parseJsonMode(env),
    reasoningEffort: parseEffort('TRAINER_REASONING_EFFORT', env),
    scoringReasoningEffort: parseEffort('TRAINER_SCORING_REASONING_EFFORT', env),
    timeoutMs: parseTimeout('TRAINER_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, env),
    scoringTimeoutMs: parseTimeout('TRAINER_SCORING_TIMEOUT_MS', DEFAULT_SCORING_TIMEOUT_MS, env),
    maxTokensParam: parseMaxTokensParam(env),
  };
}

export interface ResolvedLlm {
  llm: TrainerLlm;
  /** Hisobot uchun: 'anthropic' | 'openai-compatible' | 'demo'. */
  provider: TrainerProvider | 'demo';
  model: string;
  isDemo: boolean;
}

export interface CreateTrainerLlmOptions {
  /** Demo LLM uchun kerak (profildan javob yasaydi). */
  profile: BusinessProfile;
  /** Baholash uchun model (TRAINER_SCORING_MODEL) ishlatiladi. */
  scoring?: boolean;
  config?: ProviderConfig;
}

/**
 * LLM yasaydi. Kalit yo'q va `DEMO_LLM=1` ham qo'yilmagan bo'lsa
 * `MissingLlmKeyError` tashlaydi — JIM demo'ga o'tmaydi.
 */
export function createTrainerLlm({
  profile,
  scoring = false,
  config = resolveProviderConfig(),
}: CreateTrainerLlmOptions): ResolvedLlm {
  if (config.demoRequested) {
    return { llm: createDemoLlm({ profile }), provider: 'demo', model: 'demo-llm', isDemo: true };
  }
  if (!config.hasKey) {
    throw new MissingLlmKeyError(config);
  }

  const apiKey = (process.env[config.keyEnv] as string).trim();
  const model = scoring ? config.scoringModel : config.model;
  const timeoutMs = scoring ? config.scoringTimeoutMs : config.timeoutMs;
  const maxTokens = scoring ? SCORING_MAX_TOKENS : undefined;

  if (config.provider === 'anthropic') {
    return {
      llm: createAnthropicTrainerLlm({ apiKey, model, timeoutMs, ...(maxTokens ? { maxTokens } : {}) }),
      provider: 'anthropic',
      model,
      isDemo: false,
    };
  }

  const effort = scoring ? config.scoringReasoningEffort : config.reasoningEffort;
  return {
    llm: createOpenAiCompatibleLlm({
      apiKey,
      baseUrl: config.baseUrl as string,
      model,
      jsonMode: config.jsonMode,
      maxTokensParam: config.maxTokensParam,
      timeoutMs,
      ...(maxTokens ? { maxTokens } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
    }),
    provider: 'openai-compatible',
    model,
    isDemo: false,
  };
}

// ---------------------------------------------------------------------------
// Bannerlar
// ---------------------------------------------------------------------------
function box(lines: readonly string[]): string {
  const width = Math.max(...lines.map((line) => [...line].length)) + 2;
  const bar = '='.repeat(width + 2);
  return [bar, ...lines.map((line) => `  ${line}`), bar].join('\n');
}

/** Demo rejimi haqida KO'ZGA TASHLANADIGAN ogohlantirish. */
export function printDemoBanner(where: string): void {
  console.warn(
    `\n${box([
      'DEMO AI — BU HAQIQIY MODEL EMAS',
      '',
      `${where}: DEMO_LLM=1 qo'yilgani uchun soxta LLM ishlayapti.`,
      "Mijoz javoblari sodda va qolipli; sifat, kechikish va narx",
      "haqida HECH QANDAY xulosa chiqarib bo'lmaydi.",
      '',
      "Haqiqiy model uchun: DEMO_LLM ni o'chiring va harness/.env ga",
      'kalit qo\'ying (quyida ko\'rsatilgan env o\'zgaruvchisiga).',
    ])}\n`,
  );
}

/** Kalit yo'qligi haqida ogohlantirish (va nima qilish kerakligi). */
export function printMissingKeyBanner(where: string, config: ProviderConfig): void {
  console.error(
    `\n${box([
      'LLM KALITI YO\'Q — ishga tushirib bo\'lmaydi',
      '',
      `${where}: provayder "${config.provider}", kalit "${config.keyEnv}" env'da kutilyapti,`,
      "lekin u bo'sh yoki yo'q.",
      '',
      'Ikki yo\'ldan birini tanlang:',
      `  1) harness/.env ga haqiqiy kalit qo'ying:  ${config.keyEnv}=...`,
      '  2) yoki ataylab soxta rejimda ishlating:   DEMO_LLM=1',
      '',
      "Eslatma: avval kalit yo'q bo'lsa jim-jitlik bilan demo LLM ishlardi —",
      'endi bunday emas.',
    ])}\n`,
  );
}

/**
 * Startda chiqadigan bir qator: provayder, baseUrl'ning FAQAT host qismi,
 * model nomlari va kalit o'rnatilgan-o'rnatilmagani.
 * Kalitning QIYMATI va to'liq URL (unda kalit bo'lishi mumkin) hech qachon chiqmaydi.
 */
export function startupLine(
  config: ProviderConfig = resolveProviderConfig(),
  env: EnvLoadResult = harnessEnv,
): string {
  const parts: string[] = [];

  parts.push(`provayder=${config.demoRequested ? 'demo (DEMO_LLM=1)' : config.provider}`);

  if (config.baseUrl) parts.push(`host=${baseUrlHost(config.baseUrl)}`);
  if (config.model) parts.push(`model=${config.model}`);
  if (config.scoringModel && config.scoringModel !== config.model) {
    parts.push(`baholash=${config.scoringModel}`);
  }
  if (!config.demoRequested) {
    if (config.provider === 'openai-compatible') {
      parts.push(`json=${config.jsonMode}`);
      parts.push(`limit=${resolveMaxTokensParam(config.maxTokensParam, config.baseUrl ?? '')}`);
      parts.push(
        `reasoning=${config.reasoningEffort ?? 'default'}/${config.scoringReasoningEffort ?? 'default'}`,
      );
    }
    parts.push(`timeout=${config.timeoutMs / 1000}s/${config.scoringTimeoutMs / 1000}s`);
  }
  parts.push(
    config.keyEnv
      ? `kalit ${config.keyEnv}=${config.hasKey ? "o'rnatilgan" : "YO'Q"}`
      : 'kalit: kerak emas',
  );
  parts.push(
    env.found
      ? `env=${shortPath(env.path)} (${env.applied.length} ta o'zgaruvchi)`
      : `env=${shortPath(env.path)} TOPILMADI`,
  );

  return `LLM sozlamasi: ${parts.join(' \u00b7 ')}`;
}

/** URL'dan faqat host (kalit query'da bo'lishi mumkin — to'liq URL chiqarilmaydi). */
export function baseUrlHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return '(URL noto\'g\'ri)';
  }
}

function shortPath(path: string): string {
  const marker = `${'harness'}/`;
  const at = path.lastIndexOf(marker);
  return at >= 0 ? path.slice(at) : path;
}

/** Qaysi model ishlayotganini bir qatorda ko'rsatadi. */
export function describeLlm(resolved: ResolvedLlm): string {
  return resolved.isDemo
    ? 'DEMO (soxta javoblar)'
    : `${resolved.provider} · ${resolved.model}`;
}
