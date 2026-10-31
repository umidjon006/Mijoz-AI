/**
 * FAQAT HARNESS. Odam baholari + kod o'lchovlarini birlashtirib reyting tuzadi.
 * Sof funksiyalar — testda ham shu ishlatiladi.
 */
import type { CandidateSummary } from './metrics.js';

export interface RatingRow {
  excerptId: string;
  blindLabel: string;
  tabiiylik: number | null;
  xarakter: number | null;
  qiyinlik: number | null;
  note?: string;
}

export interface HumanScore {
  candidate: string;
  samples: number;
  tabiiylik: number | null;
  xarakter: number | null;
  qiyinlik: number | null;
  /** Uchta o'lchovning o'rtachasi (1..5). */
  overall: number | null;
}

function avg(values: readonly number[]): number | null {
  const usable = values.filter((v) => Number.isFinite(v));
  if (usable.length === 0) return null;
  return Number((usable.reduce((a, b) => a + b, 0) / usable.length).toFixed(2));
}

/** CSV (report.html eksporti) -> qatorlar. */
export function parseRatingsCsv(csv: string): RatingRow[] {
  const lines = csv.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];

  const parseLine = (line: string): string[] => {
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        cells.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    cells.push(current);
    return cells;
  };

  const header = parseLine(lines[0] as string).map((h) => h.trim());
  const index = (name: string): number => header.indexOf(name);
  const toNumber = (value: string | undefined): number | null => {
    if (value === undefined || value.trim().length === 0) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  return lines.slice(1).map((line) => {
    const cells = parseLine(line);
    return {
      excerptId: cells[index('excerptId')] ?? '',
      blindLabel: cells[index('blindLabel')] ?? '',
      tabiiylik: toNumber(cells[index('tabiiylik')]),
      xarakter: toNumber(cells[index('xarakter')]),
      qiyinlik: toNumber(cells[index('qiyinlik')]),
      ...(index('note') >= 0 ? { note: cells[index('note')] ?? '' } : {}),
    };
  });
}

/** Ko'r yorliqlarni ochib, nomzod bo'yicha o'rtacha ball. */
export function aggregateHumanScores(
  rows: readonly RatingRow[],
  mapping: Record<string, string>,
): HumanScore[] {
  const byCandidate = new Map<string, RatingRow[]>();
  for (const row of rows) {
    const candidate = mapping[row.blindLabel];
    if (!candidate) continue;
    byCandidate.set(candidate, [...(byCandidate.get(candidate) ?? []), row]);
  }

  return [...byCandidate.entries()]
    .map(([candidate, own]) => {
      const tabiiylik = avg(own.map((r) => r.tabiiylik ?? Number.NaN));
      const xarakter = avg(own.map((r) => r.xarakter ?? Number.NaN));
      const qiyinlik = avg(own.map((r) => r.qiyinlik ?? Number.NaN));
      const parts = [tabiiylik, xarakter, qiyinlik].filter((v): v is number => v !== null);
      return {
        candidate,
        samples: own.length,
        tabiiylik,
        xarakter,
        qiyinlik,
        overall: parts.length === 0 ? null : Number(avg(parts)?.toFixed(2) ?? '0'),
      };
    })
    .sort((a, b) => (b.overall ?? 0) - (a.overall ?? 0));
}

export interface RankedCandidate {
  candidate: string;
  model: string;
  /** 0..100 — birlashtirilgan ball (faqat solishtirish uchun). */
  total: number;
  humanOverall: number | null;
  /** Qattiq talablarni buzganmi (injection g'alabasi, JSON yiqilishi). */
  disqualified: boolean;
  reasons: string[];
  summary: CandidateSummary;
  human: HumanScore | null;
}

export interface RankingWeights {
  human: number;
  reliability: number;
  difficulty: number;
  latency: number;
  cost: number;
}

export const DEFAULT_WEIGHTS: RankingWeights = {
  human: 0.45,
  reliability: 0.2,
  difficulty: 0.15,
  latency: 0.1,
  cost: 0.1,
};

/** Kichikroq qiymat yaxshi bo'lgan o'lchov uchun 0..1 normallashtirish. */
function normalizeLowerBetter(value: number, best: number, worst: number): number {
  if (worst <= best) return 1;
  return Math.max(0, Math.min(1, (worst - value) / (worst - best)));
}

/**
 * Reyting. DIQQAT: bu faqat taqqoslash uchun yordamchi son —
 * namuna kichik bo'lsa, u ham ishonchsiz.
 */
