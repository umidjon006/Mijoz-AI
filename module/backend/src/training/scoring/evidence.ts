/**
 * Dalil (evidence) tekshiruvi.
 *
 * NEGA KERAK: LLM "sotuvchi shunday dedi" deb o'ylab topishi mumkin.
 * Transkript esa saqlangan AYNAN matn (yozib kiritilgan yoki STT natijasi,
 * hech qachon LLM tomonidan qayta yozilmagan), shuning uchun keltirilgan
 * iqtibosni mexanik tekshirish mazmunli.
 *
 * Qoidalar (asosiy repodagidan QATTIQROQ):
 *  - ikki tomon ham normallashtiriladi: kichik harf; apostrof/qo'shtirnoq va
 *    chiziqchalar bitta ko'rinishga; tinish belgilari olib tashlanadi;
 *    ketma-ket bo'shliqlar bitta bo'shliqqa;
 *  - iqtibos >= 3 so'z VA >= 12 belgi (normallashtirgandan keyin);
 *  - iqtibos SOTUVCHI navbati ichida bo'lishi shart (mezonlar sotuvchini
 *    baholaydi; mijoz gapidan olingan iqtibos rad etiladi);
 *  - `evidenceTurnSeq` berilgan bo'lsa avval o'sha navbat, keyin qolgan
 *    sotuvchi navbatlari tekshiriladi;
 *  - navbat chegarasidan oshib ketadigan moslik qabul qilinmaydi (har navbat
 *    alohida qidiriladi).
 *
 * Rad etilgan iqtibos O'CHIRILMAYDI — natijaga `rejectedQuote` sifatida
 * yoziladi (audit uchun), mezon bahosi esa `null` bo'ladi.
 */

export const EVIDENCE_MIN_WORDS = 3;
export const EVIDENCE_MIN_CHARS = 12;

const APOSTROPHES = /[ʻʼʽ‘’‛`´ʹ'ʾ]/g;
const QUOTES = /[“”„«»"]/g;
const DASHES = /[‐‑‒–—―−-]/g;
const PUNCTUATION = /[.,!?;:()[\]{}/\\|*_~^<>@#$%&+=…]/g;

/** Dalil solishtirish uchun normallashtirish. */
export function normalizeForEvidence(input: string): string {
  return input
    .toLowerCase()
    .replace(APOSTROPHES, "'")
    .replace(QUOTES, ' ')
    .replace(DASHES, ' ')
    .replace(PUNCTUATION, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function evidenceWordCount(normalized: string): number {
  return normalized.length === 0 ? 0 : normalized.split(' ').length;
}

export interface EvidenceTurn {
  seq: number;
  speaker: 'seller' | 'customer';
  text: string;
}

export type EvidenceRejectReason =
  | 'empty' // iqtibos berilmagan
  | 'too_short' // 3 so'z / 12 belgidan kam
  | 'customer_turn' // mijoz gapidan olingan
  | 'not_found'; // hech bir sotuvchi navbatida yo'q

export interface EvidenceOk {
  ok: true;
  /** Iqtibos topilgan haqiqiy navbat (LLM noto'g'ri seq bergan bo'lsa tuzatiladi). */
  turnSeq: number;
  /** LLM aytgan seq bilan mos keldimi. */
  matchedHint: boolean;
  normalizedQuote: string;
}

export interface EvidenceFailed {
  ok: false;
  reason: EvidenceRejectReason;
  normalizedQuote: string;
}

export type EvidenceResult = EvidenceOk | EvidenceFailed;

/**
 * Iqtibosni transkript bo'yicha tekshiradi.
 * `turns` — sessiyaning BARCHA navbatlari (mijoz navbatlari ham kerak:
 * iqtibos mijoz gapidan olingan bo'lsa buni aniq aytamiz).
 */
export function verifyEvidence(
  quote: string | null | undefined,
  turns: readonly EvidenceTurn[],
  hintSeq?: number | null,
): EvidenceResult {
  const normalizedQuote = normalizeForEvidence(quote ?? '');
  if (normalizedQuote.length === 0) {
    return { ok: false, reason: 'empty', normalizedQuote };
  }
  if (
    evidenceWordCount(normalizedQuote) < EVIDENCE_MIN_WORDS ||
    normalizedQuote.length < EVIDENCE_MIN_CHARS
  ) {
    return { ok: false, reason: 'too_short', normalizedQuote };
  }

  const sellerTurns = turns.filter((t) => t.speaker === 'seller');
  // Avval LLM ko'rsatgan navbat, keyin qolganlari (tartib barqaror bo'lsin).
  const ordered = [
    ...sellerTurns.filter((t) => hintSeq !== null && hintSeq !== undefined && t.seq === hintSeq),
    ...sellerTurns
      .filter((t) => hintSeq === null || hintSeq === undefined || t.seq !== hintSeq)
      .sort((a, b) => a.seq - b.seq),
  ];

  for (const turn of ordered) {
    // Har navbat ALOHIDA normallashtiriladi -> chegaradan oshib ketish mumkin emas.
    if (normalizeForEvidence(turn.text).includes(normalizedQuote)) {
      return {
        ok: true,
        turnSeq: turn.seq,
        matchedHint: hintSeq === turn.seq,
        normalizedQuote,
      };
    }
  }

  // Sotuvchida yo'q — mijozda bormi?
  for (const turn of turns) {
    if (turn.speaker !== 'customer') continue;
    if (normalizeForEvidence(turn.text).includes(normalizedQuote)) {
      return { ok: false, reason: 'customer_turn', normalizedQuote };
    }
  }

  return { ok: false, reason: 'not_found', normalizedQuote };
}

export const EVIDENCE_REJECT_MESSAGE: Record<EvidenceRejectReason, string> = {
  empty: "iqtibos berilmagan",
  too_short: `iqtibos juda qisqa (kamida ${EVIDENCE_MIN_WORDS} so'z va ${EVIDENCE_MIN_CHARS} belgi)`,
  customer_turn: "iqtibos mijoz gapidan olingan — mezonlar sotuvchini baholaydi",
  not_found: "iqtibos transkriptda topilmadi",
};
