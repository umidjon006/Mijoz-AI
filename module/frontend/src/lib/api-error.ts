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

// ---------------------------------------------------------------------------
// Taqdimot rejimi: texnik tafsilotsiz, do'stona o'zbekcha xabar
// ---------------------------------------------------------------------------
const FRIENDLY_BY_CODE: Record<string, string> = {
  voice_review_expired: "Yozuv eskirdi — qaytadan yozing.",
  voice_budget_exhausted: "Bu mashq uchun ovoz vaqti tugadi — matn bilan davom eting.",
  voice_turn_in_progress: 'Oldingi javob hali tayyorlanmoqda — bir soniya kuting.',
  voice_not_recognized: "Ovozni tanib bo'lmadi — matn bilan yozib ko'ring.",
  session_not_active: 'Bu mashq tugagan — yangi mashq boshlang.',
  session_not_found: 'Mashq topilmadi — yangi mashq boshlang.',
  profile_missing: "Biznes ma'lumotlari hali to'ldirilmagan.",
  rate_limited: "Juda tez — bir oz kutib, qayta urinib ko'ring.",
};

const FRIENDLY_BY_STAGE: Record<ApiErrorStage, string> = {
  audio: "Yozuv qabul qilinmadi — qaytadan yozib ko'ring.",
  stt: "Ovozni tanib bo'lmadi — qaytadan yozing yoki matn bilan yozing.",
  llm: "Mijoz hozir javob bera olmadi — bir oz kutib, qayta urinib ko'ring.",
  tts: 'Mijoz ovozini ijro etib bo\'lmadi — javob matni ekranda.',
  session: "Mashq bilan bog'liq muammo — qayta urinib ko'ring.",
  server: "Ulanishda muammo bo'ldi — qayta urinib ko'ring.",
};

/** Texnik tafsilotsiz xabar (kod, provayder matni, JSON — hech biri ko'rinmaydi). */
export function friendlyError(err: unknown): string {
  const body = apiErrorBody(err);
  if (body?.error && FRIENDLY_BY_CODE[body.error]) return FRIENDLY_BY_CODE[body.error] as string;
  if (body?.stage) return FRIENDLY_BY_STAGE[body.stage];
  return FRIENDLY_BY_STAGE.server;
}

/** Sahifalar uchun: taqdimot rejimida do'stona, aks holda bosqichli to'liq xabar. */
export function errorText(err: unknown, presentation: boolean): string {
  return presentation ? friendlyError(err) : describeApiError(err);
}
