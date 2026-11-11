/**
 * FAQAT HARNESS. `TrainerLlm` portining Gemini adapteri — Interactions API
 * (`POST /v1beta/interactions`), generateContent EMAS.
 *
 * Rasmiy hujjat (2026-11-10 da o'qildi):
 *   https://aistudio.google.com/docs/interactions-overview
 *   https://aistudio.google.com/docs/structured-output
 *  - JSON: `response_format: {type:'text', mime_type:'application/json', schema}`;
 *    null — `type: ['string','null']` ko'rinishida; minLength/maxLength jim
 *    tashlab yuboriladi (chegaralarni baribir zod tekshiradi).
 *  - Fikrlash: `generation_config.thinking_level` = low | medium | high
 *    (gemini-3.8-flash'da O'CHIRIB BO'LMAYDI; default medium). Default bu yerda `low`.
 *  - Usage: total_input_tokens, total_cached_tokens, total_output_tokens,
 *    total_thought_tokens. Thinking chiqish narxida -> `outputTokens` = chiqish + thinking.
 *  - `generation_config` har so'rovda qayta beriladi (`store: false`, stateless).
 * So'rov shakli avvalgi mustaqil solishtirish sinovida ishlagan integratsiyadan olingan.
 *
 * Xatolar `LlmCallError` bilan toifalanadi. Qayta urinish siyosati (adapter ichida):
 *  - 429 (rate limit) — server aytgan vaqtni kutib; kutish `maxWaitMs` dan uzun
 *    yoki kunlik kvota bo'lsa — darhol tashqariga (zaxira provayder ishlashi uchun);
 *  - 500/502/503/504 ("high demand") va tarmoq xatosi — eksponensial backoff;
 *  - timeout — shu urinishlar hisobida;
 *  - invalid_json / schema — adapter qayta URINMAYDI: modul (engine/persona)
 *    xato matni bilan bitta tuzatuvchi so'rov yuboradi (ikki barobar retry bo'lmasin).
 *
 * Kalit faqat `x-goog-api-key` header'ida; log/xato matniga hech qachon tushmaydi.
 */
import { LlmCallError } from '../../module/backend/src/training/errors.js';
import type {
  TokenUsage,
  TrainerLlm,
  TrainerLlmRequest,
} from '../../module/backend/src/training/ports.js';
import type { LlmCallListener } from './bakeoff/types.js';
import { defaultLlmLogSink, formatLlmCallLog, type LlmLogSink } from './llm-log.js';
import { parseContentJson, reasoningHeadroom } from './llm-openai-compatible.js';
import { zodToJsonSchema } from './zod-json-schema.js';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
export const THINKING_LEVELS = ['low', 'medium', 'high'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'low';

export interface RetryPolicy {
  /** Jami urinishlar (1 = qayta urinishsiz). */
  maxAttempts: number;
  /** Backoff boshlang'ich kutishi (ms): base, 2*base, 4*base ... */
  baseDelayMs: number;
  /** Bitta kutishning yuqori chegarasi; 429 bundan uzun kutishni so'rasa — kutilmaydi. */
  maxWaitMs: number;
}

/**
 * Xavfsizlik sozlamalari (hujjat: aistudio.google.com/docs/safety-settings):
 * so'rovning YUQORI darajasidagi `safety_settings: [{type, threshold}]`.
 * Gemini 2.5+ da default — "off". Mashq mijozi yengil qo'pollik qila oladi
 * (harassment — faqat yuqori ehtimolni bloklash), nafrat/jinsiy/xavfli
 * mazmun esa qattiqroq. Bloklansa — HTTP 400, error.code "safety"; modul
 * yumshoqroq ko'rsatma bilan BIR marta qayta so'raydi, keyin neytral gap.
 * `GEMINI_SAFETY=off` — hech narsa yuborilmaydi (provayder default'i).
 */
export const DEFAULT_SAFETY_SETTINGS = [
  { type: 'harassment', threshold: 'block_only_high' },
  { type: 'hate_speech', threshold: 'block_medium_and_above' },
  { type: 'sexually_explicit', threshold: 'block_medium_and_above' },
  { type: 'dangerous_content', threshold: 'block_medium_and_above' },
] as const;

export type SafetySetting = { type: string; threshold: string };

/** Jonli suhbat: uzoq kutib bo'lmaydi — tez taslim bo'lib, zaxiraga o'tish afzal. */
export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 1_000, maxWaitMs: 8_000 };

