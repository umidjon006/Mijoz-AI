/**
 * FAQAT HARNESS. Ko'r baholash uchun transkript parchalarini tanlash.
 *
 * Qoidalar:
 *  - har nomzoddan BIR XIL miqdorda parcha (default 12);
 *  - tanlash ham, aralashtirish ham URUG' bo'yicha — takrorlanadi;
 *  - parcha ichida mijozning kamida bitta javobi bo'lishi shart;
 *  - model nomi parchada YO'Q, faqat `Model A/B/...` yorlig'i.
 */
import { blindLabels, hashSeed, shuffle } from './shuffle.js';
import type { BlindExcerpt } from './report-html.js';
import type { SessionRun } from './types.js';

export const DEFAULT_EXCERPTS_PER_CANDIDATE = 12;
/** Parchadagi navbatlar soni (sotuvchi + mijoz). */
export const EXCERPT_TURNS = 6;

export interface ExcerptSelection {
  excerpts: BlindExcerpt[];
  /** Ko'r yorliq -> haqiqiy nomzod. Alohida faylga yoziladi. */
  mapping: Record<string, string>;
  /** Parcha id'si -> qaysi sessiya va qaysi nomzod (faqat mapping faylida). */
  sources: Record<string, { candidate: string; runKey: string }>;
}

/**
 * Parcha uchun NEYTRAL id.
 *
 * DIQQAT: sessiya kaliti (`haiku|negotiator|...`) ichida MODEL NOMI bor,
 * shuning uchun uni HTML'ga qo'yib bo'lmaydi — aks holda baholovchi DOM'dan
 * yoki CSV'dan modelni bilib oladi va "ko'r" baholash ma'nosini yo'qotadi.
 */
export function excerptId(runKey: string, seed: string): string {
  return `ex-${hashSeed(`${seed}:${runKey}`).toString(36)}`;
}

/** Sessiyadan parcha kesib oladi (mijoz javobi bilan tugaydigan oyna). */
export function sliceExcerpt(run: SessionRun, size = EXCERPT_TURNS): SessionRun['transcript'] {
  const turns = run.transcript;
  if (turns.length <= size) return [...turns];

  // Oxirgi mijoz javobi bilan tugaydigan oyna — suhbatning "qizigan" joyi.
  let end = turns.length;
  while (end > 0 && turns[end - 1]?.speaker !== 'customer') end -= 1;
  if (end === 0) end = turns.length;
  const start = Math.max(0, end - size);
  return turns.slice(start, end);
}

export function selectBlindExcerpts(
  runs: readonly SessionRun[],
  seed: string,
  perCandidate = DEFAULT_EXCERPTS_PER_CANDIDATE,
): ExcerptSelection {
  const usable = runs.filter(
    (run) => run.error === null && run.transcript.some((t) => t.speaker === 'customer'),
  );

  const candidates = [...new Set(usable.map((run) => run.candidate))].sort();
  const labels = blindLabels(candidates, seed);

  const picked: BlindExcerpt[] = [];
  const sources: Record<string, { candidate: string; runKey: string }> = {};
  for (const candidate of candidates) {
    const own = shuffle(
      usable.filter((run) => run.candidate === candidate),
      `${seed}:${candidate}`,
    ).slice(0, perCandidate);

    for (const run of own) {
      picked.push({
        blindLabel: labels.get(candidate) ?? candidate,
        id: excerptId(run.key, seed),
        archetype: run.archetype,
        script: run.script,
        turns: sliceExcerpt(run),
      });
      sources[excerptId(run.key, seed)] = { candidate, runKey: run.key };
    }
  }

  // Nomzodlar aralashib ketsin — baholovchi tartibdan taxmin qilmasin.
  const excerpts = shuffle(picked, `${seed}:order`);

  const mapping: Record<string, string> = {};
  for (const [candidate, label] of labels) mapping[label] = candidate;

  return { excerpts, mapping, sources };
}
