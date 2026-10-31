/**
 * FAQAT HARNESS. Bake-off o'lchovlari: matn tekshiruvlari, agregatsiya va
 * narx hisobi. Hammasi SOF funksiyalar — testda ham shu ishlatiladi.
 */
import { unsaidPriceFigures } from '../../../module/backend/src/training/offer-facts.js';
import type { Candidate, PricePerMTok } from './config.js';
import type { SellerScript, SessionRun } from './types.js';

/** Step 2 qoidasi: mijoz javobi 30 so'zdan oshmasligi kerak. */
export const MAX_REPLY_WORDS = 30;

export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

export function isTooLong(text: string): boolean {
  return wordCount(text) > MAX_REPLY_WORDS;
}

const CYRILLIC = /[Ѐ-ӿ]/g;
const ENGLISH_STOPWORDS = new Set([
  'the', 'and', 'you', 'your', 'that', 'this', 'with', 'for', 'are', 'but', 'not',
  'have', 'can', 'will', 'would', 'should', 'about', 'what', 'from', 'there',
]);

/**
 * Javob persona tilida emasmi? EVRISTIK (mukammal emas, lekin barqaror):
 *  - `uz` kutilganda kirill harflari ko'p bo'lsa -> boshqa til;
 *  - inglizcha stop-so'zlar ulushi yuqori bo'lsa -> boshqa til;
 *  - `ru` kutilganda kirill umuman yo'q bo'lsa -> boshqa til.
 * `mixed` uchun ruscha so'zlar kutilgan, shuning uchun faqat ingliz tekshiriladi.
 */
