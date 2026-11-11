/**
 * FAQAT HARNESS. `TtsPort` ning Gemini adapteri: gemini-3.8-flash-tts,
 * Interactions API (`POST /v1beta/interactions`, `stream: true`).
 *
 * So'rov shakli `tts-test/gemini-tts-test.ts` dagi ishlagan integratsiyadan:
 *  - matn `input[0].content[0].text` da — SO'ZMA-SO'Z o'qiladi;
 *  - uslub (ohang, persona) `annotations: [{type:'speech_metadata', style}]` da —
 *    o'qilmaydi, faqat yo'nalish;
 *  - ovoz `generation_config.speech_config: [{ voice }]`;
 *  - oqim: SSE `step.delta` (delta.type='audio', base64 PCM 24 kHz mono 16-bit).
 *
 * Ovoz va uslub persona'ga qarab `harness/tts-voices.json` dan tanlanadi
 * (jins + yosh). Brauzerga WAV oqimi beriladi: avval sarlavha (uzunligi
 * noma'lum), keyin PCM bo'laklari — `<audio>` birinchi bo'lakdan ijro qiladi.
 *
 * 429/5xx/tarmoq — birinchi baytgacha qayta urinish (backoff); keyin xato
 * `isFallbackWorthy` bo'lsa zaxira TTS (OpenAI) ishlatilishi mumkin.
 * Kalit faqat header'da; log/xato matniga tushmaydi.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { LlmCallError } from '../../../module/backend/src/training/errors.js';
import type {
  TtsPort,
  TtsRequest,
  TtsResult,
  TtsSpeaker,
  TtsStream,
} from '../../../module/backend/src/training/voice/ports.js';
import { wavHeader } from '../../../module/backend/src/training/voice/wav.js';
import { harnessRoot } from '../env.js';
import {
  DEFAULT_RETRY,
  GEMINI_BASE_URL,
  GeminiHttpError,
  isFallbackWorthy,
  parseRetryDelayMs,
  withRetry,
  type RetryPolicy,
} from '../llm-gemini.js';
import type { LlmLogSink } from '../llm-log.js';
import { GEMINI_TTS_PRICE, priceGeminiTts } from '../pricing.js';

export const DEFAULT_GEMINI_TTS_MODEL = 'gemini-3.8-flash-tts';
export const GEMINI_TTS_SAMPLE_RATE = 24_000;
export const DEFAULT_VOICES_FILE = resolve(harnessRoot, 'tts-voices.json');

// ---------------------------------------------------------------------------
// Ovoz profillari
// ---------------------------------------------------------------------------
export const PROFILE_KEYS = [
  'male_child',
  'female_child',
  'male_teen',
  'female_teen',
  'male_young',
  'male_adult',
  'male_elder',
  'female_young',
  'female_adult',
  'female_elder',
  'default',
] as const;
export type ProfileKey = (typeof PROFILE_KEYS)[number];

export interface VoiceProfile {
  voice: string;
  style: string;
}

export interface VoiceProfiles {
  readingRule: string;
  profiles: Record<ProfileKey, VoiceProfile>;
}

export class GeminiTtsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiTtsConfigError';
  }
}

export function parseVoiceProfiles(raw: unknown, source = 'tts-voices.json'): VoiceProfiles {
  const obj = raw as { readingRule?: unknown; profiles?: Record<string, unknown> } | null;
  if (!obj || typeof obj !== 'object' || !obj.profiles || typeof obj.profiles !== 'object') {
    throw new GeminiTtsConfigError(`${source}: "profiles" obyekti yo'q`);
  }
  const profiles = {} as Record<ProfileKey, VoiceProfile>;
  for (const key of PROFILE_KEYS) {
    const p = obj.profiles[key] as { voice?: unknown; style?: unknown } | undefined;
    if (!p || typeof p.voice !== 'string' || !p.voice.trim() || typeof p.style !== 'string') {
      throw new GeminiTtsConfigError(`${source}: profiles.${key} da "voice" va "style" (matn) bo'lishi shart`);
    }
    profiles[key] = { voice: p.voice.trim(), style: p.style };
  }
  return { readingRule: typeof obj.readingRule === 'string' ? obj.readingRule : '', profiles };
}

export function loadVoiceProfiles(path = DEFAULT_VOICES_FILE): VoiceProfiles {
  if (!existsSync(path)) throw new GeminiTtsConfigError(`ovoz profillari fayli topilmadi: ${path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new GeminiTtsConfigError(`${path}: JSON xato — ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseVoiceProfiles(raw, path);
}

/** Persona jinsini aytmagan bo'lsa — rol matnidan (ota/ona ...) taxmin. */
const MALE_HINT = /(?<![\p{L}'])(ota|otasi|aka|akasi|erkak|bobo|отец|папа|муж|father|man|dad)(?![\p{L}'])/iu;
const FEMALE_HINT = /(?<![\p{L}'])(ona|onasi|opa|opasi|ayol|xotin|kelin|momo|buvi|мать|мама|жена|mother|woman|mom)(?![\p{L}'])/iu;

