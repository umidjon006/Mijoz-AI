/**
 * FAQAT HARNESS. STT benchmark: har provayder × har namuna uchun kechikish,
 * WER va CER.
 *
 *   npm run bench:stt -- [--providers azure,google] [--limit 5] [--digits-to-words] [--yes]
 *
 * Avval `npm run bench:record` bilan namunalar yozib olinadi.
 * Pulli API chaqirilishidan oldin taxminiy narx chiqadi va tasdiq so'raladi.
 * Audio hech qayerga saqlanmaydi va log qilinmaydi (faqat natija JSON yoziladi).
 */
// ENG BIRINCHI: harness/.env ni yuklaydi (yo'l harness papkasiga nisbatan).
import './env.js';

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { parseWav } from '../../module/backend/src/training/voice/wav.js';
import {
  outDir,
  readSentences,
  sampleExists,
  samplePath,
  type BenchLine,
} from './voice/benchmark-data.js';
import {
  accuracy,
  mean,
  median,
  percentile,
  type AccuracyResult,
} from './voice/text-metrics.js';
import {
  availableSttProviders,
  missingKeysHint,
  PRICE_HINTS,
  type ProviderId,
} from './voice/registry.js';

interface Args {
  providers?: ProviderId[];
  limit?: number;
  digitsToWords: boolean;
  yes: boolean;
  lang: 'uz' | 'ru' | 'mixed';
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const providersRaw = get('providers');
  const providers = providersRaw
    ? (providersRaw.split(',').map((p) => p.trim()) as ProviderId[])
    : undefined;
  const limitRaw = get('limit');
  const langRaw = get('lang');

  return {
    ...(providers ? { providers } : {}),
    ...(limitRaw ? { limit: Number(limitRaw) } : {}),
    digitsToWords: argv.includes('--digits-to-words'),
    yes: argv.includes('--yes'),
    lang: langRaw === 'ru' || langRaw === 'mixed' ? langRaw : 'uz',
  };
}

interface SampleRun {
  n: number;
  reference: string;
  transcript: string;
  latencyMs: number;
  durationSec: number;
  confidence?: number;
  wer: number;
  cer: number;
  error?: string;
}

