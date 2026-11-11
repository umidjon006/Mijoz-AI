/**
 * FAQAT HARNESS. Ssenariylar KALIBROVKASI: sotuvchini ham LLM (Gemini) o'ynaydi.
 *
 * Har ssenariy × uslub (YAXSHI / O'RTA / YOMON), daraja O'rta, ko'pi bilan
 * 12 sotuvchi navbati, FAQAT MATN (TTS yo'q). Har sessiya tugagach odatdagi
 * baholash xizmati ishlaydi (ssenariy kartasi bilan).
 *
 *   npm run e2e:calibrate                         # 13 ssenariy × 3 uslub
 *   npm run e2e:calibrate -- --only prank_caller  # bitta ssenariy
 *   npm run e2e:calibrate -- --styles good,bad --budget 1.5 --concurrency 3
 *
 * Byudjet: har sessiyadan keyin haqiqiy sarf o'lchanadi; jami sarf YOKI
 * (o'rtacha × qolgan sessiyalar) bilan taxmin --budget ($3) dan oshsa —
 * yangi sessiya boshlanmaydi va skript to'xtaydi.
 * Natija: <repo>/tts_test_output/e2e_calibrate/ (git'ga kirmaydi).
 */
import './env.js';

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

import { createTrainingEngine } from '../../module/backend/src/training/engine.js';
import { describeLlmError } from '../../module/backend/src/training/errors.js';
import type { TrainerLlm, TrainerLlmRequest } from '../../module/backend/src/training/ports.js';
import type { SellerProfile } from '../../module/backend/src/training/scenario/schema.js';
import * as scoringRepo from '../../module/backend/src/training/scoring/repo.js';
import { formatBusinessFacts } from '../../module/backend/src/training/scoring/scoring-prompts.js';
import { createScoringService } from '../../module/backend/src/training/scoring/scoring.js';
import type { LlmCallEvent } from './bakeoff/types.js';
import { resolveBusinessData } from './business-data.js';
import { DEMO_BUSINESS_ID, DEMO_CONTEXT, ensureDemoRows } from './demo-env.js';
import { envStr, harnessRoot } from './env.js';
import { createTrainerLlm, describeLlm, resolveProviderConfig } from './llm-factory.js';
import { priceCall } from './pricing.js';
import { loadScenarioFiles, syncScenarios } from './scenarios.js';
import { appDatabaseUrl, createPool, createWithTenant } from './withTenant.js';

const OUT_DIR = resolve(harnessRoot, '..', 'tts_test_output', 'e2e_calibrate');
const MAX_SELLER_TURNS = 12;

type Style = 'good' | 'medium' | 'bad';
const STYLE_LABEL: Record<Style, string> = { good: 'YAXSHI', medium: "O'RTA", bad: 'YOMON' };

const STYLE_RULES: Record<Style, string> = {
  good: [
    'You are a GOOD, experienced seller.',
    '- Greet politely, introduce yourself and the center. Address the customer respectfully for their age and gender (aka / opa / ota / buvi / ...) and always use "siz".',
    '- Listen first. Ask short, open, relevant questions about THEIR situation before pitching.',
    '- Answer EXACTLY what was asked, in 1-3 sentences. Do not lecture.',
    '- If the customer is angry, sarcastic or rude: stay calm, acknowledge, apologise for real mistakes, never argue or insult back.',
    '- Ask about the reason behind their hesitation (who decides, what worries them, past experience) before offering solutions.',
    '- Address the real concern once you learn it; then agree a CONCRETE next step with a day/time (a visit, a call at an agreed time). "I will send info" alone is not enough — fix a time to follow up.',
    '- Never invent prices, courses, discounts or promises that are not in the business facts.',
  ].join('\n'),
  medium: [
    'You are an AVERAGE, somewhat inexperienced seller.',
    '- Polite, uses "siz", but often forgets the respectful address word.',
    '- Tends to start pitching course features early; asks at most one or two questions about the customer\'s situation during the whole call.',
    '- Sometimes answers a question only partly or slides back to the pitch; occasionally repeats the same selling point.',
    '- Does not insult; under sarcasm becomes a little defensive but stays polite.',
    '- Tries to close once or twice ("yozib qo\'yaymi?") without a clear reason.',
    '- Never invents prices or courses that are not in the business facts.',
  ].join('\n'),
  bad: [
    'You are a BAD, pushy seller.',
    '- Ignores the customer\'s questions and feelings; keeps pitching and repeating the same lines.',
    '- Pressures: "faqat bugun", "joylar tugayapti", asks for payment early.',
    '- Does not ask about the customer\'s situation. Argues when the customer complains ("men ishimni qilyapman").',
    '- Never uses a respectful address word; may sound impatient. Does NOT swear or insult directly.',
    '- Still only names courses/prices that exist in the business facts.',
  ].join('\n'),
};

