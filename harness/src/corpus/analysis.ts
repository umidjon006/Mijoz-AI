/**
 * FAQAT HARNESS (korpus). Mijoz tomonini HISOBLASH — sof funksiyalar.
 * Statistika faqat koddan; LLM faqat toifalash uchun (alohida fayl).
 */
import { median, percentile } from '../voice/text-metrics.js';
import { normalizeText, words } from '../voice/text-metrics.js';
import { REDACTED } from './anonymize.js';
import { toLatin, wordCount } from './text.js';
import type { Role, Segment, Turn } from './types.js';

/** Ketma-ket bir xil roldagi segmentlarni navbatga birlashtiradi. */
export function mergeTurns(segments: readonly Segment[]): Turn[] {
  const turns: Turn[] = [];
  for (const seg of segments) {
    const role: Role = seg.role ?? 'unknown';
    const last = turns[turns.length - 1];
    if (last && last.role === role) {
      last.display = `${last.display} ${seg.display}`.trim();
      last.segmentIndexes.push(seg.index);
      if (seg.quality === 'low_quality') last.quality = 'low_quality';
      if (seg.end !== undefined) last.end = seg.end;
      continue;
    }
    turns.push({
      index: turns.length,
      role,
      display: seg.display,
      quality: seg.quality,
      ...(seg.start !== undefined ? { start: seg.start } : {}),
      ...(seg.end !== undefined ? { end: seg.end } : {}),
      segmentIndexes: [seg.index],
    });
  }
  return turns;
}

export interface LengthStats {
  count: number;
  meanWords: number;
  medianWords: number;
  p90Words: number;
  maxWords: number;
  /** 1-4 so'zli javoblar ulushi (0..1). */
  shortShare: number;
  histogram: Record<'1-2' | '3-4' | '5-8' | '9-15' | '16+', number>;
}

export function lengthStats(texts: readonly string[]): LengthStats {
  const counts = texts.map(wordCount).filter((n) => n > 0);
  const histogram = { '1-2': 0, '3-4': 0, '5-8': 0, '9-15': 0, '16+': 0 };
  for (const n of counts) {
    if (n <= 2) histogram['1-2'] += 1;
    else if (n <= 4) histogram['3-4'] += 1;
    else if (n <= 8) histogram['5-8'] += 1;
    else if (n <= 15) histogram['9-15'] += 1;
    else histogram['16+'] += 1;
  }
  const total = counts.length;
  return {
    count: total,
    meanWords: total === 0 ? 0 : Number((counts.reduce((a, b) => a + b, 0) / total).toFixed(1)),
    medianWords: median(counts),
    p90Words: percentile(counts, 90),
    maxWords: total === 0 ? 0 : Math.max(...counts),
    shortShare: total === 0 ? 0 : Number((counts.filter((n) => n <= 4).length / total).toFixed(3)),
    histogram,
  };
}

/** O'zbek og'zaki nutqidagi to'ldiruvchi/tasdiq so'zlari (kichik harf, lotin). */
export const FILLER_WORDS = [
  'ha', 'xo\'p', 'mayli', 'endi', 'aa', 'aaa', 'ee', 'eee', 'hmm', 'mm', 'xm', 'yo\'q', 'voy',
  'qarang', 'bilasizmi', 'ana', 'mana', 'xullas', 'demak', 'tushunarli', 'albatta', 'shunaqa',
  'nima', 'alo', 'allo', 'labbay', 'eshitaman', 'ok', 'okey', 'da', 'net', 'koroche', 'tak',
];

/** Navbatlardagi to'ldiruvchi so'zlar chastotasi (kamayish tartibida). */
export function fillerCounts(texts: readonly string[]): Array<{ word: string; count: number }> {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const w of words(normalizeText(toLatin(text)))) {
      if (FILLER_WORDS.includes(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
}

/** Navbat boshlanishlari (birinchi 1-2 so'z) chastotasi. */
export function openerCounts(texts: readonly string[], take = 2): Array<{ opener: string; count: number }> {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const ws = words(normalizeText(toLatin(text))).slice(0, take);
    if (ws.length === 0) continue;
    const key = ws.join(' ');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([opener, count]) => ({ opener, count }))
    .sort((a, b) => b.count - a.count || a.opener.localeCompare(b.opener));
}

/**
 * Ustma-ust gapirish: keyingi segment oldingisi tugamasdan (`toleranceSec`
 * dan ko'proq) boshlangan va so'zlovchi boshqa. Vaqt belgisi bo'lmasa `null`.
 */
export function countOverlaps(segments: readonly Segment[], toleranceSec = 0.2): number | null {
  const timed = segments.filter((s) => s.start !== undefined && s.end !== undefined);
  if (timed.length < 2) return null;
  let overlaps = 0;
  for (let i = 1; i < timed.length; i += 1) {
    const prev = timed[i - 1] as Segment;
    const curr = timed[i] as Segment;
    if (prev.speaker !== curr.speaker && (curr.start as number) < (prev.end as number) - toleranceSec) overlaps += 1;
  }
  return overlaps;
}

/**
 * Hisobotga (tashqariga ulashiladigan fayl) qo'yish mumkin bo'lgan misol:
 * qisqa, `[RAQAM]` va raqamsiz, gap o'rtasida bosh harfli so'z yo'q
 * (ism bo'lishi mumkin).
 */
export function isShareableExample(text: string, maxWords = 12): boolean {
  if (text.includes(REDACTED) || /\d/.test(text)) return false;
  const ws = text.trim().split(/\s+/);
  if (ws.length === 0 || ws.length > maxWords) return false;
  return !ws.slice(1).some((w) => /^[A-ZА-ЯЎҚҒҲ][a-zа-яўқғҳ'ʻ‘’]+/u.test(w));
}

/** Toifa -> soni + verbatim misollar (low_quality belgisi bilan). */
export interface CategoryTable {
  [category: string]: { count: number; examples: Array<{ text: string; lowQuality: boolean; callId: string }> };
}

export function addToTable(
  table: CategoryTable,
  category: string,
  example: { text: string; lowQuality: boolean; callId: string },
  maxExamples = 5,
): void {
  const row = table[category] ?? { count: 0, examples: [] };
  row.count += 1;
  if (row.examples.length < maxExamples && !row.examples.some((e) => e.text === example.text)) {
    row.examples.push(example);
  }
  table[category] = row;
}
