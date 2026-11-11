/**
 * FAQAT HARNESS. Ovoz chiqishi (TTS) provayderini env bo'yicha tanlaydi.
 * STT bu yerda YO'Q — u alohida (hozircha OpenAI, keyin lokal model).
 *
 * Env:
 *   VOICE_TTS_PROVIDER   gemini | openai   (default gemini — kompaniya kaliti)
 *   GEMINI_TTS_MODEL     default gemini-3.8-flash-tts
 *   GEMINI_TTS_VOICES_FILE  ovoz profillari (default harness/tts-voices.json)
 *   TRAINER_FALLBACK=openai — Gemini TTS 429/5xx bo'lsa OpenAI TTS ga o'tadi,
 *                        FAQAT OPENAI_API_KEY (+ OPENAI_TTS_MODEL) bo'lsa.
 */
import type { TtsPort } from '../../../module/backend/src/training/voice/ports.js';
import { envStr } from '../env.js';
import type { LlmLogSink } from '../llm-log.js';
import {
  createGeminiTts,
  DEFAULT_GEMINI_TTS_MODEL,
  DEFAULT_VOICES_FILE,
  loadVoiceProfiles,
  withTtsFallback,
  type GeminiTtsEvent,
  type NamedTts,
} from './gemini-tts.js';
import { createOpenAiTts, openAiVoiceConfigFromEnv } from './openai.js';

export interface ResolvedTts {
  tts: TtsPort;
  provider: 'gemini' | 'openai';
  model: string;
  /** Ovoz nomi (OpenAI) yoki "persona bo'yicha" (Gemini). */
  voiceLabel: string;
  fallback: string | null;
  /** Bir qatorli tavsif (startda chiqadi). */
  describe: string;
}

export type TtsResolution = { ok: true; value: ResolvedTts } | { ok: false; missing: string[]; reason: string };

export function resolveTts(
  opts: { log?: LlmLogSink | null; onSynth?: (e: GeminiTtsEvent) => void } = {},
  env: NodeJS.ProcessEnv = process.env,
): TtsResolution {
  const provider = (envStr('VOICE_TTS_PROVIDER', env) ?? 'gemini').toLowerCase();
  const openAi = openAiVoiceConfigFromEnv(env);

  if (provider === 'openai') {
    if (!openAi) {
      return { ok: false, missing: ['OPENAI_API_KEY', 'OPENAI_TTS_MODEL'], reason: 'VOICE_TTS_PROVIDER=openai, lekin OpenAI sozlamasi yo\'q' };
    }
    return {
      ok: true,
      value: {
        tts: createOpenAiTts(openAi),
        provider: 'openai',
        model: openAi.ttsModel,
        voiceLabel: openAi.ttsVoice ?? 'default',
        fallback: null,
        describe: `tts=openai/${openAi.ttsModel}${openAi.ttsVoice ? ` (${openAi.ttsVoice})` : ''}`,
      },
    };
  }
  if (provider !== 'gemini') {
    return { ok: false, missing: ['VOICE_TTS_PROVIDER'], reason: `VOICE_TTS_PROVIDER "${provider}" noto'g'ri — gemini | openai` };
  }

  const apiKey = envStr('GEMINI_API_KEY', env);
  if (!apiKey) return { ok: false, missing: ['GEMINI_API_KEY'], reason: "GEMINI_API_KEY yo'q" };
  const model = envStr('GEMINI_TTS_MODEL', env) ?? DEFAULT_GEMINI_TTS_MODEL;
  const profiles = loadVoiceProfiles(envStr('GEMINI_TTS_VOICES_FILE', env) ?? DEFAULT_VOICES_FILE);
  const gemini = createGeminiTts({
    apiKey,
    model,
    profiles,
    ...(opts.log !== undefined ? { log: opts.log } : {}),
    ...(opts.onSynth ? { onSynth: opts.onSynth } : {}),
  });
  const primary: NamedTts = { tts: gemini, provider: 'gemini', model };

  const fallbackRequested = (envStr('TRAINER_FALLBACK', env) ?? 'off').toLowerCase() === 'openai';
  const fallback: NamedTts | null =
    fallbackRequested && openAi ? { tts: createOpenAiTts(openAi), provider: 'openai', model: openAi.ttsModel } : null;
  const tts =
    fallbackRequested
      ? withTtsFallback(primary, fallback, {
          ...(opts.log !== undefined ? { log: opts.log } : {}),
          unavailableReason: "TRAINER_FALLBACK=openai, lekin OPENAI_API_KEY/OPENAI_TTS_MODEL berilmagan",
        })
      : gemini;
  const voices = [...new Set(Object.values(profiles.profiles).map((p) => p.voice))].join(', ');
  return {
    ok: true,
    value: {
      tts,
      provider: 'gemini',
      model,
      voiceLabel: 'persona bo\'yicha',
      fallback: fallback ? `openai/${fallback.model}` : null,
      describe:
        `tts=gemini/${model} (ovoz persona bo'yicha: ${voices})` +
        ` · zaxira=${fallback ? `openai/${fallback.model}` : fallbackRequested ? "YO'Q (OpenAI kaliti berilmagan)" : "o'chiq"}`,
    },
  };
}
