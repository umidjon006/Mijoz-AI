/**
 * FAQAT HARNESS. Ssenariylar e2e sinovi: HAQIQIY prompt + Gemini miya + DB.
 * Har ssenariy: YAXSHI sotuvchi (empatiya, aniq javob) va YOMON sotuvchi
 * (chetlab o'tish, takrorlash, bosim) — 8 navbatdan; (a) ssenariy AYOL sotuvchi
 * bilan qo'shimcha (erkak murojaati chiqmasligi tekshiriladi); taqqoslash uchun
 * eski arxetip rejimi (bazaviy) ham.
 *
 *   npm run e2e:scenarios                # hammasi
 *   npm run e2e:scenarios -- --only angry_repeated_call
 * Natija: <repo>/tts_test_output/e2e_scenarios/ (git'ga kirmaydi).
 */
import './env.js';

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createTrainingEngine } from '../../module/backend/src/training/engine.js';
import { describeLlmError } from '../../module/backend/src/training/errors.js';
import type { GetBusinessProfile } from '../../module/backend/src/training/ports.js';
import { addressRule, findWrongAddress } from '../../module/backend/src/training/scenario/address.js';
import type { SellerProfile } from '../../module/backend/src/training/scenario/schema.js';
import type { LlmCallEvent } from './bakeoff/types.js';
import { resolveBusinessData } from './business-data.js';
import { DEMO_BUSINESS_ID, DEMO_CONTEXT, ensureDemoRows } from './demo-env.js';
import { envStr, harnessRoot } from './env.js';
import { createTrainerLlm, describeLlm } from './llm-factory.js';
import { priceCall } from './pricing.js';
import { syncScenarios } from './scenarios.js';
import { appDatabaseUrl, createPool, createWithTenant } from './withTenant.js';

const OUT_DIR = resolve(harnessRoot, '..', 'tts_test_output', 'e2e_scenarios');