export interface GeminiLlmOptions {
  apiKey: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  /** Javob byudjeti (thinking zaxirasi ALOHIDA qo'shiladi). */
  maxTokens?: number;
  stageMaxTokens?: Readonly<Record<string, number>>;
  /** `false` — response_format yuborilmaydi, JSON faqat promptda so'raladi. */
  structuredOutput?: boolean;
  /** Berilmasa DEFAULT_SAFETY_SETTINGS; bo'sh massiv — yuborilmaydi. */
  safetySettings?: readonly SafetySetting[];
  timeoutMs?: number;
  retry?: RetryPolicy;
  baseUrl?: string;
  log?: LlmLogSink | null;
  onCall?: LlmCallListener;
  /** Testlar uchun. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface InteractionUsage {
  total_input_tokens?: number;
  total_cached_tokens?: number;
  total_output_tokens?: number;
  total_thought_tokens?: number;
}

interface InteractionResponse {
  output_text?: string;
  status?: string;
  steps?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  usage?: InteractionUsage;
  error?: { message?: string };
}

/** Provayder xatosi + kutish maslahati (429 `retry in Xs` / RetryInfo). */
export class GeminiHttpError extends LlmCallError {
  readonly retryAfterMs?: number;
  readonly dailyQuota: boolean;
  constructor(status: number, short: string, retryAfterMs: number | undefined, dailyQuota: boolean) {
    super('http', `HTTP ${status}: ${short}`, { status, providerMessage: short });
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    this.dailyQuota = dailyQuota;
  }
}

function redact(text: string, apiKey: string): string {
  const out = apiKey ? text.split(apiKey).join('***') : text;
  return out.replace(/(AIza[0-9A-Za-z_-]{20,}|AQ\.[A-Za-z0-9_.-]{20,})/g, '***');
}

/** "retry in 1m2.5s" / RetryInfo `retryDelay: "12s"` -> ms. */
export function parseRetryDelayMs(text: string): number | undefined {
  const m = /retry in (?:(\d+)h)?\s*(?:(\d+)m)?\s*([\d.]+)s/i.exec(text);
  if (m) return Math.round((Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3])) * 1000);
  const d = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(text);
  return d ? Math.round(Number(d[1]) * 1000) : undefined;
}

/** Vaqtinchalik (qayta urinishga arziydigan) HTTP holatlar. */
export function isTransientStatus(status: number | undefined): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * Zaxira provayderga o'tishga arziydigan xato: 429/5xx, timeout, tarmoq.
 * 400/401/403/404 — sozlama xatosi: zaxira uni yashirmasin.
 */
export function isFallbackWorthy(err: unknown): boolean {
  if (!(err instanceof LlmCallError)) return false;
  if (err.kind === 'timeout' || err.kind === 'unknown') return true;
  return err.kind === 'http' && isTransientStatus(err.status);
}

export function buildInteractionBody(
  req: { system: string; user: string; outputSchema?: unknown },
  opts: {
    model: string;
    thinkingLevel: ThinkingLevel;
    maxOutputTokens: number;
    structuredOutput: boolean;
    safetySettings?: readonly SafetySetting[];
  },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    store: false,
    system_instruction: `${req.system}\n\nReturn ONLY a single JSON object. No prose, no code fences.`,
    input: [{ type: 'user_input', content: [{ type: 'text', text: req.user }] }],
    generation_config: { thinking_level: opts.thinkingLevel, max_output_tokens: opts.maxOutputTokens },
  };
  if (opts.safetySettings && opts.safetySettings.length > 0) {
    body.safety_settings = opts.safetySettings.map((x) => ({ type: x.type, threshold: x.threshold }));
  }
  if (opts.structuredOutput) {
    const schema = zodToJsonSchema(req.outputSchema, 'type-array');
    body.response_format = schema
      ? { type: 'text', mime_type: 'application/json', schema }
      : { type: 'text', mime_type: 'application/json' };
  }
  return body;
}

export interface RawInteraction {
  text: string;
  status: string | null;
  usage: TokenUsage;
  latencyMs: number;
}

/** Interactions javobidan matn: `output_text` yoki `model_output` qadamlari. */
export function interactionText(json: InteractionResponse): string {
  if (typeof json.output_text === 'string') return json.output_text;
  return (json.steps ?? [])
    .filter((s) => s.type === 'model_output')
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
}

/** Usage -> TokenUsage: chiqish = chiqish + thinking (narx shundan). */
export function interactionUsage(u: InteractionUsage | undefined, model: string): TokenUsage {
  const thought = u?.total_thought_tokens ?? 0;
  const cached = u?.total_cached_tokens ?? 0;
  return {
    inputTokens: u?.total_input_tokens ?? 0,
    outputTokens: (u?.total_output_tokens ?? 0) + thought,
    model,
    ...(thought ? { reasoningTokens: thought } : {}),
    ...(cached ? { cachedInputTokens: cached } : {}),
  };
}

