/**
 * FAQAT HARNESS. Haqiqiy qo'ng'iroqlarni har model bilan transkripsiya qilish (PULLIK):
 *
 *   npm run corpus:transcribe            narx taxmini + tasdiq so'raydi
 *   npm run corpus:transcribe -- --yes
 *
 * - asl fayllar o'zgarmaydi; 16 kHz mono WAV nusxa `work/wav/` da;
 * - uzun fayl jimlikda bo'linadi (`MAX_CHUNK_SEC`);
 * - DAVOM ETTIRISH: tugagan (model, fayl) juftligi qayta chaqirilmaydi;
 * - xom javob `raw/<model>/`, transkript `transcripts/<model>/` (asl matn
 *   o'zgarishsiz + lotin/yashirilgan `display`);
 * - mazmun faqat sozlangan OpenAI endpoint'iga ketadi; logda faqat id, son, vaqt.
 */
// ENG BIRINCHI: harness/.env ni yuklaydi (yo'l harness papkasiga nisbatan).
import './env.js';

import { existsSync } from 'node:fs';
import { envStr, missingKeyHint } from './env.js';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { listOpenAiModels } from './voice/openai.js';
import { checkFfmpeg, toWav } from './corpus/audio.js';
import { analysisDir, CORPUS_MODELS, rawPath, shortId, transcriptPath, wavDir } from './corpus/paths.js';
import { confirm, intake, listCalls, minutes, openAiTarget, sttPricePerMin, writeJson, type IntakeInfo } from './corpus/setup.js';
import { transcribeFile } from './corpus/stt.js';
import { buildModelTranscript, type ChunkResult } from './corpus/transcript.js';

async function ensureWavs(info: IntakeInfo): Promise<Array<{ path: string; offsetSec: number }>> {
  await mkdir(wavDir, { recursive: true });
  const single = info.chunks.length <= 1;
  return info.chunks.map((chunk, k) => {
    const path = resolve(wavDir, single ? `${info.callId}.wav` : `${info.callId}.c${k + 1}.wav`);
    if (!existsSync(path)) toWav(info.path, path, single ? undefined : chunk);
    return { path, offsetSec: chunk.start };
  });
}

async function main(): Promise<void> {
  const yes = process.argv.includes('--yes');
  const ff = checkFfmpeg();
  if (!ff.ok) {
    console.error(`Topilmadi: ${ff.missing.join(', ')}. O'rnating:  sudo apt install ffmpeg`);
    process.exit(1);
  }
  const target = openAiTarget();
  if (!target) {
    console.error(missingKeyHint(envStr('OPENAI_VOICE_KEY_ENV') ?? 'OPENAI_API_KEY', 'src/corpus-transcribe.ts'));
    process.exit(1);
  }

  const calls = (await listCalls()).map(intake);
  let available: Set<string> | null = null;
  try {
    available = new Set((await listOpenAiModels({ apiKey: target.apiKey, baseUrl: target.baseUrl })).map((m) => m.id));
  } catch {
    available = null; // ro'yxat olinmadi — urinib ko'ramiz
  }
  const models = CORPUS_MODELS.filter((m) => available === null || available.has(m));
  const skipped = CORPUS_MODELS.filter((m) => !models.includes(m));
  if (skipped.length > 0) console.log(`Kalitga ochiq emas — o'tkazib yuboriladi: ${skipped.join(', ')}`);

  const jobs = models.flatMap((model) =>
    calls.filter((c) => !existsSync(transcriptPath(model, c.callId))).map((info) => ({ model, info })),
  );
  if (jobs.length === 0) {
    console.log("Hamma fayl allaqachon transkripsiya qilingan — pullik chaqiruv yo'q.");
    return;
  }
  const pendingSec = jobs.reduce((s, j) => s + j.info.probe.durationSec, 0);
  const price = sttPricePerMin();
  console.log(
    `Qoldi: ${jobs.length} ta (model × fayl), ${minutes(pendingSec)} daqiqa audio` +
      (price === null ? " — narx noma'lum (OPENAI_STT_PRICE_PER_MIN bo'sh)." : ` ≈ $${((pendingSec / 60) * price).toFixed(3)}.`),
  );
  console.log(`Endpoint: ${new URL(target.baseUrl).host}; til rejimi: ${target.languageMode}.`);
  if (!yes && !(await confirm("Davom etilsinmi? (ha/yo'q) "))) {
    console.log("To'xtatildi — pullik chaqiruv qilinmadi. Tasdiqsiz: npm run corpus:transcribe -- --yes");
    return;
  }

  const failures: Array<{ callId: string; model: string; error: string }> = [];
  for (const { model, info } of jobs) {
    const id = shortId(info.callId);
    try {
      const wavs = await ensureWavs(info);
      const chunkResults: ChunkResult[] = [];
      const raws: unknown[] = [];
      for (const wav of wavs) {
        const out = await transcribeFile(model, wav.path, {
          apiKey: target.apiKey,
          baseUrl: target.baseUrl,
          languageMode: target.languageMode,
          hints: target.hints,
        });
        raws.push({ offsetSec: wav.offsetSec, latencyMs: out.latencyMs, response: out.raw });
        chunkResults.push({
          offsetSec: wav.offsetSec,
          text: out.text,
          segments: out.segments,
          latencyMs: out.latencyMs,
          ...(out.language ? { language: out.language } : {}),
        });
      }
      await writeJson(rawPath(model, info.callId), { model, callId: info.callId, chunks: raws });
      const transcript = buildModelTranscript({
        callId: info.callId,
        model,
        languageMode: model.includes('diarize') ? 'omit' : target.languageMode,
        durationSec: info.probe.durationSec,
        chunks: chunkResults,
      });
      await writeJson(transcriptPath(model, info.callId), transcript);
      const low = transcript.segments.filter((s) => s.quality === 'low_quality').length;
      console.log(
        `[stt] ${id} ${model} · ${info.probe.durationSec.toFixed(0)} s · ${wavs.length} bo'lak · ` +
          `${transcript.segments.length} segment (${low} low_quality) · ${transcript.latencyMs} ms`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ callId: info.callId, model, error: message.slice(0, 200) });
      console.log(`[stt] ${id} ${model} · XATO: ${message.slice(0, 160)}`);
    }
  }

  await writeJson(resolve(analysisDir, 'transcribe-failures.json'), failures);
  console.log(`\nTayyor: ${jobs.length - failures.length} ta muvaffaqiyatli, ${failures.length} ta xato.`);
  if (failures.length > 0) console.log("Xatolar qayta urinishda yana chaqiriladi (muvaffaqiyatlilar — yo'q).");
  console.log('Keyingi qadam: npm run corpus:compare');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
