/**
 * SSENARIY hisobot kartasi (debrief) — mavjud baholashga QO'SHIMCHA.
 *
 * Kod hisoblaydi (navbatlardagi `stateAfter.meta.scenario` va yakuniy holatdan):
 *  - yashirin sabab topildimi (qaysi navbatda);
 *  - haqiqiy e'tiroz yechildimi;
 *  - jahlni pasaytirish (jahl traektoriyasi);
 *  - savollarga to'g'ridan-to'g'ri javob (mijoz "savol e'tiborsiz" deb belgilagan navbatlar ulushi);
 *  - aniq keyingi qadam (sessiya natijasi).
 * LLM baholaydi (bitta ixcham chaqiruv, o'zbekcha):
 *  - kinoya/haqoratga muloyim javob (faqat shunday navbatlar bo'lsa);
 *  - mijozga to'g'ri va hurmatli murojaat;
 *  - 2-3 iqtibos (navbat raqami bilan; matnda borligi KODDA tekshiriladi) va BITTA aniq maslahat.
 * Natija `coaching.scenarioReport` ga yoziladi (sessiya natijasi bilan birga saqlanadi).
 */
import { z } from 'zod';

import { describeLlmError, isCorrectableLlmError } from '../errors.js';
import type { PersonaCard } from '../persona.js';
import type { PriceCall, TokenUsage, TrainerLlm } from '../ports.js';
import type { Scenario, SellerProfile } from '../scenario/schema.js';
import type { ScoringTurn } from './metrics.js';

export type ReportStatus = 'pass' | 'partial' | 'fail' | 'na';

export const REPORT_ITEMS = [
  ['hidden_reason', 'Yashirin sababni topdi'],
  ['real_objection', "Haqiqiy e'tirozga javob berdi"],
  ['de_escalation', 'Jahlni pasaytirdi'],
  ['polite_under_pressure', 'Kinoya/haqoratda ham muloyim qoldi'],
  ['answered_directly', 'Savollarga to\'g\'ridan-to\'g\'ri javob berdi'],
  ['next_step', 'Aniq keyingi qadamga kelishdi'],
  ['address', "Mijozga to'g'ri va hurmatli murojaat qildi"],
] as const;

export type ReportItemKey = (typeof REPORT_ITEMS)[number][0];

export interface ScenarioReportItem {
  key: ReportItemKey;
  label: string;
  status: ReportStatus;
  /** Qisqa izoh (o'zbekcha). */
  detail: string;
  /** Qaysi sotuvchi navbatida (bo'lsa). */
  turnSeq?: number;
}

export interface ScenarioReport {
  scenarioId: string;
  title: string;
  level: string;
  items: ScenarioReportItem[];
  /** 0..100 (pass=1, partial=0.5, fail=0; "na" hisobga olinmaydi). */
  score: number;
  passed: number;
  total: number;
  angerPath: number[];
  moments: Array<{ turnSeq: number; quote: string; note: string }>;
  tip: string;
  summary: string;
  /** LLM qismi bajarilmadi (xato) — faqat kod qismi bor. */
  partialOnly?: boolean;
}

interface TurnMeta {
  revealedNow?: boolean;
  objectionAddressed?: boolean;
  hangup?: string | null;
  warnedNow?: boolean;
  mistakes?: string[];
  insult?: { text: string } | null;
  style?: string;
  formality?: string;
  emotion?: { anger?: number };
}

function metaOf(t: ScoringTurn): { meta: TurnMeta | null; anger: number | null; objection: boolean } {
  const s = (t.stateAfter ?? null) as { meta?: { scenario?: TurnMeta }; emotion?: { anger?: number; objectionAddressed?: boolean } } | null;
  return {
    meta: s?.meta?.scenario ?? null,
    anger: typeof s?.emotion?.anger === 'number' ? s.emotion.anger : null,
    objection: s?.emotion?.objectionAddressed === true,
  };
}