const LINES: Record<string, { good: string[]; bad: string[] }> = {
  angry_repeated_call: {
    good: [
      "Assalomu alaykum! IT Live markazidan qo'ng'iroq qilyapman. Avvalo kecha bir necha marta bezovta qilganimiz uchun chin dildan uzr so'rayman.",
      "Haqsiz, uch marta qo'ng'iroq qilish noto'g'ri bo'lgan — arizangiz uch xodimga tushib qolgan ekan. Bu bizning xatomiz.",
      "Sizni boshqa bezovta qilmaslik uchun nima qulay: bitta xabar yuboraymi yoki o'zingiz qulay vaqtni aytasizmi?",
      "Tushundim, ishdasiz. Faqat bitta savol: farzandingiz uchun qaysi yo'nalishni qidirayotgan edingiz?",
      "Juda yaxshi. Unda Telegramda qisqa ma'lumot yuboraman — narx, vaqt, manzil, hammasi bir joyda.",
      "Tartib haqida aytganingiz to'g'ri — endi arizangiz faqat menda, boshqa hech kim qo'ng'iroq qilmaydi.",
      "Xabarni o'qib chiqqach savolingiz bo'lsa, shu raqamga yozing. Shanba kuni ertalab bir marta qo'ng'iroq qilsam bo'ladimi?",
      "Rahmat, sabringiz uchun. Yana bir bor uzr — yaxshi kun tilayman.",
    ],
    bad: [
      "Assalomu alaykum! IT Live markazidan. Bizda zo'r dasturlash kurslari bor, hozir chegirma ketyapti!",
      "Kecha kim qo'ng'iroq qilganini bilmayman. Kurslarimiz juda sifatli, mentorlar tajribali.",
      "Hozir yozilsangiz chegirma bor, faqat bugun. Yozib qo'yaymi?",
      "Yo'q, eshiting, kurslarimiz juda sifatli, mentorlar tajribali, bitiruvchilar ishga joylashgan.",
      "Qaror qiling, joylar tugayapti. Ismingizni yozib qo'yaman.",
      "Nega jahl qilyapsiz? Men ishimni qilyapman. Kurslarimiz sifatli.",
      "Bugun to'lasangiz 10 foiz chegirma. Kartangiz bormi?",
      "Xo'sh, yozamizmi yoki yo'qmi? Tezroq ayting.",
    ],
  },
  debtor_parent: {
    good: [
      "Assalomu alaykum! IT Live markazidan qo'ng'iroq qilyapman. O'g'lingiz mashg'ulotlarda juda yaxshi natija ko'rsatyapti, avvalo shuni aytmoqchi edim.",
      "Bir narsa bo'yicha maslahatlashmoqchi edim — oylik to'lov muddati o'tib ketgan ekan. Hammasi joyidami, biror muammo bo'lmadimi?",
      "Tushunaman, hayotda har xil vaziyat bo'ladi. Qiyinchilik bo'lsa ochiq aytsangiz, birga yechim topamiz.",
      "Rahmat, ochiq aytganingiz uchun. Ish masalasi og'ir, sizni tushunaman.",
      "O'g'lingizning o'qishi to'xtab qolmasligi uchun to'lovni ikki qismga bo'lsak bo'ladi: hozir bir qismi, qolgani oy oxirida.",
      "Yoki muddatni ikki haftaga sursak ham bo'ladi — sizga qaysi biri qulay?",
      "Juda yaxshi. Buni rahbariyat bilan kelishib, sizga bugun yozib yuboraman.",
      "O'g'lingiz o'qishda davom etadi, xavotir olmang. Tushunganingiz uchun rahmat!",
    ],
    bad: [
      "Assalomu alaykum. IT Live markazidan. Sizda qarz bor, qachon to'laysiz?",
      "Muddati ikki hafta oldin tugagan. Bugun to'lashingiz kerak.",
      "Bunaqa bahonalarni ko'p eshitganmiz. Qoidalar hamma uchun bir xil.",
      "Agar bugun to'lamasangiz, o'g'lingizni darsga kiritmaymiz.",
      "Nega to'lamayapsiz? Boshqa ota-onalar vaqtida to'layapti.",
      "Qarzni to'lash kerak, tushunyapsizmi? Qachon to'laysiz, aniq ayting.",
      "Bizda bo'lib to'lash yo'q. Hammasini to'lash kerak.",
      "Xo'sh, bugun to'laysizmi yo'qmi?",
    ],
  },
  grandmother_grandson: {
    good: [
      'Va alaykum assalom, buvijon! IT Live markazidan. Eshitaman, sizga qanday yordam bera olaman?',
      'Juda yaxshi qilibsiz, buvi. Nevarangiz necha yoshda?',
      "Biz bolalarga kompyuterda o'yin o'ynashni emas, o'yinni o'zi yasashni o'rgatamiz. Xuddi hunar o'rgangandek.",
      "Ha, xuddi duradgorlik kabi — faqat taxta o'rniga kompyuterda ishlaydi. Keyin shu hunar bilan pul topish mumkin.",
      "Xavotir olmang, nevarangiz qiziqadimi-yo'qmi, birinchi kelganda o'zimiz bilib olamiz.",
      "Shanba kuni nevarangiz bilan birga kelsangiz, o'zingiz ham ko'rasiz, choy ichib gaplashamiz.",
      "Manzil oddiy: stomatologiya ko'chasi, yangi prokuratura ro'parasida. Nevarangiz ham yo'lni biladi.",
      "Unda shanba kuni soat o'nda kutamiz, buvijon. Salomat bo'ling!",
    ],
    bad: [
      'Assalomu alaykum. Bizda Frontend, Backend va Full-stack yo\'nalishlari bor. Qaysi biri kerak?',
      'Frontend — bu React, JavaScript; Backend — Node.js, Python, Laravel. Qaysi stack sizga yaqin?',
      "Oldin nevarangiz Git va GitHub'ni bilishi kerak, keyin API bilan ishlaymiz.",
      "Buvi, buni tushunishingiz shart emas. To'lovni qachon qilasiz?",
      'Juda sekin gapiryapsiz, menda vaqt kam. Yozamizmi?',
      'Full-stack bootcamp 6 oy, deployment, CI/CD ham bor.',
      'Siz baribir tushunmaysiz, nevarangiz o\'zi qo\'ng\'iroq qilsin.',
      "Xo'sh, yozamizmi yoki yo'qmi?",
    ],
  },
};

const MALE: SellerProfile = { name: 'Jasur', gender: 'male', age: 25 };
const FEMALE: SellerProfile = { name: 'Dilnoza', gender: 'female', age: 24 };

interface Row {
  turn: number;
  seller: string;
  reply: string;
  anger: number | null;
  trust: number;
  interest: number;
  formality: string;
  formalityUsed: string | null;
  insult: string;
  corrections: string;
  safety: number;
  fallback: string | null;
  hangup: string | null;
  wrongMaleForms: string[];
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  llmCalls: number;
  reason: string;
  patience: number;
  warnedNow: boolean;
  revealedNow: boolean;
  personalAttack: boolean;
  error?: string;
}

