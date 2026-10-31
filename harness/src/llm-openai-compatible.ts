/**
 * FAQAT HARNESS. `TrainerLlm` portining OpenAI-mos (`/chat/completions`)
 * endpointlar uchun adapteri: Gemini (OpenAI-mos rejimi), Groq, GLM, va h.k.
 *
 * Kalit faqat env'dan olinadi va hech qachon log/xato matniga tushmaydi.
 *
 * JSON rejimi (`TRAINER_JSON_MODE`):
 *  - `schema` — `response_format: json_schema` (strict); sxema modulning
 *    `outputSchema` (zod) idan yasaladi; yasab bo'lmasa `object` ga tushadi;
 *  - `object` — `response_format: json_object`;
 *  - `prompt` — `response_format` yuborilmaydi, JSON faqat promptda so'raladi.
 *
 * Xatolar `LlmCallError` bilan TOIFALANADI: timeout | http | invalid_json |
 * schema. Qayta urinish siyosati:
 *  - timeout — ko'pi bilan BIR marta (aynan shu so'rov);
 *  - http    — qayta urinilmaydi (status va provayder xabari ko'rsatiladi);
 *  - invalid_json / schema — adapter qayta urinmaydi: modul (persona, engine,
 *    scoring) xato matni bilan tuzatuvchi so'rov yuboradi.
 * Avval adapter HAR QANDAY xatoni (timeout ham) "tuzatib" qayta so'rardi,
 * modul esa yana qayta so'rardi — timeout'lar 4 barobar cho'zilib, oxirida
 * "validatsiyadan o'tmadi" deb noto'g'ri ko'rsatilardi.
 *
 * Token chegarasi parametri (`TRAINER_MAX_TOKENS_PARAM`): `auto` —
 * api.openai.com uchun `max_completion_tokens` (yangi modellar `max_tokens` ni
 * 400 bilan rad etadi), qolganlari (Gemini, Groq, GLM) uchun `max_tokens`.
 *
 * Himoya: provayder 400 bilan "parametr qo'llanmaydi" desa (max_tokens,
 * max_completion_tokens, temperature, reasoning_effort, response_format),
 * so'rov BIR marta o'sha parametrsiz (yoki provayder taklif qilgan nom bilan)
 * qayta yuboriladi va bu jarayon oxirigacha shu model uchun eslab qolinadi.
 *
 * Reasoning modellarida yashirin reasoning tokenlari ham chegaraga kiradi —
 * shuning uchun javob byudjetiga `reasoningHeadroom` qo'shiladi; reasoning
 * tokenlari log va diag'da alohida ko'rsatiladi (narx ham ularni hisobga oladi).
 */
import { LlmCallError } from '../../module/backend/src/training/errors.js';
import type {
  TokenUsage,
  TrainerLlm,
  TrainerLlmRequest,
} from '../../module/backend/src/training/ports.js';
import type { LlmCallListener } from './bakeoff/types.js';
import { extractJson } from './llm-anthropic.js';
import { defaultLlmLogSink, formatLlmCallLog, type LlmLogSink } from './llm-log.js';
import { zodToJsonSchema, type NullableStyle } from './zod-json-schema.js';

export type JsonMode = 'schema' | 'object' | 'prompt';
export type MaxTokensParam = 'max_tokens' | 'max_completion_tokens';
export type MaxTokensParamSetting = 'auto' | MaxTokensParam;

/**
 * `auto`: api.openai.com -> `max_completion_tokens`, boshqalar -> `max_tokens`
 * (Gemini/Groq/GLM avvalgidek ishlaydi).
 */
export function resolveMaxTokensParam(
  setting: MaxTokensParamSetting | undefined,
  baseUrl: string,
): MaxTokensParam {
  if (setting === 'max_tokens' || setting === 'max_completion_tokens') return setting;
  let host = '';
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    // noto'g'ri URL — default.
  }
  return host === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens';
}

