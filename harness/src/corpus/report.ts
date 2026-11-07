/**
 * FAQAT HARNESS (korpus). Mijoz tomoni tahlilini yig'ish: uslub kutubxonasi
 * (`customer-style.json`) va o'zbekcha hisobot (`CORPUS-REPORT.md`).
 *
 * Qoidalar: statistika faqat koddan; har misol transkriptdan AYNAN
 * (indeks bo'yicha olinadi); hisobotga faqat raqamsiz/ismsiz qisqa misollar;
 * kam qo'ng'iroqda topilgan narsa "anekdotal" deb belgilanadi.
 */
import {
  addToTable,
  countOverlaps,
  fillerCounts,
  isShareableExample,
  lengthStats,
  openerCounts,
  type CategoryTable,
  type LengthStats,
} from './analysis.js';
import type { ClassifyResult } from './llm-tasks.js';
import type { Segment, Turn } from './types.js';

export interface CallAnalysis {
  callId: string;
  model: string;
  selectedBy: 'rating' | 'agreement';
  durationSec: number;
  segments: Segment[];
  turns: Turn[];
  classify: ClassifyResult;
}

export interface ModelQuality {
  model: string;
  files: number;
  failures: number;
  meanAgreement: number | null;
  meanLowQualityShare: number | null;
  speakerLabels: boolean;
  meanRating: number | null;
}

export interface CorpusSummary {
  calls: number;
  minutes: number;
  customerTurns: number;
  sellerTurns: number;
  unknownTurns: number;
  lowConfidenceLabels: number;
  length: LengthStats;
  fillers: Array<{ word: string; count: number }>;
  openers: Array<{ opener: string; count: number }>;
  objections: CategoryTable;
  questions: CategoryTable;
  emotions: CategoryTable;
  sellerIssueReactions: CategoryTable;
  endings: CategoryTable;
  /** Kategoriya -> nechta qo'ng'iroqda uchragan. */
  callsPerCategory: Record<string, number>;
  overlaps: number | null;
  overlapsAvailableCalls: number;
}

type Example = { text: string; lowQuality: boolean; callId: string };

export function summarizeCorpus(calls: readonly CallAnalysis[]): CorpusSummary {
  const objections: CategoryTable = {};
  const questions: CategoryTable = {};
  const emotions: CategoryTable = {};
  const sellerIssueReactions: CategoryTable = {};
  const endings: CategoryTable = {};
  const seen = new Map<string, Set<string>>();
  const mark = (key: string, callId: string): void => {
    seen.set(key, (seen.get(key) ?? new Set()).add(callId));
  };

  const customerTexts: string[] = [];
  let customerTurns = 0;
  let sellerTurns = 0;
  let unknownTurns = 0;
  let lowConfidence = 0;
  let overlaps = 0;
  let overlapsAvailable = 0;

  for (const call of calls) {
    const byIndex = new Map(call.turns.map((t) => [t.index, t]));
    const example = (t: Turn, extraLow = false): Example => ({
      text: t.display,
      lowQuality: t.quality === 'low_quality' || extraLow,
      callId: call.callId,
    });

    for (const t of call.turns) {
      if (t.role === 'customer') {
        customerTurns += 1;
        if (t.quality !== 'low_quality') customerTexts.push(t.display);
      } else if (t.role === 'seller') sellerTurns += 1;
      else unknownTurns += 1;
    }

    for (const label of call.classify.customerTurns) {
      const turn = byIndex.get(label.i);
      // Faqat haqiqatan MIJOZ navbati (LLM boshqa indeks bersa — e'tiborsiz).
      if (!turn || turn.role !== 'customer') continue;
      const low = label.confidence === 'low';
      if (low) lowConfidence += 1;
      if (label.objection !== 'none') {
        addToTable(objections, label.objection, example(turn, low));
        mark(`objection:${label.objection}`, call.callId);
      }
      if (label.question !== 'none') {
        addToTable(questions, label.question, example(turn, low));
        mark(`question:${label.question}`, call.callId);
      }
      if (label.emotion !== 'neutral') {
        addToTable(emotions, label.emotion, example(turn, low));
        mark(`emotion:${label.emotion}`, call.callId);
      }
    }

    for (const issue of call.classify.sellerIssues) {
      const seller = byIndex.get(issue.sellerTurn);
      const reaction = issue.reactionTurn !== null ? byIndex.get(issue.reactionTurn) : undefined;
      if (!seller || seller.role !== 'seller' || !reaction || reaction.role !== 'customer') continue;
      addToTable(sellerIssueReactions, issue.kind, example(reaction));
      mark(`seller:${issue.kind}`, call.callId);
    }

    const endTurn = call.classify.endingTurn !== null ? byIndex.get(call.classify.endingTurn) : undefined;
    const endingRow = endings[call.classify.ending] ?? { count: 0, examples: [] };
    endingRow.count += 1;
    if (endTurn && endTurn.role === 'customer' && endingRow.examples.length < 5) endingRow.examples.push(example(endTurn));
    endings[call.classify.ending] = endingRow;
    mark(`ending:${call.classify.ending}`, call.callId);

    const callOverlaps = countOverlaps(call.segments);
    if (callOverlaps !== null) {
      overlaps += callOverlaps;
      overlapsAvailable += 1;
    }
  }

  return {
    calls: calls.length,
    minutes: Number((calls.reduce((s, c) => s + c.durationSec, 0) / 60).toFixed(1)),
    customerTurns,
    sellerTurns,
    unknownTurns,
    lowConfidenceLabels: lowConfidence,
    length: lengthStats(customerTexts),
    fillers: fillerCounts(customerTexts).slice(0, 15),
    openers: openerCounts(customerTexts).slice(0, 15),
    objections,
    questions,
    emotions,
    sellerIssueReactions,
    endings,
    callsPerCategory: Object.fromEntries([...seen.entries()].map(([k, v]) => [k, v.size])),
    overlaps: overlapsAvailable > 0 ? overlaps : null,
    overlapsAvailableCalls: overlapsAvailable,
  };
}

