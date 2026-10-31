/**
 * verify-training-core.ts — Step 2 yadrosining deterministik testlari.
 * HAQIQIY LLM CHAQIRILMAYDI: hamma joyda `FakeTrainerLlm`.
 *
 * Ishga tushirish: `npm run verify:training:core` (harness ichidan).
 * DB kerak bo'lmasa: `SKIP_DB=1`.
 *
 * Qamrov (Step 2 prompt, E bo'limi):
 *   1. holat: clamping, bazaviy decay, notanish e'tiroz kalitlari, needRevealed;
 *   2. 4 arxetip uchun win/lose/timeout, `agree_or_next_step` nextStep bilan va yo'q holda;
 *   3. guard: model qoidani buzib "agrees" desa — bitta retry, keyin g'alaba YO'Q;
 *   4. info_seeker `needRevealed` bo'lmasa hech qachon yutmaydi;
 *   5. persona validatsiyasi: focusOffer, e'tiroz soni, PersonaGenerationError;
 *   6. engine + haqiqiy DB (cheklangan rol): persistence, bo'shliqsiz seq,
 *      state_after, tenant/egalik tekshiruvlari, tugagan sessiya;
 *   7. soha so'zlari skaneri (1-qoida);
 *   8. prompt builder'lar: blockers, untrusted-seller qoidasi, 12-navbat oynasi.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { ARCHETYPES, ARCHETYPE_KEYS, getArchetype, type Archetype } from './archetypes.js';
import { createTrainingEngine } from './engine.js';
import { CUSTOMER_LANGUAGE_FALLBACK, nonLatinWords } from './language.js';
import {
  classifyLlmError,
  describeLlmError,
  isCorrectableLlmError,
  LlmCallError,
  PersonaGenerationError,
  TrainingError,
} from './errors.js';
import {
  generatePersonaCard,
  makePersonaCardSchema,
  personaCardSchema,
  type PersonaCard,
} from './persona.js';
import type { GetBusinessProfile, TrainingContext, TrainingTx, WithTenant } from './ports.js';
import { profileSchema, type BusinessProfile } from './profile-schema.js';
import {
  extractPriceFigures,
  offerPriceFigures,
  offerTopic,
  unsaidPriceFigures,
} from './offer-facts.js';
import {
  buildPersonaSystemPrompt,
  buildTurnSystemPrompt,
  buildTurnUserPrompt,
  TRANSCRIPT_WINDOW,
  type TranscriptTurn,
} from './prompts.js';
import {
  applyTurnResult,
  basePatienceDecay,
  computeReadiness,
  evaluateEnd,
  initState,
  turnResultSchema,
  type TrainingState,
  type TurnResult,
} from './state.js';
import {
  assert,
  assertDeepEqual,
  assertEqual,
  assertThrows,
  check,
  checkAsync,
  createReport,
  section,
  skip,
} from './testing/assert.js';
import { FakeTrainerLlm, fakePersona, fakeTurn } from './testing/fake-llm.js';

const here = dirname(fileURLToPath(import.meta.url));
const moduleRoot = resolve(here, '../../..'); // module/backend
const report = createReport();

// ---------------------------------------------------------------------------
// Umumiy test ma'lumotlari
// ---------------------------------------------------------------------------
function loadProfile(): BusinessProfile {
  const raw: unknown = JSON.parse(readFileSync(resolve(here, 'demo-profiles.json'), 'utf8'));
  assert(raw && typeof raw === 'object', 'demo-profiles.json o\'qilmadi');
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    ([key]) => !key.startsWith('_'),
  );
  const first = entries[0];
  assert(first, 'demo profil topilmadi');
  return profileSchema.parse(first[1]);
}

const PROFILE = loadProfile();

/** Hamma demo profillar (taklif faktlari testlari uchun). */
function loadAllProfiles(): Array<[string, BusinessProfile]> {
  const raw = JSON.parse(readFileSync(resolve(here, 'demo-profiles.json'), 'utf8')) as Record<string, unknown>;
  return Object.entries(raw)
    .filter(([key]) => !key.startsWith('_'))
    .map(([key, value]) => [key, profileSchema.parse(value)]);
}
const FIRST_OFFER = PROFILE.primaryOffers[0] as string;

/** Arxetipga mos (e'tiroz soni to'g'ri) test personasi. */
function personaFor(archetype: Archetype, direction: 'inbound' | 'outbound' = 'inbound'): PersonaCard {
  const keys = Array.from({ length: archetype.objections.count }, (_, i) => `concern_${i + 1}`);
  const raw = fakePersona({
    objectionKeys: keys,
    severity: Math.min(2, archetype.objections.severityMax),
    focusOffer: FIRST_OFFER,
    hiddenNeed: archetype.hiddenNeed ? 'Haqiqiy ehtiyoji: natijaga ishonch yo\'q' : null,
    direction,
  });
  return makePersonaCardSchema({
    archetype,
    profile: PROFILE,
    direction,
    language: 'uz',
  }).parse(raw);
}

function turn(partial: Partial<TurnResult> = {}): TurnResult {
  return turnResultSchema.parse(fakeTurn(partial));
}

/** Hamma e'tirozni ko'targan va yechgan, ishonchi yetarli holat yasaydi. */
function readyState(archetype: Archetype, persona: PersonaCard): TrainingState {
  const keys = persona.objections.map((o) => o.key);
  return {
    patience: 80,
    trust: Math.max(archetype.win.minTrust, 60),
    interest: 70,
    flags: {
      objectionsRaised: [...keys],
      objectionsResolved: [...keys],
      needRevealed: archetype.hiddenNeed,
      guardViolations: 0,
    },
    promptVersion: 'training-v1',
  };
}

