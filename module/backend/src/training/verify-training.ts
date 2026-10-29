/**
 * verify-training.ts — modul poydevorini tekshiruvchi skript.
 * Ishga tushirish: `npm run verify:training` (harness ichidan) yoki
 *                  `tsx module/backend/src/training/verify-training.ts`
 *
 * Nimalarni tekshiradi:
 *   1. 4 arxetip `archetypeSchema` dan o'tadi, kalitlar unikal;
 *   2. (ixtiyoriy) ARCHETYPES konstantalari ildizdagi `archetypes.json` bilan
 *      bir xil — drift bo'lsa darhol ko'rinadi;
 *   3. har bir demo profil vendor `profileSchema` dan o'tadi;
 *   4. holat mashinasi: g'alaba / yutqazish / timeout yo'llari, qizil chiziq
 *      blokirovkasi, ballar 0..100, determinizm, immutable holat;
 *   5. persona-card: arxetip + profildan deterministik yig'iladi, matnlar
 *      faqat profildan keladi;
 *   6. (ixtiyoriy) `../sales-copilot` mavjud bo'lsa — vendor sxema va asosiy
 *      repodagi `profileSchema` bir xil namunalarni qabul/rad qiladi;
 *   7. RLS izolyatsiyasi: A biznes yaratgan qatorlar B biznes ostida
 *      KO'RINMAYDI va `withTenant` ishlatilmasa umuman o'qilmaydi;
 *   8. `state` va `persona_card` jsonb round-trip (DB ga yozib, qaytib o'qish).
 *
 * DIQQAT: bu fayl `harness/` dan HECH NARSA import qilmaydi (modul chegarasi).
 * DB ulanishi faqat env orqali keladi, shuning uchun host repoda ham
 * o'zgarishsiz ishlaydi.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';

import { ARCHETYPES, ARCHETYPE_KEYS, archetypeSchema, getArchetype } from './archetypes.js';
import { applyTurn, initialState, simulate } from './engine.js';
import { buildPersonaCard, personaCardSchema } from './persona.js';
import { profileSchema, type BusinessProfile } from './profile-schema.js';
import { trainingStateSchema, type TrainingState, type TurnSignalsInput } from './state.js';
import type { WithTenant } from './ports.js';

const here = dirname(fileURLToPath(import.meta.url));
/** module/backend/src/training -> loyiha ildizi */
const projectRoot = resolve(here, '../../../..');

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  FAIL ${name}\n       ${msg}`);
  }
}

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  FAIL ${name}\n       ${msg}`);
  }
}

