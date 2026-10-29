/**
 * FAQAT HARNESS. STT aniqligini o'lchash: normalizatsiya, WER va CER.
 *
 * Normalizatsiya (Step 3 talabi): kichik harf, tinish belgilarini olib
 * tashlash, apostroflarni (`'`, `ʻ`, `‘`, `’`, `` ` ``) bitta ko'rinishga
 * keltirish. Ixtiyoriy: raqamlarni o'zbek so'zlariga aylantirish — STT
 * "1200000" deb yozsa-da, odam "bir million ikki yuz ming" deb o'qigan
 * bo'ladi, bu esa WER'ni nohaq oshiradi.
 */
import { digitsToUzbekWords } from './numbers.js';
import { unifyApostrophes } from './locales.js';

export interface NormalizeOptions {
  /** Raqamlarni so'zga aylantirish (ikkala matnda ham bir xil qo'llanadi). */
  digitsToWords?: boolean;
}

export function normalizeText(input: string, options: NormalizeOptions = {}): string {
  let text = unifyApostrophes(input).toLowerCase();
  if (options.digitsToWords) text = digitsToUzbekWords(text);

  return text
    // apostrofdan boshqa tinish belgilari olib tashlanadi
    .replace(/[.,!?;:()[\]{}"«»…—–\-/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function words(text: string): string[] {
  return text.length === 0 ? [] : text.split(' ');
}

/** Levenshtein masofasi (ikki o'lchovli emas, bitta qatorli DP). */
export function editDistance(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = new Array<number>(b.length + 1);
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] ?? 0) + 1, // insert
        (prev[j] ?? 0) + 1, // delete
        (prev[j - 1] ?? 0) + cost, // substitute
      );
    }
    prev = curr;
  }
  return prev[b.length] ?? 0;
}

export interface AccuracyResult {
  /** Word Error Rate (0..1+). */
  wer: number;
  /** Character Error Rate (0..1+). */
  cer: number;
  refWords: number;
  hypWords: number;
  wordErrors: number;
  charErrors: number;
  normalizedRef: string;
  normalizedHyp: string;
}

export function accuracy(
  reference: string,
  hypothesis: string,
  options: NormalizeOptions = {},
): AccuracyResult {
  const ref = normalizeText(reference, options);
  const hyp = normalizeText(hypothesis, options);

  const refW = words(ref);
  const hypW = words(hyp);
  const wordErrors = editDistance(refW, hypW);

  const refC = [...ref.replace(/ /g, '')];
  const hypC = [...hyp.replace(/ /g, '')];
  const charErrors = editDistance(refC, hypC);

  return {
    wer: refW.length === 0 ? (hypW.length === 0 ? 0 : 1) : wordErrors / refW.length,
    cer: refC.length === 0 ? (hypC.length === 0 ? 0 : 1) : charErrors / refC.length,
    refWords: refW.length,
    hypWords: hypW.length,
    wordErrors,
    charErrors,
    normalizedRef: ref,
    normalizedHyp: hyp,
  };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
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
