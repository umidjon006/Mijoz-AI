/**
 * FAQAT HARNESS. OpenAI ovoz adapterlari: STT (`/audio/transcriptions`) va
 * TTS (`/audio/speech`).
 *
 * MUHIM: model NOMLARI bu faylda yo'q. Ular env'dan keladi
 * (`OPENAI_STT_MODEL`, `OPENAI_TTS_MODEL`, `OPENAI_TTS_VOICE`), qaysi model
 * mavjudligini esa `npm run diag:voice` kalitning o'ziga qarab aniqlaydi.
 * Shunday qilib model nomlari eskirganda kod o'zgartirilmaydi.
 *
 * Kalit hech qachon log qilinmaydi va audio hech qayerda saqlanmaydi.
 */
import type {
  SttPort,
  SttRequest,
  SttResult,
  TtsPort,
  TtsRequest,
  TtsResult,
} from '../../../module/backend/src/training/voice/ports.js';
import { LlmCallError } from '../../../module/backend/src/training/errors.js';
import { envStr } from '../env.js';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

export interface OpenAiVoiceConfig {
  apiKey: string;
  baseUrl: string;
  /** Qaysi env o'zgaruvchisidan kalit olingani (hisobot uchun; QIYMAT emas). */
  keyEnv: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string | undefined;
  /** `mp3` yoki `opus` — brauzer ikkalasini ham ijro etadi. */
  ttsFormat: string;
  timeoutMs: number;
  /**
   * STT ga til qanday aytiladi (`OPENAI_STT_LANGUAGE_MODE`):
   *  - `omit`   — til kodi yuborilmaydi (default; ba'zi modellar `uz` ni rad etadi);
   *  - `code`   — `language=uz`;
   *  - `prompt` — kod yo'q, lekin prompt: "O'zbekcha suhbat ..." + lug'at.
   */
  sttLanguageMode?: SttLanguageMode;
}

export const STT_LANGUAGE_MODES = ['omit', 'code', 'prompt'] as const;
export type SttLanguageMode = (typeof STT_LANGUAGE_MODES)[number];

export function parseSttLanguageMode(raw: string | undefined): SttLanguageMode {
  if (raw === undefined) return 'omit';
  if ((STT_LANGUAGE_MODES as readonly string[]).includes(raw)) return raw as SttLanguageMode;
  throw new OpenAiVoiceConfigError(
    `OPENAI_STT_LANGUAGE_MODE "${raw}" noto'g'ri — omit | code | prompt yoki bo'sh`,
  );
}

export class OpenAiVoiceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenAiVoiceConfigError';
  }
}

/**
 * Env'dan sozlama. Model nomlari BO'SH bo'lishi mumkin — `diag:voice` ularni
 * tavsiya qiladi; bo'sh bo'lsa `null` qaytaradi va ovoz rejimi o'chadi
 * (matnli rejim o'zgarmaydi).
 */
export function openAiVoiceConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OpenAiVoiceConfig | null {
  const keyEnv = envStr('OPENAI_VOICE_KEY_ENV', env) ?? 'OPENAI_API_KEY';
  const apiKey = envStr(keyEnv, env);
  const sttModel = envStr('OPENAI_STT_MODEL', env);
  const ttsModel = envStr('OPENAI_TTS_MODEL', env);
  if (!apiKey || !sttModel || !ttsModel) return null;

  return {
    apiKey,
    baseUrl: (envStr('OPENAI_BASE_URL', env) ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, ''),
    keyEnv,
    sttModel,
    ttsModel,
    ttsVoice: envStr('OPENAI_TTS_VOICE', env),
    ttsFormat: envStr('OPENAI_TTS_FORMAT', env) ?? 'mp3',
    timeoutMs: Number(envStr('OPENAI_VOICE_TIMEOUT_MS', env) ?? 30_000),
    sttLanguageMode: parseSttLanguageMode(envStr('OPENAI_STT_LANGUAGE_MODE', env)),
  };
}

/** Nega ovoz rejimi yoqilmagani — foydalanuvchiga ko'rsatiladigan sabab. */
export function missingVoiceConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  const keyEnv = envStr('OPENAI_VOICE_KEY_ENV', env) ?? 'OPENAI_API_KEY';
  const missing: string[] = [];
  if (!envStr(keyEnv, env)) missing.push(keyEnv);
  if (!envStr('OPENAI_STT_MODEL', env)) missing.push('OPENAI_STT_MODEL');
  if (!envStr('OPENAI_TTS_MODEL', env)) missing.push('OPENAI_TTS_MODEL');
  return missing;
}

