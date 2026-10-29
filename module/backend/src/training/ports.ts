/**
 * Integratsiya chokchalari (seams).
 *
 * Modul hech qanday global holatni O'QIMAYDI. Hamma narsa tashqaridan —
 * host ilova (sales-copilot) tomonidan — shu interfeyslar orqali uzatiladi.
 * Shuning uchun teammate'lar haqiqiy implementatsiyani bir necha daqiqada
 * ulab yuborishi mumkin.
 */
import type { BusinessProfile } from './profile-schema.js';

/**
 * Kim mashq qilyapti va qaysi tenant nomidan.
 * Host ilovaning auth qatlami to'ldiradi (JWT/session), modul o'zi hech
 * qachon global'dan o'qimaydi. `seatId` — ixtiyoriy (seat bo'lmasligi mumkin).
 */
export interface TrainingContext {
  businessId: string;
  userId: string;
  seatId: string | null;
}

/**
 * LLM porti — asosiy repodagi `LlmClient` bilan AYNAN bir xil shakl
 * (`backend/src/ai/llm.ts`). Integratsiyada host `getActiveLlm()` natijasini
 * 1:1 shu portga beradi, adapter yozish kerak emas.
 *
 * `stage` — qaysi bosqich uchun chaqirilgani (narx/telemetriya uchun),
 * `schema` — javob JSON'ini tekshiradigan zod sxema (yoki unga mos validator).
 */
export interface TrainerLlmRequest<T> {
  stage: string;
  system: string;
  user: string;
  schema: { parse: (input: unknown) => T };
}

export interface TrainerLlm {
  completeJson<T>(req: TrainerLlmRequest<T>): Promise<T>;
}

/**
 * Tranzaksiya ichida tenant'ni o'rnatib ishlaydigan funksiya.
 * Asosiy repodagi `withTenant` (`backend/src/db/index.ts`) bilan bir xil:
 * tranzaksiya ochadi, `set_config('app.business_id', businessId, true)` qiladi,
 * shundan keyingina RLS siyosatlari ishlaydi.
 *
 * `TTx` generik — modul Drizzle tranzaksiya tipini o'ziga bog'lab qo'ymaydi,
 * host o'z tipini beradi.
 */
export type WithTenant<TTx = unknown> = <R>(
  businessId: string,
  fn: (tx: TTx) => Promise<R>,
) => Promise<R>;

/**
 * Tenant'ning biznes profili (domen faktlari) — modul ichida hech qanday
 * soha nomi qattiq yozilmaydi, hammasi shu funksiya qaytargan profildan keladi.
 * Host buni `backend/src/business/profile.ts` ustiga ulaydi.
 * Profil hali to'ldirilmagan bo'lsa `null` qaytarishi mumkin.
 */
export type GetBusinessProfile = (businessId: string) => Promise<BusinessProfile | null>;

/**
 * Modulning barcha tashqi bog'liqliklari bitta joyda. Host ilova ishga
 * tushganda bir marta yig'adi va modulga uzatadi (DI konteyner o'rnida).
 */
export interface TrainingDeps<TTx = unknown> {
  withTenant: WithTenant<TTx>;
  getBusinessProfile: GetBusinessProfile;
  llm: TrainerLlm;
  /** Ixtiyoriy logger — host o'z pino instansiyasini berishi mumkin. */
  logger?: TrainingLogger;
}

export interface TrainingLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}