/**
 * Yashirin reasoning tokenlari uchun zaxira (javob byudjetiga QO'SHILADI).
 * Chegara faqat yuqori chegara — ishlatilmagan token pul turmaydi, lekin
 * yetmasa javob bo'sh/kesilgan keladi. `undefined` — provayder default'i
 * (masalan OpenAI'da `medium`), shuning uchun saxiy zaxira.
 */
export function reasoningHeadroom(effort: string | undefined): number {
  switch (effort) {
    case 'none':
      return 0;
    case 'minimal':
      return 1024;
    case 'low':
      return 2048;
    case 'medium':
      return 4096;
    case 'high':
      return 8192;
    default:
      return 4096;
  }
}

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  /** Eski nomlar (`json_object`, `json_schema`) ham qabul qilinadi. */
  jsonMode?: JsonMode | 'json_object' | 'json_schema';
  /** `reasoning_effort` (none | minimal | low | ...). Berilmasa yuborilmaydi. */
  reasoningEffort?: string;
  onCall?: LlmCallListener;
  /** Bitta HTTP so'rov uchun chegara (ms). */
  timeoutMs?: number;
  /** `schema` rejimida null maydon qanday yoziladi. */
  nullableStyle?: NullableStyle;
  /** Har chaqiruvga bitta log qatori; `null` — jim. Default: stderr. */
  log?: LlmLogSink | null;
  /** Default `auto`. */
  maxTokensParam?: MaxTokensParamSetting;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string };
}

export function normalizeJsonMode(mode: string | undefined): JsonMode {
  if (mode === 'json_object' || mode === 'object') return 'object';
  if (mode === 'json_schema' || mode === 'schema') return 'schema';
  if (mode === 'prompt') return 'prompt';
  return 'object';
}

/** Kalit xato matniga tushib qolmasligi uchun. */
export function sanitize(text: string, apiKey: string): string {
  return apiKey.length > 0 ? text.split(apiKey).join('***') : text;
}

/** Provayder xato javobidan qisqa xabar (JSON bo'lsa `error.message`). */
export function providerMessage(text: string, apiKey: string): string {
  let message = text;
  try {
    const parsed = JSON.parse(text) as unknown;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const inner = (first as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof inner === 'string' && inner.length > 0) message = inner;
  } catch {
    // JSON emas — matnning o'zi.
  }
  return sanitize(message, apiKey).replace(/\s+/g, ' ').trim().slice(0, 200);
}

export interface ChatRequestInput {
  system: string;
  user: string;
  outputSchema?: unknown;
  stage: string;
}

export function buildChatBody(
  input: ChatRequestInput,
  opts: {
    model: string;
    maxTokens: number;
    jsonMode: JsonMode;
    reasoningEffort?: string;
    nullableStyle?: NullableStyle;
    /** Default `max_tokens`. */
    maxTokensParam?: MaxTokensParam;
  },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    [opts.maxTokensParam ?? 'max_tokens']: opts.maxTokens,
    messages: [
      {
        role: 'system',
        content: `${input.system}\n\nReturn ONLY a single JSON object. No prose, no code fences.`,
      },
      { role: 'user', content: input.user },
    ],
  };

  if (opts.jsonMode === 'schema') {
    const schema = zodToJsonSchema(input.outputSchema, opts.nullableStyle);
    body.response_format = schema
      ? {
          type: 'json_schema',
          json_schema: {
            name: input.stage.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
            strict: true,
            schema,
          },
        }
      : { type: 'json_object' };
  } else if (opts.jsonMode === 'object') {
    body.response_format = { type: 'json_object' };
  }

  if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;
  return body;
}

/** HTTP xato + provayder JSON'idagi `error.param` / `error.code` (bo'lsa). */
export class ProviderHttpError extends LlmCallError {
  readonly param?: string;
  readonly code?: string;
  constructor(status: number, short: string, param?: string, code?: string) {
    super('http', `HTTP ${status}: ${short}`, { status, providerMessage: short });
    if (param) this.param = param;
    if (code) this.code = code;
  }
}

