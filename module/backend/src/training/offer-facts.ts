/**
 * Taklif faktlari va mijoz "biladigan" narsalar.
 *
 * Haqiqiy mijoz taklifning NARXI, MUDDATI, JADVALI va SHARTLARINI oldindan
 * bilmaydi. Persona-card'dagi `focusOffer` esa profildagi to'liq satr
 * (masalan "X: 6 oy, oyiga 700 000 so'm") — u faqat BAHOLASH uchun. Mijoz
 * promptiga faqat mavzu (nomi) beriladi: `offerTopic`.
 *
 * `extractPriceFigures` — matndagi pul miqdorlari (bake-off/smoke o'lchovi va
 * persona tekshiruvi uchun): mijoz sotuvchi aytmagan narxni aytdimi?
 *
 * Soha so'zlari yo'q: hamma qoida raqam va tinish belgilariga tayanadi.
 */

/**
 * Taklif satridan faqat mavzu (nomi): `:` / ` — ` / ` - ` / `,` gacha bo'lgan
 * qism; qolgan raqamli bo'laklar olib tashlanadi.
 */
export function offerTopic(offer: string): string {
  const text = offer.trim();
  // "Nom — Qism: shartlar" — `:` dan oldingi qism raqamsiz bo'lsa, u to'liq nom.
  const colon = text.indexOf(':');
  const separators = colon > 0 && !/\d/.test(text.slice(0, colon)) ? [':'] : [':', ' — ', ' – ', ' - ', ','];
  let cut = text.length;
  for (const sep of separators) {
    const at = text.indexOf(sep);
    if (at > 0 && at < cut) cut = at;
  }
  const head = text.slice(0, cut).trim();
  // Mavzuda baribir raqam qolgan bo'lsa (masalan "Paket 50 000 so'm") — raqamli so'zlarni olib tashlaymiz.
  const cleaned = head
    .split(/\s+/)
    .filter((word) => !/\d/.test(word))
    .join(' ')
    .replace(/\s+(so['ʻ‘’`]?m|sum|сум|\$|usd|dollar)\b/giu, '')
    .trim();
  return cleaned.length >= 2 ? cleaned : 'the offer';
}

const MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  ming: 1_000,
  тыс: 1_000,
  mln: 1_000_000,
  million: 1_000_000,
  millon: 1_000_000,
  млн: 1_000_000,
};

const CURRENCY = "(?:so['ʻ‘’`]?m|sum|сум|\\$|usd|dollar|y\\.?e\\.?)";

function toNumber(raw: string): number {
  return Number(raw.replace(',', '.'));
}

/**
 * Matndagi pul miqdorlari (takrorsiz). Topiladi:
 *  - minglik bo'laklar: `1 200 000`, `700.000`, `49,000`, `1200000`;
 *  - so'z ko'paytuvchilar: `700 ming`, `1.2 mln`, `5k`;
 *  - valyuta bilan kichik sonlar: `50 dollar`, `$50`, `500 so'm`.
 * Kichik sonlar (oylar, kunlar, foizlar) va 1900..2100 yillar — narx emas.
 */
export function extractPriceFigures(text: string): number[] {
  const found = new Set<number>();
  const t = text.toLowerCase().replace(/[  ]/g, ' ');
  const consumed: Array<[number, number]> = [];
  const take = (start: number, end: number, value: number): void => {
    if (!Number.isFinite(value) || value <= 0) return;
    if (consumed.some(([a, b]) => start < b && end > a)) return;
    consumed.push([start, end]);
    found.add(Math.round(value));
  };

  // 1) "700 ming", "1.2 mln", "5k"
  for (const m of t.matchAll(/(\d+(?:[.,]\d+)?)\s*(k|ming|тыс|mln|million|millon|млн)(?![\p{L}])/gu)) {
    const mult = MULTIPLIERS[m[2] as string] ?? 1;
    take(m.index ?? 0, (m.index ?? 0) + m[0].length, toNumber(m[1] as string) * mult);
  }
  // 2) minglik bo'laklar va >= 4 xonali sonlar
  for (const m of t.matchAll(/\d{1,3}(?:[ .,]\d{3})+(?!\d)|\d{4,}/g)) {
    const raw = m[0];
    const value = Number(raw.replace(/\D/g, ''));
    const isYear = /^\d{4}$/.test(raw) && value >= 1900 && value <= 2100;
    if (!isYear) take(m.index ?? 0, (m.index ?? 0) + raw.length, value);
  }
  // 3) valyuta bilan kichik sonlar: "50 dollar", "$50"
  for (const m of t.matchAll(new RegExp(String.raw`(?<![\d.,])(\d+(?:[.,]\d+)?)\s*${CURRENCY}`, 'gu'))) {
    take(m.index ?? 0, (m.index ?? 0) + (m[1] as string).length, toNumber(m[1] as string));
  }
  for (const m of t.matchAll(/\$\s*(\d+(?:[.,]\d+)?)/g)) {
    take(m.index ?? 0, (m.index ?? 0) + m[0].length, toNumber(m[1] as string));
  }

  return [...found];
}

/** Profildagi barcha takliflarning narx raqamlari. */
export function offerPriceFigures(offers: readonly string[]): Set<number> {
  return new Set(offers.flatMap((offer) => extractPriceFigures(offer)));
}

/**
 * Mijoz gapidagi, sotuvchi (shu suhbatda) va mijozning o'z yashirin faktlari
 * aytmagan narxlar. Bo'sh massiv — hammasi joyida.
 */
export function unsaidPriceFigures(
  customerText: string,
  known: { sellerTexts: readonly string[]; ownFacts?: readonly string[] },
): number[] {
  const allowed = new Set([
    ...known.sellerTexts.flatMap((t) => extractPriceFigures(t)),
    ...(known.ownFacts ?? []).flatMap((t) => extractPriceFigures(t)),
  ]);
  return extractPriceFigures(customerText).filter((value) => !allowed.has(value));
}

const PERCENT = /\d+(?:[.,]\d+)?\s*%|%\s*\d+/;

/**
 * Profilda narx/chegirma FAKTI bormi: takliflar yoki izohlarda pul miqdori
 * yoki foiz (chegirma). Yo'q bo'lsa — "narxsiz rejim": narx aniqligi
 * baholanmaydi, narx qizil chiziqlari tekshirilmaydi, mijoz narxni so'raydi,
 * lekin o'zi hech qanday raqam aytmaydi.
 */
export function hasPriceFacts(profile: {
  primaryOffers: readonly string[];
  additionalNotes?: string | null;
}): boolean {
  const texts = [...profile.primaryOffers, profile.additionalNotes ?? ''];
  return texts.some((text) => extractPriceFigures(text).length > 0 || PERCENT.test(text));
}

const PRICE_RULE = /narx|chegirma|aksiya|skidka|to['ʻ‘’`]?lov|pul|so['ʻ‘’`]?m\b|price|discount|payment|цен|скидк|оплат/iu;

/** Qizil chiziq narx/chegirma/to'lov haqidami (narxsiz rejimda tekshirilmaydi). */
export function isPriceRedLine(rule: string): boolean {
  return PRICE_RULE.test(rule);
}

/** Narx aniqligini baholaydigan mezon kodi (standart rubrikada). */
export const PRICE_ACCURACY_CRITERION = 'product_accuracy';

const PRICE_CONTEXT = /so['ʻ‘’`]?m|sum\b|сум|narx|ming|mln|million|to['ʻ‘’`]?lov|\$|dollar/iu;

export interface PriceMismatch {
  turnSeq: number;
  figure: number;
  text: string;
}

/**
 * Sotuvchi aytgan, profilda YO'Q narx raqamlari (mexanik tekshiruv; asosiy
 * hakam — LLM baholovchi). Ruxsat: profildagi narx yoki uning 1..12 karrasi
 * (masalan oylik narx x oylar soni). Faqat narx konteksti bor gaplar
 * ("so'm", "narx", "ming"...) va >= 10 000 raqamlar — telefon/sana emas.
 * Profilda narx fakti bo'lmasa — bo'sh (narxsiz rejimda tekshirilmaydi).
 */
export function findPriceMismatches(
  turns: ReadonlyArray<{ seq: number; speaker: 'seller' | 'customer'; text: string }>,
  profile: { primaryOffers: readonly string[]; additionalNotes?: string | null },
): PriceMismatch[] {
  if (!hasPriceFacts(profile)) return [];
  const known = [...profile.primaryOffers, profile.additionalNotes ?? ''].flatMap((t) => extractPriceFigures(t));
  const allowed = new Set<number>();
  for (const value of known) for (let k = 1; k <= 12; k += 1) allowed.add(value * k);
  const out: PriceMismatch[] = [];
  for (const turn of turns) {
    if (turn.speaker !== 'seller' || !PRICE_CONTEXT.test(turn.text)) continue;
    for (const figure of extractPriceFigures(turn.text)) {
      if (figure >= 10_000 && !allowed.has(figure)) out.push({ turnSeq: turn.seq, figure, text: turn.text });
    }
  }
  return out;
}
