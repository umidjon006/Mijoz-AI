/**
 * FAQAT HARNESS (Phase A). Raqamlarni o'zbek so'zlariga aylantirish.
 *
 * Phase A da faqat WER/CER ni adolatli hisoblash uchun kerak: odam
 * "1 200 000" ni "bir million ikki yuz ming" deb o'qiydi, STT esa raqam
 * bilan yozishi mumkin.
 *
 * Phase B da shu mantiq `module/.../voice/speech-text.ts` ga ko'chiriladi va
 * to'liq test qilinadi (0..999 999 999). Hozircha bu yerda — modul ichiga
 * sinalmagan kod kirmasligi uchun.
 */

const ONES = ['nol', 'bir', 'ikki', 'uch', "to'rt", 'besh', 'olti', 'yetti', 'sakkiz', "to'qqiz"];
const TENS = [
  '',
  "o'n",
  'yigirma',
  "o'ttiz",
  'qirq',
  'ellik',
  'oltmish',
  'yetmish',
  'sakson',
  "to'qson",
];

const SCALES: Array<[number, string]> = [
  [1_000_000_000, 'milliard'],
  [1_000_000, 'million'],
  [1_000, 'ming'],
];

/** 0..999 oralig'i. */
function underThousand(value: number): string[] {
  const out: string[] = [];
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;

  if (hundreds > 0) {
    if (hundreds > 1) out.push(ONES[hundreds] as string);
    out.push('yuz');
  }
  const tens = Math.floor(rest / 10);
  const ones = rest % 10;
  if (tens > 0) out.push(TENS[tens] as string);
  if (ones > 0) out.push(ONES[ones] as string);

  return out;
}

/** Butun sonni o'zbek so'zlariga aylantiradi (0 .. 999 999 999 999). */
export function numberToUzbekWords(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value < 0) return `minus ${numberToUzbekWords(-value)}`;
  const int = Math.trunc(value);
  if (int === 0) return ONES[0] as string;

  const out: string[] = [];
  let rest = int;

  for (const [scale, name] of SCALES) {
    const count = Math.floor(rest / scale);
    if (count > 0) {
      // "bir ming" emas, shunchaki "ming" deyiladi
      if (!(count === 1 && scale === 1_000)) out.push(...underThousand(count));
      out.push(name);
      rest %= scale;
    }
  }
  if (rest > 0) out.push(...underThousand(rest));

  return out.join(' ');
}

/**
 * Matndagi raqamlarni so'zlarga aylantiradi.
 *
 * - `1 200 000` / `1200000` / `1.200.000` -> "bir million ikki yuz ming"
 * - telefon ko'rinishidagi guruhlar (`90 123 45 67`) raqam-raqam o'qiladi;
 * - `10%` -> "o'n foiz".
 */
export function digitsToUzbekWords(input: string): string {
  let text = input;

  // Foiz
  text = text.replace(/(\d+)\s*%/g, (_m, digits: string) => `${numberToUzbekWords(Number(digits))} foiz`);

  // Telefon ko'rinishidagi ketma-ketlik: 3+ guruh raqam, umumiy uzunligi >= 7
  text = text.replace(/\b(\d{2,4}(?:[\s-]\d{2,4}){2,})\b/g, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 7) return match;
    return [...digits].map((d) => ONES[Number(d)] as string).join(' ');
  });

  // Bo'shliq/nuqta bilan ajratilgan uch xonali guruhlar: 1 200 000 yoki 1.200.000
  text = text.replace(/\b(\d{1,3}(?:[\s.]\d{3})+)\b/g, (match) => {
    const digits = match.replace(/[^\d]/g, '');
    return numberToUzbekWords(Number(digits));
  });

  // Qolgan oddiy sonlar
  text = text.replace(/\b\d+\b/g, (match) => numberToUzbekWords(Number(match)));

  return text;
}
