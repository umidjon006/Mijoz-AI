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
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
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
  },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens,
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
      const short = providerMessage(text, apiKey);
      throw new LlmCallError('http', `HTTP ${res.status}: ${short}`, {
        status: res.status,
        providerMessage: short,
      });
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
        outputTokens: json.usage?.completion_tokens ?? 0,
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

/** Model matnidan JSON; bo'lmasa `invalid_json` (kesilgan bo'lsa shuni aytadi). */
export function parseContentJson(content: string, finishReason: string | null): unknown {
  try {
    return extractJson(content);
  } catch (err) {
    const why =
      finishReason === 'length'
        ? 'javob max_tokens chegarasida kesildi (reasoning tokenlari ham shu chegaraga kiradi)'
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

  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  async function run<T>(req: TrainerLlmRequest<T>): Promise<{ value: T; usage: TokenUsage }> {
    const startedAt = Date.now();
    const body = buildChatBody(req, {
      model,
      maxTokens,
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
        const raw = await postChatCompletion({ url, apiKey, body, timeoutMs });
        usage = raw.usage;
        const value = req.schema.parse(parseContentJson(raw.content, raw.finishReason));
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
        return { value, usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model } };
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
