/**
 * FAQAT HARNESS. Topshirish paketini yasaydi:
 *
 *   npm run handoff:pack      ->  dist/handoff-<commit>.tar.gz
 *
 * Faqat COMMIT qilingan fayllar (`git archive HEAD`); `harness/data/**` va
 * `.env` hech qachon kirmaydi — yasalgandan keyin arxiv ro'yxati qayta
 * tekshiriladi, taqiqlangan yo'l topilsa arxiv o'chiriladi va xato beriladi.
 * Commit qilinmagan o'zgarishlar paketga KIRMAYDI (ogohlantiriladi).
 */
// ENG BIRINCHI: harness/.env ni yuklaydi (yo'l harness papkasiga nisbatan).
import './env.js';

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { harnessRoot } from './env.js';
import { forbiddenHandoffEntries, HANDOFF_PATHSPECS } from './handoff.js';

function git(args: string[], cwd: string): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]} xato: ${(r.stderr ?? '').slice(0, 200)}`);
  return r.stdout ?? '';
}

function main(): void {
  const repoRoot = resolve(harnessRoot, '..');
  const commit = git(['rev-parse', '--short', 'HEAD'], repoRoot).trim();
  if (git(['status', '--porcelain'], repoRoot).trim().length > 0) {
    console.warn("Diqqat: commit qilinmagan o'zgarishlar bor — ular paketga KIRMAYDI (faqat HEAD).");
  }

  const outDir = resolve(repoRoot, 'dist');
  mkdirSync(outDir, { recursive: true });
  const out = resolve(outDir, `handoff-${commit}.tar.gz`);
  git(['archive', '--format=tar.gz', `--prefix=handoff-${commit}/`, '-o', out, 'HEAD', '--', ...HANDOFF_PATHSPECS], repoRoot);

  const list = spawnSync('tar', ['-tzf', out], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (list.status !== 0) throw new Error("arxiv ro'yxatini o'qib bo'lmadi");
  const entries = (list.stdout ?? '').split('\n').filter(Boolean);
  const forbidden = forbiddenHandoffEntries(entries.map((e) => e.replace(`handoff-${commit}/`, '')));
  if (forbidden.length > 0) {
    rmSync(out, { force: true });
    console.error(`TO'XTATILDI: taqiqlangan fayllar topildi (${forbidden.length}): ${forbidden.slice(0, 5).join(', ')}`);
    process.exit(1);
  }
  console.log(`Tayyor: dist/handoff-${commit}.tar.gz — ${entries.length} ta yozuv; harness/data/** va .env yo'q.`);
}

main();
