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
    'Evidence quotes are the only exception: they must stay exactly as in the transcript.',
  ].join('\n');
}