export function genderOf(speaker: TtsSpeaker | undefined): 'male' | 'female' | null {
  if (speaker?.gender) return speaker.gender;
  const role = speaker?.role ?? '';
  const female = FEMALE_HINT.test(role);
  const male = MALE_HINT.test(role);
  if (female && !male) return 'female';
  if (male && !female) return 'male';
  return null;
}

export function isProfileKey(v: unknown): v is ProfileKey {
  return typeof v === 'string' && (PROFILE_KEYS as readonly string[]).includes(v);
}

/**
 * Profil: ssenariy aniq bergan bo'lsa (`speaker.profile`) — shu; aks holda
 * jins + yosh: <13 child, <18 teen, <30 young, 55+ elder, qolgani adult.
 */
export function pickProfile(speaker: TtsSpeaker | undefined): ProfileKey {
  if (speaker?.profile && speaker.profile !== 'auto' && isProfileKey(speaker.profile)) return speaker.profile;
  const gender = genderOf(speaker);
  if (!gender) return 'default';
  const age = speaker?.age;
  const band =
    age === undefined
      ? 'adult'
      : age < 13
        ? 'child'
        : age < 18
          ? 'teen'
          : age < 30
            ? 'young'
            : age >= 55
              ? 'elder'
              : 'adult';
  return `${gender}_${band}` as ProfileKey;
}

/**
 * Uslub matni: profil (persona to'ldirilgan) + shu navbat ohangi + o'qish qoidasi.
 * Bu matn `speech_metadata.style` ga ketadi — O'QILMAYDI.
 */
export function buildStyle(profiles: VoiceProfiles, key: ProfileKey, req: TtsRequest): string {
  const sp = req.speaker;
  const fill = (template: string): string =>
    template
      .replace(/\{age\}/g, sp?.age !== undefined ? String(sp.age) : 'adult')
      .replace(/\{role\}/g, sp?.role?.trim() || 'customer')
      .replace(/\{speakingStyle\}/g, sp?.speakingStyle?.trim() || 'natural, conversational');
  const parts = [fill(profiles.profiles[key].style)];
  if (sp?.baseStyle?.trim()) parts.push(sp.baseStyle.trim());
  if (req.instructions) parts.push(`Current mood for this line: ${req.instructions}`);
  if (profiles.readingRule) parts.push(profiles.readingRule);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------
export interface GeminiTtsEvent {
  provider: 'gemini';
  model: string;
  voice: string;
  profile: ProfileKey;
  chars: number;
  /** So'rov boshidan birinchi audio bo'lagigacha. */
  firstChunkMs: number | null;
  totalMs: number;
  inputTokens: number | null;
  audioTokens: number | null;
  /** Usage kelmagan bo'lsa audio uzunligidan taxmin qilinganmi. */
  audioTokensEstimated: boolean;
  audioSec: number;
  costUsd: number;
  attempts: number;
  ok: boolean;
  error?: string;
}

export interface GeminiTtsOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  profiles?: VoiceProfiles;
  timeoutMs?: number;
  retry?: RetryPolicy;
  log?: LlmLogSink | null;
  onSynth?: (event: GeminiTtsEvent) => void;
}

interface StreamUsage {
  total_input_tokens?: number;
  total_output_tokens?: number;
  output_tokens_by_modality?: Array<{ modality: string; tokens: number }>;
}

function redact(text: string, apiKey: string): string {
  const out = apiKey ? text.split(apiKey).join('***') : text;
  return out.replace(/(AIza[0-9A-Za-z_-]{20,}|AQ\.[A-Za-z0-9_.-]{20,})/g, '***');
}