function skip(name: string, why: string): void {
  skipped += 1;
  console.log(`  skip ${name} (${why})`);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: kutilgan ${String(expected)}, kelgan ${String(actual)}`);
}

// ---------------------------------------------------------------------------
// 1. Arxetiplar
// ---------------------------------------------------------------------------
function verifyArchetypes(): void {
  console.log('\n[1] Arxetiplar');

  assertEqual(ARCHETYPE_KEYS.length, 4, 'ARCHETYPE_KEYS soni');

  for (const key of ARCHETYPE_KEYS) {
    check(`archetype "${key}" archetypeSchema dan o'tadi`, () => {
      const result = archetypeSchema.safeParse(ARCHETYPES[key]);
      assert(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2));
      assertEqual(result.data.key, key, 'key maydoni record kaliti bilan mos emas');
    });
  }

  check('kalitlar unikal', () => {
    const unique = new Set<string>(ARCHETYPE_KEYS);
    assertEqual(unique.size, ARCHETYPE_KEYS.length, 'unikal kalitlar soni');
  });

  check("getArchetype() noto'g'ri kalitda xato beradi", () => {
    let threw = false;
    try {
      getArchetype('yoq_bunday_kalit');
    } catch {
      threw = true;
    }
    assert(threw, 'xato tashlanmadi');
  });

  check('hiddenNeed bo\'lsa needRevealTriggers mavjud', () => {
    for (const key of ARCHETYPE_KEYS) {
      const a = ARCHETYPES[key];
      if (a.hiddenNeed) {
        assert(
          a.needRevealTriggers && a.needRevealTriggers.length > 0,
          `${key}: hiddenNeed=true, lekin needRevealTriggers yo'q`,
        );
      }
    }
  });

  // Drift tekshiruvi: manba JSON bilan solishtirish (ixtiyoriy).
  const jsonPath = resolve(projectRoot, 'archetypes.json');
  if (!existsSync(jsonPath)) {
    skip('ARCHETYPES === archetypes.json', 'archetypes.json topilmadi');
    return;
  }
  check('ARCHETYPES === archetypes.json (drift yo\'q)', () => {
    const raw: unknown = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const list = z.array(archetypeSchema).parse(raw);
    assertEqual(list.length, ARCHETYPE_KEYS.length, 'JSON dagi arxetiplar soni');
    for (const fromJson of list) {
      const fromCode = ARCHETYPES[fromJson.key as keyof typeof ARCHETYPES];
      assert(fromCode, `JSON dagi "${fromJson.key}" kodda yo'q`);
      assertEqual(
        JSON.stringify(archetypeSchema.parse(fromCode)),
        JSON.stringify(fromJson),
        `"${fromJson.key}" kod va JSON farq qiladi`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// 2. Demo profillar + vendor profileSchema
// ---------------------------------------------------------------------------
const profilesPath = resolve(here, 'demo-profiles.json');

function loadDemoProfiles(): Record<string, unknown> {
  const raw: unknown = JSON.parse(readFileSync(profilesPath, 'utf8'));
  assert(raw && typeof raw === 'object' && !Array.isArray(raw), 'demo-profiles.json obyekt emas');
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.startsWith('_')) continue; // `_eslatma` kabi izoh maydonlari
    out[key] = value;
  }
  return out;
}

function verifyDemoProfiles(): void {
  console.log('\n[2] Demo profillar');
  const profiles = loadDemoProfiles();

  check('demo-profiles.json bo\'sh emas', () => {
    assert(Object.keys(profiles).length > 0, 'profil topilmadi');
  });

  for (const [name, profile] of Object.entries(profiles)) {
    check(`profil "${name}" profileSchema dan o'tadi`, () => {
      const result = profileSchema.safeParse(profile);
      assert(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2));
    });
  }

  check('profileSchema noto\'g\'ri maydonni rad etadi', () => {
    const bad = { ...(Object.values(profiles)[0] as Record<string, unknown>), customerType: 'b2x' };
    assert(!profileSchema.safeParse(bad).success, 'noto\'g\'ri customerType qabul qilindi');
  });
}

// ---------------------------------------------------------------------------
// 3. Deterministik holat mashinasi
// ---------------------------------------------------------------------------
function assertDeepEqual(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}\n       kutilgan: ${b}\n       kelgan:   ${a}`);
}

function verifyEngine(): void {
  console.log('\n[3] Holat mashinasi (deterministik)');

  check('initialState arxetip initialState ga teng', () => {
    for (const key of ARCHETYPE_KEYS) {
      const a = ARCHETYPES[key];
      const st = initialState(a);
      assertDeepEqual(
        { patience: st.patience, trust: st.trust, interest: st.interest },
        a.initialState,
        `${key}: boshlang'ich ballar`,
      );
      assertEqual(st.status, 'active', `${key}: status`);
      assertEqual(st.outcome, null, `${key}: outcome`);
      assertEqual(st.turn, 0, `${key}: turn`);
      trainingStateSchema.parse(st);
    }
  });

  check('g\'alaba yo\'li: ready_buyer rozi bo\'ladi', () => {
    const a = getArchetype('ready_buyer');
    const { state } = simulate(a, [
      { gaveSpecifics: true, empathy: true },
      { addressedObjection: true, gaveSpecifics: true, askedToClose: true },
    ]);
    assertEqual(state.outcome, 'won', 'outcome');
    assertEqual(state.endReason, 'agreed', 'endReason');
    assertEqual(state.status, 'ended', 'status');
    assertEqual(state.objectionsResolved, a.objections.count, 'yechilgan e\'tirozlar');
    assert(state.trust >= a.win.minTrust, `trust ${state.trust} < minTrust ${a.win.minTrust}`);
  });

  check('e\'tiroz yechilmasa rozilik bo\'lmaydi', () => {
    const a = getArchetype('negotiator');
    // Ishonch yetarli, lekin e'tirozlar ochiq qoldirilgan.
    const { state } = simulate(a, [
      { gaveSpecifics: true, empathy: true, askedToClose: true },
      { gaveSpecifics: true, empathy: true, askedToClose: true },
    ]);
    assertEqual(state.outcome, null, 'outcome');
    assert(state.pendingObjection, 'javobsiz e\'tiroz qolishi kerak edi');
  });

  check('yutqazish yo\'li: sabr tugaydi', () => {
    const a = getArchetype('negotiator');
    const { state } = simulate(
      a,
      Array.from({ length: a.maxTurns }, () => ({ ignoredCustomer: true })),
    );
    assertEqual(state.outcome, 'lost', 'outcome');
    assertEqual(state.endReason, 'patience_exhausted', 'endReason');
    assert(state.patience < a.lose.patienceBelow, `patience ${state.patience}`);
    assert(state.turn < a.maxTurns, 'maxTurns dan oldin tugashi kerak edi');
  });

  check('timeout yo\'li: hech qachon yopmasa maxTurns da tugaydi', () => {
    const a = getArchetype('ready_buyer');
    const turns: TurnSignalsInput[] = [
      { empathy: true },
      { addressedObjection: true, empathy: true },
      ...Array.from({ length: a.maxTurns + 5 }, () => ({ empathy: true })),
    ];
    const { state } = simulate(a, turns);
    assertEqual(state.outcome, 'timeout', 'outcome');
    assertEqual(state.endReason, 'max_turns', 'endReason');
    assertEqual(state.turn, a.maxTurns, 'turn');
  });

  check('info_seeker: ehtiyoj ochilmasa g\'alaba yo\'q', () => {
    const a = getArchetype('info_seeker');
    const before = simulate(a, [
      { gaveSpecifics: true, empathy: true },
      { addressedObjection: true, gaveSpecifics: true, empathy: true },
      { addressedObjection: true, gaveSpecifics: true, empathy: true, askedToClose: true },
    ]);
    assertEqual(before.state.needDiscovered, false, 'needDiscovered');
    assertEqual(before.state.outcome, null, 'ehtiyojsiz outcome');
    assert(
      before.state.trust >= a.win.minTrust,
      `test to'g'ri bo'lishi uchun trust yetarli bo'lishi kerak: ${before.state.trust}`,
    );

    // Ochuvchi savoldan keyin g'alaba mumkin.
    const after = applyTurn(a, before.state, {
      askedDiscoveryQuestion: true,
      empathy: true,
      askedToClose: true,
    });
    assertEqual(after.state.needDiscovered, true, 'needDiscovered');
    assertEqual(after.state.outcome, 'won', 'outcome');
  });

  check('problematic: e\'tirozlar yechilmasa ham keyingi qadam g\'alaba beradi', () => {
    const a = getArchetype('problematic');
    const nextStep = a.win.acceptedNextSteps?.[0];
    assert(nextStep, 'acceptedNextSteps bo\'sh');
    const { state } = simulate(a, [
      { gaveSpecifics: true, empathy: true },
      { addressedObjection: true, gaveSpecifics: true, empathy: true },
      { addressedObjection: true, empathy: true, proposedNextStep: nextStep },
    ]);
    assertEqual(state.outcome, 'won', 'outcome');
    assertEqual(state.endReason, 'next_step_agreed', 'endReason');
    assertEqual(state.agreedNextStep, nextStep, 'agreedNextStep');
    assert(
      state.objectionsResolved < a.objections.count,
      'test ma\'nosi: e\'tirozlar to\'liq yechilmagan bo\'lishi kerak',
    );
  });

  check('qizil chiziq g\'alabani bloklaydi', () => {
    const a = getArchetype('ready_buyer');
    const built = simulate(a, [
      { gaveSpecifics: true, empathy: true },
      { addressedObjection: true, gaveSpecifics: true },
    ]);
    const after = applyTurn(a, built.state, {
      brokeRedLine: true,
      gaveSpecifics: true,
      empathy: true,
      askedToClose: true,
    });
    assertEqual(after.state.redLineBroken, true, 'redLineBroken');
    assert(
      after.state.trust >= a.win.minTrust,
      `test ma'nosi: trust hamon yetarli bo'lishi kerak (${after.state.trust})`,
    );
    assertEqual(after.state.outcome, null, 'outcome g\'alaba bo\'lmasligi kerak');
  });

  check('ballar 0..100 oralig\'idan chiqmaydi', () => {
    for (const key of ARCHETYPE_KEYS) {
      const a = ARCHETYPES[key];
      const turns: TurnSignalsInput[] = Array.from({ length: a.maxTurns }, (_, i) =>
        i % 2 === 0
          ? { gaveSpecifics: true, empathy: true, addressedObjection: true, askedDiscoveryQuestion: true }
          : { ignoredCustomer: true, repeatedSelf: true, pressured: true },
      );
      const { results } = simulate(a, turns);
      for (const r of results) {
        for (const field of ['patience', 'trust', 'interest'] as const) {
          const v = r.state[field];
          assert(
            Number.isInteger(v) && v >= 0 && v <= 100,
            `${key}.${field} = ${v} (0..100 butun son bo'lishi kerak)`,
          );
        }
        trainingStateSchema.parse(r.state);
      }
    }
  });

  check('determinizm: bir xil kirish = bir xil natija', () => {
    const a = getArchetype('problematic');
    const turns: TurnSignalsInput[] = [
      { gaveSpecifics: true },
      { addressedObjection: true, empathy: true },
      { repeatedSelf: true },
      { addressedObjection: true, gaveSpecifics: true, askedToClose: true },
    ];
    const first = simulate(a, turns);
    const second = simulate(a, turns);
    assertDeepEqual(second.state, first.state, 'yakuniy holat');
    assertDeepEqual(
      second.results.map((r) => r.events),
      first.results.map((r) => r.events),
      'hodisalar',
    );
  });

  check('applyTurn kirish holatini o\'zgartirmaydi', () => {
    const a = getArchetype('negotiator');
    const start = Object.freeze(initialState(a));
    const snapshot = JSON.stringify(start);
    const result = applyTurn(a, start, { gaveSpecifics: true });
    assertEqual(JSON.stringify(start), snapshot, 'kirish holati');
    assert(result.state !== start, 'yangi obyekt qaytarilishi kerak');
  });

  check('tugagan sessiya o\'zgarmaydi', () => {
    const a = getArchetype('ready_buyer');
    const { state } = simulate(a, [
      { gaveSpecifics: true, empathy: true },
      { addressedObjection: true, gaveSpecifics: true, askedToClose: true },
    ]);
    assertEqual(state.status, 'ended', 'status');
    const again = applyTurn(a, state, { gaveSpecifics: true, askedToClose: true });
    assertDeepEqual(again.state, state, 'holat');
    assertEqual(again.events[0]?.code, 'already_ended', 'hodisa');
  });

  check('e\'tirozlar bittadan ko\'tariladi', () => {
    const a = getArchetype('problematic');
    const { results } = simulate(
      a,
      Array.from({ length: 3 }, () => ({ empathy: true, gaveSpecifics: true })),
    );
    for (const r of results) {
      assert(r.state.objectionsRaised - r.state.objectionsResolved <= 1, 'birdan ko\'p ochiq e\'tiroz');
    }
    const indexes = results.map((r) => r.raisedObjectionIndex).filter((i) => i !== null);
    assertDeepEqual(indexes, [0], 'faqat birinchi navbatda yangi e\'tiroz (keyin javobsiz turadi)');
  });
}

