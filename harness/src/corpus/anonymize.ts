/**
 * FAQAT HARNESS (korpus). Shaxsiy raqamlarni yashirish — SOF funksiya.
 *
 * Telefon raqamlari, e-pochta, pasport/ID ko'rinishidagi kodlar, karta
 * raqamlari va uzun raqam qatorlari `[RAQAM]` bilan almashtiriladi.
 * NARXLAR saqlanadi ("1 200 000 so'm", "700 ming") — mijoz tahlili uchun kerak.
 */
export const REDACTED = '[RAQAM]';

const PATTERNS: RegExp[] = [
  // e-pochta
  /[\p{L}\d._%+-]+@[\p{L}\d.-]+\.[\p{L}]{2,}/gu,
  // +998 xx xxx xx xx (ajratgichlar bilan yoki usiz)
  /\+?\s?998[\s-]?\(?\d{2}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g,
  // karta: 4-4-4-4
  /\b\d{4}[\s-]\d{4}[\s-]\d{4}[\s-]\d{4}\b/g,
  // mahalliy telefon: xx xxx xx xx / (xx) xxx-xx-xx
  /\(?\b\d{2}\)?[\s-]\d{3}[\s-]\d{2}[\s-]\d{2}\b/g,
  // pasport / ID: AA1234567, AB 1234567
  /\b[A-Z]{2}\s?\d{7}\b/g,
];

/** Ajratgichsiz uzun raqam (>= 7 xona), ortidan valyuta so'zi KELMASA. */
const LONG_DIGITS = /\b\d{7,}\b(?!\s*(?:so['ʻ‘’`]?m|sum|сум|ming|mln|million|dollar|\$))/giu;

export function anonymize(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(LONG_DIGITS, REDACTED);
  return out;
}
