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
 *      tenant va foydalanuvchi izolyatsiyasi (404), validatsiya;
 *   8. biznes faktlari: prompt profilni oladi, qizil chiziqlar (tekshirilgan
 *      iqtibos bilan), kuchli tomonlar qizil chiziqni maqtamaydi, skriptga
 *      moslik, sotuv skripti fayli formati, yozuv (lotin) tekshiruvi.
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
import type {
  GetBusinessProfile,
  TrainerLlm,
  TrainerLlmRequest,
  TrainingContext,
  TrainingTx,
  WithTenant,
} from './ports.js';
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
  enforceScoringLanguage,
  processLlmScoring,
  resolvePriceScope,
  STALE_PENDING_ERROR,
  userFacingScoringText,
  type GetPlaybook,
} from './scoring/scoring.js';
import { hasPriceFacts, isPriceRedLine } from './offer-facts.js';
import { buildPersonaUserPrompt, PROMPT_VERSION, TURN_STATIC_PREFIX } from './prompts.js';
import {
  buildScoringSystemPrompt,
  buildScoringUserPrompt,
  SCORING_PROMPT_VERSION,
  type ScoringPromptInput,
} from './scoring/scoring-prompts.js';
import {
  parseSalesScriptMarkdown,
  SalesScriptFormatError,
  type SalesScript,
} from './scoring/sales-script.js';
import {
  classifyUzText,
  enforceUzLatin,
  findScriptViolations,
  guardCustomerReply,
  CUSTOMER_LANGUAGE_FALLBACK,
  LANGUAGE_PLACEHOLDER,
  nonLatinWords,
  transliterateUzCyrillic,
} from './language.js';
import {
  canOfferRescore,
  RESCORE_PENDING_AFTER_MS,
  scoringRunState,
} from '../../../frontend/src/lib/rescore.js';
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
    assertEqual(criteria.length, 8, 'mezonlar soni');
  });

  check(report, "yangi vaznlar: mahsulot/narx aniqligi 15, qolganlari qayta taqsimlangan", () => {
    const weights = Object.fromEntries(
      flattenCriteria(DEFAULT_TRAINING_RUBRIC).map((c) => [c.code, c.weight]),
    );
    assertDeepEqual(
      weights,
      {
        greeting_intro: 5,
        need_discovery: 20,
        offer_fit: 10,
        product_accuracy: 15,
        objection_handling: 20,
        closing_next_step: 10,
        tone_respect: 10,
        conversation_control: 10,
      },
      'vaznlar',
    );
    const accuracy = flattenCriteria(DEFAULT_TRAINING_RUBRIC).find((c) => c.code === 'product_accuracy');
    assertEqual(accuracy?.name, "Mahsulot va narx bo'yicha to'g'ri ma'lumot", 'nomi');
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
// ---------------------------------------------------------------------------
// 8. Biznes faktlari, qizil chiziqlar, skript, yozuv
// ---------------------------------------------------------------------------
const SCRIPT_MD = [
  '# Test skripti',
  '## 1. Salomlashish',
  "- O'zini tanishtiradi",
  "> Assalomu alaykum, sizga qulay vaqtda qo'ng'iroq qildimmi?",
  '## 2. Taklif',
  '- Taklifni narxi bilan aytadi',
  '- Ibora: "Xizmat oyiga 1 200 000 so\'m"',
  '## 3. Yopish',
  '- Keyingi qadamni kelishadi',
].join('\n');

function promptInput(overrides: Partial<ScoringPromptInput> = {}): ScoringPromptInput {
  const turns = makeTurns();
  const persona = testPersona();
  return {
    criteria: flattenCriteria(DEFAULT_TRAINING_RUBRIC),
    archetype: NEGOTIATOR,
    persona,
    metrics: computeMetrics(
      {
        id: randomUUID(),
        archetypeKey: 'negotiator',
        status: 'ended',
        outcome: null,
        endReason: 'user_ended',
        turnCount: 3,
        startedAt: new Date('2026-01-01T10:00:00Z'),
        endedAt: new Date('2026-01-01T10:05:00Z'),
      },
      turns,
      NEGOTIATOR,
      persona,
    ),
    turns,
    candidates: [],
    profile: PROFILE,
    script: null,
    ...overrides,
  };
}

function verifyBusinessFacts(): void {
  section('[8] Biznes faktlari, qizil chiziqlar, skript, yozuv');

  check(report, 'prompt: profil takliflari, narxlari, shartlari va qizil chiziqlari bor', () => {
    const system = buildScoringSystemPrompt(promptInput());
    for (const offer of PROFILE.primaryOffers) assert(system.includes(offer), `taklif yo'q: ${offer}`);
    for (const rule of PROFILE.redLines) assert(system.includes(rule), `qizil chiziq yo'q: ${rule}`);
    if (PROFILE.additionalNotes) assert(system.includes(PROFILE.additionalNotes), 'shartlar yo\'q');
    assert(system.includes('Check EVERY factual claim'), "har da'voni tekshirish ko'rsatmasi");
    assert(system.includes('product_accuracy'), 'mezon tilga olingan');
  });

  check(report, "prompt: kuchli tomonlar profilga zid gapni maqtamaydi (qoida)", () => {
    const system = buildScoringSystemPrompt(promptInput());
    assert(
      system.includes('"strengths" must NEVER praise') && system.includes('contradicts the business facts'),
      'strengths qoidasi',
    );
  });

  check(report, "prompt: profilda bor faktni 'noma'lum' deb aytishni maslahat bermaydi (qoida)", () => {
    const system = buildScoringSystemPrompt(promptInput());
    assert(
      system.includes('NEVER tell the seller to say a fact is unknown') &&
        system.includes('use the real fact'),
      'unknown qoidasi',
    );
  });

  check(report, "prompt: profil yo'q -> faktlar baholanmaydi; skript yo'q -> scriptAdherence []", () => {
    const system = buildScoringSystemPrompt(promptInput({ profile: null }));
    assert(system.includes('No business profile was provided'), "profil yo'qligi aytiladi");
    assert(system.includes('return "scriptAdherence": []'), 'skriptsiz ko\'rsatma');
    assert(!system.includes('## Sales script adherence'), "skript bo'limi yo'q");
  });

  check(report, "prompt: skript bo'lsa har bosqich va kutilgan harakatlar bor", () => {
    const script = parseSalesScriptMarkdown(SCRIPT_MD);
    const system = buildScoringSystemPrompt(promptInput({ script }));
    assert(system.includes('## Sales script adherence'), "bo'lim bor");
    for (const stage of script.stages) assert(system.includes(stage.name), `bosqich: ${stage.name}`);
    assert(system.includes('Taklifni narxi bilan aytadi'), 'kutilgan harakat');
    // Transkript foydalanuvchi promptida — tizim promptida emas.
    assert(buildScoringUserPrompt(promptInput()).includes('[T1] SELLER'), 'transkript');
  });

  // --- Qizil chiziqlar ------------------------------------------------------
  const criteria = flattenCriteria(DEFAULT_TRAINING_RUBRIC);
  const lie = "Bizda bunday xizmat yo'q, lekin bugun 50 foiz chegirma bor faqat siz uchun";
  const turns: EvidenceTurn[] = [
    { seq: 1, speaker: 'seller', text: SELLER_LINES[0] as string },
    { seq: 2, speaker: 'customer', text: 'Shu xizmat bormi?' },
    { seq: 3, speaker: 'seller', text: lie },
  ];
  const fakeDiscountRule = PROFILE.redLines.find((r) => r.toLowerCase().includes('chegirma'));
  assert(fakeDiscountRule, "demo profilda 'chegirma' qizil chizig'i kutilgan");

  const baseLlm = (extra: Record<string, unknown>) =>
    llmScoringSchema.parse({
      criteria: criteria.map((c) => ({
        code: c.code,
        score: 1,
        evidenceQuote: '50 foiz chegirma bor faqat siz uchun',
        evidenceTurnSeq: 3,
        comment: 'izoh',
      })),
      coaching: { summary: 'xulosa', strengths: [], improvements: [] },
      keyMoments: [],
      ...extra,
    });

  check(report, "qizil chiziq: profildagi qoida + tekshirilgan iqtibos -> saqlanadi", () => {
    const llm = baseLlm({
      redLineViolations: [
        {
          rule: fakeDiscountRule,
          evidenceQuote: '50 foiz chegirma bor faqat siz uchun',
          evidenceTurnSeq: 3,
          explanation: "Profilda chegirma yo'q — bu soxta chegirma.",
        },
      ],
    });
    const processed = processLlmScoring(llm, criteria, turns, [], { redLines: PROFILE.redLines });
    const violations = processed.coaching.redLineViolations ?? [];
    assertEqual(violations.length, 1, 'bitta buzilish');
    assertEqual(violations[0]?.rule, fakeDiscountRule, 'qoida profildagi matn');
    assertEqual(violations[0]?.evidenceTurnSeq, 3, 'navbat');
  });

  check(report, "qizil chiziq: iqtibos topilmasa yoki qoida profilda bo'lmasa -> tashlanadi", () => {
    const llm = baseLlm({
      redLineViolations: [
        {
          rule: fakeDiscountRule,
          evidenceQuote: 'Bu gapni sotuvchi hech qachon aytmagan',
          evidenceTurnSeq: 3,
          explanation: 'x',
        },
        {
          rule: "O'ylab topilgan qoida",
          evidenceQuote: '50 foiz chegirma bor faqat siz uchun',
          evidenceTurnSeq: 3,
          explanation: 'y',
        },
      ],
    });
    const processed = processLlmScoring(llm, criteria, turns, [], { redLines: PROFILE.redLines });
    assertEqual(processed.coaching.redLineViolations?.length, 0, 'hech biri qolmaydi');
    assertEqual(processed.droppedNotes.length, 2, 'ikkalasi auditga yozildi');
  });

  check(report, "kuchli tomonlar qizil chiziqni buzgan gapni maqtasa -> olib tashlanadi", () => {
    const llm = baseLlm({
      coaching: {
        summary: 'xulosa',
        strengths: [
          "Ishonch bilan '50 foiz chegirma bor faqat siz uchun' deb taklif qildingiz",
          'Mijoz bilan xushmuomala gaplashdingiz',
        ],
        improvements: [],
      },
      redLineViolations: [
        {
          rule: fakeDiscountRule,
          evidenceQuote: '50 foiz chegirma bor faqat siz uchun',
          evidenceTurnSeq: 3,
          explanation: 'Soxta chegirma.',
        },
      ],
    });
    const processed = processLlmScoring(llm, criteria, turns, [], { redLines: PROFILE.redLines });
    assertDeepEqual(
      processed.coaching.strengths,
      ['Mijoz bilan xushmuomala gaplashdingiz'],
      'faqat zid bo\'lmagan kuchli tomon qoladi',
    );
  });

  // --- Skriptga moslik ------------------------------------------------------
  const script: SalesScript = parseSalesScriptMarkdown(SCRIPT_MD);

  check(report, "skript: followed+iqtibos qoladi, tekshirilmagan followed -> partly, yo'q bosqich -> null", () => {
    const llm = baseLlm({
      scriptAdherence: [
        // Model tartibni almashtirib yuborsa ham natija SKRIPT tartibida.
        {
          stage: 'Taklif',
          status: 'followed',
          evidenceQuote: "O'ylab topilgan iqtibos bu yerda turibdi",
          evidenceTurnSeq: 3,
          comment: 'Taklif aytildi',
        },
        {
          stage: 'Salomlashish',
          status: 'followed',
          evidenceQuote: "sizga qulay vaqtda qo'ng'iroq qildimmi",
          evidenceTurnSeq: 1,
          comment: 'Salomlashdi',
        },
      ],
    });
    const processed = processLlmScoring(llm, criteria, turns, [], { script });
    const stages = processed.coaching.scriptAdherence ?? [];
    assertDeepEqual(
      stages.map((s) => s.stage),
      ['Salomlashish', 'Taklif', 'Yopish'],
      'skript tartibi',
    );
    assertEqual(stages[0]?.status, 'followed', 'salomlashish bajarildi');
    assertEqual(stages[0]?.evidenceTurnSeq, 1, 'tekshirilgan iqtibos');
    assertEqual(stages[1]?.status, 'partly', "tekshirilmagan 'followed' -> partly");
    assertEqual(stages[1]?.evidenceQuote, null, 'iqtibos olib tashlandi');
    assertEqual(stages[1]?.rejectReason, 'not_found', 'sababi saqlanadi');
    assertEqual(stages[2]?.status, null, 'model baholamagan bosqich');
  });

  check(report, "skript yo'q -> scriptAdherence null", () => {
    const processed = processLlmScoring(baseLlm({}), criteria, turns, []);
    assertEqual(processed.coaching.scriptAdherence, null, 'null');
  });

  // --- Sotuv skripti fayli formati -----------------------------------------
  check(report, 'skript markdown: sarlavha, bosqichlar, harakatlar, iboralar', () => {
    assertEqual(script.title, 'Test skripti', 'sarlavha');
    assertEqual(script.stages.length, 3, 'bosqichlar');
    assertEqual(script.stages[0]?.name, 'Salomlashish', 'raqam olib tashlanadi');
    assertEqual(script.stages[0]?.phrases.length, 1, '> ibora');
    assertDeepEqual(script.stages[1]?.phrases, ["Xizmat oyiga 1 200 000 so'm"], "'- Ibora:' ibora");
    assertEqual(script.stages[1]?.expectedActions.length, 1, 'harakat');
  });

  for (const [name, md, expected] of [
    ['bosqichsiz fayl', '# Faqat sarlavha\nIzoh matni', 'kamida bitta bosqich'],
    ['bosqichdan oldingi band', "- O'zini tanishtiradi\n## Salom\n- x y", '1-qator'],
    ['harakatsiz bosqich', '## Salomlashish\n> faqat ibora bor', '1-bosqich "Salomlashish"'],
    ['takroriy bosqich', '## Salom\n- aa\n## Salom\n- bb', 'takrorlangan'],
  ] as const) {
    check(report, `skript xatosi aniq: ${name}`, () => {
      let caught: unknown;
      try {
        parseSalesScriptMarkdown(md);
      } catch (err) {
        caught = err;
      }
      assert(caught instanceof SalesScriptFormatError, 'SalesScriptFormatError');
      assert((caught as Error).message.includes(expected), `xabarda "${expected}": ${(caught as Error).message}`);
    });
  }

  // --- Yozuv (lotin) tekshiruvi --------------------------------------------
  check(report, "yozuv: kirill va mo'g'ul so'zlari topiladi, o'zbek lotin toza", () => {
    assertDeepEqual(nonLatinWords("Siz yaxshi gapirdingiz, лекин narxni aytmadingiz."), ['лекин'], 'kirill');
    assertDeepEqual(nonLatinWords('Mijoz сайн байна dedi'), ['сайн', 'байна'], "mo'g'ul (kirill)");
    assertDeepEqual(nonLatinWords('Bu ᠮᠣᠩᠭᠣᠯ yozuvi'), ['ᠮᠣᠩᠭᠣᠯ'], "mo'g'ul eski yozuvi");
    assertDeepEqual(
      nonLatinWords("O‘zbekcha: o'g'il, g‘alaba, oʻqituvchi, ma'lumot, café — 1 200 000 so'm!"),
      [],
      "o‘/g‘/ʻ va diakritika — ruxsat",
    );
  });

  check(report, "debrief matnlari tekshiriladi, iqtiboslar (transkript) — yo'q", () => {
    const llm = llmScoringSchema.parse({
      criteria: criteria.map((c) => ({
        code: c.code,
        score: 2,
        evidenceQuote: 'Narx tarkibida nimalar borligini',
        evidenceTurnSeq: 3,
        comment: c.code === 'need_discovery' ? 'Savollar хорошо edi' : 'izoh',
      })),
      coaching: { summary: 'Umumiy xulosa', strengths: [], improvements: [] },
      keyMoments: [],
    });
    const cyrillicSeller: EvidenceTurn[] = [
      { seq: 1, speaker: 'seller', text: 'Здравствуйте, это учебный центр' },
      { seq: 3, speaker: 'seller', text: SELLER_LINES[2] as string },
    ];
    const processed = processLlmScoring(llm, criteria, cyrillicSeller, []);
    const violations = findScriptViolations(userFacingScoringText(processed));
    assertEqual(violations.length, 1, 'faqat bitta maydon');
    assertEqual(violations[0]?.field, 'criteria.need_discovery.comment', 'maydon nomi');
  });
}

// ---------------------------------------------------------------------------
// 9. UI: "Qayta baholash" qachon chiqadi
// ---------------------------------------------------------------------------
function verifyRescoreRule(): void {
  section('[9] UI: "Qayta baholash" tugmasi qoidasi');
  const t0 = Date.parse('2026-10-31T10:00:00Z');
  const createdAt = new Date(t0).toISOString();

  check(report, 'failed -> darhol; done -> hech qachon', () => {
    assert(canOfferRescore({ status: 'failed', createdAt }, t0, null), 'failed');
    assert(!canOfferRescore({ status: 'done', createdAt }, t0 + 10 * 60_000, null), 'done');
  });

  check(report, 'pending: 3 daqiqagacha yo\'q, 3 daqiqadan keyin bor', () => {
    assertEqual(RESCORE_PENDING_AFTER_MS, 180_000, '3 daqiqa');
    assert(!canOfferRescore({ status: 'pending', createdAt }, t0 + 179_000, t0), '2:59 da yo\'q');
    assert(canOfferRescore({ status: 'pending', createdAt }, t0 + 180_000, t0), '3:00 da bor');
  });

  check(report, "tugma holati: run ketayotganda o'chiq, tugagach (done/failed) yoqiladi", () => {
    const done = { version: 3, status: 'done' as const, error: null, createdAt };
    // Qayta baholash bosildi, server v4 ni qaytardi, sahifada hali v3 done.
    assert(scoringRunState(done, done, 4).inProgress, "v4 ko'rinmaguncha o'chiq");
    const pending4 = { version: 4, status: 'pending' as const, error: null, createdAt };
    assert(scoringRunState(done, pending4, 4).inProgress, 'v4 pending — o\'chiq');
    // v4 tugadi -> route uni `result` qilib qaytaradi.
    const done4 = { ...pending4, status: 'done' as const };
    assert(!scoringRunState(done4, done4, 4).inProgress, 'v4 done — yoqiladi');
    // v4 yiqildi -> oldingi v3 ko'rsatiladi, xato haqida xabar, tugma yoqiladi.
    const failed4 = { ...pending4, status: 'failed' as const, error: 'timeout' };
    const failedState = scoringRunState(done, failed4, 4);
    assert(!failedState.inProgress, 'failed — yoqiladi');
    assertEqual(failedState.failedRun?.version, 4, "yangi run xatosi ko'rsatiladi");
    // Eski server (latestRun yo'q) bilan ham ishlaydi.
    assert(!scoringRunState(done, undefined, null).inProgress, 'latestRun yo\'q');
  });

  check(report, 'pending: server soati boshqacha bo\'lsa ham brauzer kuzatgan vaqt yetadi', () => {
    const futureCreated = new Date(t0 + 60 * 60_000).toISOString(); // server soati 1 soat oldinda
    assert(
      canOfferRescore({ status: 'pending', createdAt: futureCreated }, t0 + 200_000, t0),
      'brauzer 3+ daqiqa kuzatdi',
    );
    assert(
      canOfferRescore({ status: 'pending', createdAt }, t0 + 200_000, null),
      'eski pending (sahifa yangi ochilgan) — server yoshi bo\'yicha',
    );
  });
}

// ---------------------------------------------------------------------------
// 10. Til himoyasi (uz): transliteratsiya, tasnif, maydon darajasida qayta yaratish
// ---------------------------------------------------------------------------
/** Regressiya #1: haqiqiy debriefdagi mezon izohi (mo'g'ulcha), xabardagi ko'rinishida. */
const MONGOLIAN_COMMENT = 'санал болгосноор хариулсан ч ... нотлоогүй';
/**
 * Regressiya #2: "Muhim lahzalar" o'zbek kirillida. Xabarda aynan matn
 * keltirilmagan — shu ko'rinishdagi (o'sha bo'lim uchun xos) gap.
 */
const UZ_CYRILLIC_MOMENT = 'Мижоз нархни сўради, сотувчи эса аниқ жавоб бермади ва ишонч пасайди.';
const UZ_CYRILLIC_MOMENT_LATIN = "Mijoz narxni so'radi, sotuvchi esa aniq javob bermadi va ishonch pasaydi.";

async function verifyLanguageGuard(): Promise<void> {
  section('[10] Til himoyasi (uz)');

  check(report, "transliteratsiya: е so'z boshida/unlidan keyin, ё/ю/я, ъ, ц, katta harf", () => {
    const cases: Array<[string, string]> = [
      ['ер', 'yer'],
      ['Ер', 'Yer'],
      ['келди', 'keldi'],
      ['поезд', 'poyezd'],
      ['ёшлар', 'yoshlar'],
      ['Юлдуз', 'Yulduz'],
      ['янги', 'yangi'],
      ['маъно', "ma'no"],
      ['съезд', "s'yezd"],
      ['ўқитувчи', "o'qituvchi"],
      ['ғалаба', "g'alaba"],
      ['ҳамма', 'hamma'],
      ['Шаҳар', 'Shahar'],
      ['ШАҲАР', 'SHAHAR'],
      ['Чой', 'Choy'],
      ['цирк', 'sirk'],
      ['милиция', 'militsiya'],
      ['Ўзбекистон', "O'zbekiston"],
    ];
    for (const [cyr, lat] of cases) assertEqual(transliterateUzCyrillic(cyr), lat, cyr);
  });

  check(report, "transliteratsiya: tinish belgilari, raqamlar va lotin matn o'zgarmaydi", () => {
    assertEqual(
      transliterateUzCyrillic('Салом, дўстим! «Яхши». Ер-юзи; 12 000 сўм?'),
      "Salom, do'stim! «Yaxshi». Yer-yuzi; 12 000 so'm?",
      'aralash tinish belgilari',
    );
    assertEqual(transliterateUzCyrillic("Mijoz нархни so'radi"), "Mijoz narxni so'radi", 'aralash');
    assertEqual(transliterateUzCyrillic(UZ_CYRILLIC_MOMENT), UZ_CYRILLIC_MOMENT_LATIN, 'regressiya #2');
  });

  check(report, "tasnif: lotin / o'zbek kirill / begona (mo'g'ul, rus)", () => {
    assertEqual(classifyUzText("Mijoz narxni so'radi, 12 000 so'm."), 'latin', 'lotin');
    assertEqual(classifyUzText(UZ_CYRILLIC_MOMENT), 'uz_cyrillic', 'regressiya #2: o\'zbek kirill');
    assertEqual(classifyUzText(MONGOLIAN_COMMENT), 'foreign', "regressiya #1: mo'g'ul");
    assertEqual(classifyUzText('Санал болгосноор хариулсан'), 'foreign', "mo'g'ul so'zlari (ө/ү siz)");
    assertEqual(classifyUzText('Өнөөдөр сайн байна'), 'foreign', "mo'g'ul harflari ө ү");
    assertEqual(classifyUzText("Suhbat хорошо o'tdi"), 'foreign', "lotin ichida rus so'zi");
    assertEqual(classifyUzText('Клиент задал вопрос о цене'), 'foreign', 'rus gapi');
    assertEqual(classifyUzText('Это очень дорого'), 'foreign', 'rus');
    assertEqual(classifyUzText('Τιμή'), 'foreign', 'yunon');
  });

  /** Debriefga o'xshash qayta ishlangan natija. */
  const processedWith = (comment: string, moment: string) => {
    const criteria = flattenCriteria(DEFAULT_TRAINING_RUBRIC);
    const llm = llmScoringSchema.parse({
      criteria: criteria.map((c, i) => ({
        code: c.code,
        score: 2,
        evidenceQuote: 'Narx tarkibida nimalar borligini',
        evidenceTurnSeq: 3,
        comment: i === 0 ? comment : 'izoh',
      })),
      coaching: { summary: 'Umumiy xulosa', strengths: ['Yaxshi savol'], improvements: [] },
      keyMoments: [{ turnSeq: 2, kind: 'objection_raised', explanation: moment }],
    });
    const turns: EvidenceTurn[] = [
      { seq: 1, speaker: 'seller', text: SELLER_LINES[0] as string },
      { seq: 2, speaker: 'customer', text: 'Narxi qancha?' },
      { seq: 3, speaker: 'seller', text: SELLER_LINES[2] as string },
    ];
    return processLlmScoring(llm, criteria, turns, [{ turnSeq: 2, kind: 'objection_raised' }]);
  };
  const commentId = `criteria.${flattenCriteria(DEFAULT_TRAINING_RUBRIC)[0]!.code}.comment`;

  await checkAsync(report, "regressiya: kirill lahza o'giriladi (LLM'siz), mo'g'ul izoh — faqat u qayta so'raladi", async () => {
    const processed = processedWith(MONGOLIAN_COMMENT, UZ_CYRILLIC_MOMENT);
    const asked: string[][] = [];
    const report1 = await enforceScoringLanguage(processed, async (fields) => {
      asked.push(fields.map((f) => f.id));
      return new Map([[commentId, 'Taklif bilan javob berdi, lekin uni isbotlamadi.']]);
    });
    assertEqual(asked.length, 1, 'bitta chaqiruv');
    assertDeepEqual(asked[0], [commentId], "faqat begona maydon so'raldi");
    assertEqual(processed.keyMoments[0]?.explanation, UZ_CYRILLIC_MOMENT_LATIN, 'lahza lotinda');
    assertEqual(processed.criteria[0]?.comment, 'Taklif bilan javob berdi, lekin uni isbotlamadi.', 'izoh yangilandi');
    assertDeepEqual(report1.hidden, [], "hech narsa yashirilmadi");
    const leftovers = findScriptViolations(userFacingScoringText(processed));
    assertEqual(leftovers.length, 0, "lotin bo'lmagan matn qolmadi");
  });

  await checkAsync(report, "qayta yaratish yana begona / qaytmadi / yiqildi -> yashiriladi", async () => {
    for (const [name, regen] of [
      ['yana begona', async () => new Map([[commentId, MONGOLIAN_COMMENT]])],
      ['qaytmadi', async () => new Map<string, string>()],
      ['yiqildi', async () => {
        throw new Error('timeout');
      }],
    ] as const) {
      const processed = processedWith(MONGOLIAN_COMMENT, 'Oddiy lotin izoh');
      const r = await enforceScoringLanguage(processed, regen);
      assertDeepEqual(r.hidden, [commentId], `${name}: yashirildi`);
      assertEqual(processed.criteria[0]?.comment, LANGUAGE_PLACEHOLDER, `${name}: placeholder`);
    }
  });

  await checkAsync(report, "qayta yaratish o'zbek kirillida qaytsa -> lotinga o'giriladi", async () => {
    const processed = processedWith(MONGOLIAN_COMMENT, 'Oddiy lotin izoh');
    await enforceScoringLanguage(processed, async () => new Map([[commentId, 'Мижоз нархни сўради']]));
    assertEqual(processed.criteria[0]?.comment, "Mijoz narxni so'radi", 'lotinda');
  });

  await checkAsync(report, "hammasi lotin -> chaqiruv yo'q", async () => {
    let calls = 0;
    const processed = processedWith('Yaxshi izoh', 'Lotin lahza');
    await enforceUzLatin(
      userFacingScoringText(processed).map((f) => ({ id: f.field, text: f.text, set: () => undefined })),
      async () => {
        calls += 1;
        return new Map();
      },
    );
    assertEqual(calls, 0, "chaqiruv yo'q");
  });

  // --- Mijoz javobi --------------------------------------------------------
  await checkAsync(report, "mijoz javobi: lotin / kirill (LLM'siz) / begona -> retry / fallback", async () => {
    const latin = await guardCustomerReply({ reply: 'Narxi qancha?' }, async () => {
      throw new Error("chaqirilmasligi kerak");
    });
    assertEqual(latin.outcome, 'ok', 'lotin');

    let retries = 0;
    const cyr = await guardCustomerReply({ reply: 'Яхши, нархи қанча?' }, async () => {
      retries += 1;
      return { reply: 'x' };
    });
    assertEqual(cyr.result.reply, 'Yaxshi, narxi qancha?', "o'girildi");
    assertEqual(retries, 0, "o'zbek kirill uchun LLM chaqirilmaydi");

    const regen = await guardCustomerReply({ reply: 'Хорошо, а сколько стоит?' }, async () => ({
      reply: 'Yaxshi, narxi qancha?',
    }));
    assertEqual(regen.outcome, 'regenerated', 'qayta yaratildi');
    assertEqual(regen.stateSource.reply, 'Yaxshi, narxi qancha?', 'holat yangi javobdan');

    const fallback = await guardCustomerReply({ reply: 'Хорошо, а сколько стоит?' }, async () => ({
      reply: 'Сайн байна уу',
    }));
    assertEqual(fallback.outcome, 'fallback', 'fallback');
    assertEqual(fallback.result.reply, CUSTOMER_LANGUAGE_FALLBACK, 'neytral gap');
    assertEqual(classifyUzText(CUSTOMER_LANGUAGE_FALLBACK), 'latin', 'fallback lotinda');
  });

  check(report, "baholash prompti: faqat lotin, kirill taqiqi va namuna gap", () => {
    const system = buildScoringSystemPrompt(promptInput());
    assert(system.includes('NEVER use Cyrillic'), 'kirill taqiqi');
    assert(system.includes('Example of the required style'), 'namuna gap');
    assert(classifyUzText(LANGUAGE_PLACEHOLDER) === 'latin', 'placeholder lotinda');
  });
}

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
      assertEqual(stored.promptVersion, SCORING_PROMPT_VERSION, 'promptVersion');
      assert(Number(stored.costUsd) > 0, 'cost_usd to\'ldirilishi kerak');
      assertEqual(stored.criteria?.length, 8, 'mezonlar soni');
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

    // --- 6c-3. Biznes faktlari, qizil chiziq va skript saqlanadi ----------
    await checkAsync(report, "profil+skript: qizil chiziq va skriptga moslik natijaga yoziladi", async () => {
      const sessionId = await playSession(ctxA, { turns: 3 });
      const rule = PROFILE.redLines[0] as string;
      const script = parseSalesScriptMarkdown('## Salomlashish\n- Salomlashadi\n## Yopish\n- Kelishadi');
      const payload = {
        ...scoringPayload(),
        redLineViolations: [
          {
            rule,
            evidenceQuote: 'Narx tarkibida nimalar borligini',
            evidenceTurnSeq: 3,
            explanation: 'Test buzilishi.',
          },
        ],
        scriptAdherence: [
          {
            stage: 'Salomlashish',
            status: 'followed',
            evidenceQuote: 'Narx tarkibida nimalar borligini',
            evidenceTurnSeq: 3,
            comment: 'Bajarildi.',
          },
          { stage: 'Yopish', status: 'missed', evidenceQuote: null, evidenceTurnSeq: null, comment: "Yo'q." },
        ],
      };
      const llm = new FakeTrainerLlm([payload]);
      const scoring = createScoringService({
        withTenant,
        llm,
        getBusinessProfile: async () => PROFILE,
        getSalesScript: async () => script,
      });
      await scoring.scoreSession(ctxA, sessionId);
      const prompt = llm.calls[0]?.system ?? '';
      assert(prompt.includes(PROFILE.primaryOffers[0] as string), 'promptda profil taklifi');
      assert(prompt.includes('## Sales script adherence'), "promptda skript bo'limi");

      const stored = await scoring.getLatestResult(ctxA, sessionId);
      assertEqual(stored?.coaching?.redLineViolations?.length, 1, 'qizil chiziq saqlandi');
      assertEqual(stored?.coaching?.redLineViolations?.[0]?.rule, rule, 'qoida');
      assertDeepEqual(
        stored?.coaching?.scriptAdherence?.map((s) => s.status),
        ['followed', 'missed'],
        'skriptga moslik saqlandi',
      );
    });

    // --- 6c-4. Til: maydon darajasida qayta yaratish / yashirish --------
    // Regressiya: haqiqiy debriefdagi ikki xato (mo'g'ulcha izoh va o'zbek
    // kirillidagi "Muhim lahzalar").
    await checkAsync(report, "debrief: mo'g'ulcha izoh qayta yaratiladi, kirill lahza o'giriladi (DB)", async () => {
      const sessionId = await playSession(ctxA, { turns: 3 });
      const dirty = scoringPayload();
      dirty.criteria[0]!.comment = MONGOLIAN_COMMENT;
      dirty.keyMoments[0]!.explanation = UZ_CYRILLIC_MOMENT;
      const rewrite = {
        fields: [{ id: `criteria.${dirty.criteria[0]!.code}.comment`, text: "Taklif bilan javob berdi, lekin uni isbotlamadi." }],
      };
      const llm = new FakeTrainerLlm([dirty, rewrite]);
      const scoring = createScoringService({ withTenant, llm });
      const result = await scoring.scoreSession(ctxA, sessionId);
      assertEqual(llm.callCount, 2, 'bitta qo\'shimcha chaqiruv (faqat begona maydon)');
      assertEqual(llm.calls[1]?.stage, 'training.scoring.language', 'til chaqiruvi');
      assert(!(llm.calls[1]?.user ?? '').includes('keyMoments'), "kirill lahza qayta so'ralmaydi");
      assertEqual(result.quality, 'ok', 'hech narsa yashirilmadi');
      const stored = await scoring.getLatestResult(ctxA, sessionId);
      assertEqual(stored?.criteria?.[0]?.comment, "Taklif bilan javob berdi, lekin uni isbotlamadi.", 'izoh');
      assertEqual(stored?.keyMoments?.[0]?.explanation, UZ_CYRILLIC_MOMENT_LATIN, "lahza lotinda");
      assertEqual(stored?.coaching?.languageCheck?.transliterated, 1, "1 ta o'girildi");
    });

    await checkAsync(report, "debrief: qayta yaratish ham begona -> yashiriladi, quality=low (DB)", async () => {
      const sessionId = await playSession(ctxA, { turns: 3 });
      const dirty = scoringPayload();
      dirty.coaching.summary = "Suhbat хорошо o'tdi.";
      const stillBad = { fields: [{ id: 'coaching.summary', text: 'Всё хорошо было.' }] };
      const llm = new FakeTrainerLlm([dirty, stillBad]);
      const scoring = createScoringService({ withTenant, llm });
      const result = await scoring.scoreSession(ctxA, sessionId);
      assertEqual(result.status, 'done', 'natija yoziladi');
      assertEqual(result.quality, 'low', 'quality=low');
      assertEqual(llm.callCount, 2, "uchinchi chaqiruv yo'q");
      const stored = await scoring.getLatestResult(ctxA, sessionId);
      assertEqual(stored?.coaching?.summary, LANGUAGE_PLACEHOLDER, 'yashirildi');
      assertDeepEqual(stored?.coaching?.lowQualityReasons, ['language'], 'sabab: til');
    });

    // --- 6c-5. Server to'xtagan: osilib qolgan pending -> failed ----------
    await checkAsync(report, "startda eski pending -> failed ('server qayta ishga tushdi'), yangisi tegilmaydi", async () => {
      const sessionId = await playSession(ctxA, { turns: 3 });
      const metrics = { sellerTurns: 3 } as never;
      const [oldId, freshId] = await withTenant(bizA, async (tx) => {
        const base = (await scoringRepo.maxResultVersion(tx, sessionId)) + 1;
        const a = await scoringRepo.insertPendingResult(tx, {
          businessId: bizA,
          sessionId,
          version: base,
          metrics,
          createdAt: new Date(Date.now() - 10 * 60_000),
        });
        const b = await scoringRepo.insertPendingResult(tx, {
          businessId: bizA,
          sessionId,
          version: base + 1,
          metrics,
          createdAt: new Date(),
        });
        return [a, b];
      });

      const scoring = createScoringService({ withTenant, llm: new FakeTrainerLlm([scoringPayload()]) });
      // Boshqa tenant nomidan chaqirilsa — bizA ga tegmaydi (RLS).
      assertEqual(await scoring.failStalePending(bizB, { olderThanMs: 120_000 }), 0, 'boshqa tenant');
      const count = await scoring.failStalePending(bizA, { olderThanMs: 120_000 });
      assert(count >= 1, 'kamida bitta failed qilindi');

      const versions = await withTenant(bizA, async (tx) => scoringRepo.listResultVersions(tx, sessionId));
      const oldRow = versions.find((v) => v.id === oldId);
      const freshRow = versions.find((v) => v.id === freshId);
      assertEqual(oldRow?.status, 'failed', 'eski -> failed');
      assertEqual(oldRow?.error, STALE_PENDING_ERROR, 'xato matni');
      assertEqual(freshRow?.status, 'pending', 'yangi pending tegilmaydi');

      // Yangi `pending` hali tirik ekan, qayta baholash BOSHLANMAYDI —
      // sessiya qulfi o'sha ketayotgan run'ni qaytaradi (bitta run qoidasi).
      const blocked = await scoring.scoreSession(ctxA, sessionId);
      assertEqual(blocked.status, 'pending', 'ketayotgan run qaytariladi');
      assertEqual(blocked.alreadyRunning, true, 'yangi run boshlanmadi');
      assertEqual(blocked.version, freshRow?.version, 'aynan yangi pending');

      // Yangisi ham yopilgach — qayta baholash yangi versiya qo'shadi, eskilari qoladi.
      await scoring.failStalePending(bizA, { olderThanMs: 0 });
      const before = versions.length;
      const rescored = await scoring.scoreSession(ctxA, sessionId);
      assertEqual(rescored.status, 'done', 'qayta baholandi');
      const after = await withTenant(bizA, async (tx) => scoringRepo.listResultVersions(tx, sessionId));
      assertEqual(after.length, before + 1, 'yangi versiya');
      assert(after.some((v) => v.id === oldId && v.status === 'failed'), 'eski failed versiya saqlanadi');
    });

    // --- 6c-6. Bir sessiyada bitta baholash (tugmani ko'p bosish) --------
    /** Chaqiruvlarni "ochish"gacha ushlab turadigan LLM — run'lar ustma-ust tushsin. */
    const gatedLlm = (script: unknown[]) => {
      const inner = new FakeTrainerLlm(script);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const llm: TrainerLlm & { calls: number } = {
        calls: 0,
        async completeJson<T>(req: TrainerLlmRequest<T>): Promise<T> {
          llm.calls += 1;
          await gate;
          return inner.completeJson(req);
        },
      };
      return { llm, release: () => release() };
    };

    await checkAsync(report, '5 ta tez requestScoring -> aynan BITTA run (DB qulfi)', async () => {
      const sessionId = await playSession(ctxA, { turns: 3 });
      const versionsBefore = await withTenant(bizA, async (tx) => scoringRepo.listResultVersions(tx, sessionId));
      const { llm, release } = gatedLlm([scoringPayload(), scoringPayload()]);
      const scoring = createScoringService({ withTenant, llm });

      const requests = await Promise.all(
        Array.from({ length: 5 }, () => scoring.requestScoring(ctxA, sessionId)),
      );
      assertEqual(requests.filter((r) => !r.alreadyRunning).length, 1, 'faqat bittasi yangi');
      assertEqual(new Set(requests.map((r) => r.version)).size, 1, 'hammasi bitta versiyani oladi');
      assertEqual(requests.filter((r) => r.done !== null).length, 1, 'bitta bajarish');

      release();
      await Promise.all(requests.map((r) => r.done).filter((d) => d !== null));
      const versionsAfter = await withTenant(bizA, async (tx) => scoringRepo.listResultVersions(tx, sessionId));
      assertEqual(versionsAfter.length, versionsBefore.length + 1, 'bitta yangi versiya');
      assertEqual(llm.calls, 1, 'LLM bir marta chaqirildi');
      assertEqual(versionsAfter[0]?.status, 'done', 'tugadi');

      // Tugagandan keyin yangi qayta baholash yana mumkin.
      const next = await scoring.requestScoring(ctxA, sessionId);
      assertEqual(next.alreadyRunning, false, "tugagach yangi run boshlanadi");
      await next.done;
    });

    await checkAsync(report, "5 ta tez POST /score -> hammasi 202, aynan BITTA run; /result latestRun beradi", async () => {
      const sessionId = await playSession(ctxA, { turns: 3 });
      const { llm, release } = gatedLlm([scoringPayload()]);
      const engine = createTrainingEngine({ withTenant, getBusinessProfile, llm: new FakeTrainerLlm([]) });
      const scoring = createScoringService({ withTenant, llm });
      const app = Fastify();
      await registerTrainingRoutes(app, {
        engine,
        scoring,
        withTenant,
        getContext: () => ctxA,
        config: { autoScoreOnEnd: false, rateLimitPerMinute: 100 },
      });
      await app.ready();

      const url = `/api/v1/training/sessions/${sessionId}/score`;
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => app.inject({ method: 'POST', url, payload: {} })),
      );
      for (const res of responses) assertEqual(res.statusCode, 202, '202');
      const bodies = responses.map((r) => r.json() as { version: number; alreadyRunning: boolean });
      assertEqual(bodies.filter((b) => !b.alreadyRunning).length, 1, 'bitta yangi run');
      assertEqual(new Set(bodies.map((b) => b.version)).size, 1, 'bitta versiya');

      const during = (await app.inject({ url: `/api/v1/training/sessions/${sessionId}/result` })).json() as {
        latestRun: { status: string; version: number } | null;
      };
      assertEqual(during.latestRun?.status, 'pending', 'latestRun pending');

      release();
      let status = 'pending';
      for (let i = 0; i < 100 && status === 'pending'; i += 1) {
        await new Promise((r) => setTimeout(r, 20));
        status = (await scoring.getLatestAnyResult(ctxA, sessionId))?.status ?? 'pending';
      }
      assertEqual(status, 'done', 'fon run tugadi');
      assertEqual(llm.calls, 1, 'LLM bir marta');
      const after = (await app.inject({ url: `/api/v1/training/sessions/${sessionId}/result` })).json() as {
        result: { version: number; status: string };
        latestRun: { status: string; version: number } | null;
      };
      assertEqual(after.result.status, 'done', "yangi natija ko'rinadi");
      assertEqual(after.result.version, bodies[0]?.version, 'aynan o\'sha versiya');
      await app.close();
    });

    await checkAsync(report, "o'lik pending (pendingStaleAfterMs dan eski) yangi run'ga to'sqinlik qilmaydi", async () => {
      const sessionId = await playSession(ctxA, { turns: 3 });
      await withTenant(bizA, async (tx) => {
        await scoringRepo.insertPendingResult(tx, {
          businessId: bizA,
          sessionId,
          version: (await scoringRepo.maxResultVersion(tx, sessionId)) + 1,
          metrics: { sellerTurns: 3 } as never,
          createdAt: new Date(Date.now() - 60 * 60_000),
        });
      });
      const scoring = createScoringService({
        withTenant,
        llm: new FakeTrainerLlm([scoringPayload()]),
        pendingStaleAfterMs: 5 * 60_000,
      });
      const result = await scoring.scoreSession(ctxA, sessionId);
      assertEqual(result.alreadyRunning ?? false, false, 'yangi run boshlandi');
      assertEqual(result.status, 'done', 'tugadi');
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

// ---------------------------------------------------------------------------
// 11. Narxsiz rejim: profilda narx fakti yo'q
// ---------------------------------------------------------------------------
/** Demo profildan narx/chegirma raqamlari olib tashlangan nusxa (faqat nom, muddat, jadval). */
function stripPrices(profile: BusinessProfile): BusinessProfile {
  return profileSchema.parse({
    ...profile,
    primaryOffers: profile.primaryOffers.map((o) =>
      o.replace(/,?\s*(oyiga\s*)?\d[\d\s]*so'm/giu, '').replace(/[,:]\s*$/u, '').trim(),
    ),
    additionalNotes: profile.additionalNotes,
  });
}

function verifyNoPriceMode(): void {
  section("[11] Narxsiz rejim (profilda narx yo'q)");
  const NO_PRICE = stripPrices(PROFILE);
  const criteria = flattenCriteria(DEFAULT_TRAINING_RUBRIC);

  check(report, "hasPriceFacts: narxli demo — ha; narxsiz nusxa — yo'q; foiz chegirma — ha", () => {
    assertEqual(hasPriceFacts(PROFILE), true, 'narxli');
    assertEqual(hasPriceFacts(NO_PRICE), false, `narxsiz: ${NO_PRICE.primaryOffers.join(' | ')}`);
    assertEqual(hasPriceFacts({ primaryOffers: ['A: 3 oy'], additionalNotes: '10% chegirma' }), true, 'foiz');
    assertEqual(hasPriceFacts({ primaryOffers: ['A: 3 oy, haftada 3 marta'], additionalNotes: null }), false, 'muddat narx emas');
  });

  check(report, 'isPriceRedLine: narx/chegirma/aksiya — ha; boshqa — yo\'q', () => {
    assert(isPriceRedLine('Soxta chegirma aytmaslik'), 'chegirma');
    assert(isPriceRedLine("Narxni keyin o'zgartirmaslik"), 'narx');
    assert(isPriceRedLine('Aldamchi aksiya aytmaslik'), 'aksiya');
    assert(!isPriceRedLine("Ish kafolatini va'da qilmaslik"), 'kafolat');
  });

  check(report, "resolvePriceScope: narxsiz — product_accuracy va narx qizil chiziqlari olib tashlanadi", () => {
    const scope = resolvePriceScope(NO_PRICE, criteria);
    assertEqual(scope.priceCheck, 'skipped_no_data', 'priceCheck');
    assert(!scope.criteria.some((c) => c.code === 'product_accuracy'), 'mezon yo\'q');
    assertEqual(scope.criteria.length, criteria.length - 1, 'faqat bitta mezon olib tashlandi');
    assert(!scope.redLines.some(isPriceRedLine), 'narx qizil chizig\'i yo\'q');
    assert(scope.redLines.includes("Ish kafolatini va'da qilmaslik"), 'boshqa qizil chiziq qoladi');
    const full = resolvePriceScope(PROFILE, criteria);
    assertEqual(full.priceCheck, 'checked', 'narxli — checked');
    assertEqual(full.criteria.length, criteria.length, 'narxli — hammasi');
    assertEqual(resolvePriceScope(null, criteria).priceCheck, undefined, 'profilsiz');
  });

  check(report, "narxsiz: ball qolgan mezonlar bo'yicha (vazn qayta taqsimlanadi)", () => {
    const scope = resolvePriceScope(NO_PRICE, criteria);
    const all3 = scope.criteria.map((c) => ({
      code: c.code,
      name: c.name,
      weight: c.weight,
      score: 3 as const,
      comment: 'ok',
      evidenceQuote: null,
      evidenceTurnSeq: null,
    }));
    assertEqual(computeSkillScore(all3 as never).skillScore, 100, "hammasi 3 -> 100 (olib tashlangan vazn jazo emas)");
  });

  check(report, "narxsiz: LLM narx qizil chizig'ini qaytarsa ham belgilanmaydi", () => {
    const scope = resolvePriceScope(NO_PRICE, criteria);
    const turns: EvidenceTurn[] = [
      { seq: 1, speaker: 'seller', text: 'Bugun faqat siz uchun ellik foiz chegirma bor, shoshiling' },
    ];
    const raw = llmScoringSchema.parse({
      criteria: scope.criteria.map((c) => ({ code: c.code, score: null, comment: '-', evidenceQuote: null, evidenceTurnSeq: null })),
      coaching: { summary: 's', strengths: [], improvements: [] },
      keyMoments: [],
      redLineViolations: [
        {
          rule: 'Soxta chegirma aytmaslik',
          evidenceQuote: 'Bugun faqat siz uchun ellik foiz chegirma bor',
          evidenceTurnSeq: 1,
          explanation: 'x',
        },
      ],
      scriptAdherence: [],
    });
    const out = processLlmScoring(raw, scope.criteria, turns, [], { redLines: scope.redLines, script: null });
    assertEqual(out.coaching.redLineViolations?.length ?? 0, 0, 'belgilanmadi');
    assert(!out.criteria.some((c) => c.code === 'product_accuracy'), 'mezon natijada yo\'q');
  });

  check(report, "baholash prompti: narxsiz — narx tekshiruvi o'chiq, narx qizil chiziqlari ko'rsatilmaydi", () => {
    const system = buildScoringSystemPrompt(
      promptInput({ profile: NO_PRICE, criteria: resolvePriceScope(NO_PRICE, criteria).criteria }),
    );
    assert(system.includes('PRICE CHECK IS DISABLED'), 'qoida bor');
    assert(system.includes('NO prices were provided'), 'takliflar sarlavhasi');
    assert(!system.includes('Soxta chegirma aytmaslik'), 'narx qizil chizig\'i yo\'q');
    assert(system.includes("Ish kafolatini va'da qilmaslik"), 'boshqa qizil chiziq bor');
    assert(!system.includes('(exact offer name and price)'), 'narx aytishni maslahat bermaydi');
    assert(!buildScoringSystemPrompt(promptInput()).includes('PRICE CHECK IS DISABLED'), 'narxli profilda yo\'q');
    assertEqual(SCORING_PROMPT_VERSION, 'scoring-v4', 'versiya');
  });

  check(report, "mijoz prompti: narxni so'raydi, lekin o'zi aytmaydi/tasdiqlamaydi", () => {
    assertEqual(PROMPT_VERSION, 'training-v5', 'versiya');
    const system = TURN_STATIC_PREFIX;
    assert(system.includes('Ask about price and terms the way a real customer does'), "so'rash qoidasi");
    assert(system.includes('Never state, guess or "confirm" a price'), 'aytmaslik qoidasi');
    const personaUser = buildPersonaUserPrompt({ archetype: NEGOTIATOR, profile: NO_PRICE, direction: 'outbound', language: 'uz' });
    assert(personaUser.includes('NO PRICES were provided'), 'persona promptida narxsiz qoida');
    assert(
      !buildPersonaUserPrompt({ archetype: NEGOTIATOR, profile: PROFILE, direction: 'outbound', language: 'uz' }).includes('NO PRICES'),
      'narxli profilda yo\'q',
    );
  });

  check(report, "persona: narxsiz profilda hiddenFacts dagi narx ham rad etiladi; narxli profilda hearsay mumkin", () => {
    const card = fakePersona({ objectionKeys: OBJECTION_KEYS, severity: 3, focusOffer: NO_PRICE.primaryOffers[0] as string, direction: 'outbound' });
    const withHearsay = { ...(card as Record<string, unknown>), hiddenFacts: ["Tanishim oyiga 900 000 so'm deb aytgandi"] };
    const noPrice = makePersonaCardSchema({ archetype: NEGOTIATOR, profile: NO_PRICE, direction: 'outbound', language: 'uz' }).safeParse(withHearsay);
    assert(!noPrice.success, 'narxsiz — rad');
    assert(
      !noPrice.success && noPrice.error.issues.some((i) => i.path[0] === 'hiddenFacts' && i.message.includes('narx bermagan')),
      'hiddenFacts xatosi',
    );
    const priced = makePersonaCardSchema({ archetype: NEGOTIATOR, profile: PROFILE, direction: 'outbound', language: 'uz' }).safeParse({
      ...withHearsay,
      focusOffer: FIRST_OFFER,
    });
    assert(priced.success, `narxli — hearsay mumkin: ${priced.success ? '' : priced.error.message}`);
  });
}

async function main(): Promise<void> {
  console.log('verify-training-scoring — Step 4 Phase A (haqiqiy LLM ishlatilmaydi)');

  verifyRubric();
  verifyEvidenceRules();
  verifyScoreMath();
  verifyMetricsAndMoments();
  verifyProcessing();
  verifyBusinessFacts();
  verifyRescoreRule();
  verifyNoPriceMode();
  await verifyLanguageGuard();

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
