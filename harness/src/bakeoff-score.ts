/**
 * FAQAT HARNESS. Odam baholari (CSV/JSON) + kod o'lchovlarini birlashtirib
 * reyting va qisqa tavsiya chiqaradi.
 *
 *   npm run bakeoff:score -- [--ratings bakeoff-ratings.csv]
 *
 * Baholar bo'lmasa ham ishlaydi — lekin unda xulosa faqat kod o'lchovlariga
 * tayanadi va buni aniq aytadi.
 */
// ENG BIRINCHI: harness/.env ni yuklaydi (yo'l harness papkasiga nisbatan).
import './env.js';

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadExistingRuns } from './bakeoff.js';
import { bakeoffDir, bakeoffOutDir } from './bakeoff/config.js';
import { summarizeCandidate } from './bakeoff/metrics.js';
import {
  aggregateHumanScores,
  parseRatingsCsv,
  rankCandidates,
  recommend,
  type HumanScore,
  type RatingRow,
} from './bakeoff/score.js';

function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

async function loadRatings(): Promise<RatingRow[]> {
  const explicit = argValue('ratings');
  const candidates = [
    ...(explicit ? [resolve(process.cwd(), explicit), resolve(bakeoffDir, explicit)] : []),
    resolve(bakeoffOutDir, 'bakeoff-ratings.csv'),
    resolve(bakeoffDir, 'bakeoff-ratings.csv'),
    resolve(bakeoffOutDir, 'bakeoff-ratings.json'),
  ];

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const raw = await readFile(file, 'utf8');
    console.log(`Baholar: ${file}`);
    if (file.endsWith('.json')) return JSON.parse(raw) as RatingRow[];
    return parseRatingsCsv(raw);
  }
  return [];
}

async function loadMapping(): Promise<Record<string, string>> {
  const file = resolve(bakeoffOutDir, 'mapping.json');
  if (!existsSync(file)) return {};
  const json = JSON.parse(await readFile(file, 'utf8')) as { mapping?: Record<string, string> };
  return json.mapping ?? {};
}

async function main(): Promise<void> {
  const runs = [...(await loadExistingRuns()).values()];
  if (runs.length === 0) {
    console.error("Natija yo'q. Avval: npm run bakeoff");
    process.exit(1);
  }

  const labels = [...new Set(runs.map((r) => r.candidate))];
  const summaries = labels.map((label) => {
    const model = runs.find((r) => r.candidate === label)?.model ?? label;
    return summarizeCandidate({ label, model }, runs);
  });

  const ratings = await loadRatings();
  const mapping = await loadMapping();
  let human: HumanScore[] = [];

  if (ratings.length > 0 && Object.keys(mapping).length > 0) {
    human = aggregateHumanScores(ratings, mapping);
  } else if (ratings.length > 0) {
    console.log("mapping.json topilmadi — ko'r yorliqlarni ochib bo'lmadi.");
  }

  const ranked = rankCandidates(summaries, human);
  const recommendation = recommend(ranked);

  console.log('\n=== REYTING ===');
  console.log("o'rin  nomzod           ball   odam   JSON-1  g'alaba  p50 ms  $/100");
  for (const [index, row] of ranked.entries()) {
    const s = row.summary;
    const pct = (v: number | null): string => (v === null ? '  —' : `${(v * 100).toFixed(0)}%`);
    console.log(
      `${String(index + 1).padStart(4)}.  ${row.candidate.padEnd(16)} ` +
        `${row.total.toFixed(1).padStart(5)}  ` +
        `${(row.humanOverall === null ? '—' : row.humanOverall.toFixed(2)).padStart(5)}  ` +
        `${pct(s.jsonFirstTryRate).padStart(6)}  ${pct(s.winRate).padStart(7)}  ` +
        `${String(s.p50LatencyMs).padStart(6)}  $${s.costPer100Sessions.toFixed(2)}` +
        (row.disqualified ? '   [QATTIQ TALABNI BUZDI]' : ''),
    );
    for (const reason of row.reasons) console.log(`        - ${reason}`);
  }

  console.log('\n=== TAVSIYA ===');
  if (recommendation.live) {
    console.log(
      `Jonli mijoz uchun: ${recommendation.live.candidate} (${recommendation.live.model})`,
    );
    if (recommendation.cheaperGoodEnough) {
      console.log(
        `Arzonroq variant:  ${recommendation.cheaperGoodEnough.candidate} ` +
          `(${recommendation.cheaperGoodEnough.model})`,
      );
    } else {
      console.log('Arzonroq variant:  yo\'q (farq katta yoki arzoni talabdan o\'tmadi)');
    }
  }
  for (const note of recommendation.notes) console.log(`- ${note}`);
  console.log(
    '\nEslatma: o\'zbek tilining tabiiyligi faqat ODAM baholaridan keladi. ' +
      'Ular bo\'lmasa yoki kam bo\'lsa, reyting ham shunchalik ishonchsiz.',
  );

  const outFile = resolve(bakeoffOutDir, 'ranking.json');
  await writeFile(
    outFile,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        humanSamples: ratings.length,
        ranked: ranked.map((r) => ({
          candidate: r.candidate,
          model: r.model,
          total: r.total,
          humanOverall: r.humanOverall,
          disqualified: r.disqualified,
          reasons: r.reasons,
        })),
        recommendation: {
          live: recommendation.live?.candidate ?? null,
          cheaperGoodEnough: recommendation.cheaperGoodEnough?.candidate ?? null,
          notes: recommendation.notes,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(`\nNatija: ${outFile}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