/** `uz` / `ru` — ISO-639-1; `mixed` uchun o'zbekcha ishora beriladi. */
const STT_LANGUAGE: Record<string, string> = { uz: 'uz', ru: 'ru', mixed: 'uz' };

/**
 * Kalitni (va `sk-...` ko'rinishidagi har qanday kalit bo'lagini) matndan
 * olib tashlaydi — provayder xabari logga va xato matniga shu holda tushadi.
 */
export function redactSecrets(text: string, apiKey: string): string {
  const withoutKey = apiKey.length > 0 ? text.split(apiKey).join('***') : text;
  return withoutKey.replace(/sk-[A-Za-z0-9_*.-]{4,}/g, 'sk-***');
}

/**
 * So'rovni chegaralangan vaqtda bajaradi. Xatolar toifalanadi (matnli
 * rejimdagidek): timeout -> `timeout`, tarmoq -> `unknown`. Avval timeout
 * "This operation was aborted" bo'lib chiqardi.
 */
async function withTimeout<T>(
  what: string,
  timeoutMs: number,
  apiKey: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new LlmCallError('timeout', `${what}: ${timeoutMs} ms ichida javob kelmadi`, { cause: err });
    }
    const message = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
    throw new LlmCallError('unknown', `${what}: tarmoq xatosi: ${redactSecrets(message + cause, apiKey).slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * HTTP xato. Xato matnida kalit bo'lmasligi SHART: provayder xabari
 * (`error.message`) olinadi, kalit va `sk-...` bo'laklari yashiriladi.
 */
async function failure(what: string, res: Response, apiKey: string): Promise<Error> {
  const body = await res.text().catch(() => '');
  let message = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === 'string') message = parsed.error.message;
  } catch {
    // JSON emas — matnning o'zi.
  }
  const short = redactSecrets(message, apiKey).replace(/\s+/g, ' ').trim().slice(0, 200);
  return new LlmCallError('http', `${what} HTTP ${res.status}: ${short}`, {
    status: res.status,
    providerMessage: short,
  });
}

/** `prompt` rejimida transkripsiya promptining boshi (til va mavzu ishorasi). */
export const UZ_STT_PROMPT = "O'zbekcha suhbat (o'zbek tili, lotin yozuvi). Savdo qo'ng'irog'i.";

/**
 * Til kodini rad etgan modellar (`url|model`) — jarayon oxirigacha eslab
 * qolinadi, keyingi chaqiruvlarda kod umuman yuborilmaydi.
 */
const languageRejected = new Set<string>();

/** Faqat testlar uchun. */
export function resetSttLanguageMemoryForTests(): void {
  languageRejected.clear();
}

/** Qaysi maydonlar yuboriladi (sof funksiya — testlanadi). */
export function sttRequestFields(
  req: Pick<SttRequest, 'lang' | 'hints'>,
  mode: SttLanguageMode,
  languageAllowed: boolean,
): { language?: string; prompt?: string } {
  const out: { language?: string; prompt?: string } = {};
  if (mode === 'code' && languageAllowed) out.language = STT_LANGUAGE[req.lang] ?? 'uz';
  const hints = req.hints && req.hints.length > 0 ? req.hints.join(', ') : '';
  const parts: string[] = [];
  if (mode === 'prompt' && req.lang !== 'ru') parts.push(UZ_STT_PROMPT);
  // Lug'at/taklif nomlari — tanib olishga yordam beradi (har rejimda).
  if (hints) parts.push(mode === 'prompt' ? `So'zlar: ${hints}.` : hints);
  if (parts.length > 0) out.prompt = parts.join(' ').slice(0, 1000);
  return out;
}

/** 400 xato til parametri haqidami (masalan "Language code 'uz' is not recognized"). */
export function isLanguageRejection(err: unknown): boolean {
  return (
    err instanceof LlmCallError &&
    err.kind === 'http' &&
    err.status === 400 &&
    /language/i.test(err.providerMessage ?? err.message)
  );
}

