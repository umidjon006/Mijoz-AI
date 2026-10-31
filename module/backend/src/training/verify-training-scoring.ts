/**
 * verify-training-scoring.ts — Step 4 Phase A testlari.
 * HAQIQIY LLM CHAQIRILMAYDI: hamma joyda `FakeTrainerLlm`.
 *
 * Ishga tushirish: `npm run verify:training:scoring` (harness ichidan).
 * DB kerak bo'lmasa: `SKIP_DB=1` (faqat sof funksiyalar sinaladi).
 *
 * Qamrov (Step 4, A6):
 *   1. rubrika: vaznlar yig'indisi 100, har mezonda 4 ta tavsif;
 *   2. verifyEvidence: apostrof variantlari, tinish belgilari, minimal uzunlik,
 *      faqat sotuvchi navbati, mijoz iqtibosi rad etiladi, navbat chegarasidan
 *      oshib ketadigan moslik yo'q;
 *   3. ball hisobi: null'lar, vaznlar, hammasi null;
 *   4. muhim lahza nomzodlari va filtri;
 *   5. dalil yiqilganda baho null + `rejectedQuote` saqlanadi;
 *   6. DB: versiyalangan qayta baholash eski versiyani saqlaydi, `getPlaybook`
 *      null bo'lsa standart rubrika, past sifat (retry), kam mazmun;
 *   7. route'lar: yashirin ma'lumot tugashdan oldin yo'q / keyin bor,
 *      tenant va foydalanuvchi izolyatsiyasi (404), validatsiya.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import Fastify from 'fastify';
import { Pool } from 'pg';

import { getArchetype } from './archetypes.js';
import { createTrainingEngine } from './engine.js';
import type { PersonaCard } from './persona.js';
import { makePersonaCardSchema } from './persona.js';
import type { GetBusinessProfile, TrainingContext, TrainingTx, WithTenant } from './ports.js';
import { profileSchema, type BusinessProfile } from './profile-schema.js';
import { registerTrainingRoutes, revealPersona } from './routes.js';
import {
  EVIDENCE_MIN_CHARS,
  EVIDENCE_MIN_WORDS,
  normalizeForEvidence,
  verifyEvidence,
  type EvidenceTurn,
} from './scoring/evidence.js';
import {
  computeMetrics,
  keyMomentCandidates,
  MAX_KEY_MOMENTS,
  type ScoringSession,
  type ScoringTurn,
} from './scoring/metrics.js';
import * as scoringRepo from './scoring/repo.js';
import {
  DEFAULT_TRAINING_RUBRIC,
  flattenCriteria,
  resolveRubric,
  type PlaybookSubset,
} from './scoring/rubric.js';
import {
  computeSkillScore,
  createScoringService,
  llmScoringSchema,
  processLlmScoring,
  type GetPlaybook,
} from './scoring/scoring.js';
import type { CriterionResult } from './scoring/scoring-types.js';
import {
  assert,
  assertDeepEqual,
  assertEqual,
  check,
  checkAsync,
  createReport,
  section,
  skip,
} from './testing/assert.js';
import { FakeTrainerLlm, fakePersona, fakeTurn } from './testing/fake-llm.js';

const here = dirname(fileURLToPath(import.meta.url));
const report = createReport();

function loadProfile(): BusinessProfile {
  const raw: unknown = JSON.parse(readFileSync(resolve(here, 'demo-profiles.json'), 'utf8'));
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    ([key]) => !key.startsWith('_'),
  );
  const first = entries[0];
  assert(first, 'demo profil topilmadi');
  return profileSchema.parse(first[1]);
}

const PROFILE = loadProfile();
const FIRST_OFFER = PROFILE.primaryOffers[0] as string;
const NEGOTIATOR = getArchetype('negotiator');
const OBJECTION_KEYS = ['price_too_high', 'no_time', 'needs_to_ask_family'];

function testPersona(direction: 'inbound' | 'outbound' = 'outbound'): PersonaCard {
  return makePersonaCardSchema({
    archetype: NEGOTIATOR,
    profile: PROFILE,
    direction,
    language: 'uz',
  }).parse(
    fakePersona({
      objectionKeys: OBJECTION_KEYS,
      severity: 3,
      focusOffer: FIRST_OFFER,
      direction,
    }),
  );
}

/** Sotuvchining mashqdagi gaplari — iqtiboslar shulardan olinadi. */
const SELLER_LINES = [
  "Assalomu alaykum, sizga qulay vaqtda qo'ng'iroq qildimmi?",
  "Hozirgi holatingiz haqida bir necha savol bersam bo'ladimi?",
  "Narx tarkibida nimalar borligini aniq raqamlar bilan aytib beraman.",
  "Ertaga soat o'n birda qayta aloqaga chiqsam, sizga qulay bo'ladimi?",
];