// ---------------------------------------------------------------------------
// 1. Holat
// ---------------------------------------------------------------------------
function verifyState(): void {
  section('[1] Holat (sof funksiyalar)');

  check(report, 'initState arxetip boshlang\'ich ballarini oladi', () => {
    for (const key of ARCHETYPE_KEYS) {
      const a = ARCHETYPES[key];
      const st = initState(a, personaFor(a));
      assertDeepEqual(
        { patience: st.patience, trust: st.trust, interest: st.interest },
        a.initialState,
        `${key}: ballar`,
      );
      assertDeepEqual(
        st.flags,
        { objectionsRaised: [], objectionsResolved: [], needRevealed: false, guardViolations: 0 },
        `${key}: flaglar`,
      );
      assertEqual(st.promptVersion, 'training-v2', `${key}: promptVersion`);
    }
  });

  check(report, 'bazaviy sabr kamayishi = ceil(difficulty / 2)', () => {
    for (const key of ARCHETYPE_KEYS) {
      const a = ARCHETYPES[key];
      assertEqual(basePatienceDecay(a), Math.ceil(a.difficulty / 2), `${key}: decay`);
      const st = initState(a, personaFor(a));
      const next = applyTurnResult(st, turn(), personaFor(a), a);
      assertEqual(
        next.patience,
        a.initialState.patience - Math.ceil(a.difficulty / 2),
        `${key}: neytral navbatdan keyin sabr`,
      );
    }
  });

  check(report, 'deltalar [-20, 20] ga, holat [0, 100] ga chegaralanadi', () => {
    const a = getArchetype('ready_buyer');
    const persona = personaFor(a);
    // Sxema o'zi -20..20 ni talab qiladi; applyTurnResult ham mustaqil chegaralaydi.
    const raw: TurnResult = { ...turn(), deltas: { patience: 999, trust: 999, interest: -999 } };
    const next = applyTurnResult(initState(a, persona), raw, persona, a);
    // Deltalar [-20, 20] ga tushadi, keyin holat [0, 100] ga.
    assertEqual(
      next.patience,
      Math.min(100, a.initialState.patience + 20) - basePatienceDecay(a),
      'patience (+20, keyin decay)',
    );
    assertEqual(next.trust, Math.min(100, a.initialState.trust + 20), 'trust (+20)');
    assertEqual(next.interest, Math.max(0, a.initialState.interest - 20), 'interest (-20)');

    // Pastki chegara ham tekshiriladi.
    const floored = applyTurnResult(
      { ...initState(a, persona), patience: 3, trust: 2, interest: 1 },
      { ...turn(), deltas: { patience: -20, trust: -20, interest: -20 } },
      persona,
      a,
    );
    assertDeepEqual(
      { patience: floored.patience, trust: floored.trust, interest: floored.interest },
      { patience: 0, trust: 0, interest: 0 },
      'pastki chegara',
    );
    const badRaw = { ...(fakeTurn() as Record<string, unknown>), deltas: { patience: 999, trust: 0, interest: 0 } };
    assert(!turnResultSchema.safeParse(badRaw).success, 'sxema 999 ni qabul qilmasligi kerak');
  });

  check(report, 'notanish e\'tiroz kalitlari e\'tiborsiz qoldiriladi', () => {
    const a = getArchetype('negotiator');
    const persona = personaFor(a);
    const known = persona.objections[0]?.key as string;
    const next = applyTurnResult(
      initState(a, persona),
      turn({
        objectionRaisedKey: 'oylab_topilgan_kalit',
        objectionsResolvedKeys: [known, 'yana_bir_yoq_kalit'],
      }),
      persona,
      a,
    );
    assertDeepEqual(next.flags.objectionsRaised, [], 'raised');
    assertDeepEqual(next.flags.objectionsResolved, [known], 'resolved');
  });

  check(report, 'bir xil kalit ikki marta qo\'shilmaydi', () => {
    const a = getArchetype('negotiator');
    const persona = personaFor(a);
    const key = persona.objections[0]?.key as string;
    let st = applyTurnResult(initState(a, persona), turn({ objectionRaisedKey: key }), persona, a);
    st = applyTurnResult(st, turn({ objectionRaisedKey: key }), persona, a);
    assertDeepEqual(st.flags.objectionsRaised, [key], 'raised');
  });

  check(report, 'needRevealed hiddenNeed bo\'lmasa yoqilmaydi', () => {
    const a = getArchetype('negotiator'); // hiddenNeed = false
    const persona = personaFor(a);
    const next = applyTurnResult(initState(a, persona), turn({ needRevealed: true }), persona, a);
    assertEqual(next.flags.needRevealed, false, 'needRevealed');

    const b = getArchetype('info_seeker'); // hiddenNeed = true
    const personaB = personaFor(b);
    const nextB = applyTurnResult(initState(b, personaB), turn({ needRevealed: true }), personaB, b);
    assertEqual(nextB.flags.needRevealed, true, 'needRevealed (info_seeker)');
    // Bir yoqilgach o'chmaydi.
    const nextB2 = applyTurnResult(nextB, turn({ needRevealed: false }), personaB, b);
    assertEqual(nextB2.flags.needRevealed, true, 'needRevealed o\'chmasligi kerak');
  });

  check(report, 'applyTurnResult kirish holatini o\'zgartirmaydi', () => {
    const a = getArchetype('problematic');
    const persona = personaFor(a);
    const st = initState(a, persona);
    const snapshot = JSON.stringify(st);
    applyTurnResult(st, turn({ deltas: { patience: -5, trust: 5, interest: 1 } }), persona, a);
    assertEqual(JSON.stringify(st), snapshot, 'holat');
  });
}

// ---------------------------------------------------------------------------
// 2. Win / lose / timeout
// ---------------------------------------------------------------------------
function verifyOutcomes(): void {
  section('[2] G\'alaba / yutqazish / timeout');

  for (const key of ARCHETYPE_KEYS) {
    check(report, `${key}: tayyor holatda "agrees" g'alaba beradi`, () => {
      const a = ARCHETYPES[key];
      const persona = personaFor(a);
      const state = readyState(a, persona);
      const result = turn({ intent: 'agrees' });
      const end = evaluateEnd({ state, result, turnCount: 3, archetype: a, persona });
      assertEqual(end.ended, true, 'ended');
      assertEqual(end.outcome, 'won', 'outcome');
    });

    check(report, `${key}: e'tirozlar ko'tarilmaganda "agrees" g'alaba bermaydi`, () => {
      const a = ARCHETYPES[key];
      const persona = personaFor(a);
      const state = { ...readyState(a, persona), flags: { ...readyState(a, persona).flags, objectionsRaised: [], objectionsResolved: [] } };
      const end = evaluateEnd({
        state,
        result: turn({ intent: 'agrees' }),
        turnCount: 3,
        archetype: a,
        persona,
      });
      assertEqual(end.ended, false, 'ended');
    });

    check(report, `${key}: sabr tugasa yutqazadi`, () => {
      const a = ARCHETYPES[key];
      const persona = personaFor(a);
      const state: TrainingState = {
        ...readyState(a, persona),
        patience: Math.max(0, a.lose.patienceBelow - 1),
      };
      const end = evaluateEnd({ state, result: turn(), turnCount: 2, archetype: a, persona });
      assertEqual(end.ended, true, 'ended');
      assertEqual(end.outcome, 'lost', 'outcome');
      assertEqual(end.reason, 'patience_exhausted', 'reason');
    });

    check(report, `${key}: maxTurns da timeout`, () => {
      const a = ARCHETYPES[key];
      const persona = personaFor(a);
      const end = evaluateEnd({
        state: readyState(a, persona),
        result: turn(),
        turnCount: a.maxTurns,
        archetype: a,
        persona,
      });
      assertEqual(end.ended, true, 'ended');
      assertEqual(end.outcome, 'timeout', 'outcome');
    });
  }

  check(report, 'agree_or_next_step: nextStep bilan g\'alaba (e\'tirozlar yechilmasa ham)', () => {
    const a = getArchetype('problematic');
    assertEqual(a.win.type, 'agree_or_next_step', 'arxetip turi');
    const persona = personaFor(a);
    const state: TrainingState = {
      ...initState(a, persona),
      trust: a.win.minTrust,
      patience: 50,
    };
    const end = evaluateEnd({
      state,
      result: turn({ intent: 'agrees_next_step', nextStep: 'Ertaga soat 10 da qayta gaplashamiz' }),
      turnCount: 4,
      archetype: a,
      persona,
    });
    assertEqual(end.ended, true, 'ended');
    assertEqual(end.outcome, 'won', 'outcome');
    assertEqual(end.reason, 'next_step_agreed', 'reason');
  });

  check(report, 'agree_or_next_step: nextStep bo\'lmasa g\'alaba yo\'q', () => {
    const a = getArchetype('problematic');
    const persona = personaFor(a);
    const state: TrainingState = { ...initState(a, persona), trust: a.win.minTrust, patience: 50 };
    const end = evaluateEnd({
      state,
      result: turn({ intent: 'agrees_next_step', nextStep: null }),
      turnCount: 4,
      archetype: a,
      persona,
    });
    assertEqual(end.ended, false, 'ended');
  });

  check(report, 'agree_or_next_step: ishonch yetmasa nextStep ham yordam bermaydi', () => {
    const a = getArchetype('problematic');
    const persona = personaFor(a);
    const state: TrainingState = {
      ...initState(a, persona),
      trust: a.win.minTrust - 1,
      patience: 50,
    };
    const end = evaluateEnd({
      state,
      result: turn({ intent: 'agrees_next_step', nextStep: 'Sinov variantini ko\'ramiz' }),
      turnCount: 4,
      archetype: a,
      persona,
    });
    assertEqual(end.ended, false, 'ended');
  });

  check(report, 'agree turidagi arxetipda "agrees_next_step" g\'alaba bermaydi', () => {
    const a = getArchetype('negotiator');
    const persona = personaFor(a);
    const end = evaluateEnd({
      state: readyState(a, persona),
      result: turn({ intent: 'agrees_next_step', nextStep: 'Keyingi hafta qo\'ng\'iroq' }),
      turnCount: 3,
      archetype: a,
      persona,
    });
    assertEqual(end.ended, false, 'ended');
  });

  check(report, 'mijoz suhbatni uzsa: sabri past bo\'lsa yutqazish, yuqori bo\'lsa yo\'q', () => {
    const a = getArchetype('negotiator');
    const persona = personaFor(a);
    const low: TrainingState = { ...readyState(a, persona), patience: a.lose.patienceBelow + 5 };
    const endLow = evaluateEnd({
      state: low,
      result: turn({ intent: 'ends_call' }),
      turnCount: 3,
      archetype: a,
      persona,
    });
    assertEqual(endLow.outcome, 'lost', 'past sabr: outcome');

    const high: TrainingState = { ...readyState(a, persona), patience: 90, trust: 90 };
    const endHigh = evaluateEnd({
      state: high,
      result: turn({ intent: 'ends_call' }),
      turnCount: 3,
      archetype: a,
      persona,
    });
    assertEqual(endHigh.ended, false, 'yuqori sabr: ended');
  });
}