/** Uslub kutubxonasi (dvigatelga HALI ulanmaydi). */
export function buildStyleLibrary(summary: CorpusSummary): Record<string, unknown> {
  const strip = (table: CategoryTable) =>
    Object.fromEntries(
      Object.entries(table).map(([k, v]) => [
        k,
        { count: v.count, calls: summary.callsPerCategory[`${k}`] ?? undefined, examples: v.examples.map((e) => ({ text: e.text, lowQuality: e.lowQuality })) },
      ]),
    );
  return {
    version: 1,
    source: { calls: summary.calls, minutes: summary.minutes, customerTurns: summary.customerTurns },
    note: "6 ta qo'ng'iroqdan — kichik namuna; sanoqlar yo'nalish ko'rsatadi, statistik xulosa emas.",
    lengthStats: summary.length,
    fillers: summary.fillers,
    openers: summary.openers,
    objections: strip(summary.objections),
    questions: strip(summary.questions),
    emotions: strip(summary.emotions),
    reactionsToSeller: strip(summary.sellerIssueReactions),
    endings: strip(summary.endings),
  };
}

const LABELS: Record<string, string> = {
  price: 'narx', time: 'vaqt yo\'q', need_to_think: "o'ylab ko'rish", family: 'oila bilan maslahat',
  competitor: 'boshqa joy/raqobatchi', trust: 'ishonch', not_interested: 'qiziqmaydi',
  already_have: 'allaqachon bor', other: 'boshqa', terms: 'shartlar', schedule: 'jadval/vaqt',
  location: 'manzil', clarify: 'aniqlashtirish', impatience: 'sabrsizlik', doubt: 'shubha',
  irritation: 'asabiylik', interest: 'qiziqish', vague: 'noaniq sotuvchi', pushy: 'bosim qiluvchi',
  rude: "qo'pol", agreed: 'rozi bo\'ldi', next_step: 'keyingi qadam', will_think: "o'ylab ko'raman",
  refused: 'rad etdi', hung_up: 'tashlab qo\'ydi', callback: 'qayta qo\'ng\'iroq', unclear: 'noaniq',
};
const label = (k: string): string => LABELS[k] ?? k;

/**
 * CORPUS-REPORT.md — tashqariga ulashiladigan YAGONA fayl. Ko'pi bilan 120
 * qator va 20 ta qisqa verbatim misol (raqamsiz, ismsiz, low_quality emas).
 */