// ---------------------------------------------------------------------------
// 1. Rubrika
// ---------------------------------------------------------------------------
function verifyRubric(): void {
  section('[1] Rubrika');

  check(report, "vaznlar yig'indisi aynan 100", () => {
    const criteria = flattenCriteria(DEFAULT_TRAINING_RUBRIC);
    assertEqual(
      criteria.reduce((sum, c) => sum + c.weight, 0),
      100,
      'vaznlar',
    );
    assertEqual(criteria.length, 7, 'mezonlar soni');
  });

  check(report, 'har mezonda 0-3 uchun to\'rtta tavsif bor', () => {
    for (const c of flattenCriteria(DEFAULT_TRAINING_RUBRIC)) {
      for (const level of ['0', '1', '2', '3'] as const) {
        const text = c.rubric[level];
        assert(typeof text === 'string' && text.length > 10, `${c.code}: ${level} tavsifi yo'q`);
      }
      assert(/^[a-z][a-z0-9_]*$/.test(c.code), `${c.code}: kod snake_case emas`);
    }
  });

  check(report, 'mezon kodlari unikal', () => {
    const codes = flattenCriteria(DEFAULT_TRAINING_RUBRIC).map((c) => c.code);
    assertEqual(new Set(codes).size, codes.length, 'unikal kodlar');
  });

  check(report, 'getPlaybook null -> standart rubrika', () => {
    const resolved = resolveRubric(null);
    assertEqual(resolved.source, 'default', 'manba');
    assertEqual(resolved.totalWeight, 100, 'vazn');
  });

  check(report, 'playbook berilsa undan olinadi', () => {
    const playbook: PlaybookSubset = {
      categories: [
        {
          code: 'own',
          name: 'Tenant playbook',
          criteria: [
            {
              code: 'own_one',
              name: 'Birinchi mezon',
              weight: 60,
              rubric: { '0': 'yomon', '1': 'o\'rtacha', '2': 'yaxshi', '3': 'juda yaxshi' },
            },
            {
              code: 'own_two',
              name: 'Ikkinchi mezon',
              weight: 40,
              rubric: { '0': 'yomon', '1': 'o\'rtacha', '2': 'yaxshi', '3': 'juda yaxshi' },
            },
          ],
        },
      ],
    };
    const resolved = resolveRubric(playbook);
    assertEqual(resolved.source, 'playbook', 'manba');
    assertDeepEqual(resolved.criteria.map((c) => c.code), ['own_one', 'own_two'], 'mezonlar');
  });

  check(report, 'buzuq playbook standartga qaytadi', () => {
    const broken = { categories: [{ code: 'x', name: 'y', criteria: [] }] } as unknown;
    assertEqual(resolveRubric(broken as PlaybookSubset).source, 'default', 'manba');
  });
}

// ---------------------------------------------------------------------------
// 2. Dalil tekshiruvi
// ---------------------------------------------------------------------------
function verifyEvidenceRules(): void {
  section('[2] verifyEvidence');

  const turns: EvidenceTurn[] = [
    { seq: 1, speaker: 'customer', text: 'Narxi menga qimmatdek tuyuladi, chegirma bormi?' },
    { seq: 2, speaker: 'seller', text: "Narx tarkibida nimalar borligini aniq raqamlar bilan aytib beraman." },
    { seq: 3, speaker: 'customer', text: "Yaxshi, tushundim." },
    { seq: 4, speaker: 'seller', text: "Ertaga soat o'n birda qayta aloqaga chiqsam bo'ladimi?" },
  ];

  check(report, 'normalizatsiya: apostrof variantlari bir xil', () => {
    const forms = ["o'n birda", 'oʻn birda', 'o‘n birda', 'o’n birda', 'o`n birda'];
    const normalized = forms.map((f) => normalizeForEvidence(f));
    assertEqual(new Set(normalized).size, 1, `turli ko'rinishlar: ${normalized.join(' | ')}`);
  });

  check(report, 'normalizatsiya: tinish belgilari va bo\'shliqlar', () => {
    assertEqual(
      normalizeForEvidence('  Narx   tarkibida,  nimalar  borligini!!  '),
      'narx tarkibida nimalar borligini',
      'natija',
    );
  });

  check(report, 'to\'g\'ri iqtibos qabul qilinadi (apostrof boshqa ko\'rinishda)', () => {
    const result = verifyEvidence('Ertaga soat oʻn birda qayta aloqaga', turns, 4);
    assert(result.ok, `rad etildi: ${result.ok ? '' : result.reason}`);
    assertEqual(result.turnSeq, 4, 'navbat');
    assertEqual(result.matchedHint, true, 'matchedHint');
  });

  check(report, 'noto\'g\'ri seq berilsa ham to\'g\'ri navbat topiladi', () => {
    const result = verifyEvidence('narx tarkibida nimalar borligini', turns, 99);
    assert(result.ok, 'topilishi kerak');
    assertEqual(result.turnSeq, 2, 'navbat');
    assertEqual(result.matchedHint, false, 'matchedHint');
  });

  check(report, 'juda qisqa iqtibos rad etiladi', () => {
    const twoWords = verifyEvidence('narx tarkibida', turns, 2);
    assert(!twoWords.ok, 'qabul qilinmasligi kerak');
    assertEqual(twoWords.ok ? '' : twoWords.reason, 'too_short', 'sabab');

    // 3 so'z, lekin 12 belgidan kam
    const shortChars = verifyEvidence('a bc de', turns, 2);
    assert(!shortChars.ok, 'qabul qilinmasligi kerak');
    assertEqual(shortChars.ok ? '' : shortChars.reason, 'too_short', 'sabab');
    assert(EVIDENCE_MIN_WORDS === 3 && EVIDENCE_MIN_CHARS === 12, 'chegaralar o\'zgargan');
  });

  check(report, 'bo\'sh iqtibos rad etiladi', () => {
    for (const value of [null, undefined, '', '   ']) {
      const result = verifyEvidence(value, turns);
      assert(!result.ok, `"${String(value)}" qabul qilinmasligi kerak`);
      assertEqual(result.ok ? '' : result.reason, 'empty', 'sabab');
    }
  });

  check(report, 'mijoz gapidan olingan iqtibos rad etiladi', () => {
    const result = verifyEvidence('Narxi menga qimmatdek tuyuladi', turns, 1);
    assert(!result.ok, 'qabul qilinmasligi kerak');
    assertEqual(result.ok ? '' : result.reason, 'customer_turn', 'sabab');
  });

  check(report, 'transkriptda yo\'q iqtibos rad etiladi', () => {
    const result = verifyEvidence("Men sizga kafolat beraman albatta", turns);
    assert(!result.ok, 'qabul qilinmasligi kerak');
    assertEqual(result.ok ? '' : result.reason, 'not_found', 'sabab');
  });

  check(report, 'navbat chegarasidan oshib ketadigan moslik yo\'q', () => {
    // 2-navbat oxiri + 4-navbat boshi birga qidirilsa — topilmasligi kerak.
    const across = verifyEvidence('aytib beraman Ertaga soat', turns);
    assert(!across.ok, 'chegaradan oshgan moslik qabul qilindi');
    assertEqual(across.ok ? '' : across.reason, 'not_found', 'sabab');
  });
}

