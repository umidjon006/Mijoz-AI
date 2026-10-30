/**
 * FAQAT HARNESS. `TrainerLlm` portining OpenAI-mos (`/chat/completions`)
 * endpointlar uchun adapteri: Gemini (OpenAI-mos rejimi), Groq, GLM, va h.k.
 *
 * Kalit faqat env'dan olinadi va hech qachon log/xato matniga tushmaydi.
 *
 * JSON rejimi:
 *  - `json_object` / `json_schema` — provayderning tuzilmali chiqish rejimi;
 *  - `prompt` — provayderda bunday rejim bo'lmasa: JSON promptda so'raladi,
 *    javob zod bilan tekshiriladi va kerak bo'lsa BIR marta qayta so'raladi.
 *    Qayta urinishlar soni `onCall` orqali o'lchanadi (robustlik ko'rsatkichi).
 */
import type {
  TokenUsage,
  TrainerLlm,
  TrainerLlmRequest,
} from '../../module/backend/src/training/ports.js';
import type { LlmCallListener } from './bakeoff/types.js';
import { extractJson } from './llm-anthropic.js';

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  jsonMode?: 'json_object' | 'json_schema' | 'prompt';
  onCall?: LlmCallListener;
  /** Sekin provayderlar uchun (ms). */
  timeoutMs?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/** Kalit xato matniga tushib qolmasligi uchun. */
function sanitize(text: string, apiKey: string): string {
  return apiKey.length > 0 ? text.split(apiKey).join('***') : text;
}

export function createOpenAiCompatibleLlm(options: OpenAiCompatibleOptions): TrainerLlm {
  const {
    baseUrl,
    apiKey,
    model,
    maxTokens = 1024,
    jsonMode = 'json_object',
    onCall,
    timeoutMs = 60_000,
  } = options;

  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  async function once<T>(
    req: TrainerLlmRequest<T>,
    correction?: string,
  ): Promise<{ value: T; usage: TokenUsage }> {
    const system = correction ? `${req.system}\n\n## CORRECTION\n${correction}` : req.system;
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: [
        {
          role: 'system',
          content: `${system}\n\nReturn ONLY a single JSON object. No prose, no code fences.`,
        },
        { role: 'user', content: req.user },
      ],
    };
    if (jsonMode === 'json_object' || jsonMode === 'json_schema') {
      // `json_schema` ni qo'llamaydigan provayderlar ham `json_object` ni tushunadi.
      body.response_format = { type: 'json_object' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${sanitize(text, apiKey).slice(0, 300)}`);
      }

      const json = JSON.parse(text) as ChatCompletionResponse;
      if (json.error?.message) throw new Error(sanitize(json.error.message, apiKey).slice(0, 300));

      const content = json.choices?.[0]?.message?.content ?? '';
      const usage: TokenUsage = {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        model,
      };
      return { value: req.schema.parse(extractJson(content)), usage };
    } finally {
      clearTimeout(timer);
    }
  }

  async function run<T>(req: TrainerLlmRequest<T>): Promise<{ value: T; usage: TokenUsage }> {
    const startedAt = Date.now();
    try {
      const first = await once(req);
      onCall?.({
        stage: req.stage,
        attempts: 1,
        ok: true,
        latencyMs: Date.now() - startedAt,
        usage: first.usage,
      });
      return first;
    } catch (firstError) {
      const detail = firstError instanceof Error ? firstError.message : String(firstError);
      try {
        // Bitta tuzatuvchi qayta urinish (ayniqsa `prompt` rejimida kerak).
        const second = await once(
          req,
          `Your previous answer was rejected: ${detail}. Return a single valid JSON object with all required fields.`,
        );
        onCall?.({
          stage: req.stage,
          attempts: 2,
          ok: true,
          latencyMs: Date.now() - startedAt,
          usage: second.usage,
        });
        return second;
      } catch (secondError) {
        const message = secondError instanceof Error ? secondError.message : String(secondError);
        onCall?.({
          stage: req.stage,
          attempts: 2,
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: message.slice(0, 200),
        });
        throw secondError;
      }
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
