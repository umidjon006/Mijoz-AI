/**
 * Matnni OVOZGA tayyorlash. Provayderga bog'liq emas.
 *
 * Nega kerak: TTS "700 000" ni ba'zan "yetti nol nol nol" deb o'qiydi yoki
 * umuman o'tkazib yuboradi, `*` va `#` kabi belgilarni esa ovoz chiqarib
 * o'qiydi. Shuning uchun mijoz javobi TTS'ga BERILISHIDAN OLDIN shu
 * funksiyadan o'tadi.
 *
 * DIQQAT: bu funksiya faqat OVOZ uchun ishlatiladi. `training_turn` ga
 * MODELNING ASL matni yoziladi (transkript va baholash o'zgarmaydi).
 *
 * Tarix: raqam -> so'z mantiqi `harness/src/voice/numbers.ts` da Phase A
 * uchun yozilgan edi (faqat WER hisobi uchun). Endi u modul ichida va
 * to'liq sinaladi (`verify-training-voice.ts`).
 */
import type { VoiceLang } from './ports.js';

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

/** Shu uzunlikdan boshlab ajratuvchisiz raqam ketma-ketligi raqam-raqam o'qiladi. */
const DIGIT_BY_DIGIT_FROM = 10;

/** 0..999 oralig'i. */
function underThousand(value: number): string[] {
  const out: string[] = [];
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;

  if (hundreds > 0) {
    // "bir yuz" emas, shunchaki "yuz".
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
      // "bir ming" emas, shunchaki "ming".
      if (!(count === 1 && scale === 1_000)) out.push(...underThousand(count));
      out.push(name);
      rest %= scale;
    }
  }
  if (rest > 0) out.push(...underThousand(rest));

  return out.join(' ');
}

/** Har bir raqamni alohida o'qiydi: telefon, karta, hisob raqami. */
export function digitsOneByOne(digits: string): string {
  return [...digits.replace(/\D/g, '')].map((d) => ONES[Number(d)] as string).join(' ');
}

/**
 * Telefon ko'rinishidagi bo'lakmi?
 *
 * Shart: `+` bilan boshlanadi YOKI birinchisidan keyin AYNAN ikki xonali
 * bo'lak bor (o'zbekcha yozuvda `90 123 45 67`). Shu shart bo'lmasa
 * `120 000 000` kabi son telefon deb o'qilib ketardi.
 */
function looksLikePhone(match: string): boolean {
  const digits = match.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return false;
  if (match.trimStart().startsWith('+')) return true;
  const parts = match.replace(/^\+/, '').trim().split(/[\s-]+/);
  return parts.slice(1).some((part) => part.length === 2);
}

/**
 * Ovoz uchun tozalash: TTS o'qib yuboradigan belgilar olib tashlanadi.
 * Modelga allaqachon "markdown ishlatma" deyilgan, lekin bu — oxirgi himoya.
 */
function stripForSpeech(text: string): string {
  return (
    text
      // markdown urg'ulari
      .replace(/[*_`#]+/g, ' ')
      // emoji va boshqa belgilar (harf, raqam, tinish belgisi va bo'shliqdan boshqasi)
      .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
  );
}

/**
 * Matndagi raqamlarni o'zbek so'zlariga aylantiradi.
 *
 * Tartib MUHIM: foiz -> telefon -> uch xonali bo'laklar -> qolgan sonlar.
 * Aks holda `120 000 000` telefon deb, `90 123 45 67` esa son deb o'qiladi.
 */
export function digitsToUzbekWords(input: string): string {
  let text = input;

  // 1. Foiz: "10%" / "10 %"
  text = text.replace(
    /(\d+)\s*%/g,
    (_m, digits: string) => `${numberToUzbekWords(Number(digits))} foiz`,
  );

  // 2. Telefon ko'rinishidagi bo'laklar (faqat `looksLikePhone` bo'lsa).
  text = text.replace(/\+?\d{2,4}(?:[\s-]\d{2,4}){2,}/g, (match) =>
    looksLikePhone(match) ? digitsOneByOne(match) : match,
  );

  // 3. Bo'shliq/nuqta/vergul bilan ajratilgan uch xonali bo'laklar:
  //    "1 200 000", "1.200.000", "1,200,000".
  text = text.replace(/\b\d{1,3}(?:[\s.,]\d{3})+\b/g, (match) =>
    numberToUzbekWords(Number(match.replace(/[^\d]/g, ''))),
  );

  // 4. Qolgan sonlar. Juda uzun ketma-ketlik (karta/hisob) raqam-raqam.
  text = text.replace(/\d+/g, (match) =>
    match.length >= DIGIT_BY_DIGIT_FROM
      ? digitsOneByOne(match)
      : numberToUzbekWords(Number(match)),
  );

  return text;
}

/**
 * Mijoz javobini ovozga beradigan ko'rinishga keltiradi.
 *
 * `uz` va `mixed` — raqamlar o'zbek so'zlariga aylanadi.
 * `ru` — raqamlar TEGILMAYDI: ruscha son so'zlari hali yozilmagan, noto'g'ri
 * o'girishdan ko'ra provayderning o'ziga qoldirish yaxshi (TTS ruscha
 * raqamni odatda to'g'ri o'qiydi).
 */
export function normalizeForSpeech(text: string, lang: VoiceLang): string {
  const cleaned = stripForSpeech(text);
  if (lang === 'ru') return cleaned;
  return stripForSpeech(digitsToUzbekWords(cleaned));
}