// ---------------------------------------------------------------------------
// 3. Ball hisobi
// ---------------------------------------------------------------------------
function criterion(code: string, weight: number, score: 0 | 1 | 2 | 3 | null): CriterionResult {
  return {
    code,
    name: code,
    weight,
    score,
    comment: 'izoh',
    evidenceQuote: score === null ? null : 'dalil matni bor',
    evidenceTurnSeq: score === null ? null : 2,
  };
}

function verifyScoreMath(): void {
  section('[3] Ball hisobi');

  check(report, 'hammasi 3 -> 100', () => {
    const result = computeSkillScore([criterion('a', 50, 3), criterion('b', 50, 3)]);
    assertEqual(result.skillScore, 100, 'skillScore');
  });

  check(report, 'vaznlar hisobga olinadi', () => {
    // (3/3*80 + 0/3*20) / 100 * 100 = 80
    const result = computeSkillScore([criterion('a', 80, 3), criterion('b', 20, 0)]);
    assertEqual(result.skillScore, 80, 'skillScore');
  });

  check(report, 'null baho NOLGA aylanmaydi (vaznidan chiqadi)', () => {
    // Faqat 'a' baholangan: (2/3*50)/50*100 = 66.7
    const result = computeSkillScore([criterion('a', 50, 2), criterion('b', 50, null)]);
    assertEqual(result.skillScore, 66.7, 'skillScore');
    assertEqual(result.scoredWeight, 50, 'scoredWeight');
    assertEqual(result.scoredCount, 1, 'scoredCount');

    // Agar null nol deb hisoblansa 33.3 chiqardi — bu xato bo'lardi.
    assert(result.skillScore !== 33.3, 'null nol deb hisoblangan');
  });

  check(report, 'hammasi null -> skillScore null', () => {
    const result = computeSkillScore([criterion('a', 50, null), criterion('b', 50, null)]);
    assertEqual(result.skillScore, null, 'skillScore');
    assertEqual(result.scoredWeight, 0, 'scoredWeight');
  });

  check(report, 'bo\'sh ro\'yxat -> null', () => {
    assertEqual(computeSkillScore([]).skillScore, null, 'skillScore');
  });

  check(report, 'o\'rta qiymatlar to\'g\'ri yaxlitlanadi', () => {
    // (1/3*100)/100*100 = 33.3
    assertEqual(computeSkillScore([criterion('a', 100, 1)]).skillScore, 33.3, 'skillScore');
  });
}

// ---------------------------------------------------------------------------
// 4. O'lchovlar va muhim lahzalar
// ---------------------------------------------------------------------------
function makeTurns(): ScoringTurn[] {
  const base = {
    flags: {
      objectionsRaised: [] as string[],
      objectionsResolved: [] as string[],
      needRevealed: false,
      guardViolations: 0,
    },
    promptVersion: 'training-v1',
  };
  return [
    { seq: 1, speaker: 'seller', text: SELLER_LINES[0] as string },
    {
      seq: 2,
      speaker: 'customer',
      text: 'Narxi menga qimmatdek tuyuladi.',
      stateAfter: {
        ...base,
        patience: 58,
        trust: 36,
        interest: 60,
        flags: { ...base.flags, objectionsRaised: ['price_too_high'] },
      },
    },
    { seq: 3, speaker: 'seller', text: SELLER_LINES[2] as string },
    {
      seq: 4,
      speaker: 'customer',
      text: 'Yaxshi, tushundim.',
      stateAfter: {
        ...base,
        patience: 59,
        trust: 50,
        interest: 62,
        flags: {
          ...base.flags,
          objectionsRaised: ['price_too_high'],
          objectionsResolved: ['price_too_high'],
        },
      },
    },
    { seq: 5, speaker: 'seller', text: SELLER_LINES[3] as string },
    {
      seq: 6,
      speaker: 'customer',
      text: "Mayli, ertaga gaplashamiz.",
      stateAfter: {
        ...base,
        patience: 40,
        trust: 52,
        interest: 62,
        flags: {
          ...base.flags,
          objectionsRaised: ['price_too_high'],
          objectionsResolved: ['price_too_high'],
        },
      },
    },
  ];
}