interface RunResult {
  label: string;
  scenarioId: string | null;
  seller: SellerProfile | null;
  persona: string;
  rows: Row[];
  ended: string | null;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined;
  const business = resolveBusinessData(envStr('HARNESS_PROFILE'));
  const profile = business.profile;
  const events: LlmCallEvent[] = [];
  const resolved = createTrainerLlm({ profile, onCall: (e) => events.push(e) });
  console.log(`LLM: ${describeLlm(resolved)}`);

  await ensureDemoRows();
  const pool = createPool(appDatabaseUrl());
  const withTenant = createWithTenant(pool);
  console.log(await syncScenarios(withTenant, DEMO_BUSINESS_ID));
  const getBusinessProfile: GetBusinessProfile = async () => profile;
  const engine = createTrainingEngine({
    withTenant,
    getBusinessProfile,
    llm: resolved.llm,
    priceCall,
    logger: { info: () => undefined, warn: (_o, m) => console.log(`      [log] ${m}`), error: (_o, m) => console.log(`      [err] ${m}`) },
  });

  const plan: Array<{ label: string; scenarioId: string | null; lines: string[]; seller: SellerProfile | null }> = [];
  for (const [id, l] of Object.entries(LINES)) {
    if (only && id !== only) continue;
    plan.push({ label: `${id} · YAXSHI · erkak`, scenarioId: id, lines: l.good, seller: MALE });
    plan.push({ label: `${id} · YOMON · erkak`, scenarioId: id, lines: l.bad, seller: MALE });
  }
  if (!only || only === 'angry_repeated_call') {
    plan.push({ label: 'angry_repeated_call · YOMON · AYOL', scenarioId: 'angry_repeated_call', lines: LINES.angry_repeated_call!.bad, seller: FEMALE });
  }
  if (!only) plan.push({ label: 'BAZAVIY (arxetip problematic, eski rejim)', scenarioId: null, lines: LINES.angry_repeated_call!.good, seller: null });

  const runs: RunResult[] = [];
  try {
    for (const p of plan) {
      console.log(`\n=== ${p.label}`);
      const started = p.scenarioId
        ? await engine.startSession(DEMO_CONTEXT, { scenarioId: p.scenarioId, seller: p.seller as SellerProfile })
        : await engine.startSession(DEMO_CONTEXT, { archetypeKey: 'problematic', direction: 'outbound' });
      const persona = `${started.persona.name}, ${started.persona.age}, ${started.persona.gender ?? '?'} — ${started.persona.role}`;
      console.log(`    persona: ${persona}${started.openingLine ? ` · ochilish: "${started.openingLine}"` : ''}`);
      const run: RunResult = { label: p.label, scenarioId: p.scenarioId, seller: p.seller, persona, rows: [], ended: null };
      const rule = p.seller ? addressRule(started.persona.age, p.seller) : null;
      for (let i = 0; i < p.lines.length; i += 1) {
        const seller = p.lines[i] as string;
        const evStart = events.length;
        try {
          const t = await engine.takeTurn(DEMO_CONTEXT, { sessionId: started.sessionId, sellerText: seller });
          const m = t.meta.scenario;
          const ev = events.slice(evStart);
          const row: Row = {
            turn: i + 1,
            seller,
            reply: t.customerReply,
            anger: t.state.emotion?.anger ?? null,
            trust: t.state.trust,
            interest: t.state.interest,
            formality: m?.formality ?? '-',
            formalityUsed: m?.formalityUsed ?? null,
            insult: m?.insult ? `${m.insult.text}${m.insult.whitelisted ? ' (oq ro\'yxat)' : ' (RO\'YXATDA YO\'Q)'}${m.insult.allowed ? '' : ' RUXSATSIZ'}` : '',
            corrections: m?.corrections.join(',') ?? '',
            safety: m?.safetyBlocks ?? 0,
            fallback: m?.fallback ?? null,
            hangup: m?.hangup ?? null,
            wrongMaleForms: rule && p.seller?.gender === 'female' ? findWrongAddress(t.customerReply, rule) : [],
            latencyMs: t.meta.latencyMs,
            inputTokens: ev.reduce((s, e) => s + (e.usage?.inputTokens ?? 0), 0),
            outputTokens: ev.reduce((s, e) => s + (e.usage?.outputTokens ?? 0), 0),
            costUsd: ev.reduce((s, e) => s + (e.usage ? priceCall(e.usage) : 0), 0),
            llmCalls: ev.length,
            reason: m?.emotion.reason ?? '',
            patience: t.state.patience,
            warnedNow: m?.warnedNow ?? false,
            revealedNow: m?.revealedNow ?? false,
            personalAttack: (m?.corrections ?? []).some((c) => c.startsWith('personal_attack')),
          };
          run.rows.push(row);
          console.log(
            `  [${row.turn}] S: ${seller}\n      M: ${row.reply}\n      anger=${row.anger ?? '-'} trust=${row.trust} interest=${row.interest} sabr=${row.patience} forma=${row.formality}/${row.formalityUsed ?? '?'}` +
              `${row.warnedNow ? ' ⚠OGOHLANTIRDI' : ''}${row.revealedNow ? ' 🔓SABAB' : ''}` +
              `${row.insult ? ` haqorat="${row.insult}"` : ''}${row.corrections ? ` tuzatish=${row.corrections}` : ''}${row.safety ? ` safety=${row.safety}` : ''}` +
              `${row.hangup ? ` GO'SHAK=${row.hangup}` : ''} · ${row.latencyMs} ms · ${row.inputTokens}/${row.outputTokens} tok · $${row.costUsd.toFixed(5)} · ${row.reason}`,
          );
          if (t.ended) {
            run.ended = `${t.outcome} (${t.endReason})`;
            console.log(`      >>> sessiya tugadi: ${run.ended}`);
            break;
          }
        } catch (err) {
          run.rows.push({
            turn: i + 1, seller, reply: '', anger: null, trust: 0, interest: 0, formality: '-', formalityUsed: null, insult: '', corrections: '',
            safety: 0, fallback: null, hangup: null, wrongMaleForms: [], latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, llmCalls: 0, reason: '',
            patience: 0, warnedNow: false, revealedNow: false, personalAttack: false,
            error: describeLlmError(err),
          });
          console.log(`  [${i + 1}] XATO: ${describeLlmError(err)}`);
          break;
        }
      }
      runs.push(run);
    }
  } finally {
    await pool.end();
  }