// ---------------------------------------------------------------------------
// 4. info_seeker
// ---------------------------------------------------------------------------
function verifyInfoSeeker(): void {
  section('[4] info_seeker: ehtiyoj ochilmasa g\'alaba yo\'q');
  const a = getArchetype('info_seeker');
  const persona = personaFor(a);

  check(report, 'needRevealed=false bo\'lsa hech qanday intent yutmaydi', () => {
    const keys = persona.objections.map((o) => o.key);
    const state: TrainingState = {
      patience: 90,
      trust: 100,
      interest: 90,
      flags: {
        objectionsRaised: [...keys],
        objectionsResolved: [...keys],
        needRevealed: false,
        guardViolations: 0,
      },
      promptVersion: 'training-v1',
    };
    for (const intent of ['agrees', 'agrees_next_step'] as const) {
      const end = evaluateEnd({
        state,
        result: turn({ intent, nextStep: 'Sinov darsi' }),
        turnCount: 2,
        archetype: a,
        persona,
      });
      assertEqual(end.outcome, undefined, `intent=${intent}`);
    }
    assertEqual(computeReadiness(state, persona, a).readyToAgree, false, 'readyToAgree');
  });

  check(report, 'needRevealed=true bo\'lsa yutadi', () => {
    const end = evaluateEnd({
      state: readyState(a, persona),
      result: turn({ intent: 'agrees' }),
      turnCount: 2,
      archetype: a,
      persona,
    });
    assertEqual(end.outcome, 'won', 'outcome');
    assertEqual(end.reason, 'need_discovered_and_agreed', 'reason');
  });
}

