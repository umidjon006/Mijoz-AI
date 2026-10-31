/**
 * FAQAT LOKAL HARNESS. Asosiy repodagi `backend/src/db/index.ts` dagi
 * `withTenant` yondashuvining kichik ko'chirmasi:
 *   tranzaksiya ochadi -> set_config('app.business_id', <id>, true) -> callback.
 * `true` — "local to transaction", ya'ni commit/rollback bilan tozalanadi.
 *
 * Modul bu faylni IMPORT QILMAYDI (module/ -> harness/ bog'liqlik taqiqlangan);
 * modul faqat `ports.ts` dagi `WithTenant` tipini biladi.
 */
// ENG BIRINCHI: harness/.env ni yuklaydi (yo'l harness papkasiga nisbatan).
import './env.js';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { TrainingTx, WithTenant } from '../../module/backend/src/training/ports.js';

export function appDatabaseUrl(): string {
  const port = process.env.POSTGRES_PORT ?? '55433';
  return (
    process.env.TRAINING_DATABASE_URL ??
    `postgres://trainer_app:trainer_app@127.0.0.1:${port}/sotuv_trener`
  );
}

export function superuserDatabaseUrl(): string {
  const port = process.env.POSTGRES_PORT ?? '55433';
  return (
    process.env.SUPERUSER_DATABASE_URL ??
    `postgres://postgres:postgres@127.0.0.1:${port}/sotuv_trener`
  );
}

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 4 });
}

/** `WithTenant` portining Drizzle (node-postgres) ustidagi implementatsiyasi. */
export function createWithTenant(pool: Pool): WithTenant {
  const db = drizzle(pool);
  return async function withTenant(businessId, fn) {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.business_id', ${businessId}, true)`);
      // Host repoda tx tipi o'z sxemasi bilan keladi; modul eng umumiy tipni kutadi.
      return await fn(tx as unknown as TrainingTx);
    });
  };
}

/** `npm run withtenant:smoke` — ulanish va rol to'g'ri ekanini tez tekshiradi. */
async function smoke(): Promise<void> {
  const pool = createPool(appDatabaseUrl());
  const withTenant = createWithTenant(pool);
  const businessId = '00000000-0000-0000-0000-000000000001';
  const value = await withTenant(businessId, async (tx) => {
    const res = await tx.execute(
      sql`select current_user as who, current_setting('app.business_id', true) as biz`,
    );
    return (res as unknown as { rows: unknown[] }).rows[0];
  });
  console.log('withTenant smoke:', value);
  await pool.end();
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  smoke().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
