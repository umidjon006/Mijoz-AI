/**
 * FAQAT HARNESS. STT modellarini haqiqiy qo'ng'iroqlarda solishtirish (BEPUL):
 *
 *   npm run corpus:compare
 *
 * Har fayl va model uchun: modellar kelishuvi, low_quality ulushi, segmentlar
 * soni, so'zlovchi belgilari, kechikish -> `analysis/stt-compare.json`.
 * Tinglash sahifasi: `harness/data/real-calls/stt-compare.html` (offline,
 * har qo'ng'iroqdan ~60 s parcha va uchala transkript, ko'r baholash, CSV).
 * Qaysi model aniqroq ekani BU YERDA aytilmaydi — faqat sizning baholaringiz.
 */
// ENG BIRINCHI: harness/.env ni yuklaydi (yo'l harness papkasiga nisbatan).
import './env.js';

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { checkFfmpeg, toClip } from './corpus/audio.js';
import {
  buildComparePage,
  compareCall,
  listeningWindow,
  windowText,
  type ComparePageCall,
  type ModelCallMetrics,
} from './corpus/compare.js';
import { analysisDir, clipsDir, CORPUS_MODELS, corpusDir, shortId, transcriptPath } from './corpus/paths.js';
import { intake, listCalls, readJson, writeJson } from './corpus/setup.js';
import type { ModelTranscript } from './corpus/types.js';

async function main(): Promise<void> {
  const ff = checkFfmpeg();
  if (!ff.ok) {
    console.error(`Topilmadi: ${ff.missing.join(', ')}. O'rnating:  sudo apt install ffmpeg`);
    process.exit(1);
  }
  const failures =
    (await readJson<Array<{ callId: string; model: string; error: string }>>(resolve(analysisDir, 'transcribe-failures.json'))) ?? [];
  const calls = (await listCalls()).map(intake);
  await mkdir(clipsDir, { recursive: true });

  const metrics: ModelCallMetrics[] = [];
  const page: ComparePageCall[] = [];
  for (const [n, info] of calls.entries()) {
    const entries = await Promise.all(
      CORPUS_MODELS.map(async (model) => {
        const transcript = await readJson<ModelTranscript>(transcriptPath(model, info.callId));
        const error = failures.find((f) => f.callId === info.callId && f.model === model)?.error;
        return { model, transcript, ...(transcript ? {} : { error: error ?? "transkripsiya qilinmagan" }) };
      }),
    );
    if (entries.every((e) => e.transcript === null)) continue;
    metrics.push(...compareCall(info.callId, entries));

    const window = listeningWindow(info.probe.durationSec);
    const clipName = `${info.callId}.mp3`;
    if (!existsSync(resolve(clipsDir, clipName))) toClip(info.path, resolve(clipsDir, clipName), window);
    page.push({
      callId: info.callId,
      label: `Qo'ng'iroq ${n + 1} (${shortId(info.callId)})`,
      clipPath: `clips/${clipName}`,
      window,
      variants: entries.map((e) =>
        e.transcript
          ? { model: e.model, ...windowText(e.transcript, window) }
          : { model: e.model, text: '', approx: false, error: e.error ?? 'yo\'q' },
      ),
    });
  }

  if (page.length === 0) {
    console.log('Transkript yo\'q — avval: npm run corpus:transcribe');
    return;
  }
  await writeJson(resolve(analysisDir, 'stt-compare.json'), metrics);
  await writeFile(resolve(corpusDir, 'stt-compare.html'), buildComparePage(page), 'utf8');

  console.log('Model                         fayl  xato  kelishuv  low_quality  segment  so\'zlovchi  kechikish');
  for (const model of CORPUS_MODELS) {
    const rows = metrics.filter((m) => m.model === model);
    const ok = rows.filter((m) => m.ok);
    const avg = (f: (m: ModelCallMetrics) => number | null): string => {
      const vals = ok.map(f).filter((v): v is number => v !== null);
      return vals.length === 0 ? '—' : (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2);
    };
    console.log(
      `${model.padEnd(28)} ${String(ok.length).padStart(5)} ${String(rows.length - ok.length).padStart(5)} ` +
        `${avg((m) => m.agreement).padStart(9)} ${avg((m) => m.lowQualityShare).padStart(12)} ` +
        `${avg((m) => m.segments).padStart(8)} ${(ok.some((m) => m.speakerLabels) ? 'ha' : "yo'q").padStart(10)} ` +
        `${avg((m) => m.latencyMs).padStart(10)} ms`,
    );
  }
  console.log(
    "\n\"Kelishuv\" — modellar matni bir-biriga qanchalik o'xshashligi, aniqlik EMAS." +
      '\nTinglang va baholang: harness/data/real-calls/stt-compare.html (brauzerda oching), keyin CSV ni yuklab oling.' +
      '\nKeyingi qadam: npm run corpus:analyze -- --ratings <yuklangan stt-ratings.csv>',
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