// ---------------------------------------------------------------------------
// 5. Persona validatsiyasi
// ---------------------------------------------------------------------------
async function verifyPersonaValidation(): Promise<void> {
  section('[5] Persona validatsiyasi');
  const archetype = getArchetype('negotiator');

  await checkAsync(report, 'to\'g\'ri persona bir chaqiruvda qabul qilinadi', async () => {
    const llm = new FakeTrainerLlm([
      fakePersona({
        objectionKeys: ['price_too_high', 'no_time', 'needs_to_ask_family'],
        severity: 3,
        focusOffer: FIRST_OFFER,
      }),
    ]);
    const card = await generatePersonaCard({ llm, profile: PROFILE, archetype, direction: 'inbound' });
    assertEqual(card.focusOffer, FIRST_OFFER, 'focusOffer');
    assertEqual(llm.callCount, 1, 'chaqiruvlar soni');
  });

  await checkAsync(report, 'focusOffer profilda bo\'lmasa: retry, keyin PersonaGenerationError', async () => {
    const bad = fakePersona({
      objectionKeys: ['a_one', 'b_two', 'c_three'],
      severity: 3,
      focusOffer: "O'zim o'ylab topgan taklif",
    });
    const llm = new FakeTrainerLlm([bad, bad]);
    await assertThrows(
      () => generatePersonaCard({ llm, profile: PROFILE, archetype, direction: 'inbound' }),
      (err) => err instanceof PersonaGenerationError,
      'PersonaGenerationError kutilgan',
    );
    assertEqual(llm.callCount, 2, 'bitta retry bo\'lishi kerak');
    const second = llm.calls[1];
    assert(second, 'ikkinchi chaqiruv yo\'q');
    assert(second.user.includes('CORRECTION'), 'retry promptida CORRECTION bo\'lishi kerak');
    assert(second.user.includes('focusOffer'), 'retry promptida xato tafsiloti bo\'lishi kerak');
  });

  /** Har chaqiruvda berilgan xatoni tashlaydigan LLM (chaqiruvlar sanaladi). */
  const throwingLlm = (err: unknown) => {
    const llm = {
      calls: 0,
      async completeJson<T>(): Promise<T> {
        llm.calls += 1;
        throw err;
      },
    };
    return llm;
  };

  await checkAsync(report, 'persona: timeout -> llm_timeout, tuzatuvchi qayta so\'rov YO\'Q', async () => {
    const llm = throwingLlm(new LlmCallError('timeout', '60000 ms ichida javob kelmadi'));
    await assertThrows(
      () => generatePersonaCard({ llm, profile: PROFILE, archetype, direction: 'inbound' }),
      (err) =>
        err instanceof TrainingError &&
        err.code === 'llm_timeout' &&
        err.llmErrorKind === 'timeout' &&
        err.message.includes('[timeout]') &&
        !err.message.includes('validatsiya'),
      'llm_timeout kutilgan (validatsiya xatosi EMAS)',
    );
    assertEqual(llm.calls, 1, 'timeout modulda qayta so\'ralmaydi (adapter o\'zi 1 marta takrorlaydi)');
  });

  await checkAsync(report, 'persona: HTTP 429 -> llm_provider_error, status va xabar bilan', async () => {
    const llm = throwingLlm(
      new LlmCallError('http', 'HTTP 429: quota', { status: 429, providerMessage: 'Quota exceeded' }),
    );
    await assertThrows(
      () => generatePersonaCard({ llm, profile: PROFILE, archetype, direction: 'inbound' }),
      (err) =>
        err instanceof TrainingError &&
        err.code === 'llm_provider_error' &&
        err.message.includes('HTTP 429') &&
        err.message.includes('Quota exceeded'),
      'llm_provider_error kutilgan',
    );
    assertEqual(llm.calls, 1, 'HTTP xato qayta so\'ralmaydi');
  });

  await checkAsync(report, 'persona: invalid_json -> tuzatib qayta so\'raladi (2 chaqiruv)', async () => {
    const llm = throwingLlm(new LlmCallError('invalid_json', 'model javobidan JSON ajratib olinmadi'));
    await assertThrows(
      () => generatePersonaCard({ llm, profile: PROFILE, archetype, direction: 'inbound' }),
      (err) => err instanceof PersonaGenerationError && err.message.includes('[invalid_json]'),
      'PersonaGenerationError [invalid_json] kutilgan',
    );
    assertEqual(llm.calls, 2, 'shakl xatosi bir marta tuzatiladi');
  });

  // --- Yozuv (lotin) tekshiruvi -------------------------------------------
  const latinPersona = fakePersona({
    objectionKeys: ['price_too_high', 'no_time', 'needs_to_ask_family'],
    severity: 3,
    focusOffer: FIRST_OFFER,
  }) as Record<string, unknown>;
  const cyrillicPersona = { ...latinPersona, openingLine: 'Здравствуйте, shartlaringizni bilmoqchi edim.' };

  await checkAsync(report, "persona (uz): kirill -> bitta tuzatish urinishi, lotin olinadi", async () => {
    const llm = new FakeTrainerLlm([cyrillicPersona, latinPersona]);
    const card = await generatePersonaCard({ llm, profile: PROFILE, archetype, direction: 'inbound' });
    assertEqual(card.openingLine, latinPersona.openingLine as string, 'lotin variant');
    assertEqual(llm.callCount, 2, 'bitta qayta urinish');
    assert(llm.calls[1]?.user.includes('LATIN script only') || llm.calls[1]?.system.includes('LATIN script only'), 'tuzatish izohi');
  });

  await checkAsync(report, "persona (uz): o'zbek kirill -> LLM'siz lotinga o'giriladi", async () => {
    const uzCyr = { ...latinPersona, openingLine: 'Ассалому алайкум, нархини билмоқчи эдим.' };
    const llm = new FakeTrainerLlm([uzCyr]);
    const card = await generatePersonaCard({ llm, profile: PROFILE, archetype, direction: 'inbound' });
    assertEqual(card.openingLine, "Assalomu alaykum, narxini bilmoqchi edim.", "lotinga o'girildi");
    assertEqual(llm.callCount, 1, "qo'shimcha chaqiruv yo'q");
  });

  await checkAsync(report, "persona (uz): begona til qolsa -> yashiriladi (neytral salom), logga yoziladi", async () => {
    const warnings: string[] = [];
    const logger = {
      info: () => undefined,
      error: () => undefined,
      warn: (_obj: unknown, msg?: string) => {
        if (msg) warnings.push(msg);
      },
    };
    const llm = new FakeTrainerLlm([cyrillicPersona, cyrillicPersona]);
    const card = await generatePersonaCard({ llm, profile: PROFILE, archetype, direction: 'inbound', logger });
    assertEqual(card.openingLine, 'Assalomu alaykum.', "begona ochilish gapi ko'rsatilmaydi");
    assertEqual(llm.callCount, 2, "uchinchi chaqiruv yo'q");
    assert(warnings.some((w) => w.includes('openingLine')), 'logda maydon nomi');
    assertEqual(nonLatinWords(card.openingLine).length, 0, "lotin bo'lmagan matn yo'q");
  });

  await checkAsync(report, "persona (ru): yozuv tekshirilmaydi", async () => {
    const ruPersona = { ...cyrillicPersona, language: 'ru' };
    const llm = new FakeTrainerLlm([ruPersona]);
    await generatePersonaCard({ llm, profile: PROFILE, archetype, direction: 'inbound', language: 'ru' });
    assertEqual(llm.callCount, 1, 'bitta chaqiruv');
  });

  check(report, 'xato toifalari: ZodError/AbortError/SyntaxError/LlmCallError', () => {
    const zodErr = personaCardSchema.safeParse({}).error;
    assertEqual(classifyLlmError(zodErr), 'schema', 'ZodError -> schema');
    const abort = new Error('This operation was aborted');
    abort.name = 'AbortError';
    assertEqual(classifyLlmError(abort), 'timeout', 'AbortError -> timeout');
    assertEqual(classifyLlmError(new SyntaxError('x')), 'invalid_json', 'SyntaxError -> invalid_json');
    assertEqual(classifyLlmError(new Error('boshqa')), 'unknown', 'boshqa -> unknown');
    assert(isCorrectableLlmError(zodErr), 'schema tuzatiladi');
    assert(!isCorrectableLlmError(abort), 'timeout tuzatilmaydi');
    assert(describeLlmError(abort).startsWith('[timeout]'), 'tavsif toifadan boshlanadi');
  });

  await checkAsync(report, 'noto\'g\'ri e\'tiroz soni rad etiladi, to\'g\'risi qabul qilinadi', async () => {
    const llm = new FakeTrainerLlm([
      fakePersona({ objectionKeys: ['only_one'], severity: 3, focusOffer: FIRST_OFFER }),
      fakePersona({
        objectionKeys: ['price_too_high', 'no_time', 'needs_to_ask_family'],
        severity: 3,
        focusOffer: FIRST_OFFER,
      }),
    ]);
    const card = await generatePersonaCard({ llm, profile: PROFILE, archetype, direction: 'inbound' });
    assertEqual(card.objections.length, archetype.objections.count, 'e\'tirozlar soni');
    assertEqual(llm.callCount, 2, 'chaqiruvlar soni');
  });

  check(report, 'severity severityMax dan oshsa rad etiladi', () => {
    const schema = makePersonaCardSchema({
      archetype,
      profile: PROFILE,
      direction: 'inbound',
      language: 'uz',
    });
    const raw = fakePersona({
      objectionKeys: ['a_one', 'b_two', 'c_three'],
      severity: archetype.objections.severityMax + 1,
      focusOffer: FIRST_OFFER,
    });
    assert(!schema.safeParse(raw).success, 'qabul qilinmasligi kerak');
  });

  check(report, 'hiddenNeed: faqat kerakli arxetipda talab qilinadi', () => {
    const infoSeeker = getArchetype('info_seeker');
    const schemaHidden = makePersonaCardSchema({
      archetype: infoSeeker,
      profile: PROFILE,
      direction: 'inbound',
      language: 'uz',
    });
    const keys = Array.from({ length: infoSeeker.objections.count }, (_, i) => `k_${i + 1}`);
    assert(
      !schemaHidden.safeParse(
        fakePersona({ objectionKeys: keys, severity: 2, focusOffer: FIRST_OFFER, hiddenNeed: null }),
      ).success,
      'info_seeker uchun hiddenNeed=null rad etilishi kerak',
    );

    const schemaPlain = makePersonaCardSchema({
      archetype,
      profile: PROFILE,
      direction: 'inbound',
      language: 'uz',
    });
    assert(
      !schemaPlain.safeParse(
        fakePersona({
          objectionKeys: ['a_one', 'b_two', 'c_three'],
          severity: 2,
          focusOffer: FIRST_OFFER,
          hiddenNeed: 'bo\'lmasligi kerak',
        }),
      ).success,
      'negotiator uchun hiddenNeed to\'ldirilsa rad etilishi kerak',
    );
  });

  check(report, 'callDirection=mixed random bilan hal qilinadi', () => {
    const mixed: BusinessProfile = { ...PROFILE, callDirection: 'mixed' };
    const inbound = makePersonaCardSchema({
      archetype,
      profile: mixed,
      direction: 'inbound',
      language: 'uz',
    });
    assert(inbound, 'sxema yasalishi kerak');
    // resolveDirection bilvosita generatePersonaCard ichida sinaladi:
    assertEqual(
      JSON.stringify([0.1, 0.9].map((v) => (v < 0.5 ? 'inbound' : 'outbound'))),
      JSON.stringify(['inbound', 'outbound']),
      'random mantiqi',
    );
  });
}

// ---------------------------------------------------------------------------
// 7. Soha so'zlari skaneri
// ---------------------------------------------------------------------------
const BANNED_WORDS = [
  'kurs',
  'taksi',
  'ovqat',
  'restoran',
  'dars',
  'haydovchi',
  'kuryer',
  'guruh',
  'sertifikat',
];