export function buildTtsBody(opts: { model: string; text: string; style: string; voice: string }): Record<string, unknown> {
  return {
    model: opts.model,
    input: [
      {
        type: 'user_input',
        content: [{ type: 'text', text: opts.text, annotations: [{ type: 'speech_metadata', style: opts.style }] }],
      },
    ],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice: opts.voice }] },
    stream: true,
    store: false,
  };
}

export interface GeminiTts extends TtsPort {
  model: string;
  profiles: VoiceProfiles;
  synthesizeStream(req: TtsRequest): TtsStream;
}

export function createGeminiTts(options: GeminiTtsOptions): GeminiTts {
  const {
    apiKey,
    model = DEFAULT_GEMINI_TTS_MODEL,
    timeoutMs = 60_000,
    retry = DEFAULT_RETRY,
    log = (line: string) => console.error(line),
    onSynth,
  } = options;
  const profiles = options.profiles ?? loadVoiceProfiles();
  const url = `${(options.baseUrl ?? GEMINI_BASE_URL).replace(/\/$/, '')}/interactions`;

  /** So'rovni ochadi (HTTP xato bo'lsa — toifalangan xato). Retry — tashqarida. */
  async function open(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw new LlmCallError('timeout', `TTS: ${timeoutMs} ms ichida javob kelmadi`, { cause: err });
      const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
      throw new LlmCallError('unknown', redact(`TTS tarmoq xatosi: ${err instanceof Error ? err.message : String(err)}${cause}`, apiKey), { cause: err });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        if (parsed.error?.message) message = parsed.error.message;
      } catch {
        // JSON emas
      }
      const short = redact(message, apiKey).replace(/\s+/g, ' ').trim().slice(0, 240);
      throw new GeminiHttpError(res.status, `TTS: ${short}`, parseRetryDelayMs(text), res.status === 429 && /per day|daily|PerDay|RPD/i.test(text));
    }
    if (!res.body) throw new LlmCallError('unknown', "TTS: server bo'sh javob qaytardi");
    return res;
  }

  /**
   * PCM bo'laklarini oqim bilan beradi. Birinchi element — WAV sarlavhasi
   * (birinchi audio bo'lagi kelganda, sample_rate ma'lum bo'lgach).
   */
  async function* stream(
    req: TtsRequest,
    opts: { header: 'stream' | 'none'; meta?: { sampleRate: number } },
  ): AsyncGenerator<Uint8Array> {
    const key = pickProfile(req.speaker);
    const voice = profiles.profiles[key].voice;
    const style = buildStyle(profiles, key, req);
    const body = buildTtsBody({ model, text: req.text, style, voice });
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let firstChunkMs: number | null = null;
    let usage: StreamUsage | null = null;
    let sampleRate = GEMINI_TTS_SAMPLE_RATE;
    let pcmBytes = 0;
    let attempts = 1;
    let carry: Buffer | null = null;
    let streamError: string | null = null;

    const report = (ok: boolean, error?: string): void => {
      const audioSec = pcmBytes / (sampleRate * 2);
      const inputTokens = usage?.total_input_tokens ?? null;
      const reported =
        usage?.output_tokens_by_modality?.find((m) => m.modality.toLowerCase() === 'audio')?.tokens ??
        usage?.total_output_tokens ??
        null;
      const estimated = reported === null && audioSec > 0;
      const audioTokens = reported ?? (estimated ? Math.round(audioSec * GEMINI_TTS_PRICE.audioTokensPerSecond) : null);
      const costUsd = priceGeminiTts(inputTokens ?? 0, audioTokens ?? 0);
      const event: GeminiTtsEvent = {
        provider: 'gemini',
        model,
        voice,
        profile: key,
        chars: req.text.length,
        firstChunkMs,
        totalMs: Date.now() - t0,
        inputTokens,
        audioTokens,
        audioTokensEstimated: estimated,
        audioSec,
        costUsd,
        attempts,
        ok,
        ...(error ? { error } : {}),
      };
      log?.(
        `[tts] provider=gemini model=${model} voice=${voice} profile=${key} chars=${event.chars} ` +
          `first_chunk=${firstChunkMs ?? '-'}ms total=${event.totalMs}ms ` +
          `tokens=${inputTokens ?? '-'}/${audioTokens ?? '-'}${estimated ? '(taxmin)' : ''} ` +
          `audio=${audioSec.toFixed(1)}s cost=$${costUsd.toFixed(6)} outcome=${ok ? 'ok' : 'error'}` +
          (attempts > 1 ? ` attempt=${attempts}` : '') +
          (error ? ` · ${error.slice(0, 200)}` : ''),
      );
      onSynth?.(event);
    };

    try {
      const opened = await withRetry(`gemini tts`, retry, () => open(body, controller.signal), { log });
      attempts = opened.attempts;
      const res = opened.value;

      const decoder = new TextDecoder();
      let buffer = '';
      const pending: Buffer[] = [];
      const handle = (event: Record<string, unknown>): void => {
        const type = event.event_type;
        if (type === 'step.delta') {
          const delta = event.delta as { type?: string; data?: string; sample_rate?: number } | undefined;
          if (delta?.type === 'audio' && delta.data) {
            if (delta.sample_rate) {
              sampleRate = delta.sample_rate;
              if (opts.meta) opts.meta.sampleRate = sampleRate;
            }
            let chunk = Buffer.from(delta.data, 'base64');
            if (carry) {
              chunk = Buffer.concat([carry, chunk]);
              carry = null;
            }
            // 16-bit namunalar juft baytda — toq qoldiq keyingi bo'lakka.
            if (chunk.length % 2 === 1) {
              carry = chunk.subarray(chunk.length - 1);
              chunk = chunk.subarray(0, chunk.length - 1);
            }
            if (chunk.length > 0) pending.push(chunk);
          }
          const meta = event.metadata as { total_usage?: StreamUsage } | undefined;
          if (meta?.total_usage) usage = meta.total_usage;
        } else if (type === 'step.stop' || type === 'interaction.status_update') {
          if (event.usage) usage = event.usage as StreamUsage;
        } else if (type === 'interaction.completed') {
          const it = event.interaction as { usage?: StreamUsage } | undefined;
          if (it?.usage) usage = it.usage;
        } else if (type === 'error') {
          const e = event.error as { code?: string; message?: string } | undefined;
          streamError = `${e?.code ?? 'error'}: ${e?.message ?? ''}`;
        }
      };
      const flush = (block: string): void => {
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data || data === '[DONE]') return;
        try {
          handle(JSON.parse(data) as Record<string, unknown>);
        } catch {
          // to'liq bo'lmagan blok — o'tkaziladi
        }
      };

      try {
        for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(part, { stream: true }).replace(/\r\n/g, '\n');
          let at: number;
          while ((at = buffer.indexOf('\n\n')) >= 0) {
            flush(buffer.slice(0, at));
            buffer = buffer.slice(at + 2);
          }
          while (pending.length > 0) {
            const chunk = pending.shift() as Buffer;
            if (firstChunkMs === null) {
              firstChunkMs = Date.now() - t0;
              if (opts.header === 'stream') {
                // Uzunlik noma'lum: maksimal qiymat — brauzer oqim tugaguncha ijro qiladi.
                yield wavHeader(0x7fffffff - 36, { sampleRate, channels: 1, bitsPerSample: 16 });
              }
            }
            pcmBytes += chunk.length;
            yield chunk;
          }
        }
      } catch (err) {
        if (controller.signal.aborted) throw new LlmCallError('timeout', `TTS oqimi ${timeoutMs} ms da tugamadi`);
        throw new LlmCallError('unknown', redact(`TTS oqimi uzildi: ${err instanceof Error ? err.message : String(err)}`, apiKey));
      }
      if (buffer.trim()) flush(buffer);
      for (const chunk of pending.splice(0)) {
        if (firstChunkMs === null) {
          firstChunkMs = Date.now() - t0;
          if (opts.header === 'stream') yield wavHeader(0x7fffffff - 36, { sampleRate, channels: 1, bitsPerSample: 16 });
        }
        pcmBytes += chunk.length;
        yield chunk;
      }
      if (streamError) throw new LlmCallError('unknown', redact(`TTS oqimida xato: ${streamError}`, apiKey));
      if (pcmBytes === 0) throw new LlmCallError('unknown', "TTS: audio kelmadi (oqimda audio bo'lagi yo'q)");
      report(true);
    } catch (err) {
      report(false, err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    model,
    profiles,
    async synthesize(req: TtsRequest): Promise<TtsResult> {
      const t0 = Date.now();
      const parts: Buffer[] = [];
      let firstByteMs: number | undefined;
      const meta = { sampleRate: GEMINI_TTS_SAMPLE_RATE };
      // Sarlavhasiz PCM yig'iladi, oxirida aniq uzunlik bilan WAV yasaladi.
      for await (const chunk of stream(req, { header: 'none', meta })) {
        if (firstByteMs === undefined) firstByteMs = Date.now() - t0;
        parts.push(Buffer.from(chunk));
      }
      const pcm = Buffer.concat(parts);
      const sampleRate = meta.sampleRate;
      return {
        audio: Buffer.concat([wavHeader(pcm.length, { sampleRate, channels: 1, bitsPerSample: 16 }), pcm]),
        mime: 'audio/wav',
        latencyMs: Date.now() - t0,
        ...(firstByteMs !== undefined ? { firstByteMs } : {}),
      };
    },
    synthesizeStream(req: TtsRequest): TtsStream {
      return { mime: 'audio/wav', chunks: stream(req, { header: 'stream' }) };
    },
  };
}

