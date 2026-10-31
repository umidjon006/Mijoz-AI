/**
 * FAQAT HARNESS. Dockersiz lokal PostgreSQL klasteri.
 *
 *   npm run db:local:start     # klaster yaratadi (birinchi marta) va ishga tushiradi
 *   npm run db:local:stop      # to'xtatadi
 *   npm run db:local:status    # holatini ko'rsatadi
 *
 * Nega kerak: `npm run db:up` docker talab qiladi; foydalanuvchi `docker`
 * guruhida bo'lmasa ishlamaydi. Bu skript tizimdagi PostgreSQL binary'laridan
 * (`initdb`, `pg_ctl`, `psql`) foydalanadi — docker ham, sudo ham kerak emas.
 *
 * Klaster FAQAT 127.0.0.1 da TCP orqali tinglaydi (unix-socket o'chirilgan):
 * loyihadagi hamma skript TCP ishlatadi va ba'zi muhitlarda socket yaratish
 * taqiqlangan.
 *
 * Env: `POSTGRES_PORT` (default 55433), `PG_LOCAL_DATA` (default
 * `harness/.pg-local`), `PG_BIN` (topilmasa avtomatik qidiriladi).
 */
// ENG BIRINCHI: harness/.env ni yuklaydi (yo'l harness papkasiga nisbatan).
import './env.js';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PORT = process.env.POSTGRES_PORT ?? '55433';
const DB_NAME = 'sotuv_trener';
const SUPERUSER = 'postgres';
const dataDir = process.env.PG_LOCAL_DATA?.trim() || resolve(harnessRoot, '.pg-local');
const logFile = join(dataDir, 'server.log');

