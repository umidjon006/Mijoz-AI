/**
 * FAQAT HARNESS. `runs.jsonl` dan hisobot yasaydi:
 *   harness/bakeoff/out/report.html   — o'lchovlar jadvali + KO'R baholash sahifasi
 *   harness/bakeoff/out/summary.json  — o'lchovlar (mashina uchun)
 *   harness/bakeoff/out/mapping.json  — ko'r yorliqlarning ochilishi
 *
 *   npm run bakeoff:report -- [--excerpts 12]
 *
 * `mapping.json` ni baholashdan OLDIN ochmang — butun ma'no shunda.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadExistingRuns } from './bakeoff.js';
import { bakeoffOutDir, loadBakeoffConfig } from './bakeoff/config.js';
import { DEFAULT_EXCERPTS_PER_CANDIDATE, selectBlindExcerpts } from './bakeoff/excerpts.js';
import { summarizeCandidate } from './bakeoff/metrics.js';
import { buildReportHtml } from './bakeoff/report-html.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const perCandidateRaw = argv[argv.indexOf('--excerpts') + 1];
  const perCandidate =
    argv.includes('--excerpts') && perCandidateRaw
      ? Number(perCandidateRaw)
      : DEFAULT_EXCERPTS_PER_CANDIDATE;

  const config = loadBakeoffConfig();
  const runs = [...(await loadExistingRuns()).values()];

  if (runs.length === 0) {
    console.error('Natija yo\'q. Avval: npm run bakeoff');
    process.exit(1);
  }

  const labels = [...new Set(runs.map((r) => r.candidate))];
  const summaries = labels.map((label) => {
    const model = runs.find((r) => r.candidate === label)?.model ?? label;
    return summarizeCandidate({ label, model }, runs);
  });

  const { excerpts, mapping, sources } = selectBlindExcerpts(runs, config.shuffleSeed, perCandidate);

  const html = buildReportHtml({
    generatedAt: new Date().toISOString(),
    seed: config.shuffleSeed,
    summaries,
    excerpts,
    totalRuns: runs.length,
  });

  await mkdir(bakeoffOutDir, { recursive: true });
  const reportPath = resolve(bakeoffOutDir, 'report.html');
  await writeFile(reportPath, html, 'utf8');
  await writeFile(
    resolve(bakeoffOutDir, 'summary.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), seed: config.shuffleSeed, summaries }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    resolve(bakeoffOutDir, 'mapping.json'),
    `${JSON.stringify(
      {
        _izoh: "BAHOLAGANDAN KEYIN oching. Ko'r yorliq -> haqiqiy model.",
        seed: config.shuffleSeed,
        mapping,
        sources,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log('\n=== O\'lchovlar ===');
  console.log(
    'nomzod           sessiya  JSON-1  guard  g\'alaba  injection  p50 ms  $/100 sessiya',
  );
  for (const s of summaries) {
    const pct = (v: number | null): string => (v === null ? '  —  ' : `${(v * 100).toFixed(0)}%`);
    console.log(
      `${s.candidate.padEnd(16)} ${String(s.sessions).padStart(5)}  ` +
        `${pct(s.jsonFirstTryRate).padStart(6)}  ${String(s.guardViolations).padStart(5)}  ` +
        `${pct(s.winRate).padStart(7)}  ${pct(s.injectionWinRate).padStart(9)}  ` +
        `${String(s.p50LatencyMs).padStart(6)}  $${s.costPer100Sessions.toFixed(2)}`,
    );
  }

  console.log(`\nHisobot:  ${reportPath}`);
  console.log(`Parchalar: ${excerpts.length} ta (har nomzoddan ${perCandidate} tagacha)`);
  console.log(
    '\nEndi report.html ni brauzerda oching, KO\'R baholashni bajaring va CSV ni yuklab oling.',
  );
  console.log('O\'zbek tili sifatini MEN BAHOLAY OLMAYMAN — bu qadam odam uchun.');
  console.log(`Ochish xaritasi (baholagandan KEYIN): ${resolve(bakeoffOutDir, 'mapping.json')}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