interface ProviderSummary {
  provider: ProviderId;
  label: string;
  samples: number;
  failed: number;
  werMean: number;
  werMedian: number;
  cerMean: number;
  latencyMedianMs: number;
  latencyP90Ms: number;
  confidenceMean?: number;
  runs: SampleRun[];
}

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  for (const hint of missingKeysHint()) console.log(`[eslatma] ${hint}`);

  const providers = availableSttProviders(args.providers);
  if (providers.length === 0) {
    console.error('\nHech qanday STT provayderi mavjud emas (kalitlar yo\'q).');
    console.error('harness/.env ni to\'ldiring — harness/.env.example ga qarang.');
    process.exit(1);
  }

  const allSentences = await readSentences();
  const available: BenchLine[] = [];
  for (const line of allSentences) {
    if (await sampleExists(line.n)) available.push(line);
  }
  if (available.length === 0) {
    console.error('\nNamunalar topilmadi. Avval: npm run bench:record');
    process.exit(1);
  }

  const sentences = args.limit ? available.slice(0, args.limit) : available;

  // Umumiy audio uzunligi va taxminiy narx.
  let totalSeconds = 0;
  const audioCache = new Map<number, Buffer>();
  for (const line of sentences) {
    const audio = await readFile(samplePath(line.n));
    audioCache.set(line.n, audio);
    totalSeconds += parseWav(audio).durationSec;
  }

  console.log(
    `\nNamunalar: ${sentences.length} ta (${allSentences.length} dan), jami ` +
      `${totalSeconds.toFixed(1)} s audio`,
  );
  console.log(`Provayderlar: ${providers.map((p) => p.label).join(', ')}`);
  let estCost = 0;
  for (const p of providers) {
    const cost = (totalSeconds / 60) * (PRICE_HINTS.stt[p.id] ?? 0);
    estCost += cost;
    console.log(`  ${p.id}: ~$${cost.toFixed(4)} (taxminiy, ${PRICE_HINTS.stt[p.id]}$/daqiqa)`);
  }
  console.log(`Taxminiy jami: ~$${estCost.toFixed(4)} — narxlar tasdiqlanishi kerak.`);

  if (!args.yes) {
    const rl = createInterface({ input, output });
    const answer = (await rl.question('Davom etamizmi? (yes/no) ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'yes' && answer !== 'y') {
      console.log('Bekor qilindi.');
      return;
    }
  }

  const summaries: ProviderSummary[] = [];

  for (const provider of providers) {
    console.log(`\n=== ${provider.label} ===`);
    const runs: SampleRun[] = [];

    for (const line of sentences) {
      const audio = audioCache.get(line.n);
      if (!audio) continue;
      const durationSec = parseWav(audio).durationSec;

      try {
        const result = await provider.port.transcribeShort({
          audio,
          mime: 'audio/wav',
          lang: args.lang,
        });
        const acc: AccuracyResult = accuracy(line.text, result.text, {
          digitsToWords: args.digitsToWords,
        });
        runs.push({
          n: line.n,
          reference: line.text,
          transcript: result.text,
          latencyMs: result.latencyMs,
          durationSec,
          ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
          wer: acc.wer,
          cer: acc.cer,
        });
        console.log(
          `  ${String(line.n).padStart(2, '0')}  WER ${fmtPct(acc.wer).padStart(6)}  ` +
            `CER ${fmtPct(acc.cer).padStart(6)}  ${String(result.latencyMs).padStart(5)}ms  ` +
            `${result.confidence !== undefined ? `conf ${result.confidence.toFixed(2)}` : 'conf   -'}`,
        );
        if (acc.wer > 0) {
          console.log(`      etalon: ${acc.normalizedRef}`);
          console.log(`      natija: ${acc.normalizedHyp}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        runs.push({
          n: line.n,
          reference: line.text,
          transcript: '',
          latencyMs: 0,
          durationSec,
          wer: 1,
          cer: 1,
          error: message,
        });
        console.log(`  ${String(line.n).padStart(2, '0')}  XATO: ${message}`);
      }
    }

    const ok = runs.filter((r) => !r.error);
    const confidences = ok.map((r) => r.confidence).filter((c): c is number => c !== undefined);
    const summary: ProviderSummary = {
      provider: provider.id,
      label: provider.label,
      samples: ok.length,
      failed: runs.length - ok.length,
      werMean: mean(ok.map((r) => r.wer)),
      werMedian: median(ok.map((r) => r.wer)),
      cerMean: mean(ok.map((r) => r.cer)),
      latencyMedianMs: median(ok.map((r) => r.latencyMs)),
      latencyP90Ms: percentile(ok.map((r) => r.latencyMs), 90),
      ...(confidences.length > 0 ? { confidenceMean: mean(confidences) } : {}),
      runs,
    };
    summaries.push(summary);
  }

  console.log('\n================ XULOSA ================');
  console.log('provayder            n   WER(avg)  WER(med)  CER(avg)  lat(med)  lat(p90)');
  for (const s of summaries) {
    console.log(
      `${s.label.padEnd(20).slice(0, 20)} ${String(s.samples).padStart(2)}   ` +
        `${fmtPct(s.werMean).padStart(8)}  ${fmtPct(s.werMedian).padStart(8)}  ` +
        `${fmtPct(s.cerMean).padStart(8)}  ${String(Math.round(s.latencyMedianMs)).padStart(6)}ms  ` +
        `${String(Math.round(s.latencyP90Ms)).padStart(6)}ms` +
        (s.failed > 0 ? `   (${s.failed} xato)` : ''),
    );
  }

  await mkdir(outDir, { recursive: true });
  const outFile = resolve(outDir, 'stt-results.json');
  await writeFile(
    outFile,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        lang: args.lang,
        digitsToWords: args.digitsToWords,
        totalAudioSec: Number(totalSeconds.toFixed(2)),
        providers: summaries,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(`\nNatija: ${outFile}`);
  console.log(
    'Eslatma: raqamlar so\'z bilan o\'qilgani uchun WER oshib ketsa, ' +
      '--digits-to-words bilan qayta ishga tushirib solishtiring.',
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
