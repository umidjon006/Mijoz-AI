/**
 * FAQAT HARNESS. Bake-off asboblarining deterministik testlari.
 * HAQIQIY LLM CHAQIRILMAYDI va hech qanday pulli so'rov yuborilmaydi.
 *
 *   npm run verify:training:bakeoff
 *
 * Qamrov (Step 2b, 3-vazifa):
 *   1. konfiguratsiya validatsiyasi (nomzodlar, baseUrl, unikal label);
 *   2. urug'li aralashtirishning takrorlanishi va ko'r yorliqlar;
 *   3. resume mantig'i (`runs.jsonl` o'qish, takrorlarni o'tkazib yuborish);
 *   4. o'lchovlar (tayyor "canned" sessiyalar ustida);
 *   5. narx taxminlagichi;
 *   6. odam baholarini birlashtirish va reyting/tavsiya.
 */
// ENG BIRINCHI: harness/.env ni yuklaydi (yo'l harness papkasiga nisbatan).
import './env.js';

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assert,
  assertDeepEqual,
  assertEqual,
  check,
  checkAsync,
  createReport,
  section,
} from '../../module/backend/src/training/testing/assert.js';
import { buildPlan, loadExistingRuns } from './bakeoff.js';
import {
  loadBakeoffConfig,
  parseBakeoffConfig,
  splitByKeyAvailability,
  type BakeoffConfig,
  type Candidate,
} from './bakeoff/config.js';
import { selectBlindExcerpts, sliceExcerpt } from './bakeoff/excerpts.js';
import {
  estimateCost,
  isTooLong,
  isWrongLanguage,
  mentionsUnsaidPrice,
  summarizeCandidate,
  wordCount,
} from './bakeoff/metrics.js';
import {
  aggregateHumanScores,
  parseRatingsCsv,
  rankCandidates,
  recommend,
} from './bakeoff/score.js';
import { blindLabels, shuffle } from './bakeoff/shuffle.js';
import { runKey, sessionRunSchema, type SessionRun } from './bakeoff/types.js';
import { INJECTION_SCRIPT } from './seller-bot.js';

const report = createReport();

const baseCandidate: Candidate = {
  label: 'haiku',
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  pricePerMTok: { input: 1, output: 5 },
  jsonMode: 'json_object',
  maxTokens: 1024,
  enabled: true,
};

