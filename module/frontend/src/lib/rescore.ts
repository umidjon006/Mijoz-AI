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

/** Oxirgi baholash run'i (pending/failed bo'lishi mumkin). */
export interface LatestRunInput {
  version: number;
  status: 'pending' | 'done' | 'failed';
  error: string | null;
  createdAt: string;
}

export interface ScoringRunState {
  /** Baholash ketmoqda (yoki biz so'ragan versiya hali ko'rinmadi) — tugma o'chiq. */
  inProgress: boolean;
  /** Ko'rsatilayotgan natijadan YANGIROQ run muvaffaqiyatsiz tugagan. */
  failedRun: LatestRunInput | null;
}

/**
 * Debrief sahifasidagi baholash holati.
 *  - `latestRun` — server bergan oxirgi run (yo'q bo'lsa natijaning o'zi);
 *  - `awaitingVersion` — "Qayta baholash" bosilganda server qaytargan versiya:
 *    u ko'rinmaguncha (va pending bo'lsa) tugma o'chiq turadi.
 */
export function scoringRunState(
  result: LatestRunInput,
  latestRun: LatestRunInput | null | undefined,
  awaitingVersion: number | null,
): ScoringRunState {
  const run = latestRun ?? result;
  const inProgress =
    run.status === 'pending' || (awaitingVersion !== null && run.version < awaitingVersion);
  const failedRun = run.status === 'failed' && run.version > result.version ? run : null;
  return { inProgress, failedRun };
}
