/**
 * FAQAT HARNESS. Ovoz kirishi (STT) provayderini env bo'yicha tanlaydi.
 *
 * Env:
 *   STT_PROVIDER   local-doniyor | openai   (default local-doniyor — kalit kerak emas)
 *   STT_LOCAL_URL  default http://127.0.0.1:5190 (faqat loopback)
 *   openai — faqat shaxsiy OPENAI_API_KEY fayli (ikkinchi --env-file) va
 *            OPENAI_STT_MODEL bo'lsa.
 *
 * Zaxira YO'Q: tanlangan provayder ishlamasa — aniq xato (jim almashtirish yo'q).
 */
import type { SttPort } from '../../../module/backend/src/training/voice/ports.js';
import { envStr } from '../env.js';
import {
  createLocalStt,
  DEFAULT_LOCAL_STT_URL,
  LOCAL_STT_PROVIDER,
  LOCAL_STT_START_COMMAND,
} from './local-stt.js';
import { createOpenAiStt, missingVoiceConfig, openAiVoiceConfigFromEnv } from './openai.js';

export const STT_PROVIDERS = [LOCAL_STT_PROVIDER, 'openai'] as const;
export type SttProviderName = (typeof STT_PROVIDERS)[number];

export interface ResolvedStt {
  stt: SttPort;
  provider: SttProviderName;
  model: string;
  /** local-doniyor: servis manzili (startda /health bilan tekshiriladi). */
  url: string | null;
  /** Narx: lokal — 0; OpenAI — OPENAI_STT_PRICE_PER_MIN. */
  paid: boolean;
  describe: string;
}

export type SttResolution = { ok: true; value: ResolvedStt } | { ok: false; missing: string[]; reason: string };

export function resolveStt(env: NodeJS.ProcessEnv = process.env): SttResolution {
  const provider = (envStr('STT_PROVIDER', env) ?? LOCAL_STT_PROVIDER).toLowerCase();

  if (provider === LOCAL_STT_PROVIDER) {
    const url = envStr('STT_LOCAL_URL', env) ?? DEFAULT_LOCAL_STT_URL;
    let stt: SttPort;
    try {
      stt = createLocalStt({ url });
    } catch (err) {
      return { ok: false, missing: ['STT_LOCAL_URL'], reason: err instanceof Error ? err.message : String(err) };
    }
    return {
      ok: true,
      value: {
        stt,
        provider: LOCAL_STT_PROVIDER,
        model: 'gigaam-s1',
        url,
        paid: false,
        describe: `stt=${LOCAL_STT_PROVIDER}/gigaam-s1 (${url}; ishga tushirish: ${LOCAL_STT_START_COMMAND})`,
      },
    };
  }

  if (provider === 'openai') {
    const cfg = openAiVoiceConfigFromEnv(env);
    if (!cfg) {
      return {
        ok: false,
        missing: missingVoiceConfig(env),
        reason:
          "STT_PROVIDER=openai, lekin OpenAI sozlamasi to'liq emas (shaxsiy OPENAI_API_KEY faylini ikkinchi --env-file bilan bering)",
      };
    }
    return {
      ok: true,
      value: {
        stt: createOpenAiStt(cfg),
        provider: 'openai',
        model: cfg.sttModel,
        url: null,
        paid: true,
        describe: `stt=openai/${cfg.sttModel} · stt-til=${cfg.sttLanguageMode ?? 'omit'} · kalit ${cfg.keyEnv}=o'rnatilgan`,
      },
    };
  }

  return {
    ok: false,
    missing: ['STT_PROVIDER'],
    reason: `STT_PROVIDER "${provider}" noto'g'ri — ${STT_PROVIDERS.join(' | ')}`,
  };
}