// ---------------------------------------------------------------------------
// 4. Persona-card
// ---------------------------------------------------------------------------
function verifyPersona(): void {
  console.log('\n[4] Persona-card');
  const profiles = Object.entries(loadDemoProfiles()).map(
    ([name, raw]) => [name, profileSchema.parse(raw)] as const,
  );

  for (const [name, profile] of profiles) {
    check(`persona: "${name}" uchun 4 arxetip ham to'g'ri yig'iladi`, () => {
      for (const key of ARCHETYPE_KEYS) {
        const a = ARCHETYPES[key];
        const card = buildPersonaCard({ archetype: a, profile, seed: `seed-${name}-${key}` });
        personaCardSchema.parse(card);

        assertEqual(card.archetypeKey, key, 'archetypeKey');
        assertEqual(card.goal, profile.customerProblem, 'goal profildan kelishi kerak');

        // E'tirozlar soni arxetipdan, matni esa FAQAT profildan.
        assertEqual(
          card.objectionQueue.length,
          Math.min(a.objections.count, profile.commonObjections.length),
          'objectionQueue uzunligi',
        );
        for (const obj of card.objectionQueue) {
          assert(
            profile.commonObjections.includes(obj),
            `"${obj}" profildagi commonObjections da yo'q (soha so'zi kodda qolgan?)`,
          );
        }
        assertEqual(new Set(card.objectionQueue).size, card.objectionQueue.length, 'takroriy e\'tiroz');

        // Yashirin ehtiyoj faqat kerakli arxetipda.
        assertEqual(card.hiddenNeed !== null, a.hiddenNeed, 'hiddenNeed');
        assertEqual(card.revealTriggers.length > 0, a.hiddenNeed, 'revealTriggers');

        assertDeepEqual(card.behaviorRules, a.behaviorRules, 'behaviorRules');
        assertDeepEqual(card.acceptedNextSteps, a.win.acceptedNextSteps ?? [], 'acceptedNextSteps');
        assertDeepEqual(card.redLines, profile.redLines, 'redLines');
      }
    });
  }

  check('persona determinizm: bir xil urug\' = bir xil kard', () => {
    const first = profiles[0];
    assert(first, 'demo profil yo\'q');
    const a = getArchetype('problematic');
    const one = buildPersonaCard({ archetype: a, profile: first[1], seed: 'bir-xil-urug' });
    const two = buildPersonaCard({ archetype: a, profile: first[1], seed: 'bir-xil-urug' });
    assertDeepEqual(two, one, 'kard');
  });

  check('persona: boshqa urug\' boshqa tartib beradi', () => {
    const first = profiles[0];
    assert(first, 'demo profil yo\'q');
    const a = getArchetype('problematic');
    const base = JSON.stringify(
      buildPersonaCard({ archetype: a, profile: first[1], seed: 'urug-0' }).objectionQueue,
    );
    let different = false;
    for (let i = 1; i <= 10 && !different; i += 1) {
      const other = JSON.stringify(
        buildPersonaCard({ archetype: a, profile: first[1], seed: `urug-${i}` }).objectionQueue,
      );
      if (other !== base) different = true;
    }
    assert(different, '10 xil urug\'da ham tartib o\'zgarmadi');
  });

  check('persona: profil bo\'lmasa neytral zahira ishlatiladi', () => {
    for (const key of ARCHETYPE_KEYS) {
      const card = buildPersonaCard({ archetype: ARCHETYPES[key], profile: null, seed: 'bosh' });
      personaCardSchema.parse(card);
      assert(card.objectionQueue.length > 0, `${key}: zahira e'tirozlar yo'q`);
      assertDeepEqual(card.redLines, [], `${key}: redLines`);
    }
  });
}

