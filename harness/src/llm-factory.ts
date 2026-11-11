/**
 * FAQAT HARNESS. Qaysi LLM ishlatilishini env bo'yicha hal qiladi.
 *
 * Env:
 *   TRAINER_PROVIDER    gemini | openai-compatible | anthropic   (default: gemini;
 *                       harness/.env da gemini — kompaniya kaliti GEMINI_API_KEY)
 *   TRAINER_THINKING_LEVEL          gemini: low | medium | high (default low; o'chirib bo'lmaydi)
 *   TRAINER_SCORING_THINKING_LEVEL  gemini baholash uchun (default: TRAINER_THINKING_LEVEL)
 *   GEMINI_BASE_URL     ixtiyoriy (default https://generativelanguage.googleapis.com/v1beta)
 *   TRAINER_FALLBACK    off | openai (default off). `openai` — Gemini 429/5xx/timeout
 *                       bilan yiqilsa OpenAI'ga o'tadi, FAQAT OPENAI_API_KEY bo'lsa
 *                       (shaxsiy fayl). Har o'tish log'ga yoziladi.
 *   TRAINER_FALLBACK_MODEL / _BASE_URL / _API_KEY_ENV / _REASONING_EFFORT / _JSON_MODE
 *                       zaxira sozlamasi (default gpt-6-luna, api.openai.com/v1,
 *                       OPENAI_API_KEY, none, schema)
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
import { envInt, envStr, harnessEnv, PERSONAL_ENV_HINT_PATH, type EnvLoadResult } from './env.js';

import type { TrainerLlm } from '../../module/backend/src/training/ports.js';
import type { BusinessProfile } from '../../module/backend/src/training/profile-schema.js';
import type { LlmCallListener } from './bakeoff/types.js';
import { createDemoLlm } from './demo-llm.js';
import {
  createGeminiLlm,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_THINKING_LEVEL,
  GEMINI_BASE_URL,
  THINKING_LEVELS,
  withLlmFallback,
  type NamedLlm,
  type ThinkingLevel,
} from './llm-gemini.js';
import { createAnthropicTrainerLlm, DEFAULT_TRAINER_MODEL } from './llm-anthropic.js';
import {
  createOpenAiCompatibleLlm,
  resolveMaxTokensParam,
  type JsonMode,
  type MaxTokensParamSetting,
} from './llm-openai-compatible.js';

export type TrainerProvider = 'anthropic' | 'openai-compatible' | 'gemini';
export const TRAINER_PROVIDERS: readonly TrainerProvider[] = ['gemini', 'openai-compatible', 'anthropic'];

export const DEFAULT_FALLBACK_MODEL = 'gpt-6-luna';
export const DEFAULT_FALLBACK_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_FALLBACK_KEY_ENV = 'OPENAI_API_KEY';

export const DEFAULT_SCORING_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_SCORING_TIMEOUT_MS = 120_000;
export const DEFAULT_JSON_MODE: JsonMode = 'object';
/**
 * Mijoz navbati javobi kichik (JSON + ko'pi bilan 2 gap, ~150 token).
 * Kichik chegara: model "uzun gapirib ketsa" ham kechikish oshmaydi.
 * Persona (katta JSON) va boshqa bosqichlar — `maxTokens` (1024).
 */
export const TURN_STAGE_MAX_TOKENS: Readonly<Record<string, number>> = {
  'training.turn': 400,
  // Ssenariy qoralamasi (rahbar, "AI bilan to'ldirish") — to'liq JSON, ~1000 token.
  'training.scenario_draft': 2500,
};
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
  /** Faqat `gemini`: thinking_level. */
  thinkingLevel: ThinkingLevel;
  scoringThinkingLevel: ThinkingLevel;
  /** Zaxira provayder (faqat `gemini` asosiy bo'lganda). */
  fallback: FallbackConfig;
}