function verifyMetricsAndMoments(): void {
  section('[4] O\'lchovlar va muhim lahzalar');
  const persona = testPersona();
  const turns = makeTurns();
  const session: ScoringSession = {
    id: randomUUID(),
    archetypeKey: 'negotiator',
    status: 'ended',
    outcome: 'won',
    endReason: 'agreed',
    turnCount: 3,
    startedAt: new Date('2026-01-01T10:00:00Z'),
    endedAt: new Date('2026-01-01T10:04:30Z'),
  };

  check(report, 'o\'lchovlar transkriptdan hisoblanadi', () => {
    const metrics = computeMetrics(session, turns, NEGOTIATOR, persona);
    assertEqual(metrics.sellerTurns, 3, 'sellerTurns');
    assertEqual(metrics.customerTurns, 3, 'customerTurns');
    assertEqual(metrics.outcome, 'won', 'outcome');
    assertEqual(metrics.durationSec, 270, 'durationSec');
    assertEqual(metrics.objections.planned, 3, 'planned');
    assertDeepEqual(metrics.objections.resolved, ['price_too_high'], 'resolved');
    assertDeepEqual(metrics.objections.unresolved, ['no_time', 'needs_to_ask_family'], 'unresolved');
    assertEqual(metrics.needRevealed, null, 'needRevealed (hiddenNeed yo\'q arxetip)');
    assertEqual(metrics.series.length, 3, 'series');
    assertEqual(metrics.finalState?.trust, 52, 'oxirgi trust');
    assert(metrics.sellerWordShare > 0 && metrics.sellerWordShare < 1, 'so\'z ulushi');
  });

  check(report, 'muhim lahza nomzodlari: e\'tiroz va o\'zgarishlar', () => {
    const candidates = keyMomentCandidates(turns, persona);
    assert(candidates.length <= MAX_KEY_MOMENTS, 'nomzodlar soni chegarasi');
    const seqs = candidates.map((c) => c.turnSeq);
    assertDeepEqual([...seqs].sort((a, b) => a - b), seqs, 'seq bo\'yicha tartiblangan');
    assert(seqs.includes(4), 'e\'tiroz yechilgan navbat nomzod bo\'lishi kerak');
    assert(seqs.includes(6), 'oxirgi navbat nomzod bo\'lishi kerak');
    const resolved = candidates.find((c) => c.turnSeq === 4);
    assertEqual(resolved?.kind, 'objection_resolved', '4-navbat turi');
    assertEqual(resolved?.trustDelta, 14, 'trustDelta');
  });

  check(report, 'nomzodlar 8 tadan oshmaydi', () => {
    const many: ScoringTurn[] = [];
    for (let i = 1; i <= 40; i += 1) {
      const trust = 50 + (i % 2 === 0 ? i : -i);
      many.push({
        seq: i,
        speaker: i % 2 === 0 ? 'customer' : 'seller',
        text: `navbat ${i} matni uzunroq bo'lsin`,
        ...(i % 2 === 0
          ? {
              stateAfter: {
                patience: Math.max(0, Math.min(100, 60 - i)),
                trust: Math.max(0, Math.min(100, trust)),
                interest: 50,
                flags: {
                  objectionsRaised: [],
                  objectionsResolved: [],
                  needRevealed: false,
                  guardViolations: 0,
                },
                promptVersion: 'training-v1',
              },
            }
          : {}),
      });
    }
    const candidates = keyMomentCandidates(many, persona);
    assert(candidates.length <= MAX_KEY_MOMENTS, `${candidates.length} > ${MAX_KEY_MOMENTS}`);
    assert(
      candidates.some((c) => c.turnSeq === 40),
      'oxirgi navbat baribir kiritilishi kerak',
    );
  });
}

// ---------------------------------------------------------------------------
// 5. LLM javobini qayta ishlash
// ---------------------------------------------------------------------------
function verifyProcessing(): void {
  section('[5] LLM javobini tekshirish');
  const criteria = flattenCriteria(DEFAULT_TRAINING_RUBRIC);
  const turns: EvidenceTurn[] = [
    { seq: 1, speaker: 'seller', text: SELLER_LINES[0] as string },
    { seq: 2, speaker: 'customer', text: 'Narxi menga qimmatdek tuyuladi.' },
    { seq: 3, speaker: 'seller', text: SELLER_LINES[2] as string },
  ];
  const candidates = [
    { turnSeq: 2, kind: 'objection_raised' as const },
    { turnSeq: 3, kind: 'final_turn' as const },
  ];

  const goodQuote = 'Narx tarkibida nimalar borligini';

  check(report, 'yaxshi dalil -> baho saqlanadi', () => {
    const llm = llmScoringSchema.parse({
      criteria: criteria.map((c) => ({
        code: c.code,
        score: 2,
        evidenceQuote: goodQuote,
        evidenceTurnSeq: 3,
        comment: 'izoh',
      })),
      coaching: { summary: 'xulosa', strengths: ['yaxshi savol berdi'], improvements: [] },
      keyMoments: [],
    });
    const processed = processLlmScoring(llm, criteria, turns, candidates);
    assertEqual(processed.evidenceFailureRatio, 0, 'yiqilish nisbati');
    for (const c of processed.criteria) {
      assertEqual(c.score, 2, `${c.code}: baho`);
      assertEqual(c.evidenceTurnSeq, 3, `${c.code}: navbat`);
      assertEqual(c.rejectedQuote ?? null, null, `${c.code}: rad etilgan iqtibos bo'lmasligi kerak`);
    }
  });

  check(report, 'o\'ylab topilgan dalil -> baho null, iqtibos SAQLANADI', () => {
    const invented = "Men sizga yuz foiz kafolat beraman";
    const llm = llmScoringSchema.parse({
      criteria: criteria.map((c, i) => ({
        code: c.code,
        score: 3,
        evidenceQuote: i === 0 ? invented : goodQuote,
        evidenceTurnSeq: 3,
        comment: 'izoh',
      })),
      coaching: { summary: 'xulosa', strengths: [], improvements: [] },
      keyMoments: [],
    });
    const processed = processLlmScoring(llm, criteria, turns, candidates);
    const first = processed.criteria[0];
    assert(first, 'mezon yo\'q');
    assertEqual(first.score, null, 'baho bekor qilinishi kerak');
    assertEqual(first.rejectedQuote, invented, 'rad etilgan iqtibos saqlanishi kerak');
    assertEqual(first.rejectReason, 'not_found', 'sabab');
    assert(processed.evidenceFailureRatio > 0, 'yiqilish nisbati');
    assert(processed.failureNotes.length === 1, 'xato eslatmasi');
  });

  check(report, 'mezon kodlari mos kelmasa baho null bo\'ladi', () => {
    const llm = llmScoringSchema.parse({
      criteria: [
        { code: 'yoq_bunday_mezon', score: 3, evidenceQuote: goodQuote, evidenceTurnSeq: 3, comment: 'x' },
      ],
      coaching: { summary: 'xulosa', strengths: [], improvements: [] },
      keyMoments: [],
    });
    const processed = processLlmScoring(llm, criteria, turns, candidates);
    assertEqual(processed.criteria.length, criteria.length, 'mezonlar soni rubrikadan');
    assert(
      processed.criteria.every((c) => c.score === null),
      'hammasi baholanmagan bo\'lishi kerak',
    );
    assert(
      !processed.criteria.some((c) => c.code === 'yoq_bunday_mezon'),
      'notanish kod natijaga tushmasligi kerak',
    );
  });

  check(report, 'muhim lahzalar faqat nomzodlardan qoladi', () => {
    const llm = llmScoringSchema.parse({
      criteria: [{ code: criteria[0]?.code, score: 1, evidenceQuote: goodQuote, evidenceTurnSeq: 3, comment: 'x' }],
      coaching: { summary: 'xulosa', strengths: [], improvements: [] },
      keyMoments: [
        { turnSeq: 3, kind: 'final_turn', explanation: 'oxirgi navbat' },
        { turnSeq: 99, kind: 'invented', explanation: 'bunday navbat yo\'q' },
        { turnSeq: 2, kind: 'objection_raised', explanation: 'e\'tiroz' },
      ],
    });
    const processed = processLlmScoring(llm, criteria, turns, candidates);
    assertDeepEqual(processed.keyMoments.map((m) => m.turnSeq), [2, 3], 'faqat nomzodlar, seq bo\'yicha');
  });

  check(report, 'maslahat dalili tekshiriladi, matni saqlanadi', () => {
    const llm = llmScoringSchema.parse({
      criteria: [{ code: criteria[0]?.code, score: 1, evidenceQuote: goodQuote, evidenceTurnSeq: 3, comment: 'x' }],
      coaching: {
        summary: 'xulosa',
        strengths: [],
        improvements: [
          {
            title: 'Ehtiyojni so\'rang',
            why: 'Mijozning holatini bilmadingiz',
            evidenceQuote: 'bu gap transkriptda yo\'q umuman',
            evidenceTurnSeq: 1,
            betterPhrasing: 'Hozirgi holatingiz qanday?',
          },
        ],
      },
      keyMoments: [],
    });
    const processed = processLlmScoring(llm, criteria, turns, candidates);
    const improvement = processed.coaching.improvements[0];
    assert(improvement, 'maslahat yo\'q');
    assertEqual(improvement.evidenceQuote, null, 'dalil bekor qilinadi');
    assertEqual(improvement.rejectedQuote, 'bu gap transkriptda yo\'q umuman', 'iqtibos saqlanadi');
    assertEqual(improvement.betterPhrasing, 'Hozirgi holatingiz qanday?', 'maslahat matni qoladi');
  });
}

