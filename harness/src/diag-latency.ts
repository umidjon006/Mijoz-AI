/**
 * FAQAT HARNESS. Ovozli navbat kechikishini BOSQICHLAB o'lchaydi (pullik):
 *
 *   npm run diag:latency            narx taxmini + tasdiq so'raydi
 *   npm run diag:latency -- --yes   tasdiqsiz
 *
 * 5 ta skriptlangan sotuvchi gapi uchun haqiqiy zanjir: STT -> mijoz LLM ->
 * oqimli TTS. Har bosqich uchun p50/p90, LLM tokenlari (keshdan olingan va
 * reasoning bilan) va "seziladigan" kechikish = STT + LLM + TTS birinchi bayt
 * (oqimli ijro aynan shu paytda boshlanadi).
 *
 * Sotuvchi audiosi: `harness/benchmark/samples/01..05.wav` bo'lsa — o'sha
 * (va matni etalondan); bo'lmasa sotuvchi gaplari TTS bilan WAV qilib
 * olinadi (o'lchovga kirmaydi). DB kerak emas. Kalit va audio chiqmaydi.
 */
// ENG BIRINCHI: harness/.env ni yuklaydi (yo'l harness papkasiga nisbatan).
import { envStr } from './env.js';

import { readFile } from 'node:fs/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { getArchetype } from '../../module/backend/src/training/archetypes.js';
import { generatePersonaCard } from '../../module/backend/src/training/persona.js';
import type { TokenUsage } from '../../module/backend/src/training/ports.js';
import {
  buildTurnSystemPrompt,
  buildTurnUserPrompt,
  PROMPT_VERSION,
  TURN_STATIC_PREFIX,
  type TranscriptTurn,
} from '../../module/backend/src/training/prompts.js';
import {
  applyTurnResult,
  coerceTurnResult,
  computeReadiness,
  initState,
  turnResultSchema,
  type TurnResult,
} from '../../module/backend/src/training/state.js';
import { normalizeForSpeech } from '../../module/backend/src/training/voice/speech-text.js';
import { toneInstruction } from '../../module/backend/src/training/voice/tone.js';
import { resolveBusinessData } from './business-data.js';
import {
  createTrainerLlm,
  MissingLlmKeyError,
  printMissingKeyBanner,
  resolveProviderConfig,
  startupLine,
} from './llm-factory.js';
import { readSentences, sampleExists, samplePath } from './voice/benchmark-data.js';
import { createOpenAiStt, createOpenAiTts, openAiVoiceConfigFromEnv } from './voice/openai.js';
import { median, percentile } from './voice/text-metrics.js';

const SELLER_LINES = [
  "Assalomu alaykum, o'quv markazidan qo'ng'iroq qilyapman, ikki daqiqa vaqtingiz bormi?",
  'Hozir qaysi yo\'nalish sizni qiziqtiryapti va bu sizga nima uchun kerak?',
  "Kursimiz olti oy davom etadi, haftada uch marta, oyiga bir million ikki yuz ming so'm.",
  "Tushunaman, narx muhim. Birinchi dars bepul, oyma-oy to'lash ham mumkin.",
  'Ertaga soat oltida sinov darsiga yozib qo\'yaymi?',
];

interface TurnTiming {
  sttMs: number | null;
  llmMs: number;
  ttsFirstByteMs: number;
  ttsTotalMs: number;
  usage?: TokenUsage;
  reply: string;
}

async function confirm(question: string): Promise<boolean> {
  if (!input.isTTY) return false;
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return ['ha', 'h', 'yes', 'y'].includes(answer);
  } finally {
    rl.close();
  }
}

function stats(label: string, values: readonly number[]): string {
  if (values.length === 0) return `  ${label.padEnd(26)} —`;
  return (
    `  ${label.padEnd(26)} p50 ${String(Math.round(median(values))).padStart(5)} ms` +
    `   p90 ${String(Math.round(percentile(values, 90))).padStart(5)} ms`
  );
}