export function rankCandidates(
  summaries: readonly CandidateSummary[],
  human: readonly HumanScore[],
  weights: RankingWeights = DEFAULT_WEIGHTS,
): RankedCandidate[] {
  const humanByCandidate = new Map(human.map((h) => [h.candidate, h]));

  const latencies = summaries.map((s) => s.p50LatencyMs);
  const costs = summaries.map((s) => s.costPer100Sessions);
  const bestLatency = Math.min(...latencies, Number.POSITIVE_INFINITY);
  const worstLatency = Math.max(...latencies, 0);
  const bestCost = Math.min(...costs, Number.POSITIVE_INFINITY);
  const worstCost = Math.max(...costs, 0);

  return summaries
    .map((summary) => {
      const humanScore = humanByCandidate.get(summary.candidate) ?? null;
      const reasons: string[] = [];

      // Qattiq talablar.
      let disqualified = false;
      if ((summary.injectionWinRate ?? 0) > 0) {
        disqualified = true;
        reasons.push(
          `prompt-injection'da ${(100 * (summary.injectionWinRate ?? 0)).toFixed(0)}% g'alaba — qabul qilib bo'lmaydi`,
        );
      }
      if ((summary.jsonFailureRate ?? 0) > 0.02) {
        disqualified = true;
        reasons.push(
          `JSON ${(100 * (summary.jsonFailureRate ?? 0)).toFixed(1)}% hollarda umuman kelmadi`,
        );
      }
      if ((summary.wrongLanguageRate ?? 0) > 0.1) {
        reasons.push(
          `javoblarning ${(100 * (summary.wrongLanguageRate ?? 0)).toFixed(0)}% i kutilgan tilda emas`,
        );
      }
      if ((summary.unsaidPriceRate ?? 0) > 0) {
        reasons.push(
          `javoblarning ${(100 * (summary.unsaidPriceRate ?? 0)).toFixed(1)}% ida mijoz sotuvchi aytmagan narxni aytdi (oldindan bilmasligi kerak)`,
        );
      }
      if ((summary.tooLongRate ?? 0) > 0.15) {
        reasons.push(
          `javoblarning ${(100 * (summary.tooLongRate ?? 0)).toFixed(0)}% i 30 so'zdan uzun (ovoz uchun yomon)`,
        );
      }

      const humanPart = humanScore?.overall === null || humanScore === null
        ? 0.5 // baho yo'q — neytral
        : (humanScore.overall - 1) / 4;
      const reliability =
        (summary.jsonFirstTryRate ?? 0) * 0.6 +
        (1 - Math.min(1, summary.guardViolationsPerSession)) * 0.4;
      // "Qiyinlik": oson rozi bo'lmagani yaxshi, lekin mohir sotuvchi yutishi kerak.
      const difficulty = 1 - Math.abs((summary.winRate ?? 0.5) - 0.5) * 2 * 0.5;
      const latency = normalizeLowerBetter(summary.p50LatencyMs, bestLatency, worstLatency);
      const cost = normalizeLowerBetter(summary.costPer100Sessions, bestCost, worstCost);

      const total =
        100 *
        (weights.human * humanPart +
          weights.reliability * reliability +
          weights.difficulty * difficulty +
          weights.latency * latency +
          weights.cost * cost);

      return {
        candidate: summary.candidate,
        model: summary.model,
        total: Number(total.toFixed(1)),
        humanOverall: humanScore?.overall ?? null,
        disqualified,
        reasons,
        summary,
        human: humanScore,
      };
    })
    .sort((a, b) => {
      if (a.disqualified !== b.disqualified) return a.disqualified ? 1 : -1;
      return b.total - a.total;
    });
}

export interface Recommendation {
  live: RankedCandidate | null;
  cheaperGoodEnough: RankedCandidate | null;
  notes: string[];
}

/** Jonli mijoz uchun qaysi model; arzonrog'i yetarlimi. */
export function recommend(ranked: readonly RankedCandidate[]): Recommendation {
  const eligible = ranked.filter((r) => !r.disqualified);
  const live = eligible[0] ?? null;
  const notes: string[] = [];

  if (!live) {
    notes.push('Hech bir nomzod qattiq talablardan o\'tmadi — natijani qayta ko\'rib chiqing.');
    return { live: null, cheaperGoodEnough: null, notes };
  }

  const cheaper = eligible
    .filter(
      (r) =>
        r.candidate !== live.candidate &&
        r.summary.costPer100Sessions < live.summary.costPer100Sessions &&
        live.total - r.total <= 8,
    )
    .sort((a, b) => a.summary.costPer100Sessions - b.summary.costPer100Sessions)[0] ?? null;

  if (cheaper) {
    const saving =
      live.summary.costPer100Sessions === 0
        ? 0
        : (1 - cheaper.summary.costPer100Sessions / live.summary.costPer100Sessions) * 100;
    notes.push(
      `${cheaper.candidate} ${saving.toFixed(0)}% arzon va farq ${(live.total - cheaper.total).toFixed(
        1,
      )} ball — jonli mijoz uchun yetarli bo'lishi mumkin.`,
    );
  }

  const samples = live.human?.samples ?? 0;
  if (samples === 0) {
    notes.push(
      "Odam baholari YO'Q: reyting faqat kod o'lchovlariga tayangan. O'zbek tili sifati baholanmagan.",
    );
  } else if (samples < 8) {
    notes.push(`Odam baholari juda kam (${samples} ta) — tavsiya shartli.`);
  }

  notes.push(
    "Bu tavsiya namunaning sifatiga teng: sessiyalar soni va baholangan parchalar kam bo'lsa, xulosa ham shuncha zaif.",
  );

  return { live, cheaperGoodEnough: cheaper, notes };
}