const norm = (t: string): string =>
  t
    .toLowerCase()
    .replace(/[ʻʼ’‘`´]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Kod qismi: LLM'siz, navbatlar telemetriyasidan. */
export function computeDeterministicItems(input: {
  scenario: Scenario;
  turns: ScoringTurn[];
  outcome: string | null;
  endReason: string | null;
}): { items: Map<ReportItemKey, ScenarioReportItem>; angerPath: number[]; pressureTurns: number[] } {
  const label = (k: ReportItemKey): string => REPORT_ITEMS.find(([key]) => key === k)?.[1] ?? k;
  const items = new Map<ReportItemKey, ScenarioReportItem>();
  const customer = input.turns.filter((t) => t.speaker === 'customer');
  const start = input.scenario.emotion.baseline.anger;
  const angerPath = [start, ...customer.map((t) => metaOf(t).anger).filter((a): a is number => a !== null)];
  const peak = Math.max(...angerPath);
  const end = angerPath[angerPath.length - 1] ?? start;
  const sellerBefore = (seq: number): number => {
    const prev = input.turns.filter((t) => t.speaker === 'seller' && t.seq < seq);
    return prev[prev.length - 1]?.seq ?? seq - 1;
  };

  // 1. Yashirin sabab.
  const revealTurn = customer.find((t) => metaOf(t).meta?.revealedNow);
  items.set('hidden_reason', {
    key: 'hidden_reason',
    label: label('hidden_reason'),
    status: revealTurn ? 'pass' : 'fail',
    detail: revealTurn
      ? `Mijoz yashirin sababini ${sellerBefore(revealTurn.seq)}-navbatdagi savoldan keyin aytdi.`
      : "Yashirin sabab ochilmadi — mijozning vaziyati haqida ko'proq ochiq savol bering.",
    ...(revealTurn ? { turnSeq: sellerBefore(revealTurn.seq) } : {}),
  });

  // 2. Haqiqiy e'tiroz.
  const objTurn = customer.find((t) => metaOf(t).objection);
  items.set('real_objection', {
    key: 'real_objection',
    label: label('real_objection'),
    status: objTurn ? 'pass' : 'fail',
    detail: objTurn
      ? `Haqiqiy e'tirozga ${sellerBefore(objTurn.seq)}-navbatda aniq javob berildi.`
      : `Haqiqiy e'tiroz yechilmadi: "${input.scenario.real_objection}"`,
    ...(objTurn ? { turnSeq: sellerBefore(objTurn.seq) } : {}),
  });

  // 3. Jahlni pasaytirish.
  const hungUpAngry = input.endReason === 'customer_hung_up_angry';
  let deStatus: ReportStatus;
  if (hungUpAngry) deStatus = 'fail';
  else if (peak <= start + 5 && start < 30) deStatus = end <= start + 10 ? 'pass' : 'partial';
  else if (end <= start - 10 || (peak > start && end <= peak - 20)) deStatus = 'pass';
  else if (end <= start + 5) deStatus = 'partial';
  else deStatus = 'fail';
  items.set('de_escalation', {
    key: 'de_escalation',
    label: label('de_escalation'),
    status: deStatus,
    detail: `Jahl: boshida ${start}, eng yuqori ${peak}, oxirida ${end}${hungUpAngry ? " — mijoz jahl bilan go'shakni qo'ydi" : ''}.`,
  });

  // 5. Savollarga to'g'ridan-to'g'ri javob.
  const ignored = customer.filter((t) => metaOf(t).meta?.mistakes?.includes('ignored_question')).length;
  const ratio = customer.length ? ignored / customer.length : 0;
  items.set('answered_directly', {
    key: 'answered_directly',
    label: label('answered_directly'),
    status: ratio <= 0.1 ? 'pass' : ratio <= 0.3 ? 'partial' : 'fail',
    detail:
      ignored === 0
        ? "Mijozning savollari e'tiborsiz qolmadi."
        : `${customer.length} navbatdan ${ignored} tasida mijoz savoliga javob berilmadi.`,
  });

  // 6. Keyingi qadam.
  const won = input.outcome === 'won';
  items.set('next_step', {
    key: 'next_step',
    label: label('next_step'),
    status: won ? 'pass' : 'fail',
    detail: won
      ? input.endReason === 'agreed'
        ? 'Mijoz rozi bo\'ldi.'
        : 'Aniq keyingi qadamga kelishildi.'
      : input.endReason?.startsWith('customer_hung_up') || input.endReason === 'hangup_condition_met'
        ? "Mijoz go'shakni qo'ydi — keyingi qadam bo'lmadi."
        : 'Aniq keyingi qadam (vaqt, uchrashuv, xabar) belgilanmadi.',
  });

  // Bosim navbatlari (kinoya/haqorat/"sen") — LLM baholaydigan band uchun.
  const pressureTurns = customer
    .filter((t) => {
      const m = metaOf(t).meta;
      return Boolean(m?.insult) || m?.style === 'sarcastic' || m?.formality === 'sen';
    })
    .map((t) => t.seq);
  return { items, angerPath, pressureTurns };
}

