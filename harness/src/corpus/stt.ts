/**
 * FAQAT HARNESS (korpus). Sozlangan OpenAI endpoint'iga transkripsiya so'rovi.
 * Kalit hech qachon chiqmaydi; matn LOGGA yozilmaydi.
 *
 *  - oddiy modellar: `response_format=json` -> `{ text }`;
 *  - diarizatsiya modeli: `response_format=diarized_json`, `chunking_strategy=auto`
 *    -> `{ text, segments: [{ speaker, start, end, text }] }`.
 * Javob shakli kutilganidan farq qilsa ham yiqilmaslik uchun himoyali o'qiladi.
 */
import { readFile } from 'node:fs/promises';

import { redactSecrets, sttRequestFields, type SttLanguageMode } from '../voice/openai.js';
import { DIARIZE_MODEL } from './paths.js';

export interface SttCallConfig {
  apiKey: string;
  baseUrl: string;
  languageMode: SttLanguageMode;
  hints: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface RawSegment {
  speaker?: string;
  start?: number;
  end?: number;
  text: string;
}

export interface SttCallResult {
  text: string;
  segments: RawSegment[];
  language?: string;
  latencyMs: number;
  /** Provayderning xom javobi — faqat diskka (raw/) yoziladi. */
  raw: unknown;
}

export function isDiarizeModel(model: string): boolean {
  return model === DIARIZE_MODEL || model.includes('diarize');
}

/** Javobdan segmentlarni himoyali ajratadi. */
export function normalizeSttResponse(json: unknown): { text: string; segments: RawSegment[]; language?: string } {
  const obj = (json ?? {}) as { text?: unknown; segments?: unknown; language?: unknown };
  const segments: RawSegment[] = Array.isArray(obj.segments)
    ? obj.segments
        .map((s) => s as { speaker?: unknown; start?: unknown; end?: unknown; text?: unknown })
        .filter((s) => typeof s.text === 'string' && (s.text as string).trim().length > 0)
        .map((s) => ({
          text: (s.text as string).trim(),
          ...(typeof s.speaker === 'string' || typeof s.speaker === 'number' ? { speaker: String(s.speaker) } : {}),
          ...(typeof s.start === 'number' ? { start: s.start } : {}),
          ...(typeof s.end === 'number' ? { end: s.end } : {}),
        }))
    : [];
  const text = typeof obj.text === 'string' ? obj.text.trim() : segments.map((s) => s.text).join(' ');
  return { text, segments, ...(typeof obj.language === 'string' ? { language: obj.language } : {}) };
}

export async function transcribeFile(
  model: string,
  wavPath: string,
  config: SttCallConfig,
): Promise<SttCallResult> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const audio = await readFile(wavPath);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'call.wav');
  form.append('model', model);

  if (isDiarizeModel(model)) {
    // Diarizatsiya: >30 s audio uchun chunking talab qilinadi; prompt qo'llanmaydi.
    form.append('response_format', 'diarized_json');
    form.append('chunking_strategy', 'auto');
  } else {
    form.append('response_format', 'json');
    const fields = sttRequestFields({ lang: 'uz', hints: config.hints }, config.languageMode, true);
    if (fields.language) form.append('language', fields.language);
    if (fields.prompt) form.append('prompt', fields.prompt);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 300_000);
  const startedAt = Date.now();
  try {
    let res: Response;
    try {
      res = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}` },
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`${model}: timeout`);
      throw new Error(`${model}: tarmoq xatosi: ${redactSecrets(String(err), config.apiKey).slice(0, 160)}`);
    }
    const body = await res.text();
    if (!res.ok) {
      let message = body;
      try {
        const parsed = JSON.parse(body) as { error?: { message?: string } };
        if (parsed.error?.message) message = parsed.error.message;
      } catch {
        // JSON emas
      }
      throw new Error(`${model}: HTTP ${res.status}: ${redactSecrets(message, config.apiKey).slice(0, 200)}`);
    }
    const json = JSON.parse(body) as unknown;
    const normalized = normalizeSttResponse(json);
    return { ...normalized, latencyMs: Date.now() - startedAt, raw: json };
  } finally {
    clearTimeout(timer);
  }
}