/** Bitta HTTP so'rov (qayta urinishsiz). */
export async function postInteraction(opts: {
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  model: string;
  fetchImpl?: typeof fetch;
}): Promise<RawInteraction> {
  const { url, apiKey, body, timeoutMs, model } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    let text: string;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      if (controller.signal.aborted) {
        throw new LlmCallError('timeout', `${timeoutMs} ms ichida javob kelmadi`, { cause: err });
      }
      const message = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
      throw new LlmCallError('unknown', `tarmoq xatosi: ${redact(message + cause, apiKey).slice(0, 200)}`, {
        cause: err,
      });
    }

    if (!res.ok) {
      let message = text;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string; code?: unknown } };
        if (parsed.error?.message) message = parsed.error.message;
        // error.code (masalan "safety") — modul xavfsizlik blokini shundan taniydi.
        if (typeof parsed.error?.code === 'string') message = `${parsed.error.code}: ${message}`;
      } catch {
        // JSON emas — matnning o'zi.
      }
      const short = redact(message, apiKey).replace(/\s+/g, ' ').trim().slice(0, 240);
      throw new GeminiHttpError(
        res.status,
        short,
        parseRetryDelayMs(text),
        res.status === 429 && /per day|daily|PerDay|RPD/i.test(text),
      );
    }

    let json: InteractionResponse;
    try {
      json = JSON.parse(text) as InteractionResponse;
    } catch {
      throw new LlmCallError('invalid_json', 'provayder javobi (HTTP tanasi) JSON emas');
    }
    if (json.error?.message) {
      const short = redact(json.error.message, apiKey).slice(0, 240);
      throw new LlmCallError('http', `HTTP ${res.status}: ${short}`, { status: res.status, providerMessage: short });
    }
    return {
      text: interactionText(json),
      status: json.status ?? null,
      usage: interactionUsage(json.usage, model),
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Qayta urinish bilan bajaradi. Har kutish log'ga yoziladi (jim kutilmaydi).
 * Qaytaradi: natija va nechanchi urinishda olindi.
 */
export async function withRetry<T>(
  what: string,
  policy: RetryPolicy,
  fn: () => Promise<T>,
  hooks: { log?: LlmLogSink | null; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ value: T; attempts: number }> {
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return { value: await fn(), attempts: attempt };
    } catch (err) {
      if (attempt >= policy.maxAttempts || !isFallbackWorthy(err)) throw err;
      let waitMs = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxWaitMs);
      if (err instanceof GeminiHttpError && err.status === 429) {
        if (err.dailyQuota) throw err;
        if (err.retryAfterMs !== undefined) {
          if (err.retryAfterMs > policy.maxWaitMs) throw err;
          waitMs = err.retryAfterMs + 250;
        }
      }
      const why = err instanceof LlmCallError && err.status !== undefined ? `HTTP ${err.status}` : (err as LlmCallError).kind;
      hooks.log?.(`[retry] ${what}: ${why} — ${Math.round(waitMs)} ms kutib qayta urinilyapti (${attempt + 1}/${policy.maxAttempts})`);
      await sleep(waitMs);
    }
  }
}

function outcomeOf(err: unknown): string {
  if (err instanceof LlmCallError) {
    return err.kind === 'http' && err.status !== undefined ? `http_${err.status}` : err.kind;
  }
  if (err instanceof Error && err.name === 'ZodError') return 'schema';
  return 'unknown';
}

