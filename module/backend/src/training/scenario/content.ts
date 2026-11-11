/**
 * Kontent chegaralari — KODDA tekshiriladi (prompt ham aytadi, lekin model
 * xato qilsa shu yerda ushlanadi). Ro'yxatlar `content-rules.ts` da.
 */
import { LlmCallError } from '../errors.js';
import { normalizeUz } from './address.js';
import { BLOCKLIST, HANGUP_WARNING_CUES, INSULT_WHITELIST, PERSONAL_ATTACK_PATTERNS } from './content-rules.js';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Taqiqlangan atamalar (so'z boshi bo'yicha). */
export function findBlocked(text: string, list: readonly string[] = BLOCKLIST): string[] {
  const t = normalizeUz(text);
  const hits: string[] = [];
  for (const term of list) {
    const re = new RegExp(`(?:^|[^\\p{L}'])${escapeRe(normalizeUz(term))}`, 'u');
    if (re.test(t)) hits.push(term);
  }
  return hits;
}

/** Sotuvchining jinsi/yoshiga qaratilgan haqorat ("sen qizni", "bolakay" ...). */
export function findPersonalAttacks(text: string, patterns: readonly string[] = PERSONAL_ATTACK_PATTERNS): string[] {
  const t = normalizeUz(text);
  const hits: string[] = [];
  for (const p of patterns) {
    const m = new RegExp(p, 'u').exec(t);
    if (m) hits.push(m[0]);
  }
  return hits;
}

/** Javobda go'shak haqida ochiq ogohlantirish bormi. */
export function hasHangupWarning(text: string): boolean {
  const t = normalizeUz(text);
  return HANGUP_WARNING_CUES.some((c) => t.includes(c));
}

const stripPunct = (s: string): string => normalizeUz(s).replace(/[?!.,]/g, '').replace(/\s+/g, ' ').trim();

/** Javobdagi oq ro'yxat haqoratlari (tinish belgilarisiz moslash). */
export function findWhitelistedInsults(text: string, list: readonly string[] = INSULT_WHITELIST): string[] {
  const t = ` ${stripPunct(text)} `;
  return list.filter((p) => t.includes(` ${stripPunct(p)} `) || t.includes(` ${stripPunct(p)}`));
}

/** Model "haqorat" deb belgilagan ibora oq ro'yxatdami. */
export function isWhitelistedInsult(phrase: string, list: readonly string[] = INSULT_WHITELIST): boolean {
  const p = stripPunct(phrase);
  return p.length > 0 && list.some((w) => stripPunct(w) === p || p.includes(stripPunct(w)));
}

// ---------------------------------------------------------------------------
// "siz" / "sen" — TAXMINIY aniqlash (olmosh va fe'l qo'shimchalari)
// ---------------------------------------------------------------------------
const SEN_PRONOUN = /(?:^|[^\p{L}'])(sen|senga|seni|sening|sendan|senda|senam|o'zing|o'zingni)(?![\p{L}'])/u;
const SEN_VERB = /\p{L}{2,}(?:san|sanmi|sanku|ding|dingmi)(?![\p{L}'])/u;
const SIZ_FORM = /(?:^|[^\p{L}'])(siz|sizga|sizni|sizning|sizdan|sizda)(?![\p{L}'])|\p{L}{2,}(?:siz|sizmi|siz-u|dingiz|ingiz|ingizni)(?![\p{L}'])/u;

export type Formality = 'siz' | 'sen';

/**
 * Javobda qaysi forma ishlatilgan (taxminiy). `sen` olmoshi — aniq belgi;
 * fe'l qo'shimchasi (-san, -ding) — kuchsizroq. Ikkisi ham bo'lmasa — `null`.
 */
export function detectFormality(text: string): { form: Formality | null; strongSen: boolean } {
  const t = normalizeUz(text);
  const strongSen = SEN_PRONOUN.test(t);
  if (strongSen) return { form: 'sen', strongSen };
  if (SIZ_FORM.test(t)) return { form: 'siz', strongSen: false };
  if (SEN_VERB.test(t)) return { form: 'sen', strongSen: false };
  return { form: null, strongSen: false };
}

// ---------------------------------------------------------------------------
// Provayder xavfsizlik bloki (Gemini: HTTP 400, error.code "safety")
// ---------------------------------------------------------------------------
const SAFETY_RE = /\bsafety\b|blocked due to|prohibited_content|\bblocklist\b|harm_category|content[_ ]filter/i;

export function isSafetyBlock(err: unknown): boolean {
  if (!(err instanceof LlmCallError)) return false;
  if (err.kind !== 'http' || err.status !== 400) return false;
  return SAFETY_RE.test(`${err.providerMessage ?? ''} ${err.message}`);
}
