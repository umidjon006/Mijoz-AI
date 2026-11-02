/**
 * FAQAT HARNESS. Backend va frontend'ni birga ishga tushiradi:
 *
 *   npm run dev
 *
 * Qo'shimcha paket (concurrently) kerak bo'lmasligi uchun oddiy spawn.
 */
// ENG BIRINCHI: harness/.env ni yuklaydi (yo'l harness papkasiga nisbatan).
import { envInt, envStr } from './env.js';

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  printDemoBanner,
  printMissingKeyBanner,
  ProviderConfigError,
  resolveProviderConfig,
  startupLine,
} from './llm-factory.js';

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const children: ChildProcess[] = [];

function run(name: string, command: string, args: string[]): void {
  const child = spawn(command, args, {
    cwd: harnessRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });
  child.on('exit', (code) => {
    console.log(`[${name}] tugadi (kod ${code ?? 0})`);
    stop();
  });
  children.push(child);
}

function stop(): void {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exit(0);
}

// LLM holatini OLDIN tekshiramiz: jim demo rejimi bo'lmasin.
try {
  const config = resolveProviderConfig();
  console.log(`\n${startupLine(config)}`);
  if (config.demoRequested) {
    printDemoBanner('dev');
  } else if (!config.hasKey) {
    printMissingKeyBanner('dev', config);
    process.exit(1);
  }
} catch (err) {
  if (err instanceof ProviderConfigError) {
    console.error(`\n[sozlama xatosi] ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

// ---------------------------------------------------------------------------
// DB: backend startda Postgres'ga ulanadi. U ishlamasa (masalan kompyuter
// qayta yongandan keyin lokal klaster to'xtagan) backend `ECONNREFUSED` bilan
// yiqilardi. Endi: lokal klaster bo'lsa — avtomatik ishga tushiramiz,
// bo'lmasa tushunarli xabar bilan to'xtaymiz.
// ---------------------------------------------------------------------------
const dbPort = envInt('POSTGRES_PORT', 55433, { min: 1, max: 65535 });

function canConnect(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolvePromise(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function ensureDatabase(): Promise<void> {
  if (await canConnect(dbPort)) return;

  const localData = envStr('PG_LOCAL_DATA') ?? resolve(harnessRoot, '.pg-local');
  if (existsSync(join(localData, 'PG_VERSION'))) {
    console.log(`\nPostgres to'xtagan (127.0.0.1:${dbPort}) — lokal klaster ishga tushirilmoqda...`);
    spawnSync('npm', ['run', 'db:local:start'], { cwd: harnessRoot, stdio: 'inherit', env: process.env });
    if (await canConnect(dbPort)) return;
  }

  console.error(
    `\n[DB] Postgres ishlamayapti (127.0.0.1:${dbPort}). Ishga tushiring:\n` +
      '  npm run db:local:start   (dockersiz lokal klaster)\n' +
      '  npm run db:up            (docker)\n' +
      "Birinchi marta bo'lsa keyin: npm run db:init\n",
  );
  process.exit(1);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await ensureDatabase();

run('backend', 'npm', ['run', 'serve']);
run('frontend', 'npm', ['run', 'ui:dev']);

console.log('\nBackend: http://127.0.0.1:' + envInt('HARNESS_PORT', 5180, { min: 1, max: 65535 }));
console.log('UI:      http://127.0.0.1:' + envInt('UI_PORT', 5181, { min: 1, max: 65535 }) + '\n');