export function createOpenAiStt(config: OpenAiVoiceConfig): SttPort {
  const mode = config.sttLanguageMode ?? 'omit';
  const memoryKey = `${config.baseUrl}|${config.sttModel}`;

  async function post(req: SttRequest, fields: { language?: string; prompt?: string }) {
    const form = new FormData();
    // Fayl nomi kengaytmasi muhim: server formatni shundan ham biladi.
    form.append('file', new Blob([new Uint8Array(req.audio)], { type: req.mime }), 'turn.wav');
    form.append('model', config.sttModel);
    form.append('response_format', 'json');
    if (fields.language) form.append('language', fields.language);
    if (fields.prompt) form.append('prompt', fields.prompt);

    const startedAt = Date.now();
    const res = await withTimeout('OpenAI STT', config.timeoutMs, config.apiKey, (signal) =>
      fetch(`${config.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}` },
        body: form,
        signal,
      }),
    );
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) throw await failure('OpenAI STT', res, config.apiKey);
    const json = (await res.json()) as { text?: string; language?: string };
    return { text: (json.text ?? '').trim(), latencyMs, raw: json };
  }

  return {
    async transcribeShort(req: SttRequest): Promise<SttResult> {
      const fields = sttRequestFields(req, mode, !languageRejected.has(memoryKey));
      try {
        return await post(req, fields);
      } catch (err) {
        // Model til parametrini rad etdi — BIR marta usiz qayta, va eslab qolamiz.
        if (!isLanguageRejection(err) || fields.language === undefined) throw err;
        languageRejected.add(memoryKey);
        console.warn(
          `[stt] ${config.sttModel} til kodini qabul qilmadi — bundan keyin "language" yuborilmaydi ` +
            '(OPENAI_STT_LANGUAGE_MODE=omit yoki prompt tavsiya etiladi).',
        );
        const { language: _dropped, ...rest } = fields;
        return await post(req, rest);
      }
    },
  };
}

const FORMAT_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
};

export function createOpenAiTts(config: OpenAiVoiceConfig): TtsPort {
  return {
    async synthesize(req: TtsRequest): Promise<TtsResult> {
      const body: Record<string, unknown> = {
        model: config.ttsModel,
        input: req.text,
        voice: req.voice ?? config.ttsVoice ?? 'alloy',
        response_format: config.ttsFormat,
      };
      // Ohang ko'rsatmasi: qo'llamaydigan model uni e'tiborsiz qoldiradi
      // (`diag:voice` qaysi model qo'llashini aniqlaydi).
      if (req.instructions) body.instructions = req.instructions;

      const startedAt = Date.now();
      const res = await withTimeout('OpenAI TTS', config.timeoutMs, config.apiKey, (signal) =>
        fetch(`${config.baseUrl}/audio/speech`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal,
        }),
      );

      if (!res.ok) throw await failure('OpenAI TTS', res, config.apiKey);

      // Birinchi baytni o'lchaymiz — oqimli ijro uchun muhim ko'rsatkich.
      const chunks: Uint8Array[] = [];
      let firstByteMs: number | undefined;
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            if (firstByteMs === undefined) firstByteMs = Date.now() - startedAt;
            chunks.push(value);
          }
        }
      } else {
        chunks.push(new Uint8Array(await res.arrayBuffer()));
      }

      return {
        audio: Buffer.concat(chunks.map((c) => Buffer.from(c))),
        mime: FORMAT_MIME[config.ttsFormat] ?? 'audio/mpeg',
        latencyMs: Date.now() - startedAt,
        ...(firstByteMs !== undefined ? { firstByteMs } : {}),
      };
    },
  };
}

export interface OpenAiModel {
  id: string;
  owned_by?: string;
  created?: number;
}

/** Kalitga ochiq modellar ro'yxati (`diag:voice` shundan tanlaydi). */
export async function listOpenAiModels(config: {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
}): Promise<OpenAiModel[]> {
  const res = await withTimeout('OpenAI /models', config.timeoutMs ?? 30_000, config.apiKey, (signal) =>
    fetch(`${config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal,
    }),
  );
  if (!res.ok) throw await failure('OpenAI /models', res, config.apiKey);
  const json = (await res.json()) as { data?: OpenAiModel[] };
  return json.data ?? [];
}

/** Ovozga aloqador bo'lishi mumkin bo'lgan modellar (nom bo'yicha saralash). */
export const VOICE_MODEL_HINTS = ['transcribe', 'tts', 'audio', 'realtime', 'live'] as const;

export function filterVoiceModels(models: readonly OpenAiModel[]): OpenAiModel[] {
  return models
    .filter((m) => VOICE_MODEL_HINTS.some((hint) => m.id.toLowerCase().includes(hint)))
    .sort((a, b) => a.id.localeCompare(b.id));
}
