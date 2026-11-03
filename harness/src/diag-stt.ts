/**
 * FAQAT HARNESS. STT modellarini o'zbek nutqida SOLISHTIRADI (pullik chaqiruvlar):
 *
 *   npm run diag:stt                    narx taxmini + tasdiq so'raydi
 *   npm run diag:stt -- --yes           tasdiqsiz
 *   npm run diag:stt -- --with-diarize  gpt-4o-transcribe-diarize ham (odatda kerak emas)
 *   npm run diag:stt -- --limit 5       faqat birinchi 5 ta namuna
 *
 * Namunalar: `harness/benchmark/samples/NN.wav` (`npm run bench:record` bilan
 * yoziladi), etalon matn — `harness/benchmark/sentences.uz.txt` ning NN-qatori.
 *
 * Har model × til rejimi (`omit`, `prompt`) × namuna uchun: tanilgan matn,
 * WER/CER (apostrof, harf, tinish normallashtirilgan; kirill -> lotin
 * o'girilgandan keyin ham), kechikish, provayder aytgan til. Oxirida reyting
 * va `.env` uchun tavsiya. Kalit chiqmaydi; audio hech qayerga yozilmaydi.
 */
// ENG BIRINCHI: harness/.env ni yuklaydi (yo'l harness papkasiga nisbatan).
import { envStr } from './env.js';

import { readFile } from 'node:fs/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { offerTopic } from '../../module/backend/src/training/offer-facts.js';
import { transliterateUzCyrillic } from '../../module/backend/src/training/language.js';
import { parseWav } from '../../module/backend/src/training/voice/wav.js';
import { resolveBusinessData } from './business-data.js';
import { readSentences, sampleExists, samplePath } from './voice/benchmark-data.js';
import {
  createOpenAiStt,
  DEFAULT_OPENAI_BASE_URL,
  listOpenAiModels,
  type OpenAiVoiceConfig,
  type SttLanguageMode,
} from './voice/openai.js';
import {
  rankStt,
  scoreSample,
  summarizeStt,
  type SttSampleRun,
} from './voice/stt-compare.js';

/** Solishtiriladigan modellar (kalitga ochiq bo'lganlari olinadi). */
const CANDIDATE_MODELS = [
  'gpt-4o-mini-transcribe',
  'gpt-4o-transcribe',
  'gpt-transcribe',
  'gpt-live-transcribe',
];
/** Bir kishi gapiradi — diarizatsiya (kim gapirgani) foyda bermaydi; faqat so'ralsa. */
const DIARIZE_MODEL = 'gpt-4o-transcribe-diarize';
const MODES: SttLanguageMode[] = ['omit', 'prompt'];

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