function errorFields(text: string): { param?: string; code?: string } {
  try {
    const parsed = JSON.parse(text) as unknown;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const error = (first as { error?: { param?: unknown; code?: unknown } } | null)?.error;
    return {
      ...(typeof error?.param === 'string' ? { param: error.param } : {}),
      ...(typeof error?.code === 'string' ? { code: error.code } : {}),
    };
  } catch {
    return {};
  }
}

export interface RawChatResult {
  content: string;
  finishReason: string | null;
  usage: TokenUsage & { reasoningTokens?: number };
  latencyMs: number;
  status: number;
}

/**
 * Bitta HTTP so'rov. Xatolar toifalangan `LlmCallError` bo'lib chiqadi.
 * `diag:llm` ham shu funksiyani ishlatadi.
 */
export async function postChatCompletion(opts: {
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
  timeoutMs: number;
}): Promise<RawChatResult> {
  const { url, apiKey, body, timeoutMs } = opts;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      if (controller.signal.aborted) {
        throw new LlmCallError('timeout', `${timeoutMs} ms ichida javob kelmadi`, { cause: err });
      }
      const message = err instanceof Error ? err.message : String(err);
      // `fetch failed` o'zi hech narsa demaydi — haqiqiy sabab `cause` da (ENOTFOUND, ECONNREFUSED...).
      const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
      throw new LlmCallError(
        'unknown',
        `tarmoq xatosi: ${sanitize(message + cause, apiKey).slice(0, 200)}`,
        { cause: err },
      );
    }

    if (!res.ok) {
      const { param, code } = errorFields(text);
      throw new ProviderHttpError(res.status, providerMessage(text, apiKey), param, code);
    }

    let json: ChatCompletionResponse;
    try {
      json = JSON.parse(text) as ChatCompletionResponse;
    } catch {
      throw new LlmCallError('invalid_json', 'provayder javobi (HTTP tanasi) JSON emas');
    }
    if (json.error?.message) {
      const short = providerMessage(JSON.stringify(json), apiKey);
      throw new LlmCallError('http', `HTTP ${res.status}: ${short}`, {
        status: res.status,
        providerMessage: short,
      });
    }

    const choice = json.choices?.[0];
    const reasoningTokens = json.usage?.completion_tokens_details?.reasoning_tokens;
    return {
      content: choice?.message?.content ?? '',
      finishReason: choice?.finish_reason ?? null,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: billableOutputTokens(json.usage),
        model: typeof body.model === 'string' ? body.model : undefined,
        ...(reasoningTokens ? { reasoningTokens } : {}),
      },
      latencyMs: Date.now() - startedAt,
      status: res.status,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Narx uchun chiqish tokenlari — reasoning tokenlari BILAN.
 * OpenAI: `completion_tokens` reasoning'ni allaqachon o'z ichiga oladi.
 * Ba'zi OpenAI-mos endpointlar (Gemini) reasoning'ni `completion_tokens` ga
 * qo'shmay, faqat `total_tokens` ga qo'shadi. Shuning uchun:
 * max(completion, total - prompt) — ikkala uslubda ham reasoning hisoblanadi.
 */
export function billableOutputTokens(usage: ChatCompletionResponse['usage']): number {
  const completion = usage?.completion_tokens ?? 0;
  const prompt = usage?.prompt_tokens ?? 0;
  const total = usage?.total_tokens;
  return typeof total === 'number' ? Math.max(completion, total - prompt) : completion;
}

// ---------------------------------------------------------------------------
// "Parametr qo'llanmaydi" (400) himoyasi
// ---------------------------------------------------------------------------

/** Shu parametrlar uchungina avtomatik tuzatish qilinadi. */
export const FALLBACK_PARAMS = [
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'reasoning_effort',
  'response_format',
] as const;
export type FallbackParam = (typeof FALLBACK_PARAMS)[number];

/** Parametrni nima qilish kerak: o'chirish (`null`) yoki boshqa nomga ko'chirish. */
export interface ParamFix {
  param: FallbackParam;
  replacement: FallbackParam | null;
}

const UNSUPPORTED_RE =
  /unsupported|not supported|unrecognized|unknown (?:parameter|field|name|argument)|not (?:allowed|permitted)|does not support|invalid (?:parameter|argument)/i;