// ---------------------------------------------------------------------------
// 6 + 7. DB va route'lar
// ---------------------------------------------------------------------------
function appUrl(): string {
  const port = process.env.POSTGRES_PORT?.trim() || '55433';
  return (
    process.env.TRAINING_DATABASE_URL?.trim() ||
    `postgres://trainer_app:trainer_app@127.0.0.1:${port}/sotuv_trener`
  );
}

function superUrl(): string {
  const port = process.env.POSTGRES_PORT?.trim() || '55433';
  return (
    process.env.SUPERUSER_DATABASE_URL?.trim() ||
    `postgres://postgres:postgres@127.0.0.1:${port}/sotuv_trener`
  );
}

function createWithTenant(pool: Pool): WithTenant {
  const db = drizzle(pool);
  return async function withTenant(businessId, fn) {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.business_id', ${businessId}, true)`);
      return await fn(tx as unknown as TrainingTx);
    });
  };
}

/** Baholash uchun to'g'ri shakldagi LLM javobi (iqtiboslar haqiqiy matndan). */
function scoringPayload(options: { quote?: string; score?: 0 | 1 | 2 | 3; invented?: boolean } = {}) {
  const criteria = flattenCriteria(DEFAULT_TRAINING_RUBRIC);
  const quote = options.invented
    ? "Bu gapni hech kim aytmagan albatta"
    : (options.quote ?? 'Narx tarkibida nimalar borligini');
  return {
    criteria: criteria.map((c) => ({
      code: c.code,
      score: options.score ?? 2,
      evidenceQuote: quote,
      evidenceTurnSeq: 3,
      comment: `${c.name} bo'yicha izoh.`,
    })),
    coaching: {
      summary: 'Umumiy holda suhbat izchil bordi.',
      strengths: ['Narx tarkibini aniq tushuntirdingiz'],
      improvements: [
        {
          title: "Ehtiyojni chuqurroq aniqlang",
          why: 'Mijozning asl sababini ochmadingiz',
          evidenceQuote: quote,
          evidenceTurnSeq: 3,
          betterPhrasing: "Buni nega hozir hal qilmoqchisiz?",
        },
      ],
    },
    keyMoments: [{ turnSeq: 4, kind: 'objection_resolved', explanation: "E'tiroz yechildi." }],
  };
}