export function buildCorpusReport(
  summary: CorpusSummary,
  models: readonly ModelQuality[],
  options: { maxLines?: number; maxExamples?: number } = {},
): string {
  const maxLines = options.maxLines ?? 120;
  let examplesLeft = options.maxExamples ?? 20;
  const anecdotal = (key: string): string => ((summary.callsPerCategory[key] ?? 0) < 2 ? ' (anekdotal)' : '');
  const pickExample = (examples: Array<{ text: string; lowQuality: boolean }>): string | null => {
    if (examplesLeft <= 0) return null;
    const found = examples.find((e) => !e.lowQuality && isShareableExample(e.text));
    if (!found) return null;
    examplesLeft -= 1;
    return `«${found.text}»`;
  };
  const table = (title: string, prefix: string, t: CategoryTable): string[] => {
    const rows = Object.entries(t).sort((a, b) => b[1].count - a[1].count);
    if (rows.length === 0) return [`### ${title}`, '', "Topilmadi.", ''];
    return [
      `### ${title}`,
      '',
      '| Toifa | Soni | Qo\'ng\'iroqlar | Misol |',
      '|---|---|---|---|',
      ...rows.map(
        ([k, v]) =>
          `| ${label(k)}${anecdotal(`${prefix}:${k}`)} | ${v.count} | ${summary.callsPerCategory[`${prefix}:${k}`] ?? 0} | ${pickExample(v.examples) ?? '—'} |`,
      ),
      '',
    ];
  };

  const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);
  const L = summary.length;
  const lines: string[] = [
    "# Haqiqiy qo'ng'iroqlar: mijozlar qanday gapiradi",
    '',
    `${summary.calls} ta qo'ng'iroq, ${summary.minutes} daqiqa. Mijoz navbatlari: ${summary.customerTurns}, ` +
      `sotuvchi: ${summary.sellerTurns}, rol aniqlanmagan: ${summary.unknownTurns}.`,
    '**Namuna juda kichik** — sanoqlar yo\'nalish ko\'rsatadi, statistik xulosa emas. 2 tadan kam qo\'ng\'iroqda',
    'uchragan har narsa "(anekdotal)" deb belgilangan.',
    '',
    '## Mijoz navbatining uzunligi (so\'z)',
    '',
    `O'rtacha ${L.meanWords}, mediana ${L.medianWords}, p90 ${L.p90Words}, eng uzun ${L.maxWords}; ` +
      `1–4 so'zli javoblar: **${pct(L.shortShare)}** (${L.count} ta navbatdan).`,
    '',
    `| 1–2 | 3–4 | 5–8 | 9–15 | 16+ |`,
    '|---|---|---|---|---|',
    `| ${L.histogram['1-2']} | ${L.histogram['3-4']} | ${L.histogram['5-8']} | ${L.histogram['9-15']} | ${L.histogram['16+']} |`,
    '',
    '## Boshlanish va to\'ldiruvchi so\'zlar',
    '',
    `Ko'p uchragan boshlanishlar: ${summary.openers.slice(0, 8).map((o) => `"${o.opener}" (${o.count})`).join(', ') || '—'}.`,
    `To'ldiruvchilar: ${summary.fillers.slice(0, 10).map((f) => `"${f.word}" (${f.count})`).join(', ') || '—'}.`,
    '',
    ...table('E\'tirozlar', 'objection', summary.objections),
    ...table('Savollar', 'question', summary.questions),
    ...table('Hissiyot belgilari', 'emotion', summary.emotions),
    ...table('Noaniq / bosim qiluvchi / qo\'pol sotuvchiga reaksiya', 'seller', summary.sellerIssueReactions),
    ...table("Qo'ng'iroq qanday tugaydi", 'ending', summary.endings),
    '## Ustma-ust gapirish',
    '',
    summary.overlaps === null
      ? "Vaqt belgilari yo'q — o'lchanmadi."
      : `${summary.overlapsAvailableCalls} ta qo'ng'iroqda ${summary.overlaps} marta (diarizatsiya vaqtlari bo'yicha; aniqligi past).`,
    '',
    '## Ma\'lumot sifati',
    '',
    '| Model | Fayl | Xato | Kelishuv | low_quality | So\'zlovchi | Baho |',
    '|---|---|---|---|---|---|---|',
    ...models.map(
      (m) =>
        `| ${m.model} | ${m.files} | ${m.failures} | ${pct(m.meanAgreement)} | ${pct(m.meanLowQualityShare)} | ${m.speakerLabels ? 'ha' : 'yo\'q'} | ${m.meanRating ?? '—'} |`,
    ),
    '',
    `LLM ishonchsiz deb belgilagan yorliqlar: ${summary.lowConfidenceLabels}. "Kelishuv" — modellar matni bir-biriga`,
    "qanchalik o'xshashligi (aniqlik EMAS); qaysi model aniqroq ekanini faqat tinglab qo'yilgan baholar aytadi.",
    '',
    "## 6 ta qo'ng'iroq nimani ayta oladi va nimani ayta olmaydi",
    '',
    "- Ayta oladi: mijozlar qaysi so'z va iboralarni ishlatadi, javoblar qanchalik qisqa, qaysi e'tirozlar umuman uchraydi.",
    "- Ayta olmaydi: ulushlar va foizlar boshqa qo'ng'iroqlarga ko'chadimi; qaysi sotuvchi usuli ishlaydi; mavsum, mahsulot",
    '  yoki sotuvchiga bog\'liq farqlar.',
    "- STT xatolari (ayniqsa shovqinli telefon ovozi) misollarga kirib qolishi mumkin; low_quality misollar hisobotga qo'yilmagan.",
    "- Rollar va toifalar LLM yorlig'i — har biri tekshirilmagan; sanoqlar shu yorliqlarga tayanadi.",
  ];

  return lines.slice(0, maxLines).join('\n') + '\n';
}