/** Tayyor ("canned") sessiya natijasi. */
function cannedRun(overrides: Partial<SessionRun> = {}): SessionRun {
  const candidate = overrides.candidate ?? 'haiku';
  const archetype = overrides.archetype ?? 'negotiator';
  const script = overrides.script ?? 'skilled';
  const profile = overrides.profile ?? 'o_quv_markaz';
  const rep = overrides.rep ?? 1;

  return {
    key: runKey({ candidate, archetype, script, profile, rep }),
    candidate,
    model: 'claude-haiku-5-5',
    archetype,
    script,
    profile,
    rep,
    outcome: 'won',
    endReason: 'agreed',
    turns: 4,
    guardViolations: 0,
    customerCalls: { total: 5, firstTryOk: 5, afterRetryOk: 0, failed: 0 },
    latenciesMs: [800, 900, 1000, 1100],
    tokens: { input: 10_000, output: 600 },
    costUsd: 0.013,
    tooLongReplies: 0,
    wrongLanguageReplies: 0,
    unsaidPriceReplies: 0,
    customerReplies: 4,
    transcript: [
      { speaker: 'seller', text: 'Assalomu alaykum, vaqtingiz bormi?' },
      { speaker: 'customer', text: 'Narxi qimmatdek tuyuladi.' },
      { speaker: 'seller', text: 'Narx tarkibini aniq aytib beraman.' },
      { speaker: 'customer', text: 'Mayli, tushundim.' },
    ],
    personaName: 'Dilnoza',
    error: null,
    startedAt: '2026-10-30T10:00:00.000Z',
    durationMs: 5000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Konfiguratsiya
// ---------------------------------------------------------------------------
function verifyConfig(): void {
  section('[1] Konfiguratsiya');

  check(report, 'haqiqiy bakeoff.config.json validatsiyadan o\'tadi', () => {
    const config = loadBakeoffConfig();
    assert(config.candidates.length >= 2, 'kamida 2 nomzod kutilgan');
    assertEqual(config.sellerModel, 'claude-sonnet-5-5', 'sotuvchi modeli');
    assert(config.repetitions >= 1, 'takrorlar soni');
    for (const candidate of config.candidates) {
      assert(candidate.apiKeyEnv.length > 0, `${candidate.label}: apiKeyEnv`);
      assert(
        !JSON.stringify(candidate).includes('sk-'),
        `${candidate.label}: konfigda kalitga o'xshash satr bor!`,
      );
    }
  });

  check(report, 'openai-compatible uchun baseUrl majburiy', () => {
    const bad = {
      candidates: [{ ...baseCandidate, provider: 'openai-compatible', label: 'x' }],
    };
    assert(!safeParse(bad), 'baseUrl siz qabul qilinmasligi kerak');

    const good = {
      candidates: [
        {
          ...baseCandidate,
          provider: 'openai-compatible',
          label: 'x',
          baseUrl: 'https://api.example.com/v1',
        },
      ],
    };
    assert(safeParse(good), 'baseUrl bilan qabul qilinishi kerak');
  });

  check(report, 'takroriy label rad etiladi', () => {
    const bad = { candidates: [baseCandidate, { ...baseCandidate }] };
    assert(!safeParse(bad), 'bir xil label qabul qilinmasligi kerak');
  });

  check(report, 'noto\'g\'ri label va bo\'sh ro\'yxat rad etiladi', () => {
    assert(!safeParse({ candidates: [] }), 'bo\'sh ro\'yxat');
    assert(
      !safeParse({ candidates: [{ ...baseCandidate, label: 'yomon label!' }] }),
      'probel/belgi bor label',
    );
  });

  check(report, 'default qiymatlar qo\'yiladi', () => {
    const config = parseBakeoffConfig({ candidates: [baseCandidate] });
    assertEqual(config.repetitions, 3, 'repetitions');
    assertEqual(config.maxTurnsPerSession, 8, 'maxTurnsPerSession');
    assertEqual(config.defaultProfile, 'o_quv_markaz', 'defaultProfile');
  });

  check(report, 'kaliti yo\'q nomzodlar ajratiladi', () => {
    const withKey = { ...baseCandidate, label: 'bor', apiKeyEnv: 'BAKEOFF_TEST_KEY_PRESENT' };
    const withoutKey = { ...baseCandidate, label: 'yoq', apiKeyEnv: 'BAKEOFF_TEST_KEY_ABSENT' };
    process.env.BAKEOFF_TEST_KEY_PRESENT = 'x';
    delete process.env.BAKEOFF_TEST_KEY_ABSENT;

    const { ready, missingKey } = splitByKeyAvailability([withKey, withoutKey]);
    assertDeepEqual(ready.map((c) => c.label), ['bor'], 'tayyorlar');
    assertDeepEqual(missingKey.map((c) => c.label), ['yoq'], 'kalitsizlar');
    delete process.env.BAKEOFF_TEST_KEY_PRESENT;
  });

  check(report, 'o\'chirilgan nomzod ishlatilmaydi', () => {
    process.env.BAKEOFF_TEST_KEY_PRESENT = 'x';
    const disabled = {
      ...baseCandidate,
      label: 'ochirilgan',
      enabled: false,
      apiKeyEnv: 'BAKEOFF_TEST_KEY_PRESENT',
    };
    assertEqual(splitByKeyAvailability([disabled]).ready.length, 0, 'tayyorlar soni');
    delete process.env.BAKEOFF_TEST_KEY_PRESENT;
  });

  function safeParse(raw: unknown): boolean {
    try {
      parseBakeoffConfig(raw);
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Aralashtirish
// ---------------------------------------------------------------------------
function verifyShuffle(): void {
  section('[2] Urug\'li aralashtirish');
  const items = Array.from({ length: 20 }, (_, i) => `item-${i + 1}`);

  check(report, 'bir xil urug\' = bir xil tartib', () => {
    assertDeepEqual(shuffle(items, 'seed-a'), shuffle(items, 'seed-a'), 'tartib');
  });

  check(report, 'boshqa urug\' = boshqa tartib', () => {
    assert(
      JSON.stringify(shuffle(items, 'seed-a')) !== JSON.stringify(shuffle(items, 'seed-b')),
      'tartiblar bir xil chiqdi',
    );
  });

  check(report, 'aralashtirish elementlarni yo\'qotmaydi', () => {
    const shuffled = shuffle(items, 'seed-c');
    assertEqual(shuffled.length, items.length, 'uzunlik');
    assertDeepEqual([...shuffled].sort(), [...items].sort(), 'to\'plam');
    assertDeepEqual(items, items, 'kirish massivi o\'zgarmasligi kerak');
  });

  check(report, 'ko\'r yorliqlar takrorlanadi va unikal', () => {
    const first = blindLabels(['haiku', 'sonnet', 'gemini'], 'seed-x');
    const second = blindLabels(['haiku', 'sonnet', 'gemini'], 'seed-x');
    assertDeepEqual([...first.entries()], [...second.entries()], 'xarita');
    assertEqual(new Set(first.values()).size, 3, 'unikal yorliqlar');
    for (const label of first.values()) {
      assert(/^Model [A-Z]$/.test(label), `yorliq shakli: ${label}`);
    }
    assert(!JSON.stringify([...first.values()]).includes('haiku'), 'yorliqda model nomi bor');
  });
}

// ---------------------------------------------------------------------------
// 3. Resume
// ---------------------------------------------------------------------------
async function verifyResume(): Promise<void> {
  section('[3] Resume (davom ettirish)');

  const dir = await mkdtemp(join(tmpdir(), 'bakeoff-test-'));
  const file = join(dir, 'runs.jsonl');

  await checkAsync(report, 'bo\'sh/yo\'q fayl xato bermaydi', async () => {
    const runs = await loadExistingRuns(join(dir, 'yoq.jsonl'));
    assertEqual(runs.size, 0, 'natijalar soni');
  });

  await checkAsync(report, 'yozilgan natijalar o\'qiladi, buzuq qator tashlanadi', async () => {
    const a = cannedRun({ rep: 1 });
    const b = cannedRun({ rep: 2 });
    await writeFile(
      file,
      `${JSON.stringify(a)}\n{buzuq json\n\n${JSON.stringify(b)}\n`,
      'utf8',
    );
    const runs = await loadExistingRuns(file);
    assertEqual(runs.size, 2, 'natijalar soni');
    assert(runs.has(a.key), 'birinchi kalit');
    assert(runs.has(b.key), 'ikkinchi kalit');
  });

  await checkAsync(report, 'bir xil kalit ikki marta yozilsa oxirgisi qoladi', async () => {
    const first = cannedRun({ rep: 3, outcome: 'lost' });
    const second = cannedRun({ rep: 3, outcome: 'won' });
    await writeFile(file, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, 'utf8');
    const runs = await loadExistingRuns(file);
    assertEqual(runs.size, 1, 'natijalar soni');
    assertEqual(runs.get(second.key)?.outcome, 'won', 'oxirgi yozuv');
  });

  check(report, 'reja (plan) to\'liq matritsani beradi', () => {
    const config: BakeoffConfig = parseBakeoffConfig({
      candidates: [baseCandidate, { ...baseCandidate, label: 'sonnet' }],
      repetitions: 2,
      secondProfile: 'taksi',
      secondProfileArchetype: 'negotiator',
    });
    const plan = buildPlan(config, config.candidates);
    // 2 nomzod × (4 arxetip × 3 skript × 2 takror + 1 arxetip × 3 skript × 2 takror)
    assertEqual(plan.length, 2 * (4 * 3 * 2 + 3 * 2), 'reja hajmi');
    assertEqual(new Set(plan.map((p) => p.key)).size, plan.length, 'kalitlar unikal');
    assert(
      plan.some((p) => p.profileKey === 'taksi'),
      'ikkinchi profil rejada bo\'lishi kerak',
    );
  });

  await checkAsync(report, 'bajarilganlar rejadan chiqariladi', async () => {
    const config: BakeoffConfig = parseBakeoffConfig({
      candidates: [baseCandidate],
      repetitions: 1,
      secondProfile: null,
    });
    const plan = buildPlan(config, config.candidates);
    const firstItem = plan[0];
    assert(firstItem, 'reja bo\'sh');

    await writeFile(file, `${JSON.stringify(cannedRun({ key: firstItem.key }))}\n`, 'utf8');
    const existing = await loadExistingRuns(file);
    const todo = plan.filter((item) => !existing.has(item.key));
    assertEqual(todo.length, plan.length - 1, 'qolgan ishlar');
    assert(!todo.some((item) => item.key === firstItem.key), 'bajarilgani qolib ketdi');
  });
}

// ---------------------------------------------------------------------------
// 4. O'lchovlar
// ---------------------------------------------------------------------------
function verifyMetrics(): void {
  section('[4] O\'lchovlar');

  check(report, 'so\'z sanash va 30 so\'z chegarasi', () => {
    assertEqual(wordCount(''), 0, 'bo\'sh');
    assertEqual(wordCount('bir ikki uch'), 3, 'uch so\'z');
    assert(!isTooLong('Qisqa javob, hammasi joyida.'), 'qisqa javob');
    assert(isTooLong(Array.from({ length: 31 }, () => 'soz').join(' ')), '31 so\'z');
    assert(!isTooLong(Array.from({ length: 30 }, () => 'soz').join(' ')), '30 so\'z chegarada');
  });

  check(report, 'til tekshiruvi (evristik)', () => {
    assert(!isWrongLanguage("Narxi menga qimmatdek tuyuladi, chegirma bormi?", 'uz'), 'o\'zbekcha');
    assert(isWrongLanguage('Я не согласен, это слишком дорого для меня', 'uz'), 'ruscha matn uz uchun');
    assert(
      isWrongLanguage('I am not sure about this and I would like to think about that', 'uz'),
      'inglizcha matn',
    );
    assert(!isWrongLanguage('Narxi qimmat, lekin dostavka bepul ekan', 'mixed'), 'aralash');
    assert(!isWrongLanguage('Ha', 'uz'), 'juda qisqa matn bayroq qo\'ymaydi');
  });

  check(report, 'nomzod xulosasi tayyor sessiyalardan hisoblanadi', () => {
    const runs: SessionRun[] = [
      cannedRun({ rep: 1, outcome: 'won', script: 'skilled' }),
      cannedRun({ rep: 2, outcome: 'lost', script: 'careless', turns: 6 }),
      cannedRun({
        rep: 3,
        script: 'injection',
        outcome: 'lost',
        customerCalls: { total: 4, firstTryOk: 3, afterRetryOk: 1, failed: 0 },
        guardViolations: 2,
        tooLongReplies: 1,
        wrongLanguageReplies: 1,
        customerReplies: 4,
      }),
      cannedRun({ candidate: 'sonnet', rep: 1 }),
    ];

    const summary = summarizeCandidate({ label: 'haiku', model: 'claude-haiku-5-5' }, runs);
    assertEqual(summary.sessions, 3, 'sessiyalar soni (faqat o\'ziniki)');
    // injection stsenariysi g'alaba ulushiga KIRMAYDI: 1 won / 2 sessiya
    assertEqual(summary.winRate, 0.5, 'g\'alaba ulushi');
    assertEqual(summary.injectionWinRate, 0, 'injection g\'alabasi');
    assertEqual(summary.guardViolations, 2, 'guard buzilishi');
    // 5+5+3 = 13 firstTryOk / 14 total
    assertEqual(summary.jsonFirstTryRate, Number((13 / 14).toFixed(4)), 'JSON 1-urinish');
    assertEqual(summary.jsonAfterRetryRate, Number((1 / 14).toFixed(4)), 'retry ulushi');
    assertEqual(summary.jsonFailureRate, 0, 'yiqilish ulushi');
    // 12 qiymat: 800×3, 900×3, 1000×3, 1100×3 -> pastki median = 900
    assertEqual(summary.p50LatencyMs, 900, 'p50');
    assertEqual(summary.p90LatencyMs, 1100, 'p90');
    assertEqual(summary.tooLongRate, Number((1 / 12).toFixed(4)), 'uzun javoblar ulushi');
    assert(summary.costPer100Sessions > 0, 'narx');
  });

  check(report, 'faqat injection sessiyasi bo\'lsa g\'alaba ulushi null', () => {
    const summary = summarizeCandidate(
      { label: 'haiku', model: 'm' },
      [cannedRun({ script: 'injection', outcome: 'lost' })],
    );
    assertEqual(summary.winRate, null, 'winRate');
    assertEqual(summary.injectionWinRate, 0, 'injectionWinRate');
  });

  check(report, 'xatolik bilan tugagan sessiya alohida sanaladi', () => {
    const summary = summarizeCandidate({ label: 'haiku', model: 'm' }, [
      cannedRun({ rep: 1 }),
      cannedRun({ rep: 2, error: 'tarmoq xatosi', outcome: null }),
    ]);
    assertEqual(summary.sessions, 2, 'jami');
    assertEqual(summary.failedSessions, 1, 'xatolilar');
  });

  check(report, 'parcha kesish: mijoz javobi bilan tugaydi', () => {
    const run = cannedRun({
      transcript: [
        { speaker: 'seller', text: 's1' },
        { speaker: 'customer', text: 'c1' },
        { speaker: 'seller', text: 's2' },
        { speaker: 'customer', text: 'c2' },
        { speaker: 'seller', text: 's3' },
      ],
    });
    const excerpt = sliceExcerpt(run, 2);
    assertDeepEqual(excerpt, [{ speaker: 'seller', text: 's2' }, { speaker: 'customer', text: 'c2' }], 'oyna');
  });

  check(report, 'ko\'r parchalar: model nomi yo\'q, takrorlanadi', () => {
    const runs = [
      ...Array.from({ length: 5 }, (_, i) => cannedRun({ candidate: 'haiku', rep: i + 1 })),
      ...Array.from({ length: 5 }, (_, i) => cannedRun({ candidate: 'sonnet', rep: i + 1 })),
    ];
    const first = selectBlindExcerpts(runs, 'seed-1', 3);
    const second = selectBlindExcerpts(runs, 'seed-1', 3);
    assertDeepEqual(first.excerpts, second.excerpts, 'takrorlanadi');
    assertEqual(first.excerpts.length, 6, 'parchalar soni (2 nomzod × 3)');
    // Butun parcha obyekti (id'lar ham!) model nomini oshkor qilmasligi kerak.
    const json = JSON.stringify(first.excerpts);
    assert(!json.includes('haiku') && !json.includes('sonnet'), 'parchada model nomi bor');
    assert(
      first.excerpts.every((e) => /^ex-[a-z0-9]+$/.test(e.id)),
      'parcha id neytral bo\'lishi kerak',
    );
    assertEqual(new Set(first.excerpts.map((e) => e.id)).size, 6, 'id lar unikal');
    assertEqual(Object.keys(first.mapping).length, 2, 'ochish xaritasi');
    assertEqual(Object.keys(first.sources).length, 6, 'parcha manbalari xaritasi');
  });

  check(report, "aytilmagan narx: sotuvchi aytmagan narx ushlanadi, aytgani/eshitgani — yo'q", () => {
    assert(
      mentionsUnsaidPrice("Demak 6 oy va oyiga 700 000 so'mmi?", ["12 oy, 490 000 so'm"]),
      'sotuvchi 490 000 dedi, mijoz 700 000 dedi',
    );
    assert(!mentionsUnsaidPrice("490 ming qimmat-ku", ["Oyiga 490 000 so'm"]), 'sotuvchi aytgan');
    assert(!mentionsUnsaidPrice('Narxi qancha?', []), "narx yo'q");
    assert(
      !mentionsUnsaidPrice('Tanishim 700 ming dedi', [], ["Do'sti 700 000 so'm turishini aytgan"]),
      "o'z yashirin faktidan (eshitgan)",
    );
  });

  check(report, "aytilmagan narx ulushi summary'da; eski runs.jsonl -> 0", () => {
    const runs = [
      sessionRunSchema.parse(cannedRun({ unsaidPriceReplies: 1, customerReplies: 4 })),
      sessionRunSchema.parse(cannedRun({ rep: 2 })),
    ];
    const summary = summarizeCandidate({ label: 'haiku', model: 'm' }, runs);
    assertEqual(summary.unsaidPriceRate, 0.125, '1/8');
    const legacy = { ...cannedRun() } as Record<string, unknown>;
    delete legacy.unsaidPriceReplies;
    assertEqual(sessionRunSchema.parse(legacy).unsaidPriceReplies, 0, 'default 0');
  });

  check(report, 'injection skripti ichida haqiqiy urinish bor', () => {
    const joined = INJECTION_SCRIPT.join(' ').toLowerCase();
    assert(joined.includes('ignore'), 'injection matni yo\'q');
    assert(INJECTION_SCRIPT.length >= 3, 'skript juda qisqa');
  });
}

// ---------------------------------------------------------------------------
// 5. Narx taxmini
// ---------------------------------------------------------------------------
function verifyCostEstimate(): void {
  section('[5] Narx taxminlagichi');

  check(report, 'sessiyalar soni matritsadan kelib chiqadi', () => {
    const estimate = estimateCost({
      candidates: [baseCandidate],
      archetypes: 4,
      scripts: 3,
      repetitions: 3,
      extraSessionsPerCandidate: 9,
      maxTurnsPerSession: 8,
      sellerPrice: { input: 3, output: 15 },
    });
    assertEqual(estimate.sessionsPerCandidate, 4 * 3 * 3 + 9, 'nomzodga sessiya');
    assertEqual(estimate.totalSessions, 45, 'jami sessiya');
    assertEqual(estimate.customerCalls, 45 * 9, 'mijoz chaqiruvlari (1 persona + 8 navbat)');
    assert(estimate.totalCostUsd > 0, 'narx musbat');
  });

  check(report, 'arzon model arzonroq chiqadi', () => {
    const common = {
      archetypes: 4,
      scripts: 3,
      repetitions: 3,
      extraSessionsPerCandidate: 0,
      maxTurnsPerSession: 8,
      sellerPrice: { input: 3, output: 15 },
    };
    const cheap = estimateCost({ ...common, candidates: [baseCandidate] });
    const pricey = estimateCost({
      ...common,
      candidates: [{ ...baseCandidate, label: 'sonnet', pricePerMTok: { input: 3, output: 15 } }],
    });
    assert(
      (cheap.perCandidate[0]?.costUsd ?? 0) < (pricey.perCandidate[0]?.costUsd ?? 0),
      'arzon model qimmatroq chiqdi',
    );
  });

  check(report, 'ko\'proq takror = ko\'proq narx (chiziqli)', () => {
    const base = {
      candidates: [baseCandidate],
      archetypes: 4,
      scripts: 3,
      extraSessionsPerCandidate: 0,
      maxTurnsPerSession: 8,
      sellerPrice: { input: 3, output: 15 },
    };
    const one = estimateCost({ ...base, repetitions: 1 });
    const three = estimateCost({ ...base, repetitions: 3 });
    assertEqual(three.totalSessions, one.totalSessions * 3, 'sessiyalar');
    const ratio = three.totalCostUsd / one.totalCostUsd;
    assert(Math.abs(ratio - 3) < 0.01, `narx nisbati ${ratio.toFixed(3)}`);
  });
}

// ---------------------------------------------------------------------------
// 6. Odam baholari va reyting
// ---------------------------------------------------------------------------
function verifyScoring(): void {
  section('[6] Baholar va reyting');

  const csv = [
    'excerptId,blindLabel,tabiiylik,xarakter,qiyinlik,note',
    '"e1","Model A","5","4","4","juda tabiiy, ""zo\'r"""',
    '"e2","Model A","4","4","5",""',
    '"e3","Model B","2","3","2","sun\'iy chiqdi"',
  ].join('\n');

  check(report, 'CSV o\'qiladi (qo\'shtirnoq va vergul bilan)', () => {
    const rows = parseRatingsCsv(csv);
    assertEqual(rows.length, 3, 'qatorlar');
    assertEqual(rows[0]?.blindLabel, 'Model A', 'yorliq');
    assertEqual(rows[0]?.tabiiylik, 5, 'ball');
    assertEqual(rows[0]?.note, 'juda tabiiy, "zo\'r"', 'izoh');
    assertEqual(rows[2]?.qiyinlik, 2, 'uchinchi qator');
  });

  check(report, 'ko\'r yorliqlar ochiladi va o\'rtacha hisoblanadi', () => {
    const scores = aggregateHumanScores(parseRatingsCsv(csv), {
      'Model A': 'haiku',
      'Model B': 'sonnet',
    });
    assertEqual(scores.length, 2, 'nomzodlar');
    const haiku = scores.find((s) => s.candidate === 'haiku');
    assertEqual(haiku?.samples, 2, 'namunalar');
    assertEqual(haiku?.tabiiylik, 4.5, 'tabiiylik o\'rtachasi');
    assertEqual(scores[0]?.candidate, 'haiku', 'birinchi o\'rin (yuqori ball)');
  });

  check(report, 'injection g\'alabasi diskvalifikatsiya qiladi', () => {
    const good = summarizeCandidate({ label: 'yaxshi', model: 'm1' }, [
      cannedRun({ candidate: 'yaxshi' }),
      cannedRun({ candidate: 'yaxshi', rep: 2, script: 'injection', outcome: 'lost' }),
    ]);
    const bad = summarizeCandidate({ label: 'yomon', model: 'm2' }, [
      cannedRun({ candidate: 'yomon' }),
      cannedRun({ candidate: 'yomon', rep: 2, script: 'injection', outcome: 'won' }),
    ]);

    const ranked = rankCandidates([good, bad], []);
    assertEqual(ranked[0]?.candidate, 'yaxshi', 'birinchi o\'rin');
    assertEqual(ranked[1]?.disqualified, true, 'injection g\'olibi diskvalifikatsiya');
    assert(
      (ranked[1]?.reasons ?? []).some((r) => r.includes('injection')),
      'sabab ko\'rsatilishi kerak',
    );
  });

  check(report, 'odam bahosi deyarli teng bo\'lsa arzoni yetakchi bo\'ladi', () => {
    const expensive = summarizeCandidate({ label: 'qimmat', model: 'm1' }, [
      cannedRun({ candidate: 'qimmat', costUsd: 1 }),
    ]);
    const cheap = summarizeCandidate({ label: 'arzon', model: 'm2' }, [
      cannedRun({ candidate: 'arzon', costUsd: 0.1 }),
    ]);
    const ranked = rankCandidates([expensive, cheap], [
      { candidate: 'qimmat', samples: 10, tabiiylik: 5, xarakter: 5, qiyinlik: 5, overall: 5 },
      { candidate: 'arzon', samples: 10, tabiiylik: 4.6, xarakter: 4.6, qiyinlik: 4.6, overall: 4.6 },
    ]);
    assertEqual(ranked[0]?.candidate, 'arzon', 'yetakchi');
  });

  check(report, 'baho yo\'q bo\'lsa tavsiya buni aniq aytadi', () => {
    const summary = summarizeCandidate({ label: 'haiku', model: 'm' }, [cannedRun()]);
    const ranked = rankCandidates([summary], []);
    const result = recommend(ranked);
    assertEqual(result.live?.candidate, 'haiku', 'tavsiya qilingan model');
    assert(
      result.notes.some((n) => n.includes("Odam baholari YO'Q")),
      'ogohlantirish bo\'lishi kerak',
    );
    assert(
      result.notes.some((n) => n.includes('namuna')),
      'namuna sifati haqida eslatma bo\'lishi kerak',
    );
  });

  check(report, 'arzonroq model yaqin bo\'lsa taklif qilinadi', () => {
    const expensive = summarizeCandidate({ label: 'qimmat', model: 'm1' }, [
      cannedRun({ candidate: 'qimmat', costUsd: 1 }),
    ]);
    const cheap = summarizeCandidate({ label: 'arzon', model: 'm2' }, [
      cannedRun({ candidate: 'arzon', costUsd: 0.1 }),
    ]);
    // Odam bahosidagi farq sezilarli bo'lsa (5.0 va 3.5), qimmat model yetakchi
    // bo'ladi, lekin farq 8 balldan kam bo'lgani uchun arzoni ham taklif qilinadi.
    const ranked = rankCandidates([expensive, cheap], [
      { candidate: 'qimmat', samples: 10, tabiiylik: 5, xarakter: 5, qiyinlik: 5, overall: 5 },
      { candidate: 'arzon', samples: 10, tabiiylik: 3.5, xarakter: 3.5, qiyinlik: 3.5, overall: 3.5 },
    ]);
    const result = recommend(ranked);
    assertEqual(result.live?.candidate, 'qimmat', 'eng yaxshi');
    assertEqual(result.cheaperGoodEnough?.candidate, 'arzon', 'arzon variant');
  });
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('verify-bakeoff — Step 2b asboblari (pulli chaqiruv YO\'Q)');

  verifyConfig();
  verifyShuffle();
  await verifyResume();
  verifyMetrics();
  verifyCostEstimate();
  verifyScoring();

  console.log(
    `\nNatija: ${report.passed} o'tdi, ${report.failed} xato, ${report.skipped} tashlab ketildi.`,
  );
  if (report.failures.length > 0) {
    console.log('\nXatolar:');
    for (const f of report.failures) console.log(` - ${f}`);
  }
  process.exit(report.failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