// ---------------------------------------------------------------------------
// 5. Asosiy repo bilan sxema taqqoslash (ixtiyoriy)
// ---------------------------------------------------------------------------
type ZodLike = { safeParse: (input: unknown) => { success: boolean } };

async function verifyAgainstMainRepo(): Promise<void> {
  console.log('\n[5] Asosiy repo (`../sales-copilot`) bilan taqqoslash');
  const mainRepo = resolve(projectRoot, '../sales-copilot');
  const profileFile = resolve(mainRepo, 'backend/src/business/profile.ts');

  if (!existsSync(profileFile)) {
    skip('vendor profileSchema === asosiy repo profileSchema', `${profileFile} topilmadi`);
    return;
  }

  const samples: unknown[] = [
    ...Object.values(loadDemoProfiles()),
    {}, // bo'sh obyekt — rad etilishi kerak
    { industry: 'x' }, // chala — rad etilishi kerak
    { ...(Object.values(loadDemoProfiles())[0] as object), customerType: 'b2x' }, // noto'g'ri enum
    { ...(Object.values(loadDemoProfiles())[0] as object), callDirection: 'sideways' },
    { ...(Object.values(loadDemoProfiles())[0] as object), primaryOffers: [] },
  ];

  await checkAsync('vendor profileSchema === asosiy repo profileSchema', async () => {
    const mod: Record<string, unknown> = await import(profileFile);
    const theirs = (mod.profileSchema ?? mod.default) as ZodLike | undefined;
    assert(theirs && typeof theirs.safeParse === 'function', 'profileSchema eksport topilmadi');
    for (const [i, sample] of samples.entries()) {
      const ours = profileSchema.safeParse(sample).success;
      const them = theirs.safeParse(sample).success;
      assertEqual(ours, them, `namuna #${i}: vendor=${ours}, asosiy=${them}`);
    }
  });
}

