/**
 * FAQAT HARNESS. Qaysi LLM ishlatilishini env bo'yicha hal qiladi.
 *
 * Env:
 *   TRAINER_PROVIDER    anthropic | openai-compatible   (default: anthropic)
 *   TRAINER_MODEL       mijoz navbati modeli
 *   TRAINER_SCORING_MODEL  baholash modeli (berilmasa TRAINER_MODEL)
 *   TRAINER_API_KEY_ENV kalit qaysi env o'zgaruvchisida (kalitning O'ZI emas)
 *   TRAINER_BASE_URL    `openai-compatible` uchun majburiy
 *   DEMO_LLM=1          soxta (demo) LLM — faqat ANIQ so'ralganda
 *
 * MUHIM: kalit yo'q bo'lsa demo LLM'ga JIM O'TILMAYDI. Yo aniq `DEMO_LLM=1`
 * qo'yiladi, yo skript tushunarli ogohlantirish bilan to'xtaydi.
 */
// ENG BIRINCHI: `.env` ni yuklaydi (import tartibi qanday bo'lsa ham).
import { harnessEnv, type EnvLoadResult } from './env.js';

import type { TrainerLlm } from '../../module/backend/src/training/ports.js';
import type { BusinessProfile } from '../../module/backend/src/training/profile-schema.js';
import { createDemoLlm } from './demo-llm.js';
import { createAnthropicTrainerLlm, DEFAULT_TRAINER_MODEL } from './llm-anthropic.js';
import { createOpenAiCompatibleLlm } from './llm-openai-compatible.js';

export type TrainerProvider = 'anthropic' | 'openai-compatible';

export const DEFAULT_SCORING_MODEL = 'claude-sonnet-5-5';

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
export function resolveProviderConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const demoRequested = env.DEMO_LLM === '1';
  const raw = (env.TRAINER_PROVIDER ?? 'anthropic').trim();

  if (raw !== 'anthropic' && raw !== 'openai-compatible') {
    throw new ProviderConfigError(
      `TRAINER_PROVIDER "${raw}" noto'g'ri — faqat "anthropic" yoki "openai-compatible"`,
    );
  }
  const provider: TrainerProvider = raw;

  const keyEnv =
    env.TRAINER_API_KEY_ENV?.trim() ||
    (provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : '');

  if (provider === 'openai-compatible') {
    if (!env.TRAINER_BASE_URL?.trim()) {
      throw new ProviderConfigError(
        "TRAINER_PROVIDER=openai-compatible uchun TRAINER_BASE_URL majburiy",
      );
    }
    if (!keyEnv) {
      throw new ProviderConfigError(
        "TRAINER_PROVIDER=openai-compatible uchun TRAINER_API_KEY_ENV majburiy (kalit NOMI)",
      );
    }
    if (!env.TRAINER_MODEL?.trim()) {
      throw new ProviderConfigError(
        "TRAINER_PROVIDER=openai-compatible uchun TRAINER_MODEL majburiy",
      );
    }
  }

  const model =
    env.TRAINER_MODEL?.trim() || (provider === 'anthropic' ? DEFAULT_TRAINER_MODEL : '');
  const scoringModel =
    env.TRAINER_SCORING_MODEL?.trim() ||
    (provider === 'anthropic' ? DEFAULT_SCORING_MODEL : model);

  return {
    provider,
    keyEnv,
    baseUrl: env.TRAINER_BASE_URL?.trim() || null,
    model,
    scoringModel,
    demoRequested,
    hasKey: Boolean(keyEnv && env[keyEnv]?.trim()),
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

  const apiKey = process.env[config.keyEnv] as string;
  const model = scoring ? config.scoringModel : config.model;

  if (config.provider === 'anthropic') {
    return {
      llm: createAnthropicTrainerLlm({ apiKey, model }),
      provider: 'anthropic',
      model,
      isDemo: false,
    };
  }

  return {
    llm: createOpenAiCompatibleLlm({
      apiKey,
      baseUrl: config.baseUrl as string,
      model,
      jsonMode: (process.env.TRAINER_JSON_MODE as 'json_object' | 'prompt' | undefined) ?? 'json_object',
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