function isFallbackParam(value: string | undefined): value is FallbackParam {
  return value !== undefined && (FALLBACK_PARAMS as readonly string[]).includes(value);
}

/**
 * 400 xatoda qaysi parametr qo'llanmaganini aniqlaydi (faqat tanadagi
 * parametrlar orasidan). Topilmasa `null` — xato odatdagidek chiqadi.
 */
export function detectUnsupportedParam(
  err: unknown,
  body: Record<string, unknown>,
): ParamFix | null {
  if (!(err instanceof LlmCallError) || err.kind !== 'http' || err.status !== 400) return null;
  const message = err.providerMessage ?? err.message;
  if (!UNSUPPORTED_RE.test(message)) return null;

  let param: FallbackParam | undefined;
  const declared = err instanceof ProviderHttpError ? err.param : undefined;
  if (isFallbackParam(declared) && declared in body) {
    param = declared;
  } else {
    // Xabarda tilga olingan, tanada BOR birinchi parametr. Gemini kabi
    // provayderlar nomni aytmaydi ("Thinking level ... not supported") —
    // reasoning_effort uchun alohida belgi.
    const lower = message.toLowerCase();
    param = FALLBACK_PARAMS.filter((p) => p in body)
      .map((p) => ({ p, at: lower.indexOf(p) }))
      .filter(({ at }) => at >= 0)
      .sort((a, b) => a.at - b.at)[0]?.p;
    if (!param && 'reasoning_effort' in body && /thinking|reasoning/i.test(message)) {
      param = 'reasoning_effort';
    }
  }
  if (!param) return null;

  // "Use 'max_completion_tokens' instead" — taklif qilingan nom.
  const suggested = /use\s+['"`]?([a-z_]+)['"`]?\s+instead/i.exec(message)?.[1];
  const replacement = isFallbackParam(suggested) && suggested !== param ? suggested : null;
  return { param, replacement };
}

/** Tuzatishni tanaga qo'llaydi (yangi obyekt). */
export function applyParamFix(body: Record<string, unknown>, fix: ParamFix): Record<string, unknown> {
  if (!(fix.param in body)) return body;
  const next = { ...body };
  const value = next[fix.param];
  delete next[fix.param];
  if (fix.replacement && !(fix.replacement in next)) next[fix.replacement] = value;
  return next;
}

/** Jarayon davomida eslab qolingan tuzatishlar: `url|model` -> tuzatishlar. */
const rememberedFixes = new Map<string, ParamFix[]>();

/** Faqat testlar uchun. */
export function resetParamFixesForTests(): void {
  rememberedFixes.clear();
}

/** Model uchun eslab qolingan tuzatishlar (diag/test uchun). */
export function rememberedParamFixes(url: string, model: string): readonly ParamFix[] {
  return rememberedFixes.get(`${url}|${model}`) ?? [];
}

function describeFix(fix: ParamFix): string {
  return fix.replacement ? `${fix.param} -> ${fix.replacement}` : `${fix.param} olib tashlandi`;
}

/**
 * `postChatCompletion` + himoya: eslab qolingan tuzatishlarni qo'llaydi;
 * yangi "parametr qo'llanmaydi" 400 bo'lsa — BIR marta tuzatib qayta yuboradi,
 * tuzatishni eslab qoladi va bitta log qatori yozadi.
 */
export async function postWithParamFallback(opts: {
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  model: string;
  log?: LlmLogSink | null;
}): Promise<RawChatResult> {
  const key = `${opts.url}|${opts.model}`;
  let body = opts.body;
  for (const fix of rememberedFixes.get(key) ?? []) body = applyParamFix(body, fix);

  try {
    return await postChatCompletion({ ...opts, body });
  } catch (err) {
    const fix = detectUnsupportedParam(err, body);
    if (!fix) throw err;
    rememberedFixes.set(key, [...(rememberedFixes.get(key) ?? []), fix]);
    opts.log?.(
      `[llm] param-fallback model=${opts.model} ${describeFix(fix)} · ` +
        `provayder 400: ${(err as LlmCallError).providerMessage ?? ''}`.slice(0, 300),
    );
    return await postChatCompletion({ ...opts, body: applyParamFix(body, fix) });
  }
}

/** Model matnidan JSON; bo'lmasa `invalid_json` (kesilgan bo'lsa shuni aytadi). */
export function parseContentJson(
  content: string,
  finishReason: string | null,
  reasoningTokens?: number,
): unknown {
  try {
    return extractJson(content);
  } catch (err) {
    const why =
      finishReason === 'length'
        ? `javob token chegarasida kesildi (reasoning tokenlari ham shu chegaraga kiradi${
            reasoningTokens ? `: ${reasoningTokens} ta reasoning` : ''
          })`
        : content.trim().length === 0
          ? "model bo'sh javob qaytardi"
          : 'model javobidan JSON ajratib olinmadi';
    throw new LlmCallError('invalid_json', why, { cause: err });
  }
}

function outcomeOf(err: unknown): string {
  if (err instanceof LlmCallError) {
    return err.kind === 'http' && err.status !== undefined ? `http_${err.status}` : err.kind;
  }
  if (err instanceof Error && err.name === 'ZodError') return 'schema';
  return 'unknown';
}

export function createOpenAiCompatibleLlm(options: OpenAiCompatibleOptions): TrainerLlm {
  const {
    baseUrl,
    apiKey,
    model,
    maxTokens = 1024,
    reasoningEffort,
    onCall,
    timeoutMs = 60_000,
    nullableStyle,
  } = options;
  const jsonMode = normalizeJsonMode(options.jsonMode);
  const log = options.log === undefined ? defaultLlmLogSink() : options.log;
  const maxTokensParam = resolveMaxTokensParam(options.maxTokensParam, baseUrl);
  // Javob byudjeti + yashirin reasoning uchun zaxira.
  const completionLimit = maxTokens + reasoningHeadroom(reasoningEffort);

  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  async function run<T>(req: TrainerLlmRequest<T>): Promise<{ value: T; usage: TokenUsage }> {
    const startedAt = Date.now();
    const body = buildChatBody(req, {
      model,
      maxTokens: completionLimit,
      maxTokensParam,
      jsonMode,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(nullableStyle ? { nullableStyle } : {}),
    });

    let lastError: unknown;
    // Timeout — ko'pi bilan BIR marta qayta. Boshqa xatolar — darhol tashqariga.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const attemptStarted = Date.now();
      let usage: (TokenUsage & { reasoningTokens?: number }) | undefined;
      try {
        const raw = await postWithParamFallback({ url, apiKey, body, timeoutMs, model, log });
        usage = raw.usage;
        const value = req.schema.parse(
          parseContentJson(raw.content, raw.finishReason, raw.usage.reasoningTokens),
        );
        log?.(
          formatLlmCallLog({
            stage: req.stage,
            model,
            latencyMs: raw.latencyMs,
            usage,
            outcome: 'ok',
            attempt,
          }),
        );
        onCall?.({ stage: req.stage, attempts: attempt, ok: true, latencyMs: Date.now() - startedAt, usage });
        return {
          value,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            model,
            ...(usage.reasoningTokens ? { reasoningTokens: usage.reasoningTokens } : {}),
          },
        };
      } catch (err) {
        lastError = err;
        const outcome = outcomeOf(err);
        const detail = err instanceof Error ? err.message : String(err);
        log?.(
          formatLlmCallLog({
            stage: req.stage,
            model,
            latencyMs: Date.now() - attemptStarted,
            ...(usage ? { usage } : {}),
            outcome,
            attempt,
            detail,
          }),
        );
        const retry = attempt === 1 && err instanceof LlmCallError && err.kind === 'timeout';
        if (!retry) {
          onCall?.({
            stage: req.stage,
            attempts: attempt,
            ok: false,
            latencyMs: Date.now() - startedAt,
            ...(usage ? { usage } : {}),
            error: `[${outcome}] ${detail}`.slice(0, 200),
          });
          throw err;
        }
      }
    }
    throw lastError;
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
