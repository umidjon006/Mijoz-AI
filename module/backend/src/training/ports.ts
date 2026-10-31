/**
 * Integratsiya chokchalari (seams).
 *
 * Modul hech qanday global holatni O'QIMAYDI va hech qanday provayder SDK'sini
 * bilmaydi. Hamma narsa tashqaridan — host ilova (sales-copilot) tomonidan —
 * shu interfeyslar orqali uzatiladi.
 */
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';

import type { BusinessProfile } from './profile-schema.js';

/**
 * Kim mashq qilyapti va qaysi tenant nomidan.
 * Host ilovaning auth qatlami to'ldiradi (JWT/session), modul o'zi hech
 * qachon global'dan o'qimaydi. `seatId` — ixtiyoriy.
 */
export interface TrainingContext {
  businessId: string;
  userId: string;
  seatId: string | null;
}

/** LLM chaqiruvining token sarfi (narx hisobi uchun). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Provayder modeli (narxlash uchun), masalan 'claude-haiku-5-5'. */
  model?: string;
  /**
   * IXTIYORIY, faqat ma'lumot uchun: yashirin reasoning tokenlari.
   * `outputTokens` ularni ALLAQACHON o'z ichiga oladi (narx shundan hisoblanadi).
   */
  reasoningTokens?: number;
}

export interface TrainerLlmRequest<T> {
  /** Qaysi bosqich: 'training.persona' | 'training.turn' — telemetriya uchun. */
  stage: string;
  system: string;
  user: string;
  /** Javob JSON'ini tekshiradigan zod sxema (yoki unga mos validator). */
  schema: { parse: (input: unknown) => T };
  /**
   * IXTIYORIY: javob SHAKLINING zod tavsifi (yumshoq tozalashdan keyingi
   * yakuniy shakl). Tuzilmali chiqishni (`json_schema`) qo'llaydigan adapter
   * undan JSON Schema yasashi mumkin; boshqalar e'tiborsiz qoldiradi.
   * Tekshiruv baribir `schema.parse` bilan qilinadi.
   */
  outputSchema?: unknown;
}

/**
 * Adapter LLM chaqiruvi yiqilganda `errors.ts` dagi `LlmCallError` ni
 * (`kind`: timeout | http | invalid_json | schema) tashlashi TAVSIYA etiladi —
 * shunda modul shakl xatosini qayta so'raydi, timeout/HTTP xatoni esa
 * darhol haqiqiy toifasi bilan foydalanuvchiga ko'rsatadi.
 */

/**
 * LLM porti — asosiy repodagi `LlmClient` bilan bir xil shakl
 * (`backend/src/ai/llm.ts`): `completeJson` majburiy, shuning uchun host
 * `getActiveLlm()` natijasini 1:1 bera oladi.
 *
 * `completeJsonWithUsage` — IXTIYORIY qo'shimcha: token sarfini ham qaytaradi.
 * Bo'lsa — `cost_usd` to'ldiriladi; bo'lmasa — narx 0 qoladi, qolgan hamma
 * narsa ishlaydi. (Bu Step 1 dagi port shaklini buzmaydi.)
 */
export interface TrainerLlm {
  completeJson<T>(req: TrainerLlmRequest<T>): Promise<T>;
  completeJsonWithUsage?<T>(
    req: TrainerLlmRequest<T>,
  ): Promise<{ value: T; usage: TokenUsage }>;
}

/**
 * Drizzle tranzaksiyasi. Modul o'z sxemasi (`training_session`,
 * `training_turn`) bilan ishlaganda host sxemasini bilishi shart emas,
 * shuning uchun eng umumiy tranzaksiya tipi ishlatiladi.
 *
 * Integratsiyada host `withTenant` ning tx tipi bu bilan to'g'ridan-to'g'ri
 * mos kelmasa, ulash joyida bitta `as` yetarli (INTEGRATION.md 4-bo'lim).
 */
export type TrainingTx = PgTransaction<
  PgQueryResultHKT,
  Record<string, never>,
  ExtractTablesWithRelations<Record<string, never>>
>;

/**
 * Tranzaksiya ichida tenant'ni o'rnatib ishlaydigan funksiya.
 * Asosiy repodagi `withTenant` (`backend/src/db/index.ts`) bilan bir xil:
 * tranzaksiya ochadi, `set_config('app.business_id', businessId, true)` qiladi,
 * shundan keyingina RLS siyosatlari ishlaydi.
 */
export type WithTenant<TTx = TrainingTx> = <R>(
  businessId: string,
  fn: (tx: TTx) => Promise<R>,
) => Promise<R>;

/**
 * Tenant'ning biznes profili (domen faktlari) — modul ichida hech qanday
 * soha nomi qattiq yozilmaydi, hammasi shu funksiya qaytargan profildan keladi.
 * Profil hali to'ldirilmagan bo'lsa `null`.
 */
export type GetBusinessProfile = (businessId: string) => Promise<BusinessProfile | null>;

/** Bitta LLM chaqiruvining narxi (USD). Host o'z tariflarini biladi. */
export type PriceCall = (usage: TokenUsage) => number;

/** Modulning barcha tashqi bog'liqliklari bitta joyda. */
export interface TrainingDeps {
  withTenant: WithTenant;
  getBusinessProfile: GetBusinessProfile;
  llm: TrainerLlm;
  /** Narx hisobi; berilmasa `cost_usd` 0 bo'lib qoladi. */
  priceCall?: PriceCall;
  /** Testlar uchun deterministik tasodif; default `Math.random`. */
  random?: () => number;
  /** Testlar uchun soat; default `() => new Date()`. */
  now?: () => Date;
  /** Ixtiyoriy logger — host o'z pino instansiyasini berishi mumkin. */
  logger?: TrainingLogger;
}

export interface TrainingLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}