// ---------------------------------------------------------------------------
// LLM qismi
// ---------------------------------------------------------------------------
const statusEnum = z.enum(['pass', 'partial', 'fail']);
export const scenarioJudgeSchema = z.object({
  polite_under_pressure: z.object({ status: statusEnum, detail: z.string().min(3).max(300) }),
  address: z.object({ status: statusEnum, detail: z.string().min(3).max(300) }),
  moments: z
    .array(z.object({ turnSeq: z.number().int().min(1), quote: z.string().min(4).max(240), note: z.string().min(3).max(240) }))
    .min(1)
    .max(3),
  tip: z.string().min(10).max(400),
  summary: z.string().min(10).max(400),
});
export type ScenarioJudge = z.infer<typeof scenarioJudgeSchema>;

export const SCENARIO_REPORT_PROMPT_VERSION = 'scenario-report-v1';

export function buildJudgePrompt(input: {
  scenario: Scenario;
  persona: PersonaCard;
  seller: SellerProfile | null;
  turns: ScoringTurn[];
  pressureTurns: number[];
  items: ScenarioReportItem[];
}): { system: string; user: string } {
  const { scenario: s, persona } = input;
  const system = [
    'You review ONE sales-training phone call (the seller is a trainee). Write ALL text in natural Uzbek, Latin script.',
    'Return JSON only: {"polite_under_pressure": {"status": "pass"|"partial"|"fail", "detail": string},',
    ' "address": {"status": ..., "detail": string}, "moments": [{"turnSeq": int, "quote": string, "note": string}], "tip": string, "summary": string}',
    '- polite_under_pressure: did the SELLER stay calm and polite after the customer\'s sarcasm/insults/informal "sen" (turns listed)? If none listed, judge general politeness.',
    `- address: did the seller address the customer correctly and respectfully for a ${persona.age}-year-old ${persona.gender === 'female' ? 'woman' : 'man'} (e.g. "aka/opa/buvi/ota-ona", polite "siz")?`,
    '- moments: 2-3 key moments; quote must be copied EXACTLY from that turn (seller or customer); note says why it matters.',
    '- tip: ONE concrete improvement with an example phrase the seller could say next time.',
    '- summary: one or two sentences.',
  ].join('\n');
  const lines = input.turns.map((t) => `#${t.seq} ${t.speaker === 'seller' ? 'SELLER' : 'CUSTOMER'}: ${t.text}`);
  const user = [
    `## Scenario: ${s.title_uz}`,
    `Customer: ${persona.name}, ${persona.age}, ${persona.role}. Hidden reason: ${s.hidden_reason}. Real objection: ${s.real_objection}.`,
    input.seller ? `Seller: ${input.seller.gender === 'female' ? 'woman' : 'man'}, ${input.seller.age}.` : '',
    `Pressure turns (customer sarcasm/insult/"sen"): ${input.pressureTurns.length ? input.pressureTurns.join(', ') : 'none'}`,
    `Already measured by code: ${input.items.map((i) => `${i.key}=${i.status}`).join(', ')}`,
    '',
    '## Transcript',
    ...lines,
  ]
    .filter(Boolean)
    .join('\n');
  return { system, user };
}

export interface ScenarioReportInput {
  llm: TrainerLlm;
  priceCall?: PriceCall | undefined;
  scenario: Scenario;
  persona: PersonaCard;
  seller: SellerProfile | null;
  turns: ScoringTurn[];
  outcome: string | null;
  endReason: string | null;
  level: string;
}