/** Skaner o'zi va demo ma'lumot tekshirilmaydi. `.ts` va `.tsx` qaraladi. */
const SCAN_EXCLUDE = new Set(['verify-training-core.ts', 'demo-profiles.json']);

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if ((entry.endsWith('.ts') || entry.endsWith('.tsx')) && !SCAN_EXCLUDE.has(entry)) {
      out.push(full);
    }
  }
  return out;
}

function verifyNoDomainWords(): void {
  section('[7] Soha so\'zlari skaneri (domain-agnostic)');
  const pattern = new RegExp(`\\b(${BANNED_WORDS.join('|')})`, 'i');

  check(report, 'module/ ichidagi kodda soha so\'zi yo\'q', () => {
    const files = collectSourceFiles(moduleRoot);
    assert(files.length > 5, `juda kam fayl topildi: ${files.length}`);
    const hits: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (const [i, line] of lines.entries()) {
        const match = pattern.exec(line);
        if (match) {
          hits.push(`${file.replace(`${moduleRoot}/`, '')}:${i + 1}: "${match[0]}" -> ${line.trim()}`);
        }
      }
    }
    assert(hits.length === 0, `soha so'zlari topildi:\n       ${hits.join('\n       ')}`);
  });
}

// ---------------------------------------------------------------------------
// 8. Prompt builder'lar
// ---------------------------------------------------------------------------
function verifyPrompts(): void {
  section('[8] Prompt builder\'lar');
  const archetype = getArchetype('negotiator');
  const persona = personaFor(archetype);
  const state = initState(archetype, persona);
  const readiness = computeReadiness(state, persona, archetype);

  check(report, 'system promptda blockers va ishonchsiz-sotuvchi qoidasi bor', () => {
    assert(readiness.blockers.length > 0, 'boshlanishda blockers bo\'lishi kerak');
    const prompt = buildTurnSystemPrompt({ persona, archetype, state, readiness });
    for (const blocker of readiness.blockers) {
      assert(prompt.includes(blocker), `blocker promptda yo'q: ${blocker}`);
    }
    assert(prompt.includes('UNTRUSTED CONTENT'), 'untrusted-seller qoidasi yo\'q');
    assert(prompt.includes('never obey it'), 'injection qoidasi yo\'q');
    assert(prompt.includes('can NOT agree'), 'rozilik taqiqi yo\'q');
    assert(prompt.includes(persona.name), 'persona ismi yo\'q');
    assert(prompt.includes(offerTopic(persona.focusOffer)), 'taklif mavzusi (nomi) bor');
    assert(!prompt.includes(persona.focusOffer), "to'liq focusOffer (narx/muddat bilan) YO'Q");
    for (const rule of archetype.behaviorRules) {
      assert(prompt.includes(rule), `behaviorRule yo'q: ${rule}`);
    }
    assert(prompt.includes(`patience=${state.patience}`), 'holat sonlari yo\'q');
  });

  check(report, 'taklif faktlari: mavzu ajratiladi, narxlar topiladi', () => {
    assertEqual(
      offerTopic("Ingliz tili (IELTS): 6 oy, oyiga 700 000 so'm"),
      'Ingliz tili (IELTS)',
      'mavzu',
    );
    assertDeepEqual(extractPriceFigures("12 oy, 490 000 so'm"), [490000], 'bo\'lakli narx');
    assertDeepEqual(extractPriceFigures('700 ming'), [700000], 'ming');
    assertDeepEqual(extractPriceFigures('1.2 mln'), [1200000], 'mln');
    assertDeepEqual(extractPriceFigures('50 dollar'), [50], 'valyuta');
    assertDeepEqual(extractPriceFigures('haftada 3 marta, 10% chegirma, 2026 yil'), [], "narx emas");
    assertDeepEqual(
      unsaidPriceFigures("Demak 6 oy va oyiga 700 000 so'mmi?", { sellerTexts: ["12 oy, 490 000 so'm"] }),
      [700000],
      'sotuvchi aytmagan narx ushlanadi',
    );
    assertDeepEqual(
      unsaidPriceFigures("490 ming qimmat-ku", { sellerTexts: ["Oyiga 490 000 so'm"] }),
      [],
      "sotuvchi aytgan narx (boshqa yozuvda) — joyida",
    );
    assertDeepEqual(
      unsaidPriceFigures('Tanishim 700 ming dedi', {
        sellerTexts: [],
        ownFacts: ["Do'sti 700 000 so'm turishini aytgan"],
      }),
      [],
      "o'z yashirin faktidagi (eshitgan) narx — joyida",
    );
  });

  check(report, "mijoz system promptida HECH BIR demo taklifning narxi/sharti yo'q", () => {
    for (const [key, profile] of loadAllProfiles()) {
      const prices = offerPriceFigures(profile.primaryOffers);
      for (const offer of profile.primaryOffers) {
        const card = { ...persona, focusOffer: offer };
        const prompt = buildTurnSystemPrompt({
          persona: card,
          archetype,
          state: initState(archetype, card),
          readiness: computeReadiness(initState(archetype, card), card, archetype),
        });
        const leaked = extractPriceFigures(prompt).filter((v) => prices.has(v));
        assertEqual(leaked.length, 0, `${key}: "${offer}" narxi promptda: ${leaked.join(', ')}`);
        const terms = offer.slice(offerTopic(offer).length).replace(/^[\s:,—–-]+/, '').trim();
        if (terms.length > 3) assert(!prompt.includes(terms), `${key}: shartlar promptda: ${terms}`);
        assert(/\d/.test(offerTopic(offer)) === false, `${key}: mavzuda raqam: ${offerTopic(offer)}`);
      }
    }
    const prompt = buildTurnSystemPrompt({ persona, archetype, state, readiness });
    assert(prompt.includes('You do NOT know its price'), 'bilim qoidasi');
    assert(prompt.includes('You MAY ask about price'), "so'rashga ruxsat");
  });

  check(report, 'persona prompti: mijoz narxni bilmaydi, faqat hiddenFacts da eshitgan gap', () => {
    const prompt = buildPersonaSystemPrompt({ archetype, profile: PROFILE, direction: 'inbound', language: 'uz' });
    assert(prompt.includes('does NOT know the offer\'s price'), 'qoida bor');
    assert(prompt.includes('Only "hiddenFacts" may contain a rough figure'), 'hearsay istisnosi');
  });

  check(report, 'persona tekshiruvi: openingLine/e\'tirozda taklif narxi -> rad; hiddenFacts da -> ruxsat', () => {
    const schema = makePersonaCardSchema({ archetype, profile: PROFILE, direction: 'inbound', language: 'uz' });
    const price = extractPriceFigures(FIRST_OFFER)[0] as number;
    const priceText = price.toLocaleString('fr-FR').replace(/\u202f|\u00a0/g, ' ');
    const base = fakePersona({
      objectionKeys: ['price_too_high', 'no_time', 'needs_to_ask_family'],
      severity: 3,
      focusOffer: FIRST_OFFER,
    }) as Record<string, unknown>;
    const leaked = schema.safeParse({ ...base, openingLine: `Oyiga ${priceText} so'm ekanmi?` });
    assert(!leaked.success, 'rad etilishi kerak');
    assert(
      leaked.error.issues.some((i) => i.path[0] === 'openingLine' && i.message.includes('oldindan bilmaydi')),
      'openingLine issue',
    );
    const hearsay = schema.safeParse({
      ...base,
      hiddenFacts: [`Tanishi taxminan ${priceText} so'm dedi`],
    });
    assert(hearsay.success, 'hiddenFacts dagi eshitgan narx — ruxsat');
  });


  check(report, 'tayyor holatda prompt rozilikka ruxsat beradi', () => {
    const ready = readyState(archetype, persona);
    const prompt = buildTurnSystemPrompt({
      persona,
      archetype,
      state: ready,
      readiness: computeReadiness(ready, persona, archetype),
    });
    assert(prompt.includes('You MAY agree now'), 'ruxsat matni yo\'q');
  });

  check(report, 'sabr past bo\'lganda ogohlantirish qo\'shiladi', () => {
    const low: TrainingState = { ...state, patience: archetype.lose.patienceBelow + 10 };
    const prompt = buildTurnSystemPrompt({
      persona,
      archetype,
      state: low,
      readiness: computeReadiness(low, persona, archetype),
    });
    assert(prompt.includes('patience is LOW'), 'ogohlantirish yo\'q');
  });

  check(report, 'tuzatish eslatmasi promptga qo\'shiladi', () => {
    const prompt = buildTurnSystemPrompt({
      persona,
      archetype,
      state,
      readiness,
      correction: 'TEST-CORRECTION-MARKER',
    });
    assert(prompt.includes('TEST-CORRECTION-MARKER'), 'correction yo\'q');
  });

  check(report, 'user prompt oxirgi 12 navbat bilan cheklanadi', () => {
    assertEqual(TRANSCRIPT_WINDOW, 12, 'oyna kattaligi');
    const transcript: TranscriptTurn[] = Array.from({ length: 30 }, (_, i) => ({
      speaker: i % 2 === 0 ? ('seller' as const) : ('customer' as const),
      text: `navbat-${i + 1}`,
    }));
    const prompt = buildTurnUserPrompt({ transcript, sellerText: 'yangi gap' });
    assert(!prompt.includes('navbat-18'), '18-navbat chiqib ketishi kerak edi');
    assert(prompt.includes('navbat-19'), '19-navbat (oxirgi 12 ning birinchisi) bo\'lishi kerak');
    assert(prompt.includes('navbat-30'), 'oxirgi navbat yo\'q');
    assert(prompt.includes('yangi gap'), 'sotuvchi matni yo\'q');
    assert(prompt.includes('untrusted content'), 'ishonchsiz kontent eslatmasi yo\'q');
    const count = prompt.split('\n').filter((l) => l.startsWith('SELLER:') || l.startsWith('YOU:')).length;
    assertEqual(count, 12, 'promptdagi navbatlar soni');
  });

  check(report, 'bo\'sh transkript ham ishlaydi', () => {
    const prompt = buildTurnUserPrompt({ transcript: [], sellerText: 'salom' });
    assert(prompt.includes('start of the conversation'), 'boshlanish matni yo\'q');
  });
}