const sellerOutSchema = z.object({
  text: z.string().min(1).max(600),
  endCall: z.boolean().default(false),
});
type SellerOut = z.infer<typeof sellerOutSchema>;

const SELLER: SellerProfile = { name: 'Jasur', gender: 'male', age: 26 };

interface Turn {
  turn: number;
  seller: string;
  customer: string;
  anger: number | null;
  trust: number;
  patience: number;
  revealedNow: boolean;
  warnedNow: boolean;
  mistakes: string[];
  hangup: string | null;
}

interface RunRow {
  scenarioId: string;
  style: Style;
  sessionId: string | null;
  persona: string;
  opening: string | null;
  turns: Turn[];
  result: string; // won | lost | timeout | open (12 da kesildi) | error
  endReason: string | null;
  hiddenTurn: number | null;
  final: { anger: number | null; trust: number; patience: number } | null;
  skillScore: number | null;
  cardScore: number | null;
  cardItems: Array<{ key: string; status: string; turnSeq?: number }>;
  tip: string | null;
  moments: Array<{ turnSeq: number; quote: string; note: string }>;
  costUsd: number;
  error?: string;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function callWithUsage<T>(llm: TrainerLlm, req: TrainerLlmRequest<T>): Promise<T> {
  if (typeof llm.completeJsonWithUsage === 'function') return (await llm.completeJsonWithUsage(req)).value;
  return await llm.completeJson(req);
}

function sellerSystem(style: Style, businessFacts: string, brief: string, direction: string): string {
  return [
    'You role-play a SALES PERSON on a phone call for a training simulator. Speak natural spoken Uzbek (Latin script), short phone-style sentences.',
    `Your name: ${SELLER.name}, male, ${SELLER.age}. You work at the center described below.`,
    `Call direction: ${direction === 'inbound' ? 'the customer called YOU' : 'YOU are calling the customer'}.`,
    `What you know before the call (shown to the trainee): ${brief}`,
    '',
    'BUSINESS FACTS (the only true facts you may use):',
    businessFacts,
    '',
    'YOUR STYLE:',
    STYLE_RULES[style],
    '',
    'Output JSON {"text": "<your next line, Uzbek>", "endCall": <boolean>}.',
    'endCall=true ONLY when you say goodbye AFTER the customer has clearly agreed to a concrete next step or clearly refused/ended the conversation. Otherwise false — keep the conversation going.',
    'Write ONE turn only (1-3 sentences). Never write the customer\'s lines.',
  ].join('\n');
}

function transcriptText(opening: string | null, turns: Turn[]): string {
  const lines: string[] = [];
  if (opening) lines.push(`MIJOZ: ${opening}`);
  for (const t of turns) {
    lines.push(`SOTUVCHI: ${t.seller}`);
    lines.push(`MIJOZ: ${t.customer}`);
  }
  return lines.length ? lines.join('\n') : '(qo\'ng\'iroq hali boshlanmadi — birinchi bo\'lib siz gapirasiz)';
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const only = arg(argv, '--only');
  const styles = (arg(argv, '--styles') ?? 'good,medium,bad').split(',').filter((s): s is Style => s in STYLE_LABEL);
  const budget = Number(arg(argv, '--budget') ?? '3');
  const concurrency = Math.max(1, Number(arg(argv, '--concurrency') ?? '3'));

  const business = resolveBusinessData(envStr('HARNESS_PROFILE'));
  const profile = business.profile;
  const events: LlmCallEvent[] = [];
  const onCall = (e: LlmCallEvent): void => {
    events.push(e);
  };
  const config = resolveProviderConfig();
  const customer = createTrainerLlm({ profile, config, onCall });
  const scoringLlm = createTrainerLlm({ profile, config, scoring: true, onCall });
  const sellerLlm = createTrainerLlm({ profile, config, onCall });
  console.log(`LLM: ${describeLlm(customer)} · baholash: ${describeLlm(scoringLlm)}`);
  const spent = (): number => events.reduce((s, e) => s + (e.usage ? priceCall(e.usage) : 0), 0);

  await ensureDemoRows();
  const pool = createPool(appDatabaseUrl());
  const withTenant = createWithTenant(pool);
  console.log(await syncScenarios(withTenant, DEMO_BUSINESS_ID));
  const scenarios = loadScenarioFiles().valid.map((v) => v.scenario).filter((s) => !only || s.id === only);
  const engine = createTrainingEngine({
    withTenant,
    getBusinessProfile: async () => profile,
    llm: customer.llm,
    priceCall,
    logger: { info: () => undefined, warn: (_o, m) => console.log(`      [log] ${m}`), error: (_o, m) => console.log(`      [err] ${m}`) },
  });
  const scoring = createScoringService({
    withTenant,
    llm: scoringLlm.llm,
    priceCall,
    getBusinessProfile: async () => profile,
    getSalesScript: async () => business.script,
    logger: { info: () => undefined, warn: (_o, m) => m && console.log(`      [baholash] ${m}`), error: (_o, m) => m && console.log(`      [baholash xato] ${m}`) },
  });
  const facts = formatBusinessFacts(profile);

  const plan = scenarios.flatMap((s) => styles.map((style) => ({ s, style })));
  console.log(`Reja: ${plan.length} sessiya (${scenarios.length} ssenariy × ${styles.length} uslub), byudjet $${budget}`);
  const rows: RunRow[] = [];
  let stopped: string | null = null;

  async function runOne(s: (typeof scenarios)[number], style: Style): Promise<RunRow> {
    const before = spent();
    const row: RunRow = {
      scenarioId: s.id, style, sessionId: null, persona: '', opening: null, turns: [], result: 'open', endReason: null,
      hiddenTurn: null, final: null, skillScore: null, cardScore: null, cardItems: [], tip: null, moments: [], costUsd: 0,
    };
    try {
      const started = await engine.startSession(DEMO_CONTEXT, { scenarioId: s.id, seller: SELLER, level: 'medium' });
      row.sessionId = started.sessionId;
      row.persona = `${started.persona.name}, ${started.persona.age}, ${started.persona.gender ?? '?'}`;
      row.opening = started.openingLine;
      const system = sellerSystem(style, facts, `${s.title_uz}. ${s.description_uz}`, s.call_direction);
      let ended = false;
      for (let i = 1; i <= MAX_SELLER_TURNS && !ended; i += 1) {
        const out: SellerOut = await callWithUsage(sellerLlm.llm, {
          stage: 'calibrate.seller',
          system,
          user: `Suhbat hozirgacha:\n${transcriptText(row.opening, row.turns)}\n\nSizning navbatdagi gapingiz (JSON):`,
          schema: sellerOutSchema,
        });
        const t = await engine.takeTurn(DEMO_CONTEXT, { sessionId: started.sessionId, sellerText: out.text });
        const m = t.meta.scenario;
        row.turns.push({
          turn: i,
          seller: out.text,
          customer: t.customerReply,
          anger: t.state.emotion?.anger ?? null,
          trust: t.state.trust,
          patience: t.state.patience,
          revealedNow: m?.revealedNow ?? false,
          warnedNow: m?.warnedNow ?? false,
          mistakes: m?.mistakes ?? [],
          hangup: m?.hangup ?? null,
        });
        if (m?.revealedNow && row.hiddenTurn === null) row.hiddenTurn = i;
        row.final = { anger: t.state.emotion?.anger ?? null, trust: t.state.trust, patience: t.state.patience };
        if (t.ended) {
          ended = true;
          row.result = t.outcome ?? 'ended';
          row.endReason = t.endReason ?? null;
        } else if (out.endCall) {
          ended = true;
          row.result = 'open';
          row.endReason = 'seller_ended';
          await engine.endSession(DEMO_CONTEXT, { sessionId: started.sessionId, reason: 'seller_hung_up' });
        }
      }
      if (!ended) {
        row.endReason = 'calibrate_max_turns';
        await engine.endSession(DEMO_CONTEXT, { sessionId: started.sessionId, reason: 'calibrate_max_turns' });
      }
      const scored = await scoring.scoreSession(DEMO_CONTEXT, started.sessionId);
      if (!scored.alreadyRunning) {
        const res = await withTenant(DEMO_BUSINESS_ID, (tx) => scoringRepo.getLatestResult(tx, started.sessionId));
        row.skillScore = res?.skillScore == null ? null : Number(res.skillScore);
        const card = res?.coaching?.scenarioReport;
        if (card) {
          row.cardScore = card.score;
          row.cardItems = card.items.map((x) => ({ key: x.key, status: x.status, ...(x.turnSeq ? { turnSeq: x.turnSeq } : {}) }));
          row.tip = card.tip;
          row.moments = card.moments;
        }
      }
    } catch (err) {
      row.result = 'error';
      row.error = describeLlmError(err);
    }
    row.costUsd = spent() - before; // parallel ishda taxminiy (boshqa sessiyalar ham qo'shiladi)
    return row;
  }

  try {
    let next = 0;
    const done: number[] = [];
    async function worker(): Promise<void> {
      while (next < plan.length && !stopped) {
        const total = spent();
        const avg = done.length ? total / done.length : 0;
        const remaining = plan.length - done.length;
        if (total >= budget || (done.length >= 3 && total + avg * remaining > budget * 1.0001)) {
          stopped = `byudjet: sarflangan $${total.toFixed(3)}, taxmin jami $${(total + avg * remaining).toFixed(2)} > $${budget}`;
          return;
        }
        const p = plan[next++]!;
        const r = await runOne(p.s, p.style);
        done.push(1);
        rows.push(r);
        console.log(
          `[${rows.length}/${plan.length}] ${p.s.id} · ${STYLE_LABEL[p.style]} → ${r.result}${r.endReason ? ` (${r.endReason})` : ''} · ${r.turns.length} navbat` +
            ` · sabab: ${r.hiddenTurn ?? '-'} · yakun g/i/s ${r.final ? `${r.final.anger ?? '-'}/${r.final.trust}/${r.final.patience}` : '-'}` +
            ` · ball ${r.skillScore ?? '-'} · karta ${r.cardScore ?? '-'} · jami $${spent().toFixed(3)}${r.error ? ` · XATO ${r.error}` : ''}`,
        );
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } finally {
    await pool.end();
  }

  // --- Hisobot ----------------------------------------------------------
  rows.sort((a, b) => a.scenarioId.localeCompare(b.scenarioId) || styles.indexOf(a.style) - styles.indexOf(b.style));
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, 'runs.json'), JSON.stringify(rows, null, 2));
  const table = [
    "| Ssenariy | Uslub | Natija | Navbat | Sabab (navbat) | Yakun jahl/ishonch/sabr | Ball | Karta |",
    '|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.scenarioId} | ${STYLE_LABEL[r.style]} | ${r.result}${r.endReason ? ` (${r.endReason})` : ''} | ${r.turns.length} | ${r.hiddenTurn ?? '—'} | ` +
        `${r.final ? `${r.final.anger ?? '-'}/${r.final.trust}/${r.final.patience}` : '—'} | ${r.skillScore ?? '—'} | ${r.cardScore ?? '—'} |`,
    ),
  ];
  const byStyle = styles.map((st) => {
    const xs = rows.filter((r) => r.style === st);
    const won = xs.filter((r) => r.result === 'won').length;
    const lost = xs.filter((r) => r.result === 'lost').length;
    return `${STYLE_LABEL[st]}: ${won} yutdi, ${lost} yutqazdi, ${xs.length - won - lost} ochiq/boshqa (jami ${xs.length})`;
  });
  const stageCost = new Map<string, number>();
  for (const e of events) stageCost.set(e.stage, (stageCost.get(e.stage) ?? 0) + (e.usage ? priceCall(e.usage) : 0));
  const text = [
    ...table,
    '',
    ...byStyle,
    '',
    `Haqiqiy sarf: $${spent().toFixed(4)} (${events.length} LLM chaqiruv)`,
    ...[...stageCost.entries()].map(([k, v]) => `  ${k}: $${v.toFixed(4)}`),
    stopped ? `TO'XTATILDI — ${stopped}` : '',
  ].join('\n');
  writeFileSync(resolve(OUT_DIR, 'report.md'), text);
  console.log(`\n${text}\n\nNatija: ${resolve(OUT_DIR, 'runs.json')}`);
  if (stopped) process.exitCode = 2;
}

main().catch((err: unknown) => {
  console.error(`XATO: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
