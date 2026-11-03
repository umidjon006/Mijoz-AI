/**
 * API xatosini foydalanuvchiga tushunarli, o'zbekcha matnga aylantiradi.
 *
 * Server xato javobi: `{ error, stage, message }` (`stage`: audio | stt | llm |
 * tts | session | server). Host'ning so'rov funksiyasi (`ApiRequest`) xatoni
 * turlicha shakllantirishi mumkin, shuning uchun uch manba tekshiriladi:
 *   1. `err.body` — host javob tanasini xatoga biriktirgan bo'lsa (tavsiya);
 *   2. xato matni ichidagi JSON (`... {"error":"...","stage":"stt",...}`);
 *   3. aks holda — matnning o'zi (xom JSON ko'rsatilmaydi).
 */
import { mashq } from '../lugat/mashq.js';

export type ApiErrorStage = 'audio' | 'stt' | 'llm' | 'tts' | 'session' | 'server';

export interface ApiErrorBody {
  error?: string;
  stage?: ApiErrorStage;
  message?: string;
}

const STAGES: readonly ApiErrorStage[] = ['audio', 'stt', 'llm', 'tts', 'session', 'server'];

function asBody(value: unknown): ApiErrorBody | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (typeof body.error !== 'string' && typeof body.message !== 'string') return null;
  return {
    ...(typeof body.error === 'string' ? { error: body.error } : {}),
    ...(typeof body.message === 'string' ? { message: body.message } : {}),
    ...(typeof body.stage === 'string' && (STAGES as readonly string[]).includes(body.stage)
      ? { stage: body.stage as ApiErrorStage }
      : {}),
  };
}

/** Xatodan server tanasini ajratadi (bo'lmasa `null`). */
export function apiErrorBody(err: unknown): ApiErrorBody | null {
  const attached = asBody((err as { body?: unknown } | null)?.body);
  if (attached) return attached;
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return asBody(JSON.parse(text.slice(start, end + 1)));
    } catch {
      // JSON emas.
    }
  }
  return null;
}

/** Foydalanuvchiga ko'rsatiladigan matn: bosqich + qisqa sabab (+ maslahat). */
export function describeApiError(err: unknown): string {
  const body = apiErrorBody(err);
  if (body?.stage) {
    const label = mashq.errorStage[body.stage];
    const reason = body.message ? `: ${body.message}` : '.';
    const hint = body.stage === 'stt' || body.stage === 'tts' || body.stage === 'audio' ? ` ${mashq.voiceTypeInstead}` : '';
    return `${label} ${mashq.errorAtStage}${reason}${hint}`;
  }
  if (body?.message) return body.message;
  const text = err instanceof Error ? err.message : String(err);
  // Xom JSON yoki stack ko'rsatilmaydi.
  return text.includes('{') ? mashq.voiceFailed : text || mashq.voiceFailed;
}
