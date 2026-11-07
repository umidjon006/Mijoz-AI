/**
 * FAQAT HARNESS (korpus). Transkript matni bilan ishlash — SOF funksiyalar:
 * yozuvni lotinga keltirish, sifat belgisi, so'z darajasidagi o'xshashlik,
 * matnni segmentlarga bo'lish.
 *
 * Asl STT matni HECH QACHON o'zgartirilmaydi: bu yerdagi funksiyalar YANGI
 * maydonlar (`latin`, `display`) yasaydi.
 */
import {
  classifyHeardUzText,
  transliterateUzCyrillic,
} from '../../../module/backend/src/training/language.js';
import { editDistance, normalizeText, words } from '../voice/text-metrics.js';
import { anonymize } from './anonymize.js';

export type SegmentQuality = 'ok' | 'low_quality';

/** Kirill bo'lsa — deterministik lotin; aks holda o'zi. */
export function toLatin(text: string): string {
  return classifyHeardUzText(text) === 'uz_cyrillic' ? transliterateUzCyrillic(text) : text;
}

/**
 * `low_quality`: o'zbekcha emas (boshqa til), bo'sh yoki deyarli harfsiz
 * (shovqin), yoki bir so'z ketma-ket 4+ marta takrorlangan (STT "osilishi").
 */
export function segmentQuality(text: string): SegmentQuality {
  const latin = toLatin(text);
  if (classifyHeardUzText(latin) === 'foreign') return 'low_quality';
  const letters = latin.replace(/[^\p{L}]/gu, '');
  if (letters.length < 2) return 'low_quality';
  const ws = words(normalizeText(latin));
  for (let i = 3; i < ws.length; i += 1) {
    if (ws[i] === ws[i - 1] && ws[i] === ws[i - 2] && ws[i] === ws[i - 3]) return 'low_quality';
  }
  return 'ok';
}

/** Ko'rsatish/tahlil uchun: lotin + shaxsiy raqamlar yashirilgan. */
export function displayText(text: string): string {
  return anonymize(toLatin(text));
}

/**
 * Ikki transkript orasidagi so'z darajasidagi o'xshashlik (0..1):
 * 1 - Levenshtein(so'zlar) / max(uzunlik). Apostrof, harf, tinish
 * normallashtiriladi, kirill lotinga o'giriladi.
 */
export function wordSimilarity(a: string, b: string): number {
  const wa = words(normalizeText(toLatin(a), { digitsToWords: true }));
  const wb = words(normalizeText(toLatin(b), { digitsToWords: true }));
  const longest = Math.max(wa.length, wb.length);
  if (longest === 0) return 1;
  return Math.max(0, 1 - editDistance(wa, wb) / longest);
}

/** Vaqt belgisisiz matnni gaplarga bo'ladi (rollar shu bo'laklarga beriladi). */
export function splitSentences(text: string): string[] {
  return (
    text
      .replace(/\s+/g, ' ')
      .match(/[^.!?…]+[.!?…]+["»”']?|[^.!?…]+$/g)
      ?.map((s) => s.trim())
      .filter((s) => s.length > 0) ?? []
  );
}

/** Matndagi so'zlar soni (normallashtirilgan). */
export function wordCount(text: string): number {
  return words(normalizeText(toLatin(text))).length;
}
