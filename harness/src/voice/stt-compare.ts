/**
 * FAQAT HARNESS. STT modellarini solishtirish (`diag:stt`) uchun sof
 * funksiyalar: bitta namuna natijasi, yig'ma ko'rsatkichlar va reyting.
 */
import {
  classifyHeardUzText,
  transliterateUzCyrillic,
} from '../../../module/backend/src/training/language.js';
import { accuracy, mean, median } from './text-metrics.js';

export interface SttSampleRun {
  model: string;
  mode: string;
  n: number;
  reference: string;
  /** STT qaytargan matn (xato bo'lsa `null`). */
  text: string | null;
  latencyMs: number;
  /** Provayder qaytargan til (bo'lsa). */
  language?: string;
  error?: string;
}

export interface SttSampleScore {
  wer: number;
  cer: number;
  /** Kirill -> lotin o'girilgandan keyingi ko'rsatkichlar (amalda shu ishlatiladi). */
  werLatin: number;
  cerLatin: number;
  /** `latin` | `uz_cyrillic` | `foreign` — jonli rejimda `foreign` "takrorlaysizmi" bo'ladi. */
  script: string;
}

/**
 * Apostrof, katta-kichik harf va tinish belgilari normallashtiriladi
 * (`accuracy` ichida); raqamlar ikkala tomonda so'zga aylantiriladi.
 */
export function scoreSample(reference: string, text: string): SttSampleScore {
  const raw = accuracy(reference, text, { digitsToWords: true });
  const latin = accuracy(reference, transliterateUzCyrillic(text), { digitsToWords: true });
  return {
    wer: raw.wer,
    cer: raw.cer,
    werLatin: latin.wer,
    cerLatin: latin.cer,
    script: classifyHeardUzText(text),
  };
}

export interface SttCandidateSummary {
  model: string;
  mode: string;
  samples: number;
  errors: number;
  /** Jonli rejimda rad etiladigan (boshqa til) javoblar soni. */
  foreign: number;
  meanWer: number;
  meanWerLatin: number;
  meanCerLatin: number;
  p50LatencyMs: number;
}

export function summarizeStt(runs: readonly SttSampleRun[]): SttCandidateSummary[] {
  const groups = new Map<string, SttSampleRun[]>();
  for (const run of runs) {
    const key = `${run.model}|${run.mode}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  const out: SttCandidateSummary[] = [];
  for (const group of groups.values()) {
    const first = group[0] as SttSampleRun;
    const ok = group.filter((r) => r.text !== null);
    const scores = ok.map((r) => scoreSample(r.reference, r.text as string));
    // Xato bergan namuna — 100% xato hisoblanadi (aks holda yiqiladigan model yutib chiqardi).
    const failedPenalty = group.length - ok.length;
    const withPenalty = (values: number[]): number =>
      mean([...values, ...Array.from({ length: failedPenalty }, () => 1)]);
    out.push({
      model: first.model,
      mode: first.mode,
      samples: group.length,
      errors: failedPenalty,
      foreign: scores.filter((s) => s.script === 'foreign').length,
      meanWer: withPenalty(scores.map((s) => s.wer)),
      meanWerLatin: withPenalty(scores.map((s) => s.werLatin)),
      meanCerLatin: withPenalty(scores.map((s) => s.cerLatin)),
      p50LatencyMs: Math.round(median(ok.map((r) => r.latencyMs))),
    });
  }
  return out;
}

/** Reyting: lotindagi WER (past yaxshi), keyin CER, keyin kechikish. */
export function rankStt(summaries: readonly SttCandidateSummary[]): SttCandidateSummary[] {
  return [...summaries].sort(
    (a, b) =>
      a.meanWerLatin - b.meanWerLatin ||
      a.meanCerLatin - b.meanCerLatin ||
      a.p50LatencyMs - b.p50LatencyMs,
  );
}
