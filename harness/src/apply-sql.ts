/**
 * FAQAT LOKAL HARNESS. Superuser bilan ulanib, SQL fayllarni tartib bilan
 * qo'llaydi (drizzle-kit'siz — teammate'lar migratsiyani o'zi generatsiya
 * qiladi, qarang module/integration/training.sql).
 *
 * Tartib muhim:
 *   1. harness/db/bootstrap.sql      — cheklangan rol + host stub jadvallari
 *   2. module/integration/training.sql    — modul jadvallari
 *   3. module/integration/rls-training.sql — RLS siyosatlari
 *   4. harness/db/grants.sql         — ilova roliga DML huquqi
 */
// ENG BIRINCHI: harness/.env ni yuklaydi (yo'l harness papkasiga nisbatan).
import './env.js';

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { superuserDatabaseUrl } from './withTenant.js';

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = resolve(here, '..');
const projectRoot = resolve(harnessRoot, '..');

const files = [
  resolve(harnessRoot, 'db/bootstrap.sql'),
  resolve(projectRoot, 'module/integration/training.sql'),
  resolve(projectRoot, 'module/integration/training-scenarios.sql'),
  resolve(projectRoot, 'module/integration/rls-training.sql'),
  resolve(harnessRoot, 'db/grants.sql'),
];

async function main(): Promise<void> {
  const client = new Client({ connectionString: superuserDatabaseUrl() });
  await client.connect();
  try {
    for (const file of files) {
      const sql = await readFile(file, 'utf8');
      await client.query(sql);
      console.log(`[ok] ${file.replace(`${projectRoot}/`, '')}`);
    }
    console.log('\nDB tayyor.');
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error('[apply-sql] xato:', err);
  process.exit(1);
});