// ---------------------------------------------------------------------------
// 6. RLS izolyatsiyasi
// ---------------------------------------------------------------------------
function appUrl(): string {
  const port = process.env.POSTGRES_PORT ?? '55433';
  return (
    process.env.TRAINING_DATABASE_URL ??
    `postgres://trainer_app:trainer_app@127.0.0.1:${port}/sotuv_trener`
  );
}

function superUrl(): string {
  const port = process.env.POSTGRES_PORT ?? '55433';
  return (
    process.env.SUPERUSER_DATABASE_URL ??
    `postgres://postgres:postgres@127.0.0.1:${port}/sotuv_trener`
  );
}

/**
 * Asosiy repodagi `withTenant` yondashuvining test implementatsiyasi:
 * tranzaksiya + `set_config('app.business_id', ..., true)`.
 * (Harness'da ham xuddi shunday — lekin modul harness'ni import qilmaydi.)
 */
function createWithTenant(pool: Pool): WithTenant<PoolClient> {
  return async function withTenant(businessId, fn) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('select set_config($1, $2, true)', ['app.business_id', businessId]);
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  };
}

const INITIAL_STATE = { patience: 50, trust: 50, interest: 50 };

async function verifyRls(): Promise<void> {
  console.log('\n[6] RLS izolyatsiyasi');

  if (process.env.SKIP_DB === '1') {
    skip('RLS testlari', 'SKIP_DB=1');
    return;
  }

  const superPool = new Pool({ connectionString: superUrl(), max: 2 });
  const appPool = new Pool({ connectionString: appUrl(), max: 4 });
  const withTenant = createWithTenant(appPool);

  const bizA = randomUUID();
  const bizB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();

  try {
    // Setup: stub jadvallarga superuser yozadi (ilova roli faqat o'qiydi).
    await superPool.query('insert into business (id, name) values ($1, $2), ($3, $4)', [
      bizA,
      'A biznes',
      bizB,
      'B biznes',
    ]);
    await superPool.query(
      'insert into app_user (id, business_id, email) values ($1, $2, $3), ($4, $5, $6)',
      [userA, bizA, 'a@test.local', userB, bizB, 'b@test.local'],
    );

    // A biznes ostida sessiya + turn yaratamiz.
    const sessionIdA = await withTenant(bizA, async (tx) => {
      const res = await tx.query<{ id: string }>(
        `insert into training_session (business_id, user_id, seat_id, archetype_key, state)
         values ($1, $2, null, $3, $4) returning id`,
        [bizA, userA, 'negotiator', JSON.stringify(INITIAL_STATE)],
      );
      const row = res.rows[0];
      assert(row, 'sessiya yaratilmadi');
      await tx.query(
        `insert into training_turn (session_id, business_id, seq, speaker, text)
         values ($1, $2, 1, 'seller', 'Assalomu alaykum')`,
        [row.id, bizA],
      );
      return row.id;
    });

    await checkAsync('ilova roli superuser emas va bypassrls yo\'q', async () => {
      const res = await appPool.query<{ super: boolean; bypass: boolean }>(
        'select rolsuper as super, rolbypassrls as bypass from pg_roles where rolname = current_user',
      );
      const row = res.rows[0];
      assert(row, 'rol topilmadi');
      assertEqual(row.super, false, 'rolsuper');
      assertEqual(row.bypass, false, 'rolbypassrls');
    });

    await checkAsync('A biznes o\'z sessiyasini ko\'radi', async () => {
      const count = await withTenant(bizA, async (tx) => {
        const res = await tx.query<{ n: string }>(
          'select count(*)::text as n from training_session where id = $1',
          [sessionIdA],
        );
        return Number(res.rows[0]?.n ?? '-1');
      });
      assertEqual(count, 1, 'A ostida sessiya soni');
    });

    await checkAsync('B biznes A ning sessiyasini KO\'RMAYDI', async () => {
      const count = await withTenant(bizB, async (tx) => {
        const res = await tx.query<{ n: string }>(
          'select count(*)::text as n from training_session where id = $1',
          [sessionIdA],
        );
        return Number(res.rows[0]?.n ?? '-1');
      });
      assertEqual(count, 0, 'B ostida sessiya soni');
    });

    await checkAsync('B biznes A ning turn\'larini KO\'RMAYDI', async () => {
      const count = await withTenant(bizB, async (tx) => {
        const res = await tx.query<{ n: string }>(
          'select count(*)::text as n from training_turn where session_id = $1',
          [sessionIdA],
        );
        return Number(res.rows[0]?.n ?? '-1');
      });
      assertEqual(count, 0, 'B ostida turn soni');
    });

    await checkAsync('withTenant\'siz hech narsa o\'qilmaydi', async () => {
      const res = await appPool.query<{ n: string }>(
        'select count(*)::text as n from training_session',
      );
      assertEqual(Number(res.rows[0]?.n ?? '-1'), 0, 'tenant o\'rnatilmaganda sessiya soni');
      const res2 = await appPool.query<{ n: string }>('select count(*)::text as n from training_turn');
      assertEqual(Number(res2.rows[0]?.n ?? '-1'), 0, 'tenant o\'rnatilmaganda turn soni');
    });

    await checkAsync('withTenant\'siz yozish ham mumkin emas', async () => {
      let threw = false;
      try {
        await appPool.query(
          `insert into training_session (business_id, user_id, archetype_key, state)
           values ($1, $2, 'ready_buyer', $3)`,
          [bizA, userA, JSON.stringify(INITIAL_STATE)],
        );
      } catch {
        threw = true;
      }
      assert(threw, 'RLS with check ishlamadi — qator yozildi');
    });

    await checkAsync('boshqa tenant nomidan yozish rad etiladi', async () => {
      let threw = false;
      try {
        await withTenant(bizB, async (tx) => {
          await tx.query(
            `insert into training_session (business_id, user_id, archetype_key, state)
             values ($1, $2, 'ready_buyer', $3)`,
            [bizA, userA, JSON.stringify(INITIAL_STATE)],
          );
        });
      } catch {
        threw = true;
      }
      assert(threw, 'B tenant A ning business_id si bilan qator yozdi');
    });

    await checkAsync('arxetip CHECK noto\'g\'ri kalitni rad etadi', async () => {
      let threw = false;
      try {
        await withTenant(bizA, async (tx) => {
          await tx.query(
            `insert into training_session (business_id, user_id, archetype_key, state)
             values ($1, $2, 'yoq_bunday', $3)`,
            [bizA, userA, JSON.stringify(INITIAL_STATE)],
          );
        });
      } catch {
        threw = true;
      }
      assert(threw, 'CHECK ishlamadi');
    });

    // --- state / persona_card jsonb round-trip + to'liq sessiya yozish -----
    await checkAsync('to\'liq sessiya DB ga yozilib, o\'zgarishsiz qaytib o\'qiladi', async () => {
      const archetype = getArchetype('negotiator');
      const profiles = Object.values(loadDemoProfiles());
      const rawProfile = profiles[0];
      assert(rawProfile, 'demo profil yo\'q');
      const profile: BusinessProfile = profileSchema.parse(rawProfile);

      const seed = randomUUID();
      const card = buildPersonaCard({ archetype, profile, seed });
      const turns: TurnSignalsInput[] = [
        { gaveSpecifics: true, empathy: true },
        { addressedObjection: true, gaveSpecifics: true },
        { addressedObjection: true, gaveSpecifics: true, empathy: true },
        { addressedObjection: true, gaveSpecifics: true, empathy: true, askedToClose: true },
      ];
      const { state: finalState, results } = simulate(archetype, turns);
      assertEqual(finalState.outcome, 'won', 'simulyatsiya natijasi');

      const readBack = await withTenant(bizA, async (tx) => {
        const inserted = await tx.query<{ id: string }>(
          `insert into training_session
             (business_id, user_id, seat_id, archetype_key, persona_card, state, status, outcome, end_reason, turn_count)
           values ($1, $2, null, $3, $4, $5, 'ended', $6, $7, $8)
           returning id`,
          [
            bizA,
            userA,
            archetype.key,
            JSON.stringify(card),
            JSON.stringify(finalState),
            finalState.outcome,
            finalState.endReason,
            finalState.turn,
          ],
        );
        const sessionRow = inserted.rows[0];
        assert(sessionRow, 'sessiya yozilmadi');

        for (const [i, r] of results.entries()) {
          await tx.query(
            `insert into training_turn (session_id, business_id, seq, speaker, text, state_after)
             values ($1, $2, $3, 'seller', $4, $5)`,
            [sessionRow.id, bizA, i + 1, `sotuvchi navbati #${i + 1}`, JSON.stringify(r.state)],
          );
        }

        const res = await tx.query<{
          persona_card: unknown;
          state: unknown;
          turn_count: number;
          outcome: string | null;
          turns: string;
        }>(
          `select s.persona_card, s.state, s.turn_count, s.outcome,
                  (select count(*)::text from training_turn t where t.session_id = s.id) as turns
             from training_session s where s.id = $1`,
          [sessionRow.id],
        );
        return res.rows[0];
      });

      assert(readBack, 'sessiya qaytib o\'qilmadi');
      assertEqual(Number(readBack.turns), results.length, 'yozilgan turn soni');
      assertEqual(readBack.turn_count, finalState.turn, 'turn_count');
      assertEqual(readBack.outcome, 'won', 'outcome');

      // jsonb -> zod: shakl saqlanib qolganini sxema bilan tasdiqlaymiz.
      const stateBack: TrainingState = trainingStateSchema.parse(readBack.state);
      assertDeepEqual(stateBack, finalState, 'state jsonb round-trip');
      assertDeepEqual(personaCardSchema.parse(readBack.persona_card), card, 'persona_card round-trip');
    });

    await checkAsync('turn (session_id, seq) unikal', async () => {
      let threw = false;
      try {
        await withTenant(bizA, async (tx) => {
          await tx.query(
            `insert into training_turn (session_id, business_id, seq, speaker, text)
             values ($1, $2, 1, 'customer', 'takror seq')`,
            [sessionIdA, bizA],
          );
        });
      } catch {
        threw = true;
      }
      assert(threw, 'unique index ishlamadi');
    });
  } finally {
    // Tozalash: sessiya/turn cascade bilan o'chadi.
    await superPool
      .query('delete from business where id = any($1::uuid[])', [[bizA, bizB]])
      .catch(() => undefined);
    await appPool.end().catch(() => undefined);
    await superPool.end().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('verify-training — AI mijoz trenajyori, Step 1-2 tekshiruvi');

  verifyArchetypes();
  verifyDemoProfiles();
  verifyEngine();
  verifyPersona();
  await verifyAgainstMainRepo();

  try {
    await verifyRls();
  } catch (err) {
    failed += 1;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`RLS bloki ishga tushmadi: ${msg}`);
    console.log(
      `  FAIL RLS bloki ishga tushmadi\n       ${msg}\n` +
        '       DB ishlayaptimi? `npm run db:up && npm run db:init` (harness ichida).\n' +
        '       DB kerak bo\'lmasa: SKIP_DB=1.',
    );
  }

  console.log(`\nNatija: ${passed} o'tdi, ${failed} xato, ${skipped} tashlab ketildi.`);
  if (failures.length > 0) {
    console.log('\nXatolar:');
    for (const f of failures) console.log(` - ${f}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