export interface FallbackConfig {
  /** `TRAINER_FALLBACK=openai` qo'yilganmi. */
  requested: boolean;
  /** So'ralgan VA kaliti bor — ya'ni haqiqatan ishlaydi. */
  available: boolean;
  keyEnv: string;
  baseUrl: string;
  model: string;
  reasoningEffort: ReasoningEffort | null;
  jsonMode: JsonMode;
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

function parseThinking(name: string, fallback: ThinkingLevel, env: NodeJS.ProcessEnv): ThinkingLevel {
  const raw = envStr(name, env)?.toLowerCase();
  if (raw === undefined) return fallback;
  if ((THINKING_LEVELS as readonly string[]).includes(raw)) return raw as ThinkingLevel;
  throw new ProviderConfigError(
    `${name} "${raw}" noto'g'ri — ${THINKING_LEVELS.join(' | ')} (gemini-3.8-flash'da fikrlashni o'chirib bo'lmaydi)`,
  );
}

function parseFallback(env: NodeJS.ProcessEnv): FallbackConfig {
  const raw = envStr('TRAINER_FALLBACK', env)?.toLowerCase() ?? 'off';
  if (raw !== 'off' && raw !== 'openai') {
    throw new ProviderConfigError(`TRAINER_FALLBACK "${raw}" noto'g'ri — off | openai`);
  }
  const keyEnv = envStr('TRAINER_FALLBACK_API_KEY_ENV', env) ?? DEFAULT_FALLBACK_KEY_ENV;
  const jsonRaw = envStr('TRAINER_FALLBACK_JSON_MODE', env) ?? 'schema';
  const jsonMode: JsonMode = jsonRaw === 'object' || jsonRaw === 'prompt' ? jsonRaw : 'schema';
  const effortEnv = { ...env, TRAINER_REASONING_EFFORT: envStr('TRAINER_FALLBACK_REASONING_EFFORT', env) ?? 'none' };
  return {
    requested: raw === 'openai',
    available: raw === 'openai' && Boolean(envStr(keyEnv, env)),
    keyEnv,
    baseUrl: envStr('TRAINER_FALLBACK_BASE_URL', env) ?? DEFAULT_FALLBACK_BASE_URL,
    model: envStr('TRAINER_FALLBACK_MODEL', env) ?? DEFAULT_FALLBACK_MODEL,
    reasoningEffort: parseEffort('TRAINER_REASONING_EFFORT', effortEnv),
    jsonMode,
  };
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
  // Default — Gemini (kompaniya kaliti GEMINI_API_KEY bilan yetarli).
  const raw = envStr('TRAINER_PROVIDER', env) ?? 'gemini';

  if (!(TRAINER_PROVIDERS as readonly string[]).includes(raw)) {
    throw new ProviderConfigError(
      `TRAINER_PROVIDER "${raw}" noto'g'ri — ${TRAINER_PROVIDERS.join(' | ')}`,
    );
  }
  const provider = raw as TrainerProvider;

  const defaultKeyEnv =
    provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : provider === 'gemini' ? 'GEMINI_API_KEY' : '';
  const keyEnv = envStr('TRAINER_API_KEY_ENV', env) ?? defaultKeyEnv;

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
    envStr('TRAINER_MODEL', env) ??
    (provider === 'anthropic' ? DEFAULT_TRAINER_MODEL : provider === 'gemini' ? DEFAULT_GEMINI_MODEL : '');
  const scoringModel =
    envStr('TRAINER_SCORING_MODEL', env) ??
    (provider === 'anthropic' ? DEFAULT_SCORING_MODEL : model);
  const thinkingLevel = parseThinking('TRAINER_THINKING_LEVEL', DEFAULT_THINKING_LEVEL, env);

  return {
    provider,
    keyEnv,
    baseUrl:
      provider === 'gemini'
        ? (envStr('GEMINI_BASE_URL', env) ?? GEMINI_BASE_URL)
        : (envStr('TRAINER_BASE_URL', env) ?? null),
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
    thinkingLevel,
    scoringThinkingLevel: parseThinking('TRAINER_SCORING_THINKING_LEVEL', thinkingLevel, env),
    fallback: parseFallback(env),
  };
}

export interface ResolvedLlm {
  llm: TrainerLlm;
  /** Hisobot uchun: 'gemini' | 'anthropic' | 'openai-compatible' | 'demo'. */
  provider: TrainerProvider | 'demo';
  model: string;
  isDemo: boolean;
  /** Zaxira provayder (bo'lsa): "openai-compatible/gpt-6-luna". */
  fallback?: string;
}

export interface CreateTrainerLlmOptions {
  /** Demo LLM uchun kerak (profildan javob yasaydi). */
  profile: BusinessProfile;
  /** Baholash uchun model (TRAINER_SCORING_MODEL) ishlatiladi. */
  scoring?: boolean;
  config?: ProviderConfig;
  /** Har chaqiruv hodisasi (e2e/bake-off o'lchovlari uchun). */
  onCall?: LlmCallListener;
}

/**
 * LLM yasaydi. Kalit yo'q va `DEMO_LLM=1` ham qo'yilmagan bo'lsa
 * `MissingLlmKeyError` tashlaydi — JIM demo'ga o'tmaydi.
 */
export function createTrainerLlm({
  profile,
  scoring = false,
  config = resolveProviderConfig(),
  onCall,
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

  if (config.provider === 'gemini') {
    const primary: NamedLlm = {
      llm: createGeminiLlm({
        apiKey,
        model,
        baseUrl: config.baseUrl ?? GEMINI_BASE_URL,
        thinkingLevel: scoring ? config.scoringThinkingLevel : config.thinkingLevel,
        ...(envStr('GEMINI_SAFETY')?.toLowerCase() === 'off' ? { safetySettings: [] } : {}),
        timeoutMs,
        ...(maxTokens ? { maxTokens } : {}),
        ...(scoring ? {} : { stageMaxTokens: TURN_STAGE_MAX_TOKENS }),
        ...(onCall ? { onCall } : {}),
      }),
      provider: 'gemini',
      model,
    };
    const fb = config.fallback;
    let fallback: NamedLlm | null = null;
    if (fb.available) {
      fallback = {
        llm: createOpenAiCompatibleLlm({
          apiKey: (process.env[fb.keyEnv] as string).trim(),
          baseUrl: fb.baseUrl,
          model: fb.model,
          jsonMode: fb.jsonMode,
          timeoutMs,
          ...(maxTokens ? { maxTokens } : {}),
          ...(scoring ? {} : { stageMaxTokens: TURN_STAGE_MAX_TOKENS }),
          ...(fb.reasoningEffort ? { reasoningEffort: fb.reasoningEffort } : {}),
          ...(onCall ? { onCall: (e) => onCall({ ...e, provider: 'openai-compatible' }) } : {}),
        }),
        provider: 'openai-compatible',
        model: fb.model,
      };
    }
    const llm =
      fb.requested || fallback
        ? withLlmFallback(primary, fallback, {
            unavailableReason: `TRAINER_FALLBACK=openai, lekin ${fb.keyEnv} berilmagan — shaxsiy faylni ikkinchi --env-file bilan bering`,
          })
        : primary.llm;
    return {
      llm,
      provider: 'gemini',
      model,
      isDemo: false,
      ...(fallback ? { fallback: `${fallback.provider}/${fallback.model}` } : {}),
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
      ...(scoring ? {} : { stageMaxTokens: TURN_STAGE_MAX_TOKENS }),
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(onCall ? { onCall: (e) => onCall({ ...e, provider: 'openai-compatible' }) } : {}),
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
      'Yo\'llardan birini tanlang:',
      `  1) kompaniya kaliti bo'lsa — harness/.env ga:  ${config.keyEnv}=...`,
      `  2) shaxsiy kalit bo'lsa — ikkinchi --env-file bilan (repo'ga yozilmaydi):`,
      `     npx tsx --env-file=.env --env-file=${PERSONAL_ENV_HINT_PATH} src/dev.ts`,
      '  3) Gemini (kompaniya kaliti, default) — harness/.env da:',
      '     TRAINER_PROVIDER=gemini  va  GEMINI_API_KEY=...',
      '  4) yoki ataylab soxta rejimda ishlating:   DEMO_LLM=1',
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
    if (config.provider === 'gemini') {
      parts.push(`json=structured`);
      parts.push(`thinking=${config.thinkingLevel}/${config.scoringThinkingLevel}`);
      parts.push(
        `zaxira=${
          config.fallback.available
            ? `${config.fallback.model} (${config.fallback.keyEnv})`
            : config.fallback.requested
              ? `YO'Q (${config.fallback.keyEnv} berilmagan)`
              : "o'chiq"
        }`,
      );
    }
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

/**
 * Kechikish bo'yicha ogohlantirishlar (startda chiqariladi). Mijoz navbati
 * jonli suhbat — reasoning yoqilgan bo'lsa har javob bir necha soniya kechikadi.
 */
export function latencyWarnings(config: ProviderConfig): string[] {
  const out: string[] = [];
  if (config.demoRequested) return out;
  if (config.provider === 'gemini') {
    if (config.thinkingLevel !== 'low') {
      out.push(
        `Diqqat: mijoz bosqichida thinking=${config.thinkingLevel} — har navbat sekinlashadi va qimmatlashadi. ` +
          'Tavsiya: TRAINER_THINKING_LEVEL=low (gemini-3.8-flash\'da fikrlashni o\'chirib bo\'lmaydi).',
      );
    }
    if (config.fallback.requested && !config.fallback.available) {
      out.push(
        `Zaxira: TRAINER_FALLBACK=openai, lekin ${config.fallback.keyEnv} yo'q — Gemini 429/503 bo'lsa navbat ` +
          'aniq xato bilan tugaydi (zaxiraga o\'tilmaydi).',
      );
    }
    return out;
  }
  if (config.provider !== 'openai-compatible') return out;
  if (config.reasoningEffort !== 'none' && config.reasoningEffort !== 'minimal') {
    out.push(
      `Diqqat: mijoz bosqichida reasoning ${config.reasoningEffort ?? "provayder default'i"} — ` +
        'har navbat sekinlashadi. Tavsiya: TRAINER_REASONING_EFFORT=none ' +
        "(rad etilsa [llm] param-fallback qatori chiqadi va reasoning provayder default'iga qaytadi).",
    );
  }
  return out;
}

/** Qaysi model ishlayotganini bir qatorda ko'rsatadi. */
export function describeLlm(resolved: ResolvedLlm): string {
  return resolved.isDemo
    ? 'DEMO (soxta javoblar)'
    : `${resolved.provider} · ${resolved.model}${resolved.fallback ? ` (zaxira: ${resolved.fallback})` : ''}`;
}