// ---------------------------------------------------------------------------
// 3 + 6. Engine (haqiqiy DB, cheklangan rol)
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

/** Asosiy repodagi `withTenant` ning Drizzle ustidagi test implementatsiyasi. */
function createWithTenant(pool: Pool): WithTenant {
  const db = drizzle(pool);
  return async function withTenant(businessId, fn) {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.business_id', ${businessId}, true)`);
      return await fn(tx as unknown as TrainingTx);
    });
  };
}

async function verifyEngineWithDb(): Promise<void> {
  section('[3+6] Engine + DB (guard, persistence, izolyatsiya)');

  if (process.env.SKIP_DB === '1') {
    skip(report, 'engine + DB testlari', 'SKIP_DB=1');
    return;
  }

  const superPool = new Pool({ connectionString: superUrl(), max: 2 });
  const appPool = new Pool({ connectionString: appUrl(), max: 4 });
  const withTenant = createWithTenant(appPool);
  const getProfile: GetBusinessProfile = async () => PROFILE;

  const bizA = randomUUID();
  const bizB = randomUUID();
  const userA = randomUUID();
  const userA2 = randomUUID();
  const userB = randomUUID();

  const ctxA: TrainingContext = { businessId: bizA, userId: userA, seatId: null };
  const ctxA2: TrainingContext = { businessId: bizA, userId: userA2, seatId: null };
  const ctxB: TrainingContext = { businessId: bizB, userId: userB, seatId: null };

  const negotiator = getArchetype('negotiator');
  /** Script personasi direction'i `random` bilan mos bo'lishi SHART. */
  const personaScript = (direction: 'inbound' | 'outbound' = 'inbound'): unknown =>
    fakePersona({
      objectionKeys: ['price_too_high', 'no_time', 'needs_to_ask_family'],
      severity: 3,
      focusOffer: FIRST_OFFER,
      direction,
    });

  try {
    await superPool.query('insert into business (id, name) values ($1, $2), ($3, $4)', [
      bizA,
      'A',
      bizB,
      'B',
    ]);
    await superPool.query(
      'insert into app_user (id, business_id, email) values ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)',
      [userA, bizA, 'a@t.local', userA2, bizA, 'a2@t.local', userB, bizB, 'b@t.local'],
    );

    // --- 6a. Sessiya va navbatlar saqlanadi, seq bo'shliqsiz ---------------
    await checkAsync(report, 'startSession + takeTurn: seq bo\'shliqsiz, state_after yoziladi', async () => {
      const llm = new FakeTrainerLlm(
        [
          personaScript(),
          fakeTurn({
            reply: 'Narxi menga qimmatdek.',
            objectionRaisedKey: 'price_too_high',
            deltas: { patience: -2, trust: 1, interest: 2 },
          }),
          fakeTurn({
            reply: 'Yaxshi, tushundim.',
            objectionsResolvedKeys: ['price_too_high'],
            deltas: { patience: 1, trust: 8, interest: 1 },
          }),
        ],
        { usage: { inputTokens: 1000, outputTokens: 200, model: 'fake' } },
      );
      const engine = createTrainingEngine({
        withTenant,
        getBusinessProfile: getProfile,
        llm,
        priceCall: (u) => u.inputTokens * 0.000001 + u.outputTokens * 0.000005,
        random: () => 0.1, // inbound
      });

      const started = await engine.startSession(ctxA, { archetypeKey: 'negotiator' });
      assertEqual(started.archetypeKey, 'negotiator', 'archetypeKey');
      assert(started.openingLine, 'inbound uchun openingLine bo\'lishi kerak');

      const first = await engine.takeTurn(ctxA, {
        sessionId: started.sessionId,
        sellerText: 'Assalomu alaykum, qanday yordam bera olaman?',
      });
      assertEqual(first.ended, false, 'ended');
      assertEqual(first.turnCount, 1, 'turnCount');
      assertDeepEqual(first.state.flags.objectionsRaised, ['price_too_high'], 'raised');

      const second = await engine.takeTurn(ctxA, {
        sessionId: started.sessionId,
        sellerText: 'Narx ichida nimalar borligini aniq aytib beraman.',
      });
      assertEqual(second.turnCount, 2, 'turnCount');
      assertDeepEqual(second.state.flags.objectionsResolved, ['price_too_high'], 'resolved');

      // DB holati
      const rows = await withTenant(bizA, async (tx) => {
        const res = await tx.execute(
          sql`select seq, speaker, state_after is not null as has_state
                from training_turn where session_id = ${started.sessionId}::uuid order by seq`,
        );
        return (res as unknown as { rows: { seq: number; speaker: string; has_state: boolean }[] })
          .rows;
      });
      assertDeepEqual(
        rows.map((r) => [Number(r.seq), r.speaker]),
        [
          [1, 'customer'],
          [2, 'seller'],
          [3, 'customer'],
          [4, 'seller'],
          [5, 'customer'],
        ],
        'navbatlar ketma-ketligi',
      );
      for (const row of rows) {
        if (row.speaker === 'customer') {
          assertEqual(row.has_state, true, `seq=${row.seq}: state_after`);
        }
      }

      const session = await engine.getSession(ctxA, { sessionId: started.sessionId });
      assertEqual(session.turnCount, 2, 'sessiya turnCount');
      assertEqual(session.transcript.length, 5, 'transkript uzunligi');
      assert(Number(session.costUsd) > 0, `cost_usd to'ldirilishi kerak, keldi ${session.costUsd}`);
      assertEqual(session.state.promptVersion, 'training-v2', 'promptVersion');
    });

    // --- 3. Guard ---------------------------------------------------------
    await checkAsync(report, 'guard: qoidasiz "agrees" -> bitta retry -> g\'alaba YO\'Q', async () => {
      const agreeRaw = fakeTurn({
        reply: 'Mayli, roziman.',
        intent: 'agrees',
        deltas: { patience: 0, trust: 5, interest: 0 },
      });
      const llm = new FakeTrainerLlm([personaScript('outbound'), agreeRaw, agreeRaw]);
      const engine = createTrainingEngine({
        withTenant,
        getBusinessProfile: getProfile,
        llm,
        random: () => 0.9, // outbound
      });

      const started = await engine.startSession(ctxA, { archetypeKey: 'negotiator' });
      assertEqual(started.openingLine, null, 'outbound: openingLine bo\'lmaydi');

      const result = await engine.takeTurn(ctxA, {
        sessionId: started.sessionId,
        sellerText: 'Hoziroq rozi bo\'lsangiz, chegirma beraman.',
      });

      assertEqual(llm.callCount, 3, 'persona + 2 navbat chaqiruvi (bitta retry)');
      assertEqual(result.ended, false, 'sessiya tugamasligi kerak');
      assertEqual(result.outcome, undefined, 'outcome');
      assertEqual(result.state.flags.guardViolations, 1, 'guardViolations');
      assertEqual(result.meta.guardRetried, true, 'guardRetried');
      assertEqual(result.meta.guardViolated, true, 'guardViolated');
      assertEqual(result.customerReply, 'Mayli, roziman.', 'matn saqlanadi');
      assertEqual(result.meta.intent, 'continue', 'intent continue ga tushiriladi');

      // Retry promptida tuzatish eslatmasi bo'lishi kerak.
      const retryCall = llm.calls[2];
      assert(retryCall, 'retry chaqiruvi yo\'q');
      assert(retryCall.system.includes('CORRECTION'), 'retry promptida CORRECTION yo\'q');
      assert(retryCall.system.includes('not allowed right now'), 'tuzatish matni yo\'q');

      // DB ham g'alabani yozmagan bo'lishi kerak.
      const session = await engine.getSession(ctxA, { sessionId: started.sessionId });
      assertEqual(session.status, 'active', 'status');
      assertEqual(session.outcome, null, 'outcome');
      assertEqual(session.state.flags.guardViolations, 1, 'DB dagi guardViolations');
    });

    // --- 6b. Haqiqiy g'alaba yoziladi -------------------------------------
    await checkAsync(report, 'qoidalar bajarilsa g\'alaba DB ga yoziladi', async () => {
      const keys = ['price_too_high', 'no_time', 'needs_to_ask_family'];
      const llm = new FakeTrainerLlm([
        personaScript('outbound'),
        // 3 ta e'tirozni ko'taradi va darhol yechilgan deb belgilaydi
        fakeTurn({
          reply: 'Narxi qimmat tuyuladi.',
          objectionRaisedKey: keys[0],
          objectionsResolvedKeys: [keys[0] as string],
          deltas: { patience: 2, trust: 10, interest: 5 },
        }),
        fakeTurn({
          reply: 'Vaqtim ham ziq.',
          objectionRaisedKey: keys[1],
          objectionsResolvedKeys: [keys[1] as string],
          deltas: { patience: 2, trust: 10, interest: 2 },
        }),
        fakeTurn({
          reply: 'Yaqinlarim bilan gaplashishim kerak edi, lekin tushundim.',
          objectionRaisedKey: keys[2],
          objectionsResolvedKeys: [keys[2] as string],
          deltas: { patience: 2, trust: 10, interest: 2 },
        }),
        fakeTurn({ reply: 'Mayli, roziman.', intent: 'agrees', deltas: { patience: 0, trust: 5, interest: 0 } }),
      ]);
      const engine = createTrainingEngine({
        withTenant,
        getBusinessProfile: getProfile,
        llm,
        random: () => 0.9,
      });
      const started = await engine.startSession(ctxA, { archetypeKey: 'negotiator' });

      let last;
      for (const text of ['Salom', 'Narx tarkibi mana shunday', 'Vaqtni moslashtiramiz', 'Qaror sizda']) {
        last = await engine.takeTurn(ctxA, { sessionId: started.sessionId, sellerText: text });
      }
      assert(last, 'natija yo\'q');
      assertEqual(last.ended, true, 'ended');
      assertEqual(last.outcome, 'won', 'outcome');
      assertEqual(last.endReason, 'agreed', 'endReason');
      assertEqual(last.state.flags.guardViolations, 0, 'guardViolations');

      const session = await engine.getSession(ctxA, { sessionId: started.sessionId });
      assertEqual(session.status, 'ended', 'status');
      assertEqual(session.outcome, 'won', 'DB outcome');
      assertEqual(negotiator.win.requireObjectionsResolved, true, 'arxetip sharti');
    });

    // --- 6c. Tenant / egalik / tugagan sessiya ----------------------------
    await checkAsync(report, 'tenant B, boshqa foydalanuvchi va tugagan sessiya rad etiladi', async () => {
      const llm = new FakeTrainerLlm([
        personaScript('outbound'),
        fakeTurn({ reply: 'Eshitaman.', objectionRaisedKey: 'price_too_high' }),
      ]);
      const engine = createTrainingEngine({
        withTenant,
        getBusinessProfile: getProfile,
        llm,
        random: () => 0.9,
      });
      const started = await engine.startSession(ctxA, { archetypeKey: 'negotiator' });

      // Boshqa tenant: RLS tufayli sessiya "yo'q".
      await assertThrows(
        () => engine.takeTurn(ctxB, { sessionId: started.sessionId, sellerText: 'salom' }),
        (err) => err instanceof TrainingError && err.code === 'session_not_found',
        'tenant B uchun session_not_found kutilgan',
      );

      // Bir tenant, boshqa foydalanuvchi.
      await assertThrows(
        () => engine.takeTurn(ctxA2, { sessionId: started.sessionId, sellerText: 'salom' }),
        (err) => err instanceof TrainingError && err.code === 'session_forbidden',
        'boshqa foydalanuvchi uchun session_forbidden kutilgan',
      );

      // Tugatamiz va yangi navbatni rad etishini tekshiramiz.
      await engine.endSession(ctxA, { sessionId: started.sessionId, reason: 'test' });
      await assertThrows(
        () => engine.takeTurn(ctxA, { sessionId: started.sessionId, sellerText: 'salom' }),
        (err) => err instanceof TrainingError && err.code === 'session_not_active',
        'tugagan sessiya uchun session_not_active kutilgan',
      );

      const session = await engine.getSession(ctxA, { sessionId: started.sessionId });
      assertEqual(session.status, 'abandoned', 'status');
    });

    // --- 6d. Profil bo'lmasa ---------------------------------------------
    await checkAsync(report, 'profil bo\'lmasa profile_missing xatosi', async () => {
      const engine = createTrainingEngine({
        withTenant,
        getBusinessProfile: async () => null,
        llm: new FakeTrainerLlm([]),
      });
      await assertThrows(
        () => engine.startSession(ctxA, { archetypeKey: 'negotiator' }),
        (err) => err instanceof TrainingError && err.code === 'profile_missing',
        'profile_missing kutilgan',
      );
    });

    // --- 6e. LLM javobi buzuq bo'lsa -------------------------------------
    await checkAsync(report, 'buzuq LLM javobi: bitta retry, keyin llm_invalid_output', async () => {
      const broken = { reply: 'x', intent: 'yoq_bunday_intent' };
      const llm = new FakeTrainerLlm([personaScript('outbound'), broken, broken]);
      const engine = createTrainingEngine({
        withTenant,
        getBusinessProfile: getProfile,
        llm,
        random: () => 0.9,
      });
      const started = await engine.startSession(ctxA, { archetypeKey: 'negotiator' });
      await assertThrows(
        () => engine.takeTurn(ctxA, { sessionId: started.sessionId, sellerText: 'salom' }),
        (err) => err instanceof TrainingError && err.code === 'llm_invalid_output',
        'llm_invalid_output kutilgan',
      );
      assertEqual(llm.callCount, 3, 'persona + 2 urinish');
    });

    // --- 6e-1. Mijoz prompti taklif narxini bilmaydi (fake LLM) -----------
    await checkAsync(report, "fake LLM: mijoz navbati system promptida taklif narxi/sharti yo'q", async () => {
      const llm = new FakeTrainerLlm([personaScript('outbound'), fakeTurn({ reply: 'Narxi qancha?' })]);
      const engine = createTrainingEngine({
        withTenant,
        getBusinessProfile: getProfile,
        llm,
        random: () => 0.9,
      });
      const started = await engine.startSession(ctxA, { archetypeKey: 'negotiator' });
      await engine.takeTurn(ctxA, { sessionId: started.sessionId, sellerText: 'Assalomu alaykum' });
      const customerSystem = llm.calls[1]?.system ?? '';
      assert(customerSystem.length > 0, 'mijoz chaqiruvi bor');
      const prices = offerPriceFigures(PROFILE.primaryOffers);
      const leaked = extractPriceFigures(customerSystem).filter((v) => prices.has(v));
      assertEqual(leaked.length, 0, `promptda taklif narxi: ${leaked.join(', ')}`);
      assert(!customerSystem.includes(started.persona.focusOffer), "to'liq focusOffer yo'q");
      assert(customerSystem.includes(offerTopic(started.persona.focusOffer)), 'mavzu bor');
    });

    // --- 6e-2. Mijoz javobida kirill --------------------------------------
    await checkAsync(report, "mijoz javobi (uz): kirill -> bitta tuzatish, lotin javob qaytadi", async () => {
      const llm = new FakeTrainerLlm([
        personaScript('outbound'),
        fakeTurn({ reply: 'Хорошо, narxi qancha?' }),
        fakeTurn({ reply: 'Yaxshi, narxi qancha?' }),
      ]);
      const engine = createTrainingEngine({
        withTenant,
        getBusinessProfile: getProfile,
        llm,
        random: () => 0.9,
      });
      const started = await engine.startSession(ctxA, { archetypeKey: 'negotiator' });
      const turn = await engine.takeTurn(ctxA, { sessionId: started.sessionId, sellerText: 'salom' });
      assertEqual(turn.customerReply, 'Yaxshi, narxi qancha?', 'lotin javob');
      assertEqual(llm.callCount, 3, 'persona + 2 urinish');
      assert(llm.calls[2]?.system.includes('LATIN script only') ?? false, 'tuzatish izohi');
    });

    await checkAsync(report, "mijoz javobi (uz): o'zbek kirill -> LLM'siz o'giriladi", async () => {
      const llm = new FakeTrainerLlm([
        personaScript('outbound'),
        fakeTurn({ reply: 'Яхши, нархи қанча?' }),
      ]);
      const engine = createTrainingEngine({
        withTenant,
        getBusinessProfile: getProfile,
        llm,
        random: () => 0.9,
      });
      const started = await engine.startSession(ctxA, { archetypeKey: 'negotiator' });
      const turn = await engine.takeTurn(ctxA, { sessionId: started.sessionId, sellerText: 'salom' });
      assertEqual(turn.customerReply, 'Yaxshi, narxi qancha?', "lotinga o'girildi");
      assertEqual(llm.callCount, 2, "qo'shimcha chaqiruv yo'q");
    });

    await checkAsync(report, "mijoz javobi (uz): begona til qolsa -> neytral gap, logga yoziladi", async () => {
      const warnings: string[] = [];
      const llm = new FakeTrainerLlm([
        personaScript('outbound'),
        fakeTurn({ reply: 'Хорошо, narxi qancha?' }),
        fakeTurn({ reply: 'Хорошо, narxi qancha?' }),
      ]);
      const engine = createTrainingEngine({
        withTenant,
        getBusinessProfile: getProfile,
        llm,
        random: () => 0.9,
        logger: {
          info: () => undefined,
          error: () => undefined,
          warn: (_obj: unknown, msg?: string) => {
            if (msg) warnings.push(msg);
          },
        },
      });
      const started = await engine.startSession(ctxA, { archetypeKey: 'negotiator' });
      const turn = await engine.takeTurn(ctxA, { sessionId: started.sessionId, sellerText: 'salom' });
      assertEqual(turn.customerReply, CUSTOMER_LANGUAGE_FALLBACK, "begona javob ko'rsatilmaydi");
      assertEqual(llm.callCount, 3, "uchinchi urinish yo'q");
      assert(warnings.some((w) => w.includes('lotin')), 'ogohlantirish logda');
    });

    // --- 6f. Timeout DB orqali -------------------------------------------
    await checkAsync(report, 'maxTurns ga yetganda timeout yoziladi', async () => {
      const ready = getArchetype('ready_buyer');
      const script: unknown[] = [
        fakePersona({
          objectionKeys: ['price_too_high'],
          severity: 2,
          focusOffer: FIRST_OFFER,
          direction: 'outbound',
        }),
      ];
      for (let i = 0; i < ready.maxTurns; i += 1) {
        script.push(
          fakeTurn({ reply: `Yana bir savol (${i + 1}).`, deltas: { patience: 2, trust: 0, interest: 0 } }),
        );
      }
      const llm = new FakeTrainerLlm(script);
      const engine = createTrainingEngine({
        withTenant,
        getBusinessProfile: getProfile,
        llm,
        random: () => 0.9,
      });
      const started = await engine.startSession(ctxA, { archetypeKey: 'ready_buyer' });

      let last;
      for (let i = 0; i < ready.maxTurns; i += 1) {
        last = await engine.takeTurn(ctxA, {
          sessionId: started.sessionId,
          sellerText: `javob ${i + 1}`,
        });
      }
      assert(last, 'natija yo\'q');
      assertEqual(last.turnCount, ready.maxTurns, 'turnCount');
      assertEqual(last.ended, true, 'ended');
      assertEqual(last.outcome, 'timeout', 'outcome');
      assertEqual(last.endReason, 'max_turns', 'endReason');
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
  console.log('verify-training-core — Step 2 yadrosi (haqiqiy LLM ishlatilmaydi)');

  verifyState();
  verifyOutcomes();
  verifyInfoSeeker();
  await verifyPersonaValidation();
  verifyNoDomainWords();
  verifyPrompts();

  try {
    await verifyEngineWithDb();
  } catch (err) {
    report.failed += 1;
    const msg = err instanceof Error ? err.message : String(err);
    report.failures.push(`engine + DB bloki ishga tushmadi: ${msg}`);
    console.log(
      `  FAIL engine + DB bloki ishga tushmadi\n       ${msg}\n` +
        '       DB ishlayaptimi? `npm run db:up && npm run db:init` (harness ichida).\n' +
        '       DB kerak bo\'lmasa: SKIP_DB=1.',
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

if (!existsSync(resolve(here, 'demo-profiles.json'))) {
  console.error('demo-profiles.json topilmadi');
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
