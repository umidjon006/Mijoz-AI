/**
 * FAQAT HARNESS. Backend va frontend'ni birga ishga tushiradi:
 *
 *   npm run dev
 *
 * Qo'shimcha paket (concurrently) kerak bo'lmasligi uchun oddiy spawn.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  printDemoBanner,
  printMissingKeyBanner,
  ProviderConfigError,
  resolveProviderConfig,
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
  if (config.demoRequested) {
    printDemoBanner('dev');
  } else if (!config.hasKey) {
    printMissingKeyBanner('dev', config);
    process.exit(1);
  } else {
    console.log(`\nLLM: ${config.provider} · ${config.model} (baholash: ${config.scoringModel})`);
  }
} catch (err) {
  if (err instanceof ProviderConfigError) {
    console.error(`\n[sozlama xatosi] ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

run('backend', 'npm', ['run', 'serve']);
run('frontend', 'npm', ['run', 'ui:dev']);

console.log('\nBackend: http://127.0.0.1:' + (process.env.HARNESS_PORT ?? '5180'));
console.log('UI:      http://127.0.0.1:' + (process.env.UI_PORT ?? '5181') + '\n');