/** `initdb`/`pg_ctl`/`psql` qayerda. */
function findPgBin(): string {
  const fromEnv = process.env.PG_BIN?.trim();
  if (fromEnv) return fromEnv;

  // Debian/Ubuntu: /usr/lib/postgresql/<versiya>/bin — eng yangisini olamiz.
  const base = '/usr/lib/postgresql';
  if (existsSync(base)) {
    const versions = readdirSync(base)
      .filter((name) => /^\d+$/.test(name))
      .sort((a, b) => Number(b) - Number(a));
    for (const version of versions) {
      const candidate = join(base, version, 'bin');
      if (existsSync(join(candidate, 'pg_ctl'))) return candidate;
    }
  }

  // PATH dagi pg_ctl (Homebrew, Postgres.app, boshqa distributivlar).
  const which = spawnSync('which', ['pg_ctl'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return dirname(which.stdout.trim());

  throw new Error(
    "PostgreSQL binary'lari topilmadi (initdb/pg_ctl). `PG_BIN` env'ini qo'ying " +
      "yoki PostgreSQL o'rnating (Ubuntu: sudo apt install postgresql).",
  );
}

function run(
  bin: string,
  args: readonly string[],
  options: { quiet?: boolean } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(bin, args, { encoding: 'utf8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (!options.quiet && stdout.trim()) console.log(stdout.trim());
  return { ok: result.status === 0, stdout, stderr };
}

function isRunning(pgBin: string): boolean {
  if (!existsSync(join(dataDir, 'PG_VERSION'))) return false;
  return run(join(pgBin, 'pg_ctl'), ['-D', dataDir, 'status'], { quiet: true }).ok;
}

function psql(pgBin: string, sql: string): { ok: boolean; out: string } {
  const result = spawnSync(
    join(pgBin, 'psql'),
    ['-h', '127.0.0.1', '-p', PORT, '-U', SUPERUSER, '-d', 'postgres', '-tAc', sql],
    { encoding: 'utf8' },
  );
  return { ok: result.status === 0, out: (result.stdout ?? '').trim() };
}

function start(pgBin: string): void {
  if (isRunning(pgBin)) {
    console.log(`Klaster allaqachon ishlayapti (port ${PORT}).`);
    printUrls();
    return;
  }

  if (!existsSync(join(dataDir, 'PG_VERSION'))) {
    console.log(`Klaster yaratilyapti: ${dataDir}`);
    mkdirSync(dataDir, { recursive: true });
    const init = run(
      join(pgBin, 'initdb'),
      ['-D', dataDir, '-U', SUPERUSER, '--auth=trust', '--encoding=UTF8'],
      { quiet: true },
    );
    if (!init.ok) {
      console.error(`initdb xato berdi:\n${init.stderr.trim() || init.stdout.trim()}`);
      process.exit(1);
    }
    console.log('Klaster yaratildi.');
  }

  // unix_socket_directories='' — faqat TCP; hamma skript 127.0.0.1 ga ulanadi.
  const started = run(
    join(pgBin, 'pg_ctl'),
    [
      '-D',
      dataDir,
      '-l',
      logFile,
      '-o',
      `-p ${PORT} -c unix_socket_directories='' -c listen_addresses=127.0.0.1`,
      '-w',
      'start',
    ],
    { quiet: true },
  );
  if (!started.ok) {
    console.error(
      `Ishga tushmadi. Log: ${logFile}\n${started.stderr.trim() || started.stdout.trim()}`,
    );
    process.exit(1);
  }

  const exists = psql(pgBin, `select 1 from pg_database where datname = '${DB_NAME}'`);
  if (exists.ok && exists.out !== '1') {
    const created = psql(pgBin, `create database ${DB_NAME}`);
    console.log(created.ok ? `"${DB_NAME}" bazasi yaratildi.` : `Baza yaratilmadi: ${created.out}`);
  }

  console.log(`\nPostgreSQL ishlayapti — 127.0.0.1:${PORT}, baza "${DB_NAME}".`);
  printUrls();
  console.log(`\nKeyingi qadam:  npm run db:init`);
  console.log(`To'xtatish:     npm run db:local:stop`);
  console.log(`Log:            ${logFile}`);
}

function stop(pgBin: string): void {
  if (!isRunning(pgBin)) {
    console.log("Klaster ishlamayapti — to'xtatadigan narsa yo'q.");
    return;
  }
  const stopped = run(join(pgBin, 'pg_ctl'), ['-D', dataDir, '-m', 'fast', 'stop'], {
    quiet: true,
  });
  console.log(
    stopped.ok
      ? "Klaster to'xtatildi (ma'lumotlar saqlanib qoldi)."
      : `To'xtatib bo'lmadi:\n${stopped.stderr.trim()}`,
  );
  if (!stopped.ok) process.exit(1);
}

function status(pgBin: string): void {
  if (!existsSync(join(dataDir, 'PG_VERSION'))) {
    console.log(`Klaster hali yaratilmagan (${dataDir}). Boshlash: npm run db:local:start`);
    return;
  }
  console.log(
    isRunning(pgBin)
      ? `Ishlayapti — 127.0.0.1:${PORT}, papka: ${dataDir}`
      : `To'xtagan — papka: ${dataDir}. Boshlash: npm run db:local:start`,
  );
}

/** `.env` ga qo'yiladigan ulanish satrlari (maxfiy ma'lumot yo'q — lokal trust auth). */
function printUrls(): void {
  console.log('\nharness/.env uchun:');
  console.log(`  POSTGRES_PORT=${PORT}`);
  console.log(`  SUPERUSER_DATABASE_URL=postgres://${SUPERUSER}@127.0.0.1:${PORT}/${DB_NAME}`);
  console.log(`  TRAINING_DATABASE_URL=postgres://trainer_app:trainer_app@127.0.0.1:${PORT}/${DB_NAME}`);
}

function main(): void {
  const command = process.argv[2] ?? 'start';
  const pgBin = findPgBin();

  switch (command) {
    case 'start':
      start(pgBin);
      break;
    case 'stop':
      stop(pgBin);
      break;
    case 'status':
      status(pgBin);
      break;
    default:
      console.error(`Noma'lum buyruq: ${command} (start | stop | status)`);
      process.exit(1);
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
