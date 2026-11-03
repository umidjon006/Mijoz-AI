/**
 * Yozuv (alifbo) tekshiruvi: o'zbek (lotin) matni ichida kirill va boshqa
 * lotin bo'lmagan harflar.
 *
 * NEGA KODDA: model ba'zan o'zbek lotin matni ichiga kirill yoki hatto
 * mo'g'ul so'zlarini qo'shib yuboradi. Promptdagi "Latin script" talabi
 * buni kafolatlamaydi — shuning uchun foydalanuvchiga ko'rinadigan har bir
 * LLM matni (mijoz javobi va debrief) til `uz` bo'lganda mexanik tekshiriladi.
 *
 * Ruxsat: lotin harflari (diakritik bilan ham), raqamlar, tinish belgilari
 * va "Common" yozuvidagi belgilar — jumladan o'zbekcha `ʻ` (U+02BB) va `ʼ`.
 * Taqiq: qolgan hamma HARFLAR (kirill, yunon, arab, mo'g'ul, CJK ...).
 */

/** Harf, lekin lotin/umumiy/meros yozuvida emas. */
const NON_LATIN_LETTER = /[^\P{L}\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

/**
 * Matndagi lotin bo'lmagan harfli so'zlar (takrorlanmasdan, ko'pi bilan
 * `limit` ta). Bo'sh massiv — matn toza.
 */
export function nonLatinWords(text: string, limit = 5): string[] {
  const found: string[] = [];
  for (const word of text.split(/\s+/)) {
    if (!NON_LATIN_LETTER.test(word)) continue;
    const clean = word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    if (clean && !found.includes(clean)) found.push(clean);
    if (found.length >= limit) break;
  }
  return found;
}

export interface ScriptViolation {
  /** Qaysi maydon: `reply`, `coaching.summary`, `criteria.need_discovery.comment` ... */
  field: string;
  words: string[];
}

/** Bir nechta maydonni tekshiradi; faqat buzilganlarini qaytaradi. */
export function findScriptViolations(
  fields: ReadonlyArray<{ field: string; text: string | null | undefined }>,
): ScriptViolation[] {
  const out: ScriptViolation[] = [];
  for (const { field, text } of fields) {
    if (!text) continue;
    const words = nonLatinWords(text);
    if (words.length > 0) out.push({ field, words });
  }
  return out;
}

/** Modelga yuboriladigan tuzatish izohi (ingliz tilida, qolgan ko'rsatmalar kabi). */
export function scriptCorrectionNote(violations: readonly ScriptViolation[]): string {
  const sample = violations
    .slice(0, 6)
    .map((v) => `- ${v.field}: ${v.words.map((w) => `"${w}"`).join(', ')}`)
    .join('\n');
  return [
    'Your previous answer mixed scripts: the text must be Uzbek in LATIN script only.',
    'These fields contained Cyrillic or other non-Latin letters:',
    sample,
    'Rewrite every such word in Uzbek Latin (o‘, g‘, sh, ch, ng). Do not use Russian, Mongolian or any other language.',
    'Never write Uzbek in Cyrillic either: "so\'radi", not "сўради"; "yaxshi", not "хорошо".',
    'Evidence quotes are the only exception: they must stay exactly as in the transcript.',
  ].join('\n');
}

/**
 * Mijoz javobi qayta urinishdan keyin ham begona tilda qolsa — o'rniga
 * aytiladigan neytral gap (suhbat to'xtamaydi, ovozda ham tabiiy eshitiladi).
 */
export const CUSTOMER_LANGUAGE_FALLBACK = 'Kechirasiz, tushunmadim. Yana bir bor aytib bera olasizmi?';

// ---------------------------------------------------------------------------
// Maydon tasnifi: lotin / o'zbek kirill / boshqa til
// ---------------------------------------------------------------------------

/**
 * Foydalanuvchi BIROR joyda ko'rmasligi kerak bo'lgan matn o'rniga
 * ko'rsatiladigan yozuv (til `uz`, qayta yaratish ham yordam bermaganda).
 */
export const LANGUAGE_PLACEHOLDER = "Bu qism to'g'ri tilda yaratilmadi";

/**
 * - `latin`       — lotin o'zbekcha (yoki umuman harf yo'q): joyida;
 * - `uz_cyrillic` — o'zbek kirill alifbosi: kodda lotinga o'giriladi;
 * - `foreign`     — boshqa til yoki aralash begona so'zlar (mo'g'ul, rus...):
 *                   LLM bilan qayta yaratiladi, bo'lmasa yashiriladi.
 */
export type UzTextClass = 'latin' | 'uz_cyrillic' | 'foreign';

/** O'zbek kirill alifbosi (kichik harflar). Rus `щ`, `ы` va mo'g'ul `ө`, `ү` YO'Q. */
const UZ_CYRILLIC_LETTERS = new Set([...'абвгдеёжзийклмнопрстуфхцчшъьэюяўқғҳ']);
const UZ_SPECIFIC_LETTERS = /[ўқғҳЎҚҒҲ]/u;
const CYRILLIC = /\p{Script=Cyrillic}/u;

/** Faqat rus (yoki mo'g'ul) tilida uchraydigan ko'p ishlatiladigan so'zlar. */
const FOREIGN_CYRILLIC_WORDS = new Set([
  // rus
  'и', 'в', 'не', 'на', 'что', 'это', 'как', 'но', 'по', 'для', 'же', 'очень', 'хорошо',
  'плохо', 'да', 'нет', 'вы', 'он', 'она', 'они', 'мы', 'я', 'с', 'к', 'от', 'за', 'из',
  'так', 'уже', 'еще', 'ещё', 'было', 'был', 'была', 'если', 'когда', 'чтобы', 'потому',
  'который', 'которая', 'можно', 'нужно', 'надо', 'клиент', 'клиента', 'продавец', 'цена',
  'сделка', 'вопрос', 'ответ', 'хотя', 'также', 'тоже', 'только', 'всё', 'все', 'или',
  // mo'g'ul (umumiy alifbodagi harflar bilan yoziladigan)
  'ч', 'бол', 'болон', 'байна', 'байсан', 'гэж', 'гэсэн', 'энэ', 'тэр', 'санал', 'харин',
  'хариулсан', 'болгосноор', 'хэрэглэгч', 'үйлчлүүлэгч',
]);

/** O'zbekcha ekanini ko'rsatadigan ko'p ishlatiladigan kirill so'zlar. */
const UZ_CYRILLIC_WORDS = new Set([
  'ва', 'бу', 'у', 'учун', 'билан', 'эмас', 'ҳам', 'сиз', 'мен', 'биз', 'бир', 'лекин',
  'жуда', 'мижоз', 'мижозни', 'мижознинг', 'сотувчи', 'нарх', 'нархни', 'яхши', 'агар',
  'шу', 'ўша', 'қилди', 'қилган', 'берди', 'деди', 'айтди', 'кейин', 'олдин', 'ҳали',
  'энди', 'бўлди', 'бўлган', 'суҳбат', 'суҳбатда', 'савол', 'жавоб', 'таклиф', 'эътироз',
  'ассалому', 'алайкум', 'салом', 'эди', 'эдим', 'керак', 'бор', 'йўқ', 'ҳа', 'менга', 'сизга',
  'қанча', 'нима', 'нега', 'қандай', 'қачон', 'майли', 'раҳмат', 'кечирасиз', 'эса', 'аниқ',
]);

const UZ_SUFFIXES = ['лар', 'ларни', 'ларга', 'нинг', 'ни', 'га', 'да', 'дан', 'ди', 'ган', 'миз', 'сиз', 'ингиз', 'моқ', 'япти', 'лик', 'ади', 'ини'];

function cyrillicWords(text: string): string[] {
  return text
    .split(/[^\p{L}ʼ']+/u)
    .map((w) => w.toLowerCase())
    .filter((w) => CYRILLIC.test(w));
}

function looksUzbekCyrillic(word: string): boolean {
  if (UZ_SPECIFIC_LETTERS.test(word) || UZ_CYRILLIC_WORDS.has(word)) return true;
  return word.length >= 4 && UZ_SUFFIXES.some((suffix) => word.endsWith(suffix));
}

/** Til `uz` uchun matn tasnifi (tushuntirish: `UzTextClass`). */
export function classifyUzText(text: string): UzTextClass {
  const letters = [...text].filter((ch) => /\p{L}/u.test(ch));
  const foreignLetters = letters.filter((ch) => NON_LATIN_LETTER.test(ch));
  if (foreignLetters.length === 0) return 'latin';

  // O'zbek kirill alifbosida YO'Q harf (ө, ү, щ, ы, yunon, arab...) — begona.
  if (foreignLetters.some((ch) => !UZ_CYRILLIC_LETTERS.has(ch.toLowerCase()))) return 'foreign';

  const words = cyrillicWords(text);
  if (words.some((w) => FOREIGN_CYRILLIC_WORDS.has(w))) return 'foreign';

  // Kirill so'zlarning kamida 30% i o'zbekcha belgiga (ў қ ғ ҳ, ko'p
  // ishlatiladigan so'z yoki qo'shimcha) ega bo'lishi kerak; aks holda
  // (masalan lotin gap ichida bitta "отлично") — begona so'z.
  const uzbek = words.filter(looksUzbekCyrillic).length;
  if (uzbek === 0 || uzbek / words.length < 0.3) return 'foreign';
  return 'uz_cyrillic';
}

// ---------------------------------------------------------------------------
// O'zbek kirill -> lotin (deterministik)
// ---------------------------------------------------------------------------
const VOWELS = new Set([...'аеёиоуэюяў']);

const SIMPLE: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k',
  л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'x', ч: 'ch', ш: 'sh', ъ: "'", ь: '', э: 'e', ё: 'yo', ю: 'yu', я: 'ya',
  ў: "o'", қ: 'q', ғ: "g'", ҳ: 'h',
};

function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && /\p{L}/u.test(ch);
}

function isUpper(ch: string | undefined): boolean {
  return ch !== undefined && ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}

/**
 * O'zbek kirill matnini lotinga o'giradi (1995 yilgi qoidalar, apostrof
 * sifatida `'`). Lotin harflar, raqamlar va tinish belgilari o'zgarmaydi.
 *  - `е` so'z boshida va unli / `ъ` / `ь` dan keyin `ye`, boshqa joyda `e`;
 *  - `ц` unlidan keyin `ts`, boshqa joyda `s`;
 *  - katta harf: `Ш` -> `Sh`, butun so'z katta bo'lsa `SH`.
 */
export function transliterateUzCyrillic(text: string): string {
  const chars = [...text];
  let out = '';
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] as string;
    const lower = ch.toLowerCase();
    const prevLower = chars[i - 1]?.toLowerCase();

    let latin: string | undefined;
    if (lower === 'е') {
      const wordStart = !isLetter(chars[i - 1]);
      const afterVowel = prevLower !== undefined && (VOWELS.has(prevLower) || prevLower === 'ъ' || prevLower === 'ь');
      latin = wordStart || afterVowel ? 'ye' : 'e';
    } else if (lower === 'ц') {
      latin = prevLower !== undefined && VOWELS.has(prevLower) ? 'ts' : 's';
    } else {
      latin = SIMPLE[lower];
    }

    if (latin === undefined) {
      out += ch;
      continue;
    }
    if (isUpper(ch) && latin.length > 0) {
      // Keyingi (yoki oldingi) harf ham katta bo'lsa — butun so'z katta: SH, YO.
      const neighbourUpper = isUpper(chars[i + 1]) || (isUpper(chars[i - 1]) && !isLetter(chars[i + 1]));
      latin = neighbourUpper ? latin.toUpperCase() : latin[0]!.toUpperCase() + latin.slice(1);
    }
    out += latin;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Maydon darajasidagi himoya
// ---------------------------------------------------------------------------
export interface EditableText {
  /** Maydon nomi: `criteria.need_discovery.comment`, `keyMoments.T4` ... */
  id: string;
  text: string;
  set(text: string): void;
}

export interface UzLatinReport {
  transliterated: string[];
  regenerated: string[];
  /** Yashirilgan (placeholder qo'yilgan) maydonlar. */
  hidden: string[];
}

/** Begona maydonlarni qayta yaratadi: `id -> yangi matn` (qaytmaganlari yashiriladi). */
export type RegenerateFields = (
  fields: ReadonlyArray<{ id: string; text: string }>,
) => Promise<ReadonlyMap<string, string>>;

/**
 * Til `uz` uchun har maydonni tekshiradi:
 *  1. `uz_cyrillic` -> lotinga o'giriladi (LLM'siz);
 *  2. `foreign` -> FAQAT shu maydonlar bitta qo'shimcha chaqiruvda qayta
 *     yaratiladi; natija yana tekshiriladi (kirill bo'lsa o'giriladi);
 *  3. baribir yaroqsiz -> `placeholder` qo'yiladi (yashiriladi).
 * Foydalanuvchi hech qachon lotin bo'lmagan matnni ko'rmaydi.
 */
export async function enforceUzLatin(
  fields: readonly EditableText[],
  regenerate: RegenerateFields,
  placeholder: string = LANGUAGE_PLACEHOLDER,
): Promise<UzLatinReport> {
  const report: UzLatinReport = { transliterated: [], regenerated: [], hidden: [] };
  const foreign: EditableText[] = [];

  for (const field of fields) {
    const kind = classifyUzText(field.text);
    if (kind === 'uz_cyrillic') {
      field.set(transliterateUzCyrillic(field.text));
      report.transliterated.push(field.id);
    } else if (kind === 'foreign') {
      foreign.push(field);
    }
  }
  if (foreign.length === 0) return report;

  let fresh: ReadonlyMap<string, string> = new Map();
  try {
    fresh = await regenerate(foreign.map((f) => ({ id: f.id, text: f.text })));
  } catch {
    // Qayta yaratish yiqildi — hammasi yashiriladi.
  }

  for (const field of foreign) {
    const candidate = fresh.get(field.id)?.trim();
    const kind = candidate ? classifyUzText(candidate) : 'foreign';
    if (candidate && kind === 'latin') {
      field.set(candidate);
      report.regenerated.push(field.id);
    } else if (candidate && kind === 'uz_cyrillic') {
      field.set(transliterateUzCyrillic(candidate));
      report.regenerated.push(field.id);
    } else {
      field.set(placeholder);
      report.hidden.push(field.id);
    }
  }
  return report;
}

/** Qayta yaratish chaqiruvi uchun qat'iy ko'rsatma (misollar bilan). */
export const UZ_LATIN_REWRITE_SYSTEM = [
  'You fix the LANGUAGE of short texts shown to an Uzbek salesperson.',
  'Each input text was supposed to be in Uzbek written in the LATIN script, but it contains',
  'Cyrillic, Mongolian, Russian or other foreign words.',
  '',
  'Rules:',
  '- Rewrite EVERY text fully in Uzbek, LATIN script only (letters a-z, o‘, g‘, sh, ch, ng, \').',
  '- Keep the meaning, keep it short, keep any numbers. Translate foreign words; do not transliterate them.',
  '- Never output a single Cyrillic letter (no а, б, ў, қ, ө, ү ...).',
  '- Return the same ids you received.',
  '',
  'Examples:',
  '- "Mijoz нархни сўради" -> "Mijoz narxni so\'radi"',
  '- "Suhbat хорошо o\'tdi" -> "Suhbat yaxshi o\'tdi"',
  '- "санал болгосноор хариулсан ч нотлоогүй" -> "Taklif bilan javob berdi, lekin uni isbotlamadi"',
  '',
  'Return JSON only: {"fields":[{"id":string,"text":string}]}',
].join('\n');

// ---------------------------------------------------------------------------
// STT natijasi (uz): sotuvchi nima deganini tanigan matn
// ---------------------------------------------------------------------------

/** O'zbek lotin alifbosida YO'Q, lekin turk/ozarbayjon/turkman/qozoq lotinida bor harflar. */
const TURKIC_LATIN_STRONG = /[şğıəŞĞİƏñÑäÄ]/u;
const TURKIC_LATIN_WEAK = /[çöüÇÖÜ]/gu;
const ENGLISH_STOPWORDS = new Set([
  'the', 'and', 'you', 'your', 'that', 'this', 'with', 'for', 'are', 'is', 'what',
  'how', 'much', 'does', 'have', 'can', 'will', 'hello', 'please', 'course', 'price',
]);

/**
 * STT tanigan matn tili (`uz` sessiya uchun):
 *  - `latin`       — o'zbek lotin: joyida;
 *  - `uz_cyrillic` — o'zbek kirill: deterministik lotinga o'giriladi;
 *  - `foreign`     — aniq boshqa til (qozoq/rus kirill, turk lotin, ingliz):
 *                    ishonchsiz — "eshitolmadim, takrorlaysizmi" yo'li.
 */
export function classifyHeardUzText(text: string): UzTextClass {
  const base = classifyUzText(text);
  if (base !== 'latin') return base;
  if (TURKIC_LATIN_STRONG.test(text)) return 'foreign';
  if ((text.match(TURKIC_LATIN_WEAK) ?? []).length >= 2) return 'foreign';
  const words = text.toLowerCase().split(/[^a-z']+/).filter((w) => w.length > 1);
  const english = words.filter((w) => ENGLISH_STOPWORDS.has(w)).length;
  if (words.length >= 3 && english / words.length >= 0.3) return 'foreign';
  return 'latin';
}

// ---------------------------------------------------------------------------
// Mijoz javobi (uz)
// ---------------------------------------------------------------------------
export type CustomerReplyOutcome = 'ok' | 'transliterated' | 'regenerated' | 'fallback';

/**
 * Mijoz javobi tili: lotin — joyida; o'zbek kirill — o'giriladi (LLM'siz);
 * begona — `retry()` bilan BIR marta qayta; yana begona (yoki retry yiqilsa)
 * — `CUSTOMER_LANGUAGE_FALLBACK`. `stateSource` — holat qaysi javobdan
 * olinishi kerak (qayta urinish muvaffaqiyatli bo'lsa — yangisidan).
 */
export async function guardCustomerReply<T extends { reply: string }>(
  result: T,
  retry: () => Promise<T>,
): Promise<{ result: T; stateSource: T; outcome: CustomerReplyOutcome }> {
  const kind = classifyUzText(result.reply);
  if (kind === 'latin') return { result, stateSource: result, outcome: 'ok' };
  if (kind === 'uz_cyrillic') {
    return {
      result: { ...result, reply: transliterateUzCyrillic(result.reply) },
      stateSource: result,
      outcome: 'transliterated',
    };
  }
  try {
    const retried = await retry();
    const retryKind = classifyUzText(retried.reply);
    if (retryKind === 'latin') return { result: retried, stateSource: retried, outcome: 'regenerated' };
    if (retryKind === 'uz_cyrillic') {
      return {
        result: { ...retried, reply: transliterateUzCyrillic(retried.reply) },
        stateSource: retried,
        outcome: 'regenerated',
      };
    }
  } catch {
    // Qayta urinish yiqildi — neytral gap.
  }
  return {
    result: { ...result, reply: CUSTOMER_LANGUAGE_FALLBACK },
    stateSource: result,
    outcome: 'fallback',
  };
}
