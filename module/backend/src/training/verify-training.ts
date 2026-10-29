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
 *   4. (ixtiyoriy) `../sales-copilot` mavjud bo'lsa — vendor sxema va asosiy
 *      repodagi `profileSchema` bir xil namunalarni qabul/rad qiladi;
 *   5. RLS izolyatsiyasi: A biznes yaratgan qatorlar B biznes ostida
 *      KO'RINMAYDI va `withTenant` ishlatilmasa umuman o'qilmaydi.
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
import { profileSchema } from './profile-schema.js';
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
// 3. Asosiy repo bilan sxema taqqoslash (ixtiyoriy)
// ---------------------------------------------------------------------------
type ZodLike = { safeParse: (input: unknown) => { success: boolean } };

async function verifyAgainstMainRepo(): Promise<void> {
  console.log('\n[3] Asosiy repo (`../sales-copilot`) bilan taqqoslash');
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
// 4. RLS izolyatsiyasi
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
  console.log('\n[4] RLS izolyatsiyasi');

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
  console.log('verify-training — AI mijoz trenajyori, Step 1 tekshiruvi');

  verifyArchetypes();
  verifyDemoProfiles();
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
