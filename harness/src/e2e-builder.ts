/**
 * FAQAT HARNESS. Ssenariy builder e2e (Part 2): HAQIQIY server + HTTP API.
 *
 *  1. Rollar: sotuvchi ssenariy yarata olmaydi (403), rahbar — oladi.
 *  2. Ssenariy A — to'liq qo'lda (POST /scenarios/validate -> POST /scenarios).
 *  3. Ssenariy B — erkin matndan "AI bilan to'ldirish" (POST /scenarios/ai-draft) -> saqlash.
 *  4. Har biri 8 navbatdan: YAXSHI, O'RTA (xato qilib, tuzaladi), YOMON sotuvchi.
 *  5. "Sinab ko'rish" (POST /scenarios/try) — saqlamasdan 2 navbat.
 *
 *   npm run e2e:builder           (DB ishlab turishi kerak; server o'zi ishga tushiriladi)
 * Natija: <repo>/tts_test_output/e2e_builder/ (git'ga kirmaydi).
 */
import './env.js';

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEMO_BUSINESS_ID, DEMO_SELLER_USER_ID, DEMO_USER_ID } from './demo-env.js';
import { harnessRoot } from './env.js';

const PORT = Number(process.env.E2E_BUILDER_PORT ?? 5196);
const BASE = `http://127.0.0.1:${PORT}/api/v1/training`;
const OUT_DIR = resolve(harnessRoot, '..', 'tts_test_output', 'e2e_builder');
const MANAGER = { 'x-business-id': DEMO_BUSINESS_ID, 'x-user-id': DEMO_USER_ID };
const SELLER = { 'x-business-id': DEMO_BUSINESS_ID, 'x-user-id': DEMO_SELLER_USER_ID };

async function api<T>(method: string, path: string, body?: unknown, headers = MANAGER): Promise<{ status: number; json: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as T };
}

/** A — to'liq qo'lda yaratilgan ssenariy. */
const MANUAL = {
  title_uz: 'Narxni boshqa markaz bilan solishtirayotgan ona',
  description_uz: "Ona qizi uchun ikki markazni solishtiryapti. Boshqa joy arzonroq deb eshitgan, juda band, tez qaror qilmoqchi.",
  difficulty: 3,
  call_direction: 'outbound',
  relationship: 'new_lead',
  persona: {
    gender: 'female',
    age: { min: 36, max: 44 },
    role: 'parent',
    name_pool: ['Dildora', 'Nargiza', 'Feruza'],
    backstory: "Qizi (15 yosh) dasturlashga qiziqadi. Ona ishda juda band, qo'shnisi boshqa markaz arzonroq deb aytgan.",
    relation: 'mother',
    situation: { money: 'medium', busy: 'very_busy', studied_before: false },
  },
  hidden_reason: "Arzonlik emas, qizining xavfsizligi muhim: dars kechqurun tugasa qizi uyga yolg'iz qaytishidan qo'rqadi.",
  real_objection: "Boshqa joyda arzonroq ekan, nega sizlarga ko'proq to'lashim kerak?",
  success_condition: "Sotuvchi farqni aniq tushuntirsa, dars vaqti va xavfsizlik haqidagi xavotirini topib javob bersa — sinov darsiga yoziladi.",
  hangup_condition: "Sotuvchi boshqa markazni yomonlasa yoki bosim qilsa.",
  emotion: {
    baseline: { anger: 25, trust: 35, interest: 45, patience: 45 },
    volatility: 'medium',
    may_hang_up: true,
    traits: ['shoshqaloq', 'ishonchsiz'],
    triggers: {
      anger_up: ['uzun gapirish', 'savolga javob bermaslik'],
      anger_down: ['qisqa va aniq javob'],
      trust_up: ['aniq raqam va dalil'],
      trust_down: ['boshqa markazni yomonlash'],
      interest_up: ['qizining kelajagi haqida'],
      interest_down: ['umumiy maqtov'],
    },
  },
  behavior: { default_formality: 'siz', allow_sen_when_angry: false, sarcasm: 1, insult_level: 1, randomization_notes: [] },
  voice: { profile: 'auto', base_style: 'A busy mother on a short break at work, speaks quickly.' },
};