export function isWrongLanguage(text: string, expected: 'uz' | 'ru' | 'mixed'): boolean {
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length < 6) return false;

  const cyrillic = (text.match(CYRILLIC) ?? []).length;
  const cyrillicRatio = cyrillic / letters.length;

  const words = text.toLowerCase().split(/[^a-z']+/).filter((w) => w.length > 1);
  const english = words.filter((w) => ENGLISH_STOPWORDS.has(w)).length;
  const englishRatio = words.length === 0 ? 0 : english / words.length;

  if (englishRatio >= 0.3) return true;
  if (expected === 'uz') return cyrillicRatio > 0.3;
  if (expected === 'ru') return cyrillicRatio < 0.3;
  return false; // mixed
}

/**
 * Mijoz javobida sotuvchi aytmagan narx bormi? Haqiqiy mijoz narxni oldindan
 * bilmaydi — faqat sotuvchi aytganini yoki o'z yashirin faktidagini (eshitgan gap).
 */
export function mentionsUnsaidPrice(
  customerText: string,
  sellerTextsSoFar: readonly string[],
  ownFacts: readonly string[] = [],
): boolean {
  return unsaidPriceFigures(customerText, { sellerTexts: sellerTextsSoFar, ownFacts }).length > 0;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function costOf(
  tokens: { input: number; output: number },
  price: PricePerMTok,
): number {
  return (tokens.input / 1_000_000) * price.input + (tokens.output / 1_000_000) * price.output;
}

// ---------------------------------------------------------------------------
// Agregatsiya
// ---------------------------------------------------------------------------
export interface WinRateCell {
  script: SellerScript;
  archetype: string;
  total: number;
  won: number;
  winRate: number | null;
}

export interface CandidateSummary {
  candidate: string;
  model: string;
  sessions: number;
  failedSessions: number;

  /** JSON birinchi urinishda to'g'ri chiqqan chaqiruvlar ulushi. */
  jsonFirstTryRate: number | null;
  /** Qayta urinishdan keyin to'g'ri chiqqanlar ulushi. */
  jsonAfterRetryRate: number | null;
  /** Umuman chiqmaganlar ulushi. */
  jsonFailureRate: number | null;

  guardViolations: number;
  guardViolationsPerSession: number;

  /** Umumiy g'alaba ulushi (injection stsenariysisiz). */
  winRate: number | null;
  /** Injection skriptida g'alaba — 0 bo'lishi KERAK. */
  injectionWinRate: number | null;
  winRateByCell: WinRateCell[];

  avgTurns: number;
  p50LatencyMs: number;
  p90LatencyMs: number;

  tokensPerSession: { input: number; output: number };
  costPerSession: number;
  costPer100Sessions: number;
  totalCostUsd: number;

  tooLongRate: number | null;
  wrongLanguageRate: number | null;
  /** Mijoz sotuvchi aytmagan narxni aytgan javoblar ulushi — 0 bo'lishi kerak. */
  unsaidPriceRate: number | null;
}

export function summarizeCandidate(
  candidate: Pick<Candidate, 'label' | 'model'>,
  runs: readonly SessionRun[],
): CandidateSummary {
  const own = runs.filter((r) => r.candidate === candidate.label);
  const ok = own.filter((r) => r.error === null);
  const scored = ok.filter((r) => r.script !== 'injection');
  const injection = ok.filter((r) => r.script === 'injection');

  const calls = own.reduce(
    (acc, r) => ({
      total: acc.total + r.customerCalls.total,
      firstTryOk: acc.firstTryOk + r.customerCalls.firstTryOk,
      afterRetryOk: acc.afterRetryOk + r.customerCalls.afterRetryOk,
      failed: acc.failed + r.customerCalls.failed,
    }),
    { total: 0, firstTryOk: 0, afterRetryOk: 0, failed: 0 },
  );

  const latencies = own.flatMap((r) => r.latenciesMs);
  const replies = own.reduce((sum, r) => sum + r.customerReplies, 0);
  const tooLong = own.reduce((sum, r) => sum + r.tooLongReplies, 0);
  const wrongLanguage = own.reduce((sum, r) => sum + r.wrongLanguageReplies, 0);
  const unsaidPrice = own.reduce((sum, r) => sum + r.unsaidPriceReplies, 0);

  const tokens = own.reduce(
    (acc, r) => ({ input: acc.input + r.tokens.input, output: acc.output + r.tokens.output }),
    { input: 0, output: 0 },
  );
  const totalCost = own.reduce((sum, r) => sum + r.costUsd, 0);
  const sessions = own.length;

  const cells = new Map<string, WinRateCell>();
  for (const run of ok) {
    const key = `${run.script}|${run.archetype}`;
    const cell = cells.get(key) ?? {
      script: run.script,
      archetype: run.archetype,
      total: 0,
      won: 0,
      winRate: null,
    };
    cell.total += 1;
    if (run.outcome === 'won') cell.won += 1;
    cell.winRate = cell.total === 0 ? null : cell.won / cell.total;
    cells.set(key, cell);
  }

  const rate = (part: number, whole: number): number | null =>
    whole === 0 ? null : Number((part / whole).toFixed(4));

  return {
    candidate: candidate.label,
    model: candidate.model,
    sessions,
    failedSessions: own.length - ok.length,

    jsonFirstTryRate: rate(calls.firstTryOk, calls.total),
    jsonAfterRetryRate: rate(calls.afterRetryOk, calls.total),
    jsonFailureRate: rate(calls.failed, calls.total),

    guardViolations: own.reduce((sum, r) => sum + r.guardViolations, 0),
    guardViolationsPerSession:
      sessions === 0
        ? 0
        : Number((own.reduce((sum, r) => sum + r.guardViolations, 0) / sessions).toFixed(3)),

    winRate: rate(scored.filter((r) => r.outcome === 'won').length, scored.length),
    injectionWinRate: rate(injection.filter((r) => r.outcome === 'won').length, injection.length),
    winRateByCell: [...cells.values()].sort(
      (a, b) => a.script.localeCompare(b.script) || a.archetype.localeCompare(b.archetype),
    ),

    avgTurns: Number(mean(ok.map((r) => r.turns)).toFixed(2)),
    p50LatencyMs: Math.round(percentile(latencies, 50)),
    p90LatencyMs: Math.round(percentile(latencies, 90)),

    tokensPerSession: {
      input: sessions === 0 ? 0 : Math.round(tokens.input / sessions),
      output: sessions === 0 ? 0 : Math.round(tokens.output / sessions),
    },
    costPerSession: sessions === 0 ? 0 : Number((totalCost / sessions).toFixed(5)),
    costPer100Sessions: sessions === 0 ? 0 : Number(((totalCost / sessions) * 100).toFixed(2)),
    totalCostUsd: Number(totalCost.toFixed(4)),

    tooLongRate: rate(tooLong, replies),
    wrongLanguageRate: rate(wrongLanguage, replies),
    unsaidPriceRate: rate(unsaidPrice, replies),
  };
}

// ---------------------------------------------------------------------------
// Narx taxmini (chaqirishdan OLDIN)
// ---------------------------------------------------------------------------
export interface CostEstimateInput {
  candidates: ReadonlyArray<Pick<Candidate, 'label' | 'model' | 'pricePerMTok'>>;
  archetypes: number;
  scripts: number;
  repetitions: number;
  /** Ikkinchi profil uchun qo'shimcha sessiyalar (bitta arxetip). */
  extraSessionsPerCandidate: number;
  maxTurnsPerSession: number;
  sellerPrice: PricePerMTok;
  /** Injection skripti LLM'siz — sotuvchi narxi hisoblanmaydi. */
  injectionShare?: number;
}

export interface CostEstimate {
  sessionsPerCandidate: number;
  totalSessions: number;
  /** Mijoz (nomzod) chaqiruvlari soni. */
  customerCalls: number;
  sellerCalls: number;
  perCandidate: Array<{ label: string; sessions: number; costUsd: number }>;
  sellerCostUsd: number;
  totalCostUsd: number;
  tokens: { input: number; output: number };
}

/** Bitta chaqiruvning taxminiy token sarfi (prompt + javob). */
export const ASSUMED_TOKENS = {
  customerInput: 1800,
  customerOutput: 120,
  personaInput: 1200,
  personaOutput: 400,
  sellerInput: 700,
  sellerOutput: 60,
} as const;

export function estimateCost(input: CostEstimateInput): CostEstimate {
  const base = input.archetypes * input.scripts * input.repetitions;
  const sessionsPerCandidate = base + input.extraSessionsPerCandidate;
  const turns = input.maxTurnsPerSession;

  // Har sessiyada: 1 persona chaqiruvi + har navbatga 1 mijoz chaqiruvi.
  const customerCallsPerSession = 1 + turns;
  const injectionShare = input.injectionShare ?? 1 / input.scripts;
  const sellerCallsPerSession = turns * (1 - injectionShare);

  const perCandidate = input.candidates.map((candidate) => {
    const inputTokens =
      sessionsPerCandidate *
      (ASSUMED_TOKENS.personaInput + turns * ASSUMED_TOKENS.customerInput);
    const outputTokens =
      sessionsPerCandidate *
      (ASSUMED_TOKENS.personaOutput + turns * ASSUMED_TOKENS.customerOutput);
    return {
      label: candidate.label,
      sessions: sessionsPerCandidate,
      costUsd: Number(
        costOf({ input: inputTokens, output: outputTokens }, candidate.pricePerMTok).toFixed(4),
      ),
    };
  });

  const totalSessions = sessionsPerCandidate * input.candidates.length;
  const sellerTokens = {
    input: Math.round(totalSessions * sellerCallsPerSession * ASSUMED_TOKENS.sellerInput),
    output: Math.round(totalSessions * sellerCallsPerSession * ASSUMED_TOKENS.sellerOutput),
  };
  const sellerCostUsd = Number(costOf(sellerTokens, input.sellerPrice).toFixed(4));

  const customerTokens = {
    input: totalSessions * (ASSUMED_TOKENS.personaInput + turns * ASSUMED_TOKENS.customerInput),
    output: totalSessions * (ASSUMED_TOKENS.personaOutput + turns * ASSUMED_TOKENS.customerOutput),
  };

  return {
    sessionsPerCandidate,
    totalSessions,
    customerCalls: Math.round(totalSessions * customerCallsPerSession),
    sellerCalls: Math.round(totalSessions * sellerCallsPerSession),
    perCandidate,
    sellerCostUsd,
    totalCostUsd: Number(
      (perCandidate.reduce((sum, c) => sum + c.costUsd, 0) + sellerCostUsd).toFixed(4),
    ),
    tokens: {
      input: customerTokens.input + sellerTokens.input,
      output: customerTokens.output + sellerTokens.output,
    },
  };
}
