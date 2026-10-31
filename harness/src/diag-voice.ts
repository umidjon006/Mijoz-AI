/**
 * FAQAT HARNESS. OpenAI ovoz imkoniyatlarini KALITNING O'ZIDAN aniqlaydi.
 *
 *   npm run diag:voice                 # faqat model ro'yxati va narx taxmini
 *   npm run diag:voice -- --yes        # haqiqiy (pullik) chaqiruvlar bilan
 *   npm run diag:voice -- --tts-models gpt-x-tts --voices alloy,verse
 *
 * Nega kerak: model nomlari tez o'zgaradi va har kalitda har xil model
 * ochiq. Shuning uchun kodda model nomi YO'Q — bu skript `GET /v1/models`
 * dan ovozga aloqador modellarni topadi, ularni sinaydi va `harness/.env`
 * uchun TAVSIYA chiqaradi.
 *
 * DIQQAT: `--yes` bo'lmasa hech qanday pullik chaqiruv qilinmaydi.
 * Audio `harness/benchmark/out/openai-tts/` ga tinglash uchun yoziladi.
 */
// ENG BIRINCHI: harness/.env ni yuklaydi (yo'l harness papkasiga nisbatan).
import { envStr } from './env.js';

import { mkdir, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { parseWav } from '../../module/backend/src/training/voice/wav.js';
import { normalizeForSpeech } from '../../module/backend/src/training/voice/speech-text.js';
import { toneInstruction } from '../../module/backend/src/training/voice/tone.js';
import {
  outDir,
  readSentences,
  samplePath,
  sampleExists,
} from './voice/benchmark-data.js';
import { accuracy } from './voice/text-metrics.js';
import {
  createOpenAiStt,
  createOpenAiTts,
  DEFAULT_OPENAI_BASE_URL,
  filterVoiceModels,
  listOpenAiModels,
  VOICE_MODEL_HINTS,
  type OpenAiModel,
  type OpenAiVoiceConfig,
} from './voice/openai.js';

const ttsOutDir = resolve(outDir, 'openai-tts');

/**
 * Sinov gaplari. Birinchisida NARXLAR bor (raqam -> so'z aylantirishni
 * eshitib tekshirish uchun), ikkinchisi xotirjam, uchinchisi asabiy
 * (ohang ko'rsatmasi bilan).
 */
const PROBES = [
  {
    key: 'narx',
    tone: 'calm' as const,
    text: "Bitta darsning narxi yetti yuz ming so'm, oyiga uch million ikki yuz ming bo'ladi.",
  },
  {
    key: 'xotirjam',
    tone: 'calm' as const,
    text: "Yaxshi, tushundim. Shartlaringizni birma-bir aytib bera olasizmi?",
  },
  {
    key: 'asabiy',
    tone: 'irritated' as const,
    text: "Qarang, men buni uchinchi marta so'rayapman. Nega aniq javob bermaysiz?",
  },
] as const;

interface Args {
  yes: boolean;
  sttModels: string[] | undefined;
  ttsModels: string[] | undefined;
  voices: string[] | undefined;
  limit: number;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const list = (name: string): string[] | undefined => {
    const raw = get(name);
    if (!raw) return undefined;
    const items = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    return items.length > 0 ? items : undefined;
  };

  return {
    yes: argv.includes('--yes'),
    sttModels: list('stt-models'),
    ttsModels: list('tts-models'),
    voices: list('voices'),
    limit: Number(get('limit') ?? 3),
  };
}

function ms(value: number): string {
  return `${value.toString().padStart(5)} ms`;
}

/** Nomiga qarab STT/TTS ga bo'lish (tartib ham shu — eng ehtimolligi oldinda). */
function splitByKind(models: readonly OpenAiModel[]): {
  stt: OpenAiModel[];
  tts: OpenAiModel[];
  other: OpenAiModel[];
} {
  const stt: OpenAiModel[] = [];
  const tts: OpenAiModel[] = [];
  const other: OpenAiModel[] = [];
  for (const model of models) {
    const id = model.id.toLowerCase();
    if (id.includes('transcribe') || (id.includes('audio') && id.includes('asr'))) stt.push(model);
    else if (id.includes('tts') || id.includes('speech')) tts.push(model);
    else other.push(model);
  }
  return { stt, tts, other };
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  const answer = (await rl.question(`${question} (yes/no) `)).trim().toLowerCase();
  rl.close();
  return answer === 'yes' || answer === 'y';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const keyEnv = envStr('OPENAI_VOICE_KEY_ENV') ?? 'OPENAI_API_KEY';
  const apiKey = envStr(keyEnv);
  const baseUrl = (envStr('OPENAI_BASE_URL') ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');

  if (!apiKey) {
    console.error(
      `\n${keyEnv} bo'sh yoki yo'q. harness/.env ga qo'ying (kalit hech qayerda chop etilmaydi).\n`,
    );
    process.exit(1);
  }

  console.log(`\nOpenAI ovoz diagnostikasi`);
  console.log(`  host:  ${new URL(baseUrl).host}`);
  console.log(`  kalit: ${keyEnv} = o'rnatilgan\n`);

  // --- 1. Modellar ---------------------------------------------------------
  console.log('[1/4] Kalitga ochiq modellar');
  const all = await listOpenAiModels({ apiKey, baseUrl });
  const voiceModels = filterVoiceModels(all);
  console.log(`  jami ${all.length} ta model, shundan ovozga aloqadori ${voiceModels.length} ta`);
  console.log(`  (saralash: ${VOICE_MODEL_HINTS.join(', ')})\n`);

  const { stt: sttFound, tts: ttsFound, other } = splitByKind(voiceModels);
  for (const [label, list] of [
    ['STT (nutq -> matn)', sttFound],
    ['TTS (matn -> nutq)', ttsFound],
    ['boshqa (realtime/audio)', other],
  ] as const) {
    console.log(`  ${label}:`);
    if (list.length === 0) console.log('    — topilmadi');
    for (const model of list) console.log(`    ${model.id}`);
  }

  const sttModels = args.sttModels ?? sttFound.slice(0, 1).map((m) => m.id);
  const ttsModels = args.ttsModels ?? ttsFound.slice(0, args.limit).map((m) => m.id);
  const voices = args.voices ?? ['alloy', 'verse', 'shimmer'];

  if (sttModels.length === 0 && ttsModels.length === 0) {
    console.log(
      "\nOvoz modellari topilmadi. Kalitga ular ochiq emas bo'lishi mumkin — " +
        'OpenAI hisobingizni tekshiring yoki `--stt-models` / `--tts-models` bilan qo\'lda bering.\n',
    );
    return;
  }

  // --- 2. Narx taxmini (chaqirishdan OLDIN) --------------------------------
  const samples: number[] = [];
  const sentences = await readSentences();
  for (const line of sentences) {
    if (await sampleExists(line.n)) samples.push(line.n);
  }

  const ttsCalls = ttsModels.length * Math.min(voices.length, 3) * PROBES.length;
  const ttsChars = PROBES.reduce((sum, p) => sum + p.text.length, 0) *
    ttsModels.length * Math.min(voices.length, 3);
  const sttCalls = sttModels.length * samples.length;

  console.log('\n[2/4] Nima qilinadi va taxminiy narx');
  console.log(`  TTS: ${ttsCalls} chaqiruv, ~${ttsChars} belgi`);
  console.log(
    `       modellar: ${ttsModels.join(', ') || '—'}; ovozlar: ${voices.slice(0, 3).join(', ')}`,
  );
  console.log(`  STT: ${sttCalls} chaqiruv (${samples.length} ta namuna × ${sttModels.length} model)`);
  if (samples.length === 0) {
    console.log('       namuna yo\'q — avval `npm run bench:record` bilan yozib oling');
  }
  console.log(
    '\n  Narx: OpenAI tariflari kodda YO\'Q (tez o\'zgaradi). Hajm bo\'yicha ' +
      'o\'zingiz hisoblang:\n' +
      `    TTS ~${ttsChars} belgi ≈ ${(ttsChars / 1_000_000).toFixed(5)} million belgi\n` +
      `    STT ~${sttCalls} ta qisqa yozuv (odatda 5–15 s)\n` +
      '  Odatda bu bir necha sentdan oshmaydi, lekin tarifni sahifadan tasdiqlang.',
  );

  if (!args.yes) {
    const ok = await confirm('\nPullik chaqiruvlarni bajaramizmi?');
    if (!ok) {
      console.log('Bekor qilindi — hech narsa chaqirilmadi.\n');
      return;
    }
  }

  // --- 3. TTS --------------------------------------------------------------
  console.log('\n[3/4] TTS');
  await mkdir(ttsOutDir, { recursive: true });

  interface TtsRow {
    model: string;
    voice: string;
    probe: string;
    latencyMs: number;
    firstByteMs: number | null;
    bytes: number;
    file: string;
    instructionsAccepted: boolean;
  }
  const ttsRows: TtsRow[] = [];

  for (const model of ttsModels) {
    for (const voice of voices.slice(0, 3)) {
      for (const probe of PROBES) {
        const config: OpenAiVoiceConfig = {
          apiKey,
          baseUrl,
          keyEnv,
          sttModel: sttModels[0] ?? '',
          ttsModel: model,
          ttsVoice: voice,
          ttsFormat: envStr('OPENAI_TTS_FORMAT') ?? 'mp3',
          timeoutMs: 60_000,
        };
        const port = createOpenAiTts(config);
        // Mijoz javobi serverda ham aynan shunday tayyorlanadi.
        const text = normalizeForSpeech(probe.text, 'uz');

        let instructionsAccepted = true;
        let out;
        try {
          out = await port.synthesize({
            text,
            lang: 'uz',
            voice,
            tone: probe.tone,
            instructions: toneInstruction(probe.tone),
          });
        } catch (err) {
          // Ko'rsatmani qo'llamaydigan model 400 qaytaradi — ko'rsatmasiz urinamiz.
          const message = err instanceof Error ? err.message : String(err);
          console.log(`  ${model} / ${voice} / ${probe.key}: ko'rsatmasiz qayta urinish (${message.slice(0, 80)})`);
          instructionsAccepted = false;
          try {
            out = await port.synthesize({ text, lang: 'uz', voice });
          } catch (err2) {
            console.log(
              `  FAIL ${model} / ${voice} / ${probe.key}: ${
                err2 instanceof Error ? err2.message.slice(0, 160) : String(err2)
              }`,
            );
            continue;
          }
        }

        const ext = out.mime === 'audio/mpeg' ? 'mp3' : out.mime === 'audio/ogg' ? 'ogg' : 'bin';
        const file = `${model.replace(/[^\w.-]/g, '_')}__${voice}__${probe.key}.${ext}`;
        await writeFile(resolve(ttsOutDir, file), out.audio);

        ttsRows.push({
          model,
          voice,
          probe: probe.key,
          latencyMs: out.latencyMs,
          firstByteMs: out.firstByteMs ?? null,
          bytes: out.audio.length,
          file,
          instructionsAccepted,
        });
        console.log(
          `  ok   ${model} / ${voice} / ${probe.key.padEnd(9)} ` +
            `${ms(out.latencyMs)} · birinchi bayt ${
              out.firstByteMs === undefined ? '  —  ' : ms(out.firstByteMs)
            } · ${(out.audio.length / 1024).toFixed(0)} KB` +
            `${instructionsAccepted ? '' : " · ohang ko'rsatmasi QO'LLANMADI"}`,
        );
      }
    }
  }

  // --- 4. STT --------------------------------------------------------------
  console.log('\n[4/4] STT');
  interface SttRow {
    model: string;
    n: number;
    latencyMs: number;
    text: string;
    wer: number | null;
  }
  const sttRows: SttRow[] = [];

  if (samples.length === 0) {
    console.log('  namuna yo\'q — o\'tkazib yuborildi');
  }

  for (const model of sttModels) {
    for (const n of samples) {
      const config: OpenAiVoiceConfig = {
        apiKey,
        baseUrl,
        keyEnv,
        sttModel: model,
        ttsModel: ttsModels[0] ?? '',
        ttsVoice: undefined,
        ttsFormat: 'mp3',
        timeoutMs: 60_000,
      };
      const port = createOpenAiStt(config);
      const audio = await readFile(samplePath(n));
      const info = parseWav(audio);

      try {
        const heard = await port.transcribeShort({ audio, mime: 'audio/wav', lang: 'uz' });
        const reference = sentences.find((s) => s.n === n)?.text;
        const acc = reference ? accuracy(reference, heard.text) : null;
        sttRows.push({
          model,
          n,
          latencyMs: heard.latencyMs,
          text: heard.text,
          wer: acc ? acc.wer : null,
        });
        console.log(
          `  ${String(n).padStart(2, '0')}.wav (${info.durationSec.toFixed(1)}s) ${ms(heard.latencyMs)}` +
            `${acc ? ` · WER ${(acc.wer * 100).toFixed(1)}%` : ''}`,
        );
        console.log(`       "${heard.text}"`);
        if (reference) console.log(`       etalon: "${reference}"`);
      } catch (err) {
        console.log(
          `  FAIL ${String(n).padStart(2, '0')}.wav: ${
            err instanceof Error ? err.message.slice(0, 200) : String(err)
          }`,
        );
      }
    }
  }

  // --- Tavsiya -------------------------------------------------------------
  console.log('\n--- harness/.env uchun tavsiya ---');

  const bestTts = [...ttsRows]
    .filter((r) => r.probe === 'xotirjam')
    .sort((a, b) => (a.firstByteMs ?? a.latencyMs) - (b.firstByteMs ?? b.latencyMs))[0];
  const bestStt = sttRows.length > 0
    ? [...sttRows].sort((a, b) => (a.wer ?? 1) - (b.wer ?? 1))[0]
    : undefined;

  console.log(`  OPENAI_STT_MODEL=${bestStt?.model ?? sttModels[0] ?? '<model topilmadi>'}`);
  console.log(`  OPENAI_TTS_MODEL=${bestTts?.model ?? ttsModels[0] ?? '<model topilmadi>'}`);
  console.log(`  OPENAI_TTS_VOICE=${bestTts?.voice ?? voices[0] ?? ''}`);
  console.log(`  OPENAI_TTS_FORMAT=${envStr('OPENAI_TTS_FORMAT') ?? 'mp3'}`);
  console.log('  VOICE_MAX_MINUTES_PER_SESSION=10');
  console.log('  OPENAI_STT_PRICE_PER_MIN=        # narx sahifasidan to\'ldiring');
  console.log('  OPENAI_TTS_PRICE_PER_1M_CHARS=   # narx sahifasidan to\'ldiring');

  if (ttsRows.some((r) => !r.instructionsAccepted)) {
    console.log(
      '\n  Eslatma: ba\'zi modellar ohang ko\'rsatmasini (`instructions`) qabul ' +
        'qilmadi. Ovozli navbat ishlaydi, lekin ohang faqat MATN orqali ' +
        'ifodalanadi (jahl/xotirjamlik eshitilmaydi).',
    );
  }
  if (bestStt && bestStt.wer !== null && bestStt.wer > 0.25) {
    console.log(
      `\n  DIQQAT: eng yaxshi WER ${(bestStt.wer * 100).toFixed(1)}% — o'zbekcha uchun ` +
        'bu yuqori. Ovozli mashqda tanib olish xatolari ko\'p bo\'ladi; matnli rejimni ' +
        'zaxira sifatida qoldiring.',
    );
  }

  console.log(`\n  Audio tinglash uchun: ${ttsOutDir}\n`);
}

main().catch((err: unknown) => {
  console.error(`\n[diag:voice] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