async function confirm(question: string): Promise<boolean> {
  if (!input.isTTY) return false;
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'ha' || answer === 'h' || answer === 'yes' || answer === 'y';
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const yes = args.includes('--yes');
  const withDiarize = args.includes('--with-diarize');
  const limitArg = args[args.indexOf('--limit') + 1];
  const limit = args.includes('--limit') && limitArg ? Number(limitArg) : Infinity;

  const keyEnv = envStr('OPENAI_VOICE_KEY_ENV') ?? 'OPENAI_API_KEY';
  const apiKey = envStr(keyEnv);
  if (!apiKey) {
    console.error(`${keyEnv} bo'sh yoki yo'q — harness/.env ni to'ldiring.`);
    process.exit(1);
  }
  const baseUrl = (envStr('OPENAI_BASE_URL') ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');

  // --- Namunalar (bepul) ---------------------------------------------------
  const sentences = await readSentences();
  const samples: Array<{ n: number; reference: string; audio: Buffer; seconds: number }> = [];
  for (const line of sentences) {
    if (samples.length >= limit) break;
    if (!(await sampleExists(line.n))) continue;
    const audio = await readFile(samplePath(line.n));
    samples.push({ n: line.n, reference: line.text, audio, seconds: parseWav(audio).durationSec });
  }
  if (samples.length === 0) {
    console.log(
      "Namuna yo'q: harness/benchmark/samples/NN.wav topilmadi.\n" +
        "Yozib oling:  npm run bench:record   (brauzerda sentences.uz.txt gaplarini o'qing)\n" +
        "Keyin qayta:  npm run diag:stt\n" +
        'Hech qanday pullik chaqiruv qilinmadi.',
    );
    return;
  }

  // --- Modellar (bepul: GET /models) ---------------------------------------
  const available = new Set((await listOpenAiModels({ apiKey, baseUrl })).map((m) => m.id));
  const wanted = [...CANDIDATE_MODELS, ...(withDiarize ? [DIARIZE_MODEL] : [])];
  const models = wanted.filter((m) => available.has(m));
  const missing = wanted.filter((m) => !available.has(m));
  console.log(`Namunalar: ${samples.length} ta`);
  console.log(`Modellar:  ${models.join(', ') || "(birortasi ham kalitga ochiq emas)"}`);
  if (missing.length > 0) console.log(`Kalitga ochiq emas: ${missing.join(', ')}`);
  if (models.length === 0) process.exit(1);

  // --- Narx taxmini --------------------------------------------------------
  const audioMinutes = samples.reduce((s, x) => s + x.seconds, 0) / 60;
  const billedMinutes = audioMinutes * models.length * MODES.length;
  const calls = samples.length * models.length * MODES.length;
  const pricePerMin = Number(envStr('OPENAI_STT_PRICE_PER_MIN') ?? NaN);
  console.log(
    `\nTaxmin: ${calls} ta chaqiruv, ~${billedMinutes.toFixed(2)} daqiqa audio` +
      (Number.isFinite(pricePerMin)
        ? ` ≈ $${(billedMinutes * pricePerMin).toFixed(4)} (OPENAI_STT_PRICE_PER_MIN bo'yicha)`
        : ' (narx: OPENAI_STT_PRICE_PER_MIN bo\'sh — OpenAI narxlar sahifasidagi daqiqa narxiga ko\'paytiring)'),
  );
  if (!yes && !(await confirm("Davom etilsinmi? (ha/yo'q) "))) {
    console.log("To'xtatildi — pullik chaqiruv qilinmadi. Tasdiqsiz: npm run diag:stt -- --yes");
    return;
  }

  // --- Ishga tushirish -----------------------------------------------------
  let hints: string[] = [];
  try {
    const profile = resolveBusinessData(envStr('HARNESS_PROFILE')).profile;
    hints = [...profile.vocabulary, ...profile.primaryOffers.map(offerTopic)].slice(0, 100);
  } catch {
    // Profil bo'lmasa ishorasiz.
  }

  const runs: SttSampleRun[] = [];
  for (const model of models) {
    for (const mode of MODES) {
      const config: OpenAiVoiceConfig = {
        apiKey,
        baseUrl,
        keyEnv,
        sttModel: model,
        ttsModel: '',
        ttsVoice: undefined,
        ttsFormat: 'mp3',
        timeoutMs: 60_000,
        sttLanguageMode: mode,
      };
      const stt = createOpenAiStt(config);
      console.log(`\n=== ${model} · til=${mode} ===`);
      for (const sample of samples) {
        try {
          const out = await stt.transcribeShort({
            audio: sample.audio,
            mime: 'audio/wav',
            lang: 'uz',
            ...(hints.length > 0 ? { hints } : {}),
          });
          const raw = out.raw as { language?: string } | undefined;
          runs.push({
            model,
            mode,
            n: sample.n,
            reference: sample.reference,
            text: out.text,
            latencyMs: out.latencyMs,
            ...(raw?.language ? { language: raw.language } : {}),
          });
          const score = scoreSample(sample.reference, out.text);
          const latin = score.script === 'uz_cyrillic' ? ` → "${transliterateUzCyrillic(out.text)}"` : '';
          console.log(
            `  ${String(sample.n).padStart(2, '0')} WER ${pct(score.werLatin)} CER ${pct(score.cerLatin)} ` +
              `${out.latencyMs}ms [${score.script}${raw?.language ? `, til=${raw.language}` : ''}] "${out.text}"${latin}`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          runs.push({
            model,
            mode,
            n: sample.n,
            reference: sample.reference,
            text: null,
            latencyMs: 0,
            error: message,
          });
          console.log(`  ${String(sample.n).padStart(2, '0')} XATO: ${message.slice(0, 160)}`);
        }
      }
    }
  }

  // --- Reyting -------------------------------------------------------------
  const ranking = rankStt(summarizeStt(runs));
  console.log('\nReyting (lotindagi WER bo\'yicha; kirill o\'girilgandan keyin):');
  console.log('  #  model                      til     WER(lotin) CER(lotin) WER(xom) p50ms  boshqa-til xato');
  ranking.forEach((s, i) => {
    console.log(
      `  ${i + 1}  ${s.model.padEnd(26)} ${s.mode.padEnd(7)} ${pct(s.meanWerLatin).padStart(9)} ` +
        `${pct(s.meanCerLatin).padStart(10)} ${pct(s.meanWer).padStart(8)} ${String(s.p50LatencyMs).padStart(5)} ` +
        `${String(s.foreign).padStart(10)} ${String(s.errors).padStart(4)}`,
    );
  });

  const best = ranking[0];
  if (best) {
    console.log('\nTavsiya (harness/.env):');
    console.log(`  OPENAI_STT_MODEL=${best.model}`);
    console.log(`  OPENAI_STT_LANGUAGE_MODE=${best.mode}`);
    if (best.foreign > 0) {
      console.log(
        `  Diqqat: eng yaxshi variantda ham ${best.foreign} ta javob boshqa tilda chiqdi — ` +
          "jonli rejimda ular 'takrorlaysizmi' bo'ladi.",
      );
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
