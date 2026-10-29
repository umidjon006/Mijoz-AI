/**
 * FAQAT HARNESS. Til kodlarini provayder locale'iga o'girish va lotin->kirill
 * transliteratsiya (TTS qaysi yozuvni yaxshi o'qishini benchmark aniqlaydi).
 */
import type { VoiceLang } from '../../../module/backend/src/training/voice/ports.js';

/**
 * Azure ham, Google ham BCP-47 locale kutadi.
 * `mixed` uchun alohida locale yo'q — o'zbekcha locale ishlatiladi
 * (ruscha so'zlar o'zbek tanib olishida qanday chiqishini benchmark ko'rsatadi).
 */
export const LOCALE: Record<VoiceLang, string> = {
  uz: 'uz-UZ',
  ru: 'ru-RU',
  mixed: 'uz-UZ',
};

/** Benchmark'da sinaladigan yozuvlar. */
export type Script = 'latin' | 'cyrillic';

/**
 * O'zbek lotin -> kirill. To'liq lingvistik aniqlik emas, TTS sinovi uchun
 * yetarli darajada. Uzun birikmalar oldin keladi (sh, ch, o', g', ng).
 */
const LATIN_TO_CYRILLIC: Array<[string, string]> = [
  ["sh", 'ш'],
  ["ch", 'ч'],
  ["ng", 'нг'],
  ["yo", 'ё'],
  ["yu", 'ю'],
  ["ya", 'я'],
  ["ye", 'е'],
  ["o'", 'ў'],
  ["g'", 'ғ'],
  ['a', 'а'],
  ['b', 'б'],
  ['d', 'д'],
  ['e', 'е'],
  ['f', 'ф'],
  ['g', 'г'],
  ['h', 'ҳ'],
  ['i', 'и'],
  ['j', 'ж'],
  ['k', 'к'],
  ['l', 'л'],
  ['m', 'м'],
  ['n', 'н'],
  ['o', 'о'],
  ['p', 'п'],
  ['q', 'қ'],
  ['r', 'р'],
  ['s', 'с'],
  ['t', 'т'],
  ['u', 'у'],
  ['v', 'в'],
  ['x', 'х'],
  ['y', 'й'],
  ['z', 'з'],
  ["‘", ''],
  ["'", 'ъ'],
];

/** Apostroflarni bitta ko'rinishga keltiradi (`'`, `ʻ`, `‘`, `’`, `` ` ``). */
export function unifyApostrophes(text: string): string {
  return text.replace(/[ʻʼ‘’`´]/g, "'");
}

export function latinToCyrillic(input: string): string {
  const text = unifyApostrophes(input).toLowerCase();
  let out = '';
  let i = 0;

  while (i < text.length) {
    let matched = false;
    for (const [from, to] of LATIN_TO_CYRILLIC) {
      if (text.startsWith(from, i)) {
        out += to;
        i += from.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += text[i];
      i += 1;
    }
  }

  // Gap boshidagi harfni katta qilamiz (TTS intonatsiyasi uchun ahamiyatsiz,
  // lekin listen.html da o'qish qulay bo'ladi).
  return out.replace(/(^|[.!?]\s+)(\p{L})/gu, (_m, p1: string, p2: string) => p1 + p2.toUpperCase());
}

export function applyScript(text: string, script: Script): string {
  return script === 'cyrillic' ? latinToCyrillic(text) : text;
}
