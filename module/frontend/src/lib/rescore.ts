/**
 * "Qayta baholash" tugmasi qachon ko'rsatiladi — sof funksiya (testlanadi).
 *
 * Baholash fon rejimida ketadi; server to'xtasa natija `pending` da qolib
 * ketishi mumkin. Shuning uchun tugma:
 *  - natija `failed` bo'lsa — darhol;
 *  - natija hali `pending` bo'lsa — 3 daqiqadan keyin.
 * Yosh ikki manbadan olinadi (kattasi): serverdagi `createdAt` va brauzer
 * shu versiyani birinchi marta `pending` holatda ko'rgan vaqt — soatlar
 * farq qilsa ham tugma baribir chiqadi.
 */
export const RESCORE_PENDING_AFTER_MS = 3 * 60 * 1000;

export interface RescoreInput {
  status: 'pending' | 'done' | 'failed';
  /** ISO vaqt (server). */
  createdAt: string;
}

export function canOfferRescore(
  result: RescoreInput,
  nowMs: number,
  pendingSeenSinceMs: number | null,
): boolean {
  if (result.status === 'failed') return true;
  if (result.status !== 'pending') return false;
  const created = Date.parse(result.createdAt);
  const serverAge = Number.isFinite(created) ? nowMs - created : 0;
  const clientAge = pendingSeenSinceMs === null ? 0 : nowMs - pendingSeenSinceMs;
  return Math.max(serverAge, clientAge) >= RESCORE_PENDING_AFTER_MS;
}