/** B — erkin matn ("AI bilan to'ldirish"). */
const AI_TEXT =
  "45 yoshli ota qo'ng'iroq qilyapti. O'g'li 2 oy o'qib, tashlab ketgan. Ota pulini qaytarishni talab qilmoqda, jahli chiqqan, " +
  "sababini ochiq aytmaydi. Aslida o'g'li mentor bilan kelisha olmagan va uyalib uyda aytmagan. Ota hurmat bilan gapirilsa yumshaydi.";

const LINES: Record<'manual' | 'ai', Record<'good' | 'medium' | 'bad', string[]>> = {
  manual: {
    good: [
      "Assalomu alaykum! IT Live markazidan. Qizingiz uchun ariza qoldirgan ekansiz — bir daqiqa vaqtingiz bormi, qisqa gaplashamiz.",
      "Tushunaman, bandsiz. Qisqa so'rasam: qizingiz uchun eng muhimi nima — narxmi, sifatmi yoki dars vaqtimi?",
      "Haqlisiz, narx muhim. Biz bilan farq: guruhda 8 kishi, har darsda mentor tekshiradi, oyiga 690 000 so'm. Boshqa markazda guruh necha kishi ekan?",
      "Yaxshi savol. Sizni yana nima xavotirga solyapti — vaqtmi, yo'lmi?",
      "Tushundim — kechki darsdan keyin qizingiz yolg'iz qaytishi tashvishli. Bizda shanba va yakshanba kunduzi soat 10 dagi guruh bor.",
      "Kunduzgi guruhda qizingiz uyga yorug'da qaytadi. Xohlasangiz, sinov darsida o'zingiz ham ko'rib ketasiz.",
      "Shanba soat 10 ga sinov darsiga yozib qo'yaymi? Bepul, majburiyat yo'q.",
      "Rahmat! Manzil va vaqtni Telegramga yuboraman. Qizingizga omad!",
    ],
    medium: [
      "Assalomu alaykum! IT Live markazidan. Bizda zo'r dasturlash kurslari bor, qizingiz uchun ajoyib bo'ladi!",
      "Kurslarimiz juda sifatli, mentorlar tajribali, bitiruvchilar ishga joylashgan, zamonaviy xonalar bor, kompyuterlar yangi…",
      "Kechirasiz, ko'p gapirib yubordim. Siz uchun eng muhimi nima — narxmi yoki boshqa narsa?",
      "Tushunaman. Boshqa markaz arzon bo'lsa, farqni aniq aytay: guruhda 8 kishi, mentor har darsda tekshiradi. U yerda guruh necha kishi?",
      "Sizni yana nima xavotirga solyapti? Ochiq aytsangiz, yechim topamiz.",
      "Tushundim, kechki vaqt tashvishli ekan. Bizda dam olish kunlari kunduzgi guruh bor, soat 10 da.",
      "Shanba kuni soat 10 ga bepul sinov darsiga yozib qo'yaymi?",
      "Rahmat, ma'lumotni Telegramga yuboraman.",
    ],
    bad: [
      "Assalomu alaykum. Bizda kurslar bor, yozilasizmi?",
      "Boshqa markazlar yomon, ularda sifat yo'q. Bizga yoziling.",
      "Narxi 690 000. Bu arzon. Yozamizmi?",
      "Kurslarimiz sifatli, mentorlar tajribali. Yozamizmi?",
      "Bugun yozilmasangiz joy qolmaydi.",
      "Boshqa markazga borsangiz pulingiz kuyadi, aytib qo'yay.",
      "Xo'sh, qaror qildingizmi?",
      "Yozilasizmi yo'qmi?",
    ],
  },
  ai: {
    good: [
      "Assalomu alaykum, IT Live markazi, eshitaman. Qanday yordam bera olaman?",
      "Tushunaman, sizni bezovta qilgan narsa jiddiy. Iltimos, nima bo'lganini batafsil aytib bering — o'g'lingiz nega to'xtatdi?",
      "To'g'ri, pul masalasini ham albatta hal qilamiz. Avval tushunay: o'g'lingiz mashg'ulotlarda o'zini qanday his qilgan edi?",
      "Ochiq aytganingiz uchun rahmat. Mentor bilan kelisha olmagan bo'lsa — bu bizning ham kamchiligimiz.",
      "Taklifim: o'g'lingiz boshqa mentor guruhiga o'tadi, birinchi oy bepul. Agar yoqmasa, qolgan pulni qaytaramiz.",
      "Ertaga o'g'lingiz bilan kelsangiz, yangi mentor bilan tanishtiraman. Qaror keyin sizniki.",
      "Ertaga soat 5 da kelasizmi? Men shaxsan kutib olaman.",
      "Rahmat, ota. O'g'lingizni kutamiz.",
    ],
    medium: [
      "Assalomu alaykum, IT Live. Nima masala?",
      "Qaytarish bo'yicha qoidalarimiz bor, shartnomada yozilgan. Qoidaga ko'ra pul qaytarilmaydi.",
      "Kechirasiz, qoida haqida gapirib yubordim. Avval sizni tushunay: o'g'lingiz nega to'xtatdi?",
      "Tushunaman, bu yoqimsiz. O'g'lingiz mashg'ulotlarda nima bo'lganini aytganmi?",
      "Mentor bilan kelisha olmagan bo'lsa, bu bizning kamchiligimiz. Boshqa mentorga o'tkazishimiz mumkin.",
      "Birinchi oy bepul bo'ladi, yoqmasa qolgan pulni qaytaramiz.",
      "Ertaga o'g'lingiz bilan kelib, yangi mentor bilan tanishasizmi?",
      "Rahmat, kutamiz.",
    ],
    bad: [
      "Allo, IT Live. Nima kerak?",
      "Pul qaytarilmaydi, shartnomani o'qing.",
      "O'g'lingiz o'zi dangasa bo'lsa kerak, bizda hammasi zo'r.",
      "Shartnomada yozilgan, pul qaytarilmaydi.",
      "Baqirmang, men ishimni qilyapman.",
      "Pul qaytarilmaydi, tushunyapsizmi?",
      "Boshqa gap bo'lmasa, xayr.",
      "Xo'sh?",
    ],
  },
};