async function verifyDbAndRoutes(): Promise<void> {
  section('[6+7] DB, xizmat va route\'lar');

  if (process.env.SKIP_DB === '1') {
    skip(report, 'DB va route testlari', 'SKIP_DB=1');
    return;
  }

  const superPool = new Pool({ connectionString: superUrl(), max: 2 });
  const appPool = new Pool({ connectionString: appUrl(), max: 6 });
  const withTenant = createWithTenant(appPool);
  const getBusinessProfile: GetBusinessProfile = async () => PROFILE;

  const bizA = randomUUID();
  const bizB = randomUUID();
  const userA = randomUUID();
  const userA2 = randomUUID();
  const userB = randomUUID();

  const ctxA: TrainingContext = { businessId: bizA, userId: userA, seatId: null };
  const ctxA2: TrainingContext = { businessId: bizA, userId: userA2, seatId: null };
  const ctxB: TrainingContext = { businessId: bizB, userId: userB, seatId: null };

  /** Sessiyani boshdan oxirigacha o'ynab beradi (tugatadi). */
  async function playSession(
    ctx: TrainingContext,
    options: { turns?: number } = {},
  ): Promise<string> {
    const turnsCount = options.turns ?? 3;
    const script: unknown[] = [
      fakePersona({
        objectionKeys: OBJECTION_KEYS,
        severity: 3,
        focusOffer: FIRST_OFFER,
        direction: 'outbound',
      }),
    ];
    const replies = [
      { reply: 'Narxi menga qimmatdek tuyuladi.', objectionRaisedKey: OBJECTION_KEYS[0] },
      { reply: 'Yaxshi, tushundim.', objectionsResolvedKeys: [OBJECTION_KEYS[0] as string] },
      { reply: "Mayli, ertaga gaplashamiz.", objectionRaisedKey: OBJECTION_KEYS[1] },
      { reply: 'Yana bir savolim bor.', objectionsResolvedKeys: [OBJECTION_KEYS[1] as string] },
    ];
    for (let i = 0; i < turnsCount; i += 1) {
      script.push(fakeTurn({ ...(replies[i % replies.length] ?? {}), deltas: { patience: 0, trust: 5, interest: 2 } }));
    }
    const engine = createTrainingEngine({
      withTenant,
      getBusinessProfile,
      llm: new FakeTrainerLlm(script),
      random: () => 0.9,
    });
    const started = await engine.startSession(ctx, { archetypeKey: 'negotiator' });
    for (let i = 0; i < turnsCount; i += 1) {
      await engine.takeTurn(ctx, {
        sessionId: started.sessionId,
        sellerText: SELLER_LINES[i % SELLER_LINES.length] as string,
      });
    }
    await engine.endSession(ctx, { sessionId: started.sessionId, reason: 'test' });
    return started.sessionId;
  }

  try {
    await superPool.query('insert into business (id, name) values ($1, $2), ($3, $4)', [
      bizA,
      'A',
      bizB,
      'B',
    ]);
    await superPool.query(
      'insert into app_user (id, business_id, email) values ($1,$2,$3), ($4,$5,$6), ($7,$8,$9)',
      [userA, bizA, 'a@t.local', userA2, bizA, 'a2@t.local', userB, bizB, 'b@t.local'],
    );

    // --- 6a. Kam mazmun -------------------------------------------------
    await checkAsync(report, 'kam mazmun -> insufficient, LLM chaqirilmaydi', async () => {
      const sessionId = await playSession(ctxA, { turns: 1 });
      const llm = new FakeTrainerLlm([]); // bitta chaqiruv ham bo'lmasligi kerak
      const scoring = createScoringService({ withTenant, llm });
      const result = await scoring.scoreSession(ctxA, sessionId);
      assertEqual(result.status, 'done', 'status');
      assertEqual(result.quality, 'insufficient', 'quality');
      assertEqual(result.skillScore, null, 'skillScore');
      assertEqual(llm.callCount, 0, 'LLM chaqirilmasligi kerak');

      const stored = await scoring.getLatestResult(ctxA, sessionId);
      assert(stored, 'natija saqlanmadi');
      assert(
        (stored.coaching?.summary ?? '').length > 10,
        'qisqa tushuntirish bo\'lishi kerak',
      );
    });

    // --- 6b. To'liq baholash + getPlaybook null -------------------------
    let okSessionId = '';
    await checkAsync(report, 'to\'liq baholash: ball, dalil, standart rubrika', async () => {
      okSessionId = await playSession(ctxA, { turns: 3 });
      const llm = new FakeTrainerLlm([scoringPayload()], {
        usage: { inputTokens: 4000, outputTokens: 900, model: 'fake-scorer' },
      });
      let playbookCalls = 0;
      const getPlaybook: GetPlaybook = async () => {
        playbookCalls += 1;
        return null; // -> standart rubrika
      };
      const scoring = createScoringService({
        withTenant,
        llm,
        getPlaybook,
        priceCall: (u) => u.inputTokens * 1e-6 + u.outputTokens * 5e-6,
      });

      const result = await scoring.scoreSession(ctxA, okSessionId);
      assertEqual(result.status, 'done', 'status');
      assertEqual(result.quality, 'ok', 'quality');
      assertEqual(result.version, 1, 'version');
      assertEqual(result.skillScore, 66.7, 'skillScore (hamma mezon 2 ball)');
      assertEqual(playbookCalls, 1, 'getPlaybook chaqirilishi kerak');

      const stored = await scoring.getLatestResult(ctxA, okSessionId);
      assert(stored, 'natija yo\'q');
      assertEqual(stored.model, 'fake-scorer', 'model');
      assertEqual(stored.promptVersion, 'scoring-v1', 'promptVersion');
      assert(Number(stored.costUsd) > 0, 'cost_usd to\'ldirilishi kerak');
      assertEqual(stored.criteria?.length, 7, 'mezonlar soni');
      assertEqual(stored.keyMoments?.length, 1, 'muhim lahzalar');
      assert((stored.metrics?.sellerTurns ?? 0) === 3, 'o\'lchovlar saqlanadi');
    });

    // --- 6c. Versiyalash -------------------------------------------------
    await checkAsync(report, 'qayta baholash yangi versiya qo\'shadi, eskisi qoladi', async () => {
      const llm = new FakeTrainerLlm([scoringPayload({ score: 3 })]);
      const scoring = createScoringService({ withTenant, llm });
      const second = await scoring.scoreSession(ctxA, okSessionId);
      assertEqual(second.version, 2, 'version');
      assertEqual(second.skillScore, 100, 'yangi ball');

      const versions = await withTenant(bizA, async (tx) =>
        scoringRepo.listResultVersions(tx, okSessionId),
      );
      assertEqual(versions.length, 2, 'versiyalar soni');
      assertDeepEqual(versions.map((v) => v.version), [2, 1], 'eski versiya saqlanadi');
      const first = versions.find((v) => v.version === 1);
      assertEqual(Number(first?.skillScore), 66.7, 'eski ball o\'zgarmaydi');

      const latest = await scoring.getLatestResult(ctxA, okSessionId);
      assertEqual(latest?.version, 2, 'oxirgi versiya');
    });

    // --- 6c-2. Sessiya ro'yxatida ball ko'rinadi (regressiya testi) -----
    await checkAsync(report, 'sessiya ro\'yxati oxirgi natija ballini qaytaradi', async () => {
      const rows = await withTenant(bizA, async (tx) =>
        scoringRepo.listSessionsWithScore(tx, userA),
      );
      const row = rows.find((r) => r.id === okSessionId);
      assert(row, 'sessiya ro\'yxatda yo\'q');
      // Bu subquery bir marta jim-jitlik bilan null qaytargan edi
      // (jadval nomisiz "id" -> training_result.id ga tegib ketgan).
      assertEqual(Number(row.skillScore), 100, 'oxirgi versiya balli');
      assertEqual(row.resultStatus, 'done', 'natija holati');
      assertEqual(row.outcome, null, 'sessiya natijasi (tashlab ketilgan)');
    });

    // --- 6d. Past sifat (dalillar yiqiladi) -----------------------------
    await checkAsync(report, 'dalillar yiqilsa: bitta retry, keyin quality=low', async () => {
      const sessionId = await playSession(ctxA, { turns: 3 });
      const bad = scoringPayload({ invented: true });
      const llm = new FakeTrainerLlm([bad, bad]);
      const scoring = createScoringService({ withTenant, llm });
      const result = await scoring.scoreSession(ctxA, sessionId);

      assertEqual(llm.callCount, 2, 'bitta qayta urinish bo\'lishi kerak');
      assertEqual(result.status, 'done', 'status');
      assertEqual(result.quality, 'low', 'quality');
      assertEqual(result.skillScore, null, 'hech bir baho qolmasligi kerak');

      const stored = await scoring.getLatestResult(ctxA, sessionId);
      const first = stored?.criteria?.[0];
      assert(first?.rejectedQuote, 'rad etilgan iqtibos saqlanishi kerak');
      const second = llm.calls[1];
      assert(second?.system.includes('CORRECTION'), 'retry promptida CORRECTION bo\'lishi kerak');
    });

    // --- 6e. Egalik va tenant izolyatsiyasi -----------------------------
    await checkAsync(report, 'boshqa tenant/foydalanuvchi baholay olmaydi', async () => {
      const scoringB = createScoringService({ withTenant, llm: new FakeTrainerLlm([]) });
      let notFound = false;
      try {
        await scoringB.scoreSession(ctxB, okSessionId);
      } catch (err) {
        notFound = err instanceof Error && err.message.includes('topilmadi');
      }
      assert(notFound, 'tenant B uchun session_not_found kutilgan');

      let forbidden = false;
      try {
        await scoringB.scoreSession(ctxA2, okSessionId);
      } catch (err) {
        forbidden = err instanceof Error && err.message.includes('boshqa foydalanuvchiga');
      }
      assert(forbidden, 'boshqa foydalanuvchi uchun session_forbidden kutilgan');
    });

    // --- 7. Route'lar ---------------------------------------------------
    await checkAsync(report, 'route\'lar: yashirin kartalar faqat tugagandan keyin', async () => {
      const app = Fastify();
      const llm = new FakeTrainerLlm([
        fakePersona({
          objectionKeys: OBJECTION_KEYS,
          severity: 3,
          focusOffer: FIRST_OFFER,
          direction: 'outbound',
        }),
        fakeTurn({ reply: 'Narxi qimmat.', objectionRaisedKey: OBJECTION_KEYS[0] }),
        scoringPayload(),
      ]);
      const engine = createTrainingEngine({
        withTenant,
        getBusinessProfile,
        llm,
        random: () => 0.9,
      });
      const scoring = createScoringService({ withTenant, llm });
      let currentCtx = ctxA;
      await registerTrainingRoutes(app, {
        engine,
        scoring,
        withTenant,
        getContext: () => currentCtx,
        config: { autoScoreOnEnd: false },
      });
      await app.ready();

      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/training/sessions',
        payload: { archetypeKey: 'negotiator' },
      });
      assertEqual(created.statusCode, 200, 'POST /sessions');
      const createdBody = created.json() as Record<string, unknown>;
      const sessionId = String(createdBody.sessionId);
      const personaJson = JSON.stringify(createdBody.persona);
      assert(!personaJson.includes('hiddenNeed'), 'yashirin ehtiyoj yuborilmasligi kerak');
      assert(!personaJson.includes('objections'), 'e\'tirozlar reja yuborilmasligi kerak');

      await app.inject({
        method: 'POST',
        url: `/api/v1/training/sessions/${sessionId}/turn`,
        payload: { text: SELLER_LINES[0] },
      });

      // Sessiya hali tugamagan -> revealed null
      const during = await app.inject({ url: `/api/v1/training/sessions/${sessionId}` });
      const duringBody = during.json() as Record<string, unknown>;
      assertEqual(duringBody.revealed, null, 'tugamagan sessiyada revealed null bo\'lishi kerak');
      assert(
        !JSON.stringify(duringBody).includes('hiddenFacts'),
        'yashirin faktlar chiqib ketmasligi kerak',
      );

      // Tugatamiz -> revealed to'ldiriladi
      await app.inject({ method: 'POST', url: `/api/v1/training/sessions/${sessionId}/end`, payload: {} });
      const after = await app.inject({ url: `/api/v1/training/sessions/${sessionId}` });
      const afterBody = after.json() as Record<string, unknown>;
      const revealed = afterBody.revealed as Record<string, unknown> | null;
      assert(revealed, 'tugagandan keyin revealed bo\'lishi kerak');
      assert(Array.isArray(revealed.objections), 'e\'tiroz rejasi oshkor qilinadi');
      assert(Array.isArray(revealed.hiddenFacts), 'yashirin faktlar oshkor qilinadi');

      // Boshqa tenant -> 404 (403 EMAS)
      currentCtx = ctxB;
      const foreign = await app.inject({ url: `/api/v1/training/sessions/${sessionId}` });
      assertEqual(foreign.statusCode, 404, 'boshqa tenant uchun status');
      // Boshqa foydalanuvchi, o'sha tenant -> ham 404
      currentCtx = ctxA2;
      const otherUser = await app.inject({ url: `/api/v1/training/sessions/${sessionId}` });
      assertEqual(otherUser.statusCode, 404, 'boshqa foydalanuvchi uchun status');
      currentCtx = ctxA;

      // Validatsiya
      const badBody = await app.inject({
        method: 'POST',
        url: '/api/v1/training/sessions',
        payload: { archetypeKey: 'yoq_bunday' },
      });
      assertEqual(badBody.statusCode, 400, 'noto\'g\'ri archetypeKey');
      const badId = await app.inject({ url: '/api/v1/training/sessions/not-a-uuid' });
      assertEqual(badId.statusCode, 400, 'noto\'g\'ri uuid');

      // Baholashni boshlash -> 202
      const score = await app.inject({
        method: 'POST',
        url: `/api/v1/training/sessions/${sessionId}/score`,
        payload: {},
      });
      assertEqual(score.statusCode, 202, 'POST /score');

      await app.close();
    });

    await checkAsync(report, 'route\'lar: debug ma\'lumoti faqat ruxsat berilganda', async () => {
      const makeApp = async (allowDebug: boolean) => {
        const app = Fastify();
        const llm = new FakeTrainerLlm([]);
        const engine = createTrainingEngine({ withTenant, getBusinessProfile, llm });
        const scoring = createScoringService({ withTenant, llm });
        await registerTrainingRoutes(app, {
          engine,
          scoring,
          withTenant,
          getContext: () => ctxA,
          config: { allowDebug, autoScoreOnEnd: false },
        });
        await app.ready();
        return app;
      };

      const withoutDebug = await makeApp(false);
      const res1 = await withoutDebug.inject({ url: `/api/v1/training/sessions/${okSessionId}` });
      assert(!('debug' in (res1.json() as Record<string, unknown>)), 'debug bo\'lmasligi kerak');
      await withoutDebug.close();

      const withDebug = await makeApp(true);
      const res2 = await withDebug.inject({ url: `/api/v1/training/sessions/${okSessionId}` });
      assert('debug' in (res2.json() as Record<string, unknown>), 'debug bo\'lishi kerak');
      await withDebug.close();
    });

    await checkAsync(report, 'route\'lar: natija va statistika', async () => {
      const app = Fastify();
      const llm = new FakeTrainerLlm([]);
      const engine = createTrainingEngine({ withTenant, getBusinessProfile, llm });
      const scoring = createScoringService({ withTenant, llm });
      await registerTrainingRoutes(app, {
        engine,
        scoring,
        withTenant,
        getContext: () => ctxA,
        config: { autoScoreOnEnd: false },
      });
      await app.ready();

      const result = await app.inject({ url: `/api/v1/training/sessions/${okSessionId}/result` });
      assertEqual(result.statusCode, 200, 'GET /result');
      const body = result.json() as Record<string, unknown>;
      const stored = body.result as Record<string, unknown>;
      assertEqual(stored.version, 2, 'oxirgi versiya');
      assertEqual(stored.status, 'done', 'status');
      assert(Array.isArray(body.transcript), 'transkript qaytadi');
      assert(body.revealed !== null, 'tugagan sessiyada yashirin kartalar');

      const stats = await app.inject({ url: '/api/v1/training/me/stats' });
      assertEqual(stats.statusCode, 200, 'GET /me/stats');
      const statsBody = stats.json() as Record<string, unknown>;
      assert((statsBody.totalSessions as number) >= 3, 'sessiyalar soni');
      assert(Array.isArray(statsBody.winRateByArchetype), 'arxetip bo\'yicha g\'alaba');
      assert(Array.isArray(statsBody.skillScoreTrend), 'ball dinamikasi');
      assert(Array.isArray(statsBody.weakestCriteria), 'zaif mezonlar');

      const sessions = await app.inject({ url: '/api/v1/training/sessions' });
      assertEqual(sessions.statusCode, 200, 'GET /sessions');
      const list = (sessions.json() as { sessions: unknown[] }).sessions;
      assert(list.length >= 3, 'sessiyalar ro\'yxati');

      // `training:view:all` talab qiladigan route: authorize rad etsa 401.
      const restricted = Fastify();
      await registerTrainingRoutes(restricted, {
        engine,
        scoring,
        withTenant,
        getContext: () => ctxA,
        authorize: (_ctx, permission) => {
          if (permission === 'training:view:all') throw new Error('ruxsat yo\'q');
        },
        config: { autoScoreOnEnd: false },
      });
      await restricted.ready();
      const denied = await restricted.inject({ url: '/api/v1/training/stats' });
      assertEqual(denied.statusCode, 401, 'ruxsatsiz /stats');
      const allowed = await restricted.inject({ url: '/api/v1/training/me/stats' });
      assertEqual(allowed.statusCode, 200, 'o\'z statistikasi ruxsat etiladi');
      await restricted.close();

      await app.close();
    });

    check(report, 'revealPersona o\'lchovsiz ham ishlaydi', () => {
      const persona = testPersona();
      const revealed = revealPersona(persona, null);
      assertEqual(revealed.objections.length, persona.objections.length, 'e\'tirozlar');
      assert(
        revealed.objections.every((o) => o.raised === false && o.resolved === false),
        'o\'lchov bo\'lmasa hammasi false',
      );
    });
  } finally {
    await superPool
      .query('delete from business where id = any($1::uuid[])', [[bizA, bizB]])
      .catch(() => undefined);
    await appPool.end().catch(() => undefined);
    await superPool.end().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('verify-training-scoring — Step 4 Phase A (haqiqiy LLM ishlatilmaydi)');

  verifyRubric();
  verifyEvidenceRules();
  verifyScoreMath();
  verifyMetricsAndMoments();
  verifyProcessing();

  try {
    await verifyDbAndRoutes();
  } catch (err) {
    report.failed += 1;
    const message = err instanceof Error ? err.message : String(err);
    report.failures.push(`DB/route bloki ishga tushmadi: ${message}`);
    console.log(
      `  FAIL DB/route bloki ishga tushmadi\n       ${message}\n` +
        '       DB ishlayaptimi? `npm run db:up && npm run db:init` (harness ichida).',
    );
  }

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