// ---------------------------------------------------------------------------
// Zaxira TTS
// ---------------------------------------------------------------------------
export interface NamedTts {
  tts: TtsPort;
  provider: string;
  model: string;
}

/**
 * Asosiy TTS 429/5xx/timeout bilan (qayta urinishdan keyin ham) yiqilsa —
 * zaxiraga o'tadi va buni log'ga yozadi. Oqimda: faqat birinchi bayt
 * BERILMASDAN oldin va zaxira oqimi formati (mime) bir xil bo'lsa.
 */
export function withTtsFallback(
  primary: NamedTts,
  fallback: NamedTts | null,
  opts: { log?: LlmLogSink | null; unavailableReason?: string } = {},
): TtsPort {
  const log = opts.log === undefined ? (line: string) => console.error(line) : opts.log;
  const reasonOf = (err: unknown): string =>
    err instanceof LlmCallError ? (err.status !== undefined ? `http_${err.status}` : err.kind) : 'unknown';
  const noFallback = (err: unknown): void => {
    log?.(
      `[tts] ${primary.provider} ${reasonOf(err)} — zaxira TTS YO'Q` +
        (opts.unavailableReason ? ` (${opts.unavailableReason})` : '') +
        '.',
    );
  };

  const port: TtsPort = {
    async synthesize(req: TtsRequest): Promise<TtsResult> {
      try {
        return await primary.tts.synthesize(req);
      } catch (err) {
        if (!isFallbackWorthy(err)) throw err;
        if (!fallback) {
          noFallback(err);
          throw err;
        }
        log?.(`[tts] FALLBACK ${primary.provider}/${primary.model} -> ${fallback.provider}/${fallback.model} · sabab=${reasonOf(err)}`);
        return await fallback.tts.synthesize(req);
      }
    },
  };

  if (primary.tts.synthesizeStream) {
    const primaryStream = primary.tts.synthesizeStream.bind(primary.tts);
    port.synthesizeStream = (req: TtsRequest): TtsStream => {
      const first = primaryStream(req);
      async function* chunks(): AsyncGenerator<Uint8Array> {
        let yielded = false;
        try {
          for await (const chunk of first.chunks) {
            yielded = true;
            yield chunk;
          }
        } catch (err) {
          if (yielded || !isFallbackWorthy(err)) throw err;
          if (!fallback) {
            noFallback(err);
            throw err;
          }
          const fbStream = fallback.tts.synthesizeStream?.(req);
          if (!fbStream || fbStream.mime !== first.mime) {
            log?.(
              `[tts] ${primary.provider} ${reasonOf(err)} — zaxira ${fallback.provider} oqim formati mos emas ` +
                `(${fbStream?.mime ?? 'oqim yo\'q'} != ${first.mime}); OPENAI_TTS_FORMAT=wav qo'ying.`,
            );
            throw err;
          }
          log?.(`[tts] FALLBACK ${primary.provider}/${primary.model} -> ${fallback.provider}/${fallback.model} · sabab=${reasonOf(err)} (oqim)`);
          yield* fbStream.chunks;
        }
      }
      return { mime: first.mime, chunks: chunks() };
    };
  }
  return port;
}