interface TurnDebug {
  state: { trust: number; interest: number; patience: number; emotion?: { anger: number; formality: string; revealed?: boolean } };
  latencyMs: number;
  usage?: { inputTokens: number; outputTokens: number; reasoningTokens?: number };
  costUsd: number;
  scenario?: {
    corrections: string[];
    warnedNow: boolean;
    revealedNow: boolean;
    revealTooEarly: boolean;
    hangup: string | null;
    mistakes: string[];
    insult: { text: string; whitelisted: boolean } | null;
    goodQuestions: number;
    agreeBlocked: boolean;
    fallback: string | null;
    formality: string;
    llmCalls: number;
  };
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 90; i += 1) {
    try {
      const r = await fetch(`${BASE}/archetypes`, { headers: MANAGER });
      if (r.ok) return;
    } catch {
      // hali ishga tushmagan
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('server 90 s ichida ishga tushmadi');
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const server = spawn(process.execPath, ['--env-file-if-exists=.env', '--import', 'tsx', 'src/server.ts'], {
    cwd: harnessRoot,
    env: { ...process.env, HARNESS_PORT: String(PORT), DEMO_PRESENTATION: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog: string[] = [];
  server.stdout.on('data', (d) => serverLog.push(String(d)));
  server.stderr.on('data', (d) => serverLog.push(String(d)));
  const report: Record<string, unknown> = {};
  try {
    await waitForServer();

    // --- 1. Rollar ---------------------------------------------------------
    const me = await api<{ canManageScenarios: boolean }>('GET', '/me');
    const meSeller = await api<{ canManageScenarios: boolean }>('GET', '/me', undefined, SELLER);
    const forbidden = await api<{ error: string; message: string }>('POST', '/scenarios', { scenario: MANUAL }, SELLER);
    report.roles = { manager: me.json.canManageScenarios, seller: meSeller.json.canManageScenarios, sellerCreate: forbidden.status, msg: forbidden.json?.message };
    console.log('Rollar:', JSON.stringify(report.roles));

    // --- 2. A — qo'lda ------------------------------------------------------
    const stamp = Date.now().toString(36).slice(-4);
    const manual = { ...MANUAL, id: `e2e_qolda_${stamp}` };
    const badCheck = await api<{ ok: boolean; issues: unknown[] }>('POST', '/scenarios/validate', {
      scenario: { ...manual, difficulty: 9, emotion: { ...manual.emotion, traits: ['iliq', 'jahldor'] } },
    });
    const check = await api<{ ok: boolean; issues: unknown[]; warnings: string[] }>('POST', '/scenarios/validate', { scenario: manual });
    const savedA = await api<{ scenario: { id: string } }>('POST', '/scenarios', { scenario: manual });
    report.manual = { invalidExample: badCheck.json, check: check.json, saveStatus: savedA.status };
    console.log(`A (qo'lda): tekshiruv ok=${check.json.ok} · saqlash HTTP ${savedA.status} · noto'g'ri namuna xatolari:`, JSON.stringify(badCheck.json.issues));

    // --- 3. B — AI bilan to'ldirish -----------------------------------------
    const t0 = Date.now();
    const draft = await api<{ ok: boolean; scenario: Record<string, unknown>; issues: unknown[]; warnings: string[]; attempts: number }>(
      'POST',
      '/scenarios/ai-draft',
      { text: AI_TEXT },
    );
    const draftMs = Date.now() - t0;
    writeFileSync(resolve(OUT_DIR, 'ai-draft.json'), JSON.stringify(draft.json, null, 2));
    const aiScenario: Record<string, unknown> = { ...draft.json.scenario, id: `e2e_ai_${stamp}` };
    const savedB = await api<{ scenario: { id: string } }>('POST', '/scenarios', { scenario: aiScenario });
    report.ai = { ok: draft.json.ok, issues: draft.json.issues, warnings: draft.json.warnings, attempts: draft.json.attempts, ms: draftMs, saveStatus: savedB.status };
    console.log(`B (AI): ok=${draft.json.ok} urinish=${draft.json.attempts} ${draftMs} ms · saqlash HTTP ${savedB.status}`);
    console.log(`   AI taklifi: ${String(aiScenario.title_uz)} · qiyinlik ${String(aiScenario.difficulty)} · xususiyatlar ${JSON.stringify((aiScenario.emotion as { traits?: unknown })?.traits)}`);

    // --- 4. "Sinab ko'rish" (saqlamasdan) ------------------------------------
    const seller = { name: 'Jasur', gender: 'male', age: 25 };
    const try1 = await api<{ customerReply: string; persona: unknown; state: unknown; meta: { latencyMs: number } }>('POST', '/scenarios/try', {
      scenario: manual,
      seller,
      transcript: [],
      sellerText: LINES.manual.good[0],
    });
    const try2 = await api<{ customerReply: string }>('POST', '/scenarios/try', {
      scenario: manual,
      seller,
      persona: try1.json.persona,
      state: try1.json.state,
      transcript: [
        { speaker: 'seller', text: LINES.manual.good[0] },
        { speaker: 'customer', text: try1.json.customerReply },
      ],
      sellerText: LINES.manual.good[1],
    });
    report.try = [try1.json.customerReply, try2.json.customerReply];
    console.log(`Sinab ko'rish: 1) ${try1.json.customerReply}\n               2) ${try2.json.customerReply}`);

    // --- 5. O'yinlar --------------------------------------------------------
    const runs: unknown[] = [];
    for (const [key, id] of [
      ['manual', manual.id],
      ['ai', aiScenario.id as string],
    ] as const) {
      for (const kind of ['good', 'medium', 'bad'] as const) {
        const started = await api<{ sessionId: string; persona: { name: string; age: number; role: string }; openingLine: string | null }>(
          'POST',
          '/sessions',
          { scenarioId: id, seller },
        );
        if (started.status !== 200) throw new Error(`sessiya ochilmadi: ${started.status} ${JSON.stringify(started.json)}`);
        const label = `${key === 'manual' ? 'A qo\'lda' : 'B AI'} · ${kind === 'good' ? 'YAXSHI' : kind === 'medium' ? "O'RTA" : 'YOMON'}`;
        console.log(`\n=== ${label} — ${started.json.persona.name}, ${started.json.persona.age} — ${started.json.persona.role}${started.json.openingLine ? `\n    ochilish: ${started.json.openingLine}` : ''}`);
        const rows: unknown[] = [];
        let ended: string | null = null;
        for (const [i, line] of LINES[key][kind].entries()) {
          const t = await api<{ customerReply: string; ended: boolean; outcome: string | null; endReason: string | null; debug: TurnDebug }>(
            'POST',
            `/sessions/${started.json.sessionId}/turn`,
            { text: line },
          );
          if (t.status !== 200) {
            console.log(`  [${i + 1}] XATO HTTP ${t.status}: ${JSON.stringify(t.json).slice(0, 200)}`);
            rows.push({ turn: i + 1, error: t.status });
            break;
          }
          const d = t.json.debug;
          const m = d.scenario;
          const row = {
            turn: i + 1,
            seller: line,
            reply: t.json.customerReply,
            anger: d.state.emotion?.anger,
            trust: d.state.trust,
            interest: d.state.interest,
            patience: d.state.patience,
            formality: d.state.emotion?.formality,
            warnedNow: m?.warnedNow,
            revealedNow: m?.revealedNow,
            revealTooEarly: m?.revealTooEarly,
            goodQuestions: m?.goodQuestions,
            mistakes: m?.mistakes,
            corrections: m?.corrections,
            insult: m?.insult?.text ?? null,
            agreeBlocked: m?.agreeBlocked,
            fallback: m?.fallback,
            hangup: m?.hangup,
            latencyMs: d.latencyMs,
            inputTokens: d.usage?.inputTokens ?? 0,
            outputTokens: d.usage?.outputTokens ?? 0,
            costUsd: d.costUsd,
            llmCalls: m?.llmCalls,
          };
          rows.push(row);
          console.log(
            `  [${row.turn}] S: ${line}\n      M: ${row.reply}\n      jahl=${row.anger} ishonch=${row.trust} qiziqish=${row.interest} sabr=${row.patience} forma=${row.formality}` +
              `${row.mistakes?.length ? ` xato=${row.mistakes.join(',')}` : ''}${row.warnedNow ? ' ⚠OGOHLANTIRDI' : ''}${row.revealedNow ? ' 🔓SABAB OCHILDI' : ''}${row.revealTooEarly ? ' (erta)' : ''}` +
              `${row.corrections?.length ? ` tuzatish=${row.corrections.join(',')}` : ''}${row.insult ? ` haqorat="${row.insult}"` : ''}${row.agreeBlocked ? ' rozilik-bloklandi' : ''}` +
              `${row.hangup ? ` GO'SHAK=${row.hangup}` : ''} · ${row.latencyMs} ms · ${row.inputTokens}/${row.outputTokens} tok · $${Number(row.costUsd).toFixed(5)}`,
          );
          if (t.json.ended) {
            ended = `${t.json.outcome} (${t.json.endReason})`;
            console.log(`      >>> tugadi: ${ended}`);
            break;
          }
        }
        runs.push({ label, persona: started.json.persona, rows, ended });
      }
    }
    report.runs = runs;

    // --- 6. Tahrir / nusxa / arxiv -------------------------------------------
    const dup = await api<{ scenario: { id: string } }>('POST', `/scenarios/${manual.id}/duplicate`, {});
    const arch = await api('POST', `/scenarios/${dup.json.scenario.id}/archive`, { archived: true });
    const upd = await api('PUT', `/scenarios/${manual.id}`, { scenario: { ...manual, title_uz: `${manual.title_uz} (tahrir)` } });
    const list = await api<{ scenarios: Array<{ id: string }> }>('GET', '/scenarios', undefined, SELLER);
    report.crud = {
      duplicate: dup.status,
      archive: arch.status,
      update: upd.status,
      sellerSeesA: list.json.scenarios.some((x) => x.id === manual.id),
      sellerSeesArchived: list.json.scenarios.some((x) => x.id === dup.json.scenario.id),
    };
    console.log('\nCRUD:', JSON.stringify(report.crud));
  } finally {
    server.kill('SIGTERM');
    writeFileSync(resolve(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(resolve(OUT_DIR, 'server.log'), serverLog.join(''));
  }
  console.log(`\nNatija: ${resolve(OUT_DIR, 'report.json')}`);
}

main().catch((err: unknown) => {
  console.error(`XATO: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