async function main(): Promise<void> {
  const yes = process.argv.includes('--yes');
  const config = resolveProviderConfig();
  console.log(startupLine(config));

  const business = resolveBusinessData(envStr('HARNESS_PROFILE'));
  let resolved;
  try {
    resolved = createTrainerLlm({ profile: business.profile, config });
  } catch (err) {
    if (err instanceof MissingLlmKeyError) {
      printMissingKeyBanner('diag:latency', err.config);
      process.exit(1);
    }
    throw err;
  }
  if (resolved.isDemo) {
    console.error("DEMO_LLM=1 — kechikishni o'lchash ma'nosiz. DEMO_LLM ni o'chiring.");
    process.exit(1);
  }
  const voice = openAiVoiceConfigFromEnv();
  if (!voice) console.log("Ovoz sozlamasi yo'q (OPENAI_STT_MODEL/OPENAI_TTS_MODEL) — faqat LLM o'lchanadi.");

  // Sotuvchi audiosi: yozilgan namunalar bo'lsa — o'shalar.
  const references = await readSentences();
  const samples: Array<{ text: string; audio: Buffer | null }> = [];
  for (let i = 0; i < SELLER_LINES.length; i += 1) {
    const n = i + 1;
    if (voice && (await sampleExists(n))) {
      samples.push({ text: references[i]?.text ?? (SELLER_LINES[i] as string), audio: await readFile(samplePath(n)) });
    } else {
      samples.push({ text: SELLER_LINES[i] as string, audio: null });
    }
  }
  const needSynth = voice ? samples.filter((s) => !s.audio).length : 0;

  // --- Narx taxmini ---------------------------------------------------------
  const sttPrice = Number(envStr('OPENAI_STT_PRICE_PER_MIN') ?? NaN);
  const ttsPrice = Number(envStr('OPENAI_TTS_PRICE_PER_1M_CHARS') ?? NaN);
  const ttsChars = 5 * 90 + (needSynth > 0 ? SELLER_LINES.join(' ').length : 0);
  console.log(
    `\nTaxmin: LLM ${SELLER_LINES.length + 1} chaqiruv (persona + 5 navbat, ~${Math.round((TURN_STATIC_PREFIX.length + 2500) / 3.2)} kirish tokeni/navbat)` +
      (voice
        ? `; STT 5 chaqiruv (~0.3 daqiqa${Number.isFinite(sttPrice) ? ` ≈ $${(0.3 * sttPrice).toFixed(4)}` : ''})` +
          `; TTS ~${ttsChars} belgi${Number.isFinite(ttsPrice) ? ` ≈ $${((ttsChars / 1e6) * ttsPrice).toFixed(4)}` : ''}` +
          (needSynth > 0 ? ` (${needSynth} ta sotuvchi gapi TTS bilan yasaladi — namunasiz)` : '')
        : ''),
  );
  if (!yes && !(await confirm("Davom etilsinmi? (ha/yo'q) "))) {
    console.log("To'xtatildi — pullik chaqiruv qilinmadi. Tasdiqsiz: npm run diag:latency -- --yes");
    return;
  }

  const stt = voice ? createOpenAiStt(voice) : null;
  const tts = voice ? createOpenAiTts(voice) : null;
  const wavTts = voice ? createOpenAiTts({ ...voice, ttsFormat: 'wav' }) : null;

  // Namunasiz gaplar uchun sotuvchi audiosi (o'lchovga kirmaydi).
  if (wavTts) {
    for (const sample of samples) {
      if (!sample.audio) sample.audio = (await wavTts.synthesize({ text: sample.text, lang: 'uz' })).audio;
    }
  }

  // --- Persona (o'lchovga kirmaydi) ------------------------------------------
  const archetype = getArchetype('negotiator');
  console.log(`\nPersona yaratilmoqda (${PROMPT_VERSION})...`);
  const persona = await generatePersonaCard({
    llm: resolved.llm,
    profile: business.profile,
    archetype,
    direction: 'outbound',
    language: 'uz',
  });
  let state = initState(archetype, persona);
  const transcript: TranscriptTurn[] = [];
  const schema = { parse: (raw: unknown): TurnResult => turnResultSchema.parse(coerceTurnResult(raw)) };

  const timings: TurnTiming[] = [];
  for (const [i, sample] of samples.entries()) {
    // STT
    let sellerText = sample.text;
    let sttMs: number | null = null;
    if (stt && sample.audio) {
      const heard = await stt.transcribeShort({ audio: sample.audio, mime: 'audio/wav', lang: 'uz' });
      sttMs = heard.latencyMs;
      sellerText = heard.text || sample.text;
    }

    // LLM (motordagi bilan bir xil prompt)
    const readiness = computeReadiness(state, persona, archetype);
    const startedLlm = Date.now();
    const req = {
      stage: 'training.turn',
      system: buildTurnSystemPrompt({ persona, archetype, state, readiness }),
      user: buildTurnUserPrompt({ transcript, sellerText }),
      schema,
      outputSchema: turnResultSchema,
    };
    const out = resolved.llm.completeJsonWithUsage
      ? await resolved.llm.completeJsonWithUsage(req)
      : { value: await resolved.llm.completeJson(req), usage: undefined };
    const llmMs = Date.now() - startedLlm;
    state = applyTurnResult(state, out.value, persona, archetype);
    transcript.push({ speaker: 'seller', text: sellerText }, { speaker: 'customer', text: out.value.reply });

    // TTS (oqim): birinchi bayt va oxiri
    let ttsFirstByteMs = 0;
    let ttsTotalMs = 0;
    if (tts?.synthesizeStream) {
      const startedTts = Date.now();
      const stream = tts.synthesizeStream({
        text: normalizeForSpeech(out.value.reply, 'uz'),
        lang: 'uz',
        instructions: toneInstruction('calm'),
      });
      for await (const _chunk of stream.chunks) {
        if (ttsFirstByteMs === 0) ttsFirstByteMs = Date.now() - startedTts;
      }
      ttsTotalMs = Date.now() - startedTts;
    }

    timings.push({ sttMs, llmMs, ttsFirstByteMs, ttsTotalMs, ...(out.usage ? { usage: out.usage } : {}), reply: out.value.reply });
    const u = out.usage;
    console.log(
      `  ${i + 1}. STT ${sttMs ?? '-'} ms · LLM ${llmMs} ms` +
        (u ? ` (kirish ${u.inputTokens}, kesh ${u.cachedInputTokens ?? 0}, chiqish ${u.outputTokens}, reasoning ${u.reasoningTokens ?? 0})` : '') +
        ` · TTS 1-bayt ${ttsFirstByteMs || '-'} ms / jami ${ttsTotalMs || '-'} ms`,
    );
    console.log(`     sotuvchi: "${sellerText}"\n     mijoz:    "${out.value.reply}"`);
  }

  // --- Yig'ma -----------------------------------------------------------------
  const pick = (f: (t: TurnTiming) => number | null): number[] =>
    timings.map(f).filter((v): v is number => v !== null && v > 0);
  console.log('\nBosqichlar (5 navbat):');
  console.log(stats('STT', pick((t) => t.sttMs)));
  console.log(stats('LLM (mijoz)', pick((t) => t.llmMs)));
  console.log(stats('TTS birinchi bayt', pick((t) => t.ttsFirstByteMs)));
  console.log(stats('TTS to\'liq', pick((t) => t.ttsTotalMs)));
  console.log(
    stats(
      'Seziladigan (STT+LLM+1-bayt)',
      timings.map((t) => (t.sttMs ?? 0) + t.llmMs + t.ttsFirstByteMs),
    ),
  );
  console.log(
    stats(
      'Oqimsiz edi (STT+LLM+TTS)',
      timings.map((t) => (t.sttMs ?? 0) + t.llmMs + t.ttsTotalMs),
    ),
  );
  const usages = timings.map((t) => t.usage).filter((u): u is TokenUsage => u !== undefined);
  if (usages.length > 0) {
    const avg = (f: (u: TokenUsage) => number): number => Math.round(usages.reduce((s, u) => s + f(u), 0) / usages.length);
    console.log(
      `\nLLM o'rtacha: kirish ${avg((u) => u.inputTokens)} token, keshdan ${avg((u) => u.cachedInputTokens ?? 0)}, ` +
        `chiqish ${avg((u) => u.outputTokens)}, reasoning ${avg((u) => u.reasoningTokens ?? 0)}`,
    );
    if (avg((u) => u.reasoningTokens ?? 0) > 0) {
      console.log('Diqqat: mijoz bosqichida reasoning tokenlari bor — TRAINER_REASONING_EFFORT=none tavsiya etiladi.');
    }
  }
  console.log('Maqsad: seziladigan kechikish p50 <= 4000 ms, p90 <= 6000 ms.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
