/**
 * O'zbekcha murojaat shakllari: mijoz (yosh/jins) -> sotuvchi (yosh/jins).
 * So'z ro'yxatlari `content-rules.ts` da (tahrirlanadi).
 *
 * Post-check: ayol sotuvchiga erkak shakli ("uka", "o'g'lim"...) yoki
 * aksincha — MUROJAAT (vokativ) sifatida ishlatilganini topadi. Uchinchi
 * shaxs haqida gap ("akam kasal", "o'g'lim maktabda") murojaat emas:
 * faqat vergul / gap chegarasi yonidagi shakl hisoblanadi.
 */
import {
  ADDRESS_AGE_RULES,
  ADDRESS_TABLE,
  FEMALE_ADDRESS_FORMS,
  MALE_ADDRESS_FORMS,
} from './content-rules.js';
import type { SellerProfile } from './schema.js';

export type AddressCase = keyof typeof ADDRESS_TABLE;

export interface AddressRule {
  case: AddressCase;
  /** Shu sessiyada ishlatiladigan shakllar. */
  allowed: readonly string[];
  /** Shu sotuvchiga HECH QACHON aytilmaydigan shakllar (boshqa jinsniki). */
  forbidden: readonly string[];
}

export function addressCase(customerAge: number, seller: Pick<SellerProfile, 'age'>): AddressCase {
  const gap = customerAge - seller.age;
  if (customerAge < ADDRESS_AGE_RULES.minorAge) return 'younger';
  if (customerAge >= 55 && gap >= ADDRESS_AGE_RULES.elderGap) return 'elder';
  if (gap >= ADDRESS_AGE_RULES.olderGap) return 'older';
  if (gap <= -ADDRESS_AGE_RULES.olderGap) return 'younger';
  return 'peer';
}

export function addressRule(customerAge: number, seller: Pick<SellerProfile, 'age' | 'gender'>): AddressRule {
  const c = addressCase(customerAge, seller);
  return {
    case: c,
    allowed: ADDRESS_TABLE[c][seller.gender],
    forbidden: seller.gender === 'female' ? MALE_ADDRESS_FORMS : FEMALE_ADDRESS_FORMS,
  };
}

const APOS = /[ʻʼ’‘`´]/g;

export function normalizeUz(text: string): string {
  return text.toLowerCase().replace(APOS, "'");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Murojaat ham, "mening o'g'lim/qizim/ukam" ham bo'la oladigan so'zlar. */
const AMBIGUOUS_KIN = new Set(["o'g'lim", "o'g'ilim", 'qizim', 'ukam', 'akam', 'opam', 'singlim']);

/** Ikkinchi shaxsga qaratilgan gap belgilari (siz/sen, -siz, -dingiz, -san, buyruq -ng). */
const SECOND_PERSON =
  /(?:^|[^\p{L}'])(?:siz|sen|sizga|senga|sizni|seni|sizning|sening|sizdan|sendan)(?![\p{L}'])|\p{L}+(?:sizmi|siz|dingizmi|dingiz|ingiz|sanmi|san|dingmi|ding)(?![\p{L}'])|\p{L}+(?<!ni|u|me|biz|lar)ng(?:chi|-chi)?(?![\p{L}'])/u;

/**
 * Javobda sotuvchiga NOTO'G'RI jinsdagi murojaat bormi. Faqat murojaat
 * (vokativ) holati:
 *  - gap oxirida / o'rtasida vergul bilan: "Rahmat, uka." / "Bilasizmi, uka, ...";
 *  - gap boshida: "Uka, ..." — lekin "o'g'lim/qizim/ukam" kabi so'zlar faqat
 *    gapning davomi sotuvchiga qaratilgan bo'lsa ("O'g'lim, tushundingizmi?").
 *    "O'g'lim, maktabda yaxshi o'qiydi" — mijozning O'Z farzandi haqida, murojaat emas.
 */
export function findWrongAddress(reply: string, rule: Pick<AddressRule, 'forbidden'>): string[] {
  const t = normalizeUz(reply).trim();
  const hits: string[] = [];
  for (const form of rule.forbidden) {
    const f = `(?:(?:hoy|ey|voy)\\s+)?${escapeRe(form)}(?:jon)?`;
    const end = new RegExp(`[,—-]\\s*${f}\\s*(?=[.!?]|$)`, 'u');
    const mid = new RegExp(`,\\s*${f}\\s*,`, 'u');
    const alone = new RegExp(`(?:^|[.!?]\\s+)${f}\\s*(?=[.!?]|$)`, 'u');
    const start = new RegExp(`(?:^|[.!?]\\s+)${f}\\s*,\\s*([^.!?]*)`, 'u');
    let hit = end.test(t) || mid.test(t) || alone.test(t);
    if (!hit) {
      const m = start.exec(t);
      if (m) hit = !AMBIGUOUS_KIN.has(form) || SECOND_PERSON.test(m[1] ?? '');
    }
    if (hit) hits.push(form);
  }
  // "ukajon" = "uka" + "jon" — bitta murojaat sifatida qaytaramiz.
  const uniq = [...new Set(hits)];
  return uniq.filter((h) => !(h.endsWith('jon') && uniq.includes(h.slice(0, -3))));
}

/** Prompt uchun bir qator: kimga qanday murojaat qilish. */
export function addressPromptLines(customerAge: number, seller: SellerProfile): string[] {
  const rule = addressRule(customerAge, seller);
  const sellerWord = seller.gender === 'female' ? 'a WOMAN' : 'a MAN';
  return [
    `The seller is ${sellerWord}, about ${seller.age} years old, named ${seller.name}. Gender is given, never guess it.`,
    `Address the seller ONLY as: ${rule.allowed.map((a) => `"${a}"`).join(', ')}, or by name, or with no address word.`,
    `NEVER call the seller: ${rule.forbidden.slice(0, 8).map((a) => `"${a}"`).join(', ')} (wrong gender).`,
  ];
}