  // --- Hisobot ----------------------------------------------------------
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, 'runs.json'), JSON.stringify(runs, null, 2));
  const turnEvents = events.filter((e) => e.stage === 'training.turn');
  const jsonFails = turnEvents.filter((e) => e.outcome === 'invalid_json' || e.outcome === 'schema').length;
  const summary: string[] = ['| Yugurish | navbat | latency median/o\'rt (ms) | kirish tok o\'rt | chiqish tok o\'rt | $/navbat o\'rt | tuzatishlar | safety | go\'shak/yakun |', '|---|---|---|---|---|---|---|---|---|'];
  for (const r of runs) {
    const ok = r.rows.filter((x) => !x.error);
    summary.push(
      `| ${r.label} | ${ok.length} | ${median(ok.map((x) => x.latencyMs)).toFixed(0)}/${mean(ok.map((x) => x.latencyMs)).toFixed(0)} | ${mean(ok.map((x) => x.inputTokens)).toFixed(0)} | ${mean(ok.map((x) => x.outputTokens)).toFixed(0)} | ${mean(ok.map((x) => x.costUsd)).toFixed(5)} | ${ok.filter((x) => x.corrections).length} | ${ok.reduce((s, x) => s + x.safety, 0)} | ${r.ended ?? '-'} |`,
    );
  }
  const female = runs.find((r) => r.seller?.gender === 'female');
  const maleForms = female ? female.rows.flatMap((x) => x.wrongMaleForms) : [];
  const text = [
    ...summary,
    '',
    `JSON xatolari (training.turn, xom chaqiruvlar): ${jsonFails} / ${turnEvents.length}`,
    `Ayol sotuvchi yugurishida yakuniy javoblarda erkak murojaati: ${maleForms.length ? maleForms.join(', ') : "YO'Q"}` +
      ` (tuzatishlar: ${female ? female.rows.filter((x) => x.corrections.includes('address_gender')).length : 0})`,
  ].join('\n');
  writeFileSync(resolve(OUT_DIR, 'report.md'), text);
  console.log(`\n${text}\n\nNatija: ${resolve(OUT_DIR, 'runs.json')}`);
}

main().catch((err: unknown) => {
  console.error(`XATO: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