export function createGeminiLlm(options: GeminiLlmOptions): TrainerLlm {
  const {
    apiKey,
    model = DEFAULT_GEMINI_MODEL,
    thinkingLevel = DEFAULT_THINKING_LEVEL,
    maxTokens = 1024,
    structuredOutput = true,
    safetySettings = DEFAULT_SAFETY_SETTINGS,
    timeoutMs = 60_000,
    retry = DEFAULT_RETRY,
    onCall,
  } = options;
  const log = options.log === undefined ? defaultLlmLogSink() : options.log;
  const url = `${(options.baseUrl ?? GEMINI_BASE_URL).replace(/\/$/, '')}/interactions`;
  // Thinking tokenlari ham chegaraga kiradi — javob byudjetiga zaxira qo'shiladi.
  const limitFor = (stage: string): number =>
    (options.stageMaxTokens?.[stage] ?? maxTokens) + reasoningHeadroom(thinkingLevel);

  async function run<T>(req: TrainerLlmRequest<T>): Promise<{ value: T; usage: TokenUsage }> {
    const startedAt = Date.now();
    const body = buildInteractionBody(req, {
      model,
      thinkingLevel,
      maxOutputTokens: limitFor(req.stage),
      structuredOutput,
      safetySettings,
    });
    let usage: TokenUsage | undefined;
    let attempts = 1;
    try {
      const out = await withRetry(
        `gemini ${req.stage}`,
        retry,
        () =>
          postInteraction({
            url,
            apiKey,
            body,
            timeoutMs,
            model,
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          }),
        { log, ...(options.sleep ? { sleep: options.sleep } : {}) },
      );
      attempts = out.attempts;
      const raw = out.value;
      usage = raw.usage;
      const finish = raw.status === 'incomplete' ? 'length' : raw.status;
      const value = req.schema.parse(parseContentJson(raw.text, finish, usage.reasoningTokens));
      log?.(
        formatLlmCallLog({ provider: 'gemini', stage: req.stage, model, latencyMs: raw.latencyMs, usage, outcome: 'ok', attempt: attempts }),
      );
      onCall?.({ stage: req.stage, attempts, ok: true, latencyMs: Date.now() - startedAt, usage, provider: 'gemini', outcome: 'ok' });
      return { value, usage };
    } catch (err) {
      const outcome = outcomeOf(err);
      const detail = err instanceof Error ? err.message : String(err);
      log?.(
        formatLlmCallLog({
          provider: 'gemini',
          stage: req.stage,
          model,
          latencyMs: Date.now() - startedAt,
          ...(usage ? { usage } : {}),
          outcome,
          attempt: attempts,
          detail,
        }),
      );
      onCall?.({
        stage: req.stage,
        attempts,
        ok: false,
        latencyMs: Date.now() - startedAt,
        ...(usage ? { usage } : {}),
        error: `[${outcome}] ${detail}`.slice(0, 200),
        provider: 'gemini',
        outcome,
      });
      throw err;
    }
  }

  return {
    async completeJson<T>(req: TrainerLlmRequest<T>): Promise<T> {
      return (await run(req)).value;
    },
    async completeJsonWithUsage<T>(req: TrainerLlmRequest<T>) {
      return await run(req);
    },
  };
}

// ---------------------------------------------------------------------------
// Zaxira (fallback) provayder
// ---------------------------------------------------------------------------

export interface NamedLlm {
  llm: TrainerLlm;
  provider: string;
  model: string;
}

/**
 * Asosiy provayder 429/5xx/timeout bilan (qayta urinishlardan keyin ham)
 * yiqilsa — zaxira provayderga o'tadi. O'tish HAR SAFAR log'ga yoziladi
 * (qaysi provayder javob berdi). Zaxira yo'q bo'lsa — aniq xabar va asl xato.
 */
export function withLlmFallback(
  primary: NamedLlm,
  fallback: NamedLlm | null,
  opts: { log?: LlmLogSink | null; unavailableReason?: string } = {},
): TrainerLlm {
  const log = opts.log === undefined ? defaultLlmLogSink() : opts.log;

  async function run<T>(req: TrainerLlmRequest<T>): Promise<{ value: T; usage?: TokenUsage }> {
    try {
      if (primary.llm.completeJsonWithUsage) return await primary.llm.completeJsonWithUsage(req);
      return { value: await primary.llm.completeJson(req) };
    } catch (err) {
      if (!isFallbackWorthy(err)) throw err;
      const reason = outcomeOf(err);
      if (!fallback) {
        log?.(
          `[llm] ${primary.provider} ${reason} — zaxira provayder YO'Q` +
            (opts.unavailableReason ? ` (${opts.unavailableReason})` : '') +
            '. Navbat xato bilan tugaydi.',
        );
        throw err;
      }
      log?.(
        `[llm] FALLBACK ${primary.provider}/${primary.model} -> ${fallback.provider}/${fallback.model} ` +
          `· sabab=${reason} · stage=${req.stage}`,
      );
      if (fallback.llm.completeJsonWithUsage) return await fallback.llm.completeJsonWithUsage(req);
      return { value: await fallback.llm.completeJson(req) };
    }
  }

  return {
    async completeJson<T>(req: TrainerLlmRequest<T>): Promise<T> {
      return (await run(req)).value;
    },
    async completeJsonWithUsage<T>(req: TrainerLlmRequest<T>) {
      const out = await run(req);
      return { value: out.value, usage: out.usage ?? { inputTokens: 0, outputTokens: 0 } };
    },
  };
}