export async function computeScenarioReport(
  input: ScenarioReportInput,
): Promise<{ report: ScenarioReport; costUsd: number; usage?: TokenUsage }> {
  const det = computeDeterministicItems(input);
  const items = det.items;
  const label = (k: ReportItemKey): string => REPORT_ITEMS.find(([key]) => key === k)?.[1] ?? k;
  let costUsd = 0;
  let usage: TokenUsage | undefined;
  let judge: ScenarioJudge | null = null;
  const prompt = buildJudgePrompt({
    scenario: input.scenario,
    persona: input.persona,
    seller: input.seller,
    turns: input.turns,
    pressureTurns: det.pressureTurns,
    items: [...items.values()],
  });
  const call = async (correction?: string): Promise<ScenarioJudge> => {
    const req = {
      stage: 'training.scenario_report',
      system: prompt.system,
      user: correction ? `${prompt.user}\n\n## CORRECTION\n${correction}` : prompt.user,
      schema: scenarioJudgeSchema,
      outputSchema: scenarioJudgeSchema,
    };
    if (typeof input.llm.completeJsonWithUsage === 'function') {
      const out = await input.llm.completeJsonWithUsage(req);
      usage = out.usage;
      costUsd += input.priceCall ? Math.max(0, input.priceCall(out.usage)) : 0;
      return out.value;
    }
    return await input.llm.completeJson(req);
  };
  try {
    try {
      judge = await call();
    } catch (err) {
      if (!isCorrectableLlmError(err)) throw err;
      judge = await call(`Previous answer invalid: ${describeLlmError(err)}. Return valid JSON.`);
    }
  } catch {
    judge = null; // faqat kod qismi bilan
  }

  const byTurn = new Map(input.turns.map((t) => [t.seq, t.text]));
  if (judge) {
    items.set('polite_under_pressure', {
      key: 'polite_under_pressure',
      label: label('polite_under_pressure'),
      status: det.pressureTurns.length === 0 && judge.polite_under_pressure.status === 'pass' ? 'na' : judge.polite_under_pressure.status,
      detail: det.pressureTurns.length === 0 ? 'Mijoz kinoya yoki haqorat qilmadi.' : judge.polite_under_pressure.detail,
    });
    items.set('address', { key: 'address', label: label('address'), status: judge.address.status, detail: judge.address.detail });
  } else {
    items.set('polite_under_pressure', { key: 'polite_under_pressure', label: label('polite_under_pressure'), status: 'na', detail: 'Baholanmadi.' });
    items.set('address', { key: 'address', label: label('address'), status: 'na', detail: 'Baholanmadi.' });
  }

  // Iqtiboslar KODDA tekshiriladi: o'sha navbat matnida bo'lishi shart.
  const moments = (judge?.moments ?? []).filter((m) => {
    const text = byTurn.get(m.turnSeq);
    return text !== undefined && norm(text).includes(norm(m.quote)) && norm(m.quote).length >= 4;
  });

  const ordered = REPORT_ITEMS.map(([k]) => items.get(k)).filter((i): i is ScenarioReportItem => Boolean(i));
  const scored = ordered.filter((i) => i.status !== 'na');
  const points = scored.reduce((s, i) => s + (i.status === 'pass' ? 1 : i.status === 'partial' ? 0.5 : 0), 0);
  const firstFail = ordered.find((i) => i.status === 'fail');
  return {
    report: {
      scenarioId: input.scenario.id,
      title: input.scenario.title_uz,
      level: input.level,
      items: ordered,
      score: scored.length ? Math.round((100 * points) / scored.length) : 0,
      passed: scored.filter((i) => i.status === 'pass').length,
      total: scored.length,
      angerPath: det.angerPath,
      moments,
      tip: judge?.tip ?? (firstFail ? `Keyingi safar: ${firstFail.detail}` : "Shu uslubda davom eting."),
      summary: judge?.summary ?? '',
      ...(judge ? {} : { partialOnly: true }),
    },
    costUsd,
    ...(usage ? { usage } : {}),
  };
}
