/**
 * FAQAT HARNESS. End-to-end sinov: HAQIQIY harness prompti (persona + engine +
 * holat mashinasi + DB), Gemini "miya" va Gemini TTS.
 *
 * Har sessiyada 6 ta sotuvchi gapi -> mijoz javobi (matn) -> javobning TTS
 * oqimi. O'lchanadi: sotuvchi gapidan BIRINCHI AUDIO BO'LAGIGACHA vaqt,
 * LLM kechikishi, kirish/chiqish/thinking tokenlari, narx, JSON xatolari.
 * WAV fayllar: <repo>/tts_test_output/e2e_gemini/ (git'ga kirmaydi).
 *
 * Ishga tushirish (harness papkasidan; DB ishlab turishi kerak):
 *   npm run e2e:gemini                     # 2 sessiya × 6 navbat, TTS bilan
 *   npm run e2e:gemini -- --sessions 1 --no-tts
 */
import './env.js';

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getArchetype, type ArchetypeKey } from '../../module/backend/src/training/archetypes.js';
import { createTrainingEngine } from '../../module/backend/src/training/engine.js';
import { describeLlmError } from '../../module/backend/src/training/errors.js';
import type { GetBusinessProfile } from '../../module/backend/src/training/ports.js';
import type { VoiceLang } from '../../module/backend/src/training/voice/ports.js';
import { normalizeForSpeech } from '../../module/backend/src/training/voice/speech-text.js';
import { toneInstruction } from '../../module/backend/src/training/voice/tone.js';
import { speakerOf } from '../../module/backend/src/training/voice/voice-turn.js';
import { wavHeader } from '../../module/backend/src/training/voice/wav.js';
import type { LlmCallEvent } from './bakeoff/types.js';
import { describeBusinessData, resolveBusinessData } from './business-data.js';
import { DEMO_CONTEXT, ensureDemoRows } from './demo-env.js';
import { envStr, harnessRoot } from './env.js';
import {
  createTrainerLlm,
  describeLlm,
  MissingLlmKeyError,
  printMissingKeyBanner,
  resolveProviderConfig,
  startupLine,
} from './llm-factory.js';
import { priceCall } from './pricing.js';
import type { GeminiTtsEvent } from './voice/gemini-tts.js';
import { resolveTts } from './voice/tts-select.js';
import { appDatabaseUrl, createPool, createWithTenant } from './withTenant.js';

const OUT_DIR = resolve(harnessRoot, '..', 'tts_test_output', 'e2e_gemini');
/**
 * TTS so'rovlari orasidagi pauza (o'lchovga KIRMAYDI): Tier 1 da
 * gemini-3.8-flash-tts daqiqasiga 10 so'rov. 0 — pauzasiz.
 */
const TTS_GAP_MS = Number(process.env.E2E_TTS_GAP_MS ?? 6_500);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let lastTtsAt = 0;
async function ttsPace(): Promise<void> {
  const wait = lastTtsAt + TTS_GAP_MS - Date.now();
  if (lastTtsAt > 0 && wait > 0) await sleep(wait);
}

/** Sotuvchi gaplari (o'quv markazi profili uchun; boshqa profilda ham ma'noli). */
const SELLER_LINES = [
  "Assalomu alaykum! IT Live o'quv markazidan qo'ng'iroq qilyapman. Bir daqiqa gaplashsak bo'ladimi?",
  "Siz yoki farzandingiz dasturlashni o'rganishga qiziqasizmi? Qaysi yo'nalish sizga yaqinroq?",
  "Bizda Foundation kursi bor — noldan boshlaydiganlar uchun, mashg'ulotlar amaliy va mentor bilan.",
  "Narxi 690 000 so'm. Bu sizga qanday ko'rinadi?",
  "Tushunaman. Aytingchi, sizni eng ko'p nima o'ylantiryapti — vaqtmi yoki pulmi?",
  "Keling, sizni ro'yxatga yozib qo'yay — qaysi kun sizga qulay?",
];

interface Args {
  sessions: number;
  tts: boolean;
  archetypes: ArchetypeKey[];
}

function parseArgs(argv: readonly string[]): Args {
  const val = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const sessions = Number(val('--sessions') ?? 2);
  return {
    sessions: Number.isInteger(sessions) && sessions > 0 ? sessions : 2,
    tts: !argv.includes('--no-tts'),
    archetypes: ((val('--archetypes') ?? 'negotiator,info_seeker').split(',') as ArchetypeKey[]),
  };
}

interface TurnRow {
  session: number;
  turn: number;
  seller: string;
  reply: string;
  ok: boolean;
  error?: string;
  ttsError?: string;
  llmMs: number;
  providers: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  llmCost: number;
  ttsFirstChunkMs: number | null;
  sellerToFirstAudioMs: number | null;
  ttsTotalMs: number | null;
  ttsInputTokens: number | null;
  ttsAudioTokens: number | null;
  ttsAudioSec: number | null;
  ttsCost: number;
  ttsVoice?: string;
  ttsProfile?: string;
  wav?: string;
}

const fmt = (n: number | null | undefined, d = 0): string => (n === null || n === undefined ? '—' : n.toFixed(d));
const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const business = resolveBusinessData(envStr('HARNESS_PROFILE'));
  const profile = business.profile;
  const config = resolveProviderConfig();
  console.log(startupLine(config));
  console.log(describeBusinessData(business));

  const events: LlmCallEvent[] = [];
  let resolved;
  try {
    resolved = createTrainerLlm({ profile, config, onCall: (e) => events.push(e) });
  } catch (err) {
    if (err instanceof MissingLlmKeyError) {
      printMissingKeyBanner('e2e-gemini', err.config);
      process.exit(1);
    }
    throw err;
  }
  console.log(`LLM: ${describeLlm(resolved)}`);

  const ttsEvents: GeminiTtsEvent[] = [];
  const ttsChoice = args.tts ? resolveTts({ onSynth: (e) => ttsEvents.push(e) }) : null;
  if (ttsChoice && !ttsChoice.ok) {
    console.error(`TTS yo'q: ${ttsChoice.reason}`);
    process.exit(1);
  }
  const tts = ttsChoice?.ok ? ttsChoice.value : null;
  if (tts) console.log(`TTS: ${tts.describe}`);
  mkdirSync(OUT_DIR, { recursive: true });

  await ensureDemoRows();
  const pool = createPool(appDatabaseUrl());
  const withTenant = createWithTenant(pool);
  const getBusinessProfile: GetBusinessProfile = async () => profile;
  const engine = createTrainingEngine({ withTenant, getBusinessProfile, llm: resolved.llm, priceCall });

  const rows: TurnRow[] = [];
  let networkRetries = 0;
  let personaCalls = 0;
  try {
    for (let s = 1; s <= args.sessions; s += 1) {
      const archetype = getArchetype(args.archetypes[(s - 1) % args.archetypes.length] ?? 'negotiator');
      const before = events.length;
      const started = await engine.startSession(DEMO_CONTEXT, { archetypeKey: archetype.key, direction: 'outbound' });
      personaCalls += events.length - before;
      const persona = started.persona;
      const speaker = speakerOf(persona);
      const lang = persona.language as VoiceLang;
      console.log(
        `\n=== Sessiya ${s}: ${archetype.key} · ${persona.name}, ${persona.age} yosh, ` +
          `gender=${persona.gender ?? "(yo'q)"} · ${persona.role}`,
      );

      for (let t = 1; t <= SELLER_LINES.length; t += 1) {
        const seller = SELLER_LINES[t - 1] as string;
        let evStart = events.length;
        if (tts) await ttsPace(); // pauza seller->audio o'lchovidan OLDIN
        let t0 = Date.now();
        const row: TurnRow = {
          session: s, turn: t, seller, reply: '', ok: false, llmMs: 0, providers: '', calls: 0,
          inputTokens: 0, outputTokens: 0, thinkingTokens: 0, llmCost: 0,
          ttsFirstChunkMs: null, sellerToFirstAudioMs: null, ttsTotalMs: null,
          ttsInputTokens: null, ttsAudioTokens: null, ttsAudioSec: null, ttsCost: 0,
        };
        try {
          // Lokal tarmoq (DNS) uzilsa — 15 s kutib AYNAN shu gap qayta yuboriladi.
          // Bu urinishlar alohida sanaladi va kechikish o'lchoviga kirmaydi.
          let turn;
          for (let attempt = 1; ; attempt += 1) {
            try {
              turn = await engine.takeTurn(DEMO_CONTEXT, { sessionId: started.sessionId, sellerText: seller });
              break;
            } catch (err) {
              const msg = describeLlmError(err);
              if (attempt >= 3 || !/tarmoq xatosi|EAI_AGAIN|ENOTFOUND|ECONNRESET/.test(msg)) throw err;
              networkRetries += 1;
              console.log(`  [${t}] tarmoq uzildi — 15 s kutib shu gap qayta yuboriladi (${attempt}/2)`);
              await sleep(15_000);
              evStart = events.length;
              t0 = Date.now();
            }
          }
          row.llmMs = Date.now() - t0;
          row.reply = turn.customerReply;
          row.ok = true;
          const turnEvents = events.slice(evStart);
          row.calls = turnEvents.length;
          row.providers = [...new Set(turnEvents.filter((e) => e.ok).map((e) => e.provider ?? '?'))].join('+');
          for (const e of turnEvents) {
            if (!e.usage) continue;
            row.inputTokens += e.usage.inputTokens;
            row.outputTokens += e.usage.outputTokens - (e.usage.reasoningTokens ?? 0);
            row.thinkingTokens += e.usage.reasoningTokens ?? 0;
            row.llmCost += priceCall(e.usage);
          }
          console.log(`  [${t}] sotuvchi: ${seller}`);
          console.log(`      mijoz (${turn.meta.tone}): ${turn.customerReply}`);

          if (tts && turn.customerReply.trim()) {
            const ttsBefore = ttsEvents.length;
            lastTtsAt = Date.now();
            const stream = tts.tts.synthesizeStream?.({
              text: normalizeForSpeech(turn.customerReply, lang),
              lang,
              tone: turn.meta.tone,
              instructions: toneInstruction(turn.meta.tone),
              speaker,
            });
            if (!stream) throw new Error("TTS oqimni qo'llamaydi");
            const parts: Buffer[] = [];
            try {
              for await (const chunk of stream.chunks) {
                if (row.sellerToFirstAudioMs === null) row.sellerToFirstAudioMs = Date.now() - t0;
                parts.push(Buffer.from(chunk));
              }
            } catch (err) {
              row.ttsError = describeLlmError(err);
              console.log(`      TTS XATO: ${row.ttsError}`);
            }
            const ev = ttsEvents[ttsBefore];
            if (ev) {
              row.ttsFirstChunkMs = ev.firstChunkMs;
              row.ttsTotalMs = ev.totalMs;
              row.ttsInputTokens = ev.inputTokens;
              row.ttsAudioTokens = ev.audioTokens;
              row.ttsAudioSec = ev.audioSec;
              row.ttsCost = ev.costUsd;
              row.ttsVoice = ev.voice;
              row.ttsProfile = ev.profile;
            }
            // Oqim sarlavhasi (uzunligi noma'lum) aniq uzunlikdagi sarlavhaga almashtiriladi.
            const all = Buffer.concat(parts);
            if (all.length > 44) {
            const pcm = all.subarray(0, 4).toString('ascii') === 'RIFF' ? all.subarray(44) : all;
            const sampleRate = all.subarray(0, 4).toString('ascii') === 'RIFF' ? all.readUInt32LE(24) : 24_000;
            const file = resolve(OUT_DIR, `s${s}-t${t}.wav`);
            writeFileSync(file, Buffer.concat([wavHeader(pcm.length, { sampleRate, channels: 1, bitsPerSample: 16 }), pcm]));
            row.wav = file;
            }
          }
          rows.push(row);
          if (turn.ended) {
            console.log(`  (suhbat tugadi: ${turn.outcome ?? ''} ${turn.endReason ?? ''})`);
            break;
          }
        } catch (err) {
          row.llmMs = row.llmMs || Date.now() - t0;
          row.error = describeLlmError(err);
          rows.push(row);
          console.log(`  [${t}] XATO: ${row.error}`);
          break;
        }
      }
    }
    // --- Ovoz profili tekshiruvi: ayol persona (ona) — uslub to'g'ri maydonga ketadi ---
    if (tts?.tts.synthesizeStream) {
      await ttsPace();
      lastTtsAt = Date.now();
      const text = "Ha, eshityapman... Lekin men eri bilan maslahatlashmay, bunaqa pulni to'lay olmayman.";
      const parts: Buffer[] = [];
      try {
        for await (const c of tts.tts.synthesizeStream({
          text,
          lang: 'uz',
          tone: 'hesitant',
          instructions: toneInstruction('hesitant'),
          speaker: { gender: 'female', age: 38, role: "ikki farzandning onasi", speakingStyle: 'yumshoq, ehtiyotkor' },
        }).chunks) parts.push(Buffer.from(c));
        const all = Buffer.concat(parts);
        const file = resolve(OUT_DIR, 'voice-check-female.wav');
        writeFileSync(file, Buffer.concat([wavHeader(all.length - 44, { sampleRate: all.readUInt32LE(24), channels: 1, bitsPerSample: 16 }), all.subarray(44)]));
        const ev = ttsEvents.at(-1);
        console.log(`\nOvoz tekshiruvi (ayol, 38): voice=${ev?.voice} profile=${ev?.profile} -> ${file}`);
      } catch (err) {
        console.log(`\nOvoz tekshiruvi XATO: ${describeLlmError(err)}`);
      }
    }
  } finally {
    await pool.end();
  }

  // --- Hisobot ----------------------------------------------------------
  const okRows = rows.filter((r) => r.ok);
  const turnEvents = events.filter((e) => e.stage === 'training.turn');
  const jsonFails = (es: LlmCallEvent[]): number =>
    es.filter((e) => e.outcome === 'invalid_json' || e.outcome === 'schema').length;
  const httpSeen = [
    ...events
      .filter((e) => !e.ok && e.outcome && /^http_|timeout|unknown/.test(e.outcome))
      .map((e) => `llm/${e.provider}:${e.outcome}`),
    ...ttsEvents.filter((e) => !e.ok).map((e) => `tts:${(e.error ?? '').slice(0, 60)}`),
  ];

  const lines: string[] = [];
  lines.push('| # | LLM ms | seller→1-audio ms | TTS 1-bo\'lak ms | kirish tok | chiqish tok | thinking tok | LLM $ | TTS in/audio tok | audio s | TTS $ | provayder | ovoz |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    lines.push(
      `| s${r.session}t${r.turn}${r.ok ? '' : ' XATO'}${r.ttsError ? ' TTS-XATO' : ''} | ${r.llmMs} | ${fmt(r.sellerToFirstAudioMs)} | ${fmt(r.ttsFirstChunkMs)} | ` +
        `${r.inputTokens} | ${r.outputTokens} | ${r.thinkingTokens} | ${r.llmCost.toFixed(6)} | ` +
        `${fmt(r.ttsInputTokens)}/${fmt(r.ttsAudioTokens)} | ${fmt(r.ttsAudioSec, 1)} | ${r.ttsCost.toFixed(6)} | ${r.providers || '—'} | ${r.ttsVoice ?? '—'} ${r.ttsProfile ? `(${r.ttsProfile})` : ''} |`,
    );
  }
  const s2a = okRows.map((r) => r.sellerToFirstAudioMs).filter((x): x is number => x !== null);
  const llmMs = okRows.map((r) => r.llmMs);
  const turnCost = okRows.map((r) => r.llmCost + r.ttsCost);
  const summary = [
    '',
    `Navbatlar: ${okRows.length} muvaffaqiyatli / ${rows.length}; persona chaqiruvlari: ${personaCalls}`,
    `LLM kechikishi (navbat): median ${fmt(median(llmMs))} ms, o'rtacha ${fmt(mean(llmMs))} ms`,
    `Sotuvchi gapidan birinchi audio bo'lagigacha: median ${fmt(median(s2a))} ms, o'rtacha ${fmt(mean(s2a))} ms, eng ko'p ${fmt(s2a.length ? Math.max(...s2a) : null)} ms`,
    `Bir navbat narxi (LLM+TTS): o'rtacha $${fmt(mean(turnCost), 6)}; jami $${fmt(turnCost.reduce((a, b) => a + b, 0), 6)}`,
    `JSON xatolari (training.turn): ${jsonFails(turnEvents)} / ${turnEvents.length} chaqiruv` +
      ` (${turnEvents.length ? ((jsonFails(turnEvents) / turnEvents.length) * 100).toFixed(1) : '0'}%); ` +
      `barcha bosqichlar: ${jsonFails(events)} / ${events.length}`,
    `HTTP/timeout xatolari: ${httpSeen.length ? httpSeen.join(', ') : "yo'q"}`,
    `TTS: ${ttsEvents.filter((e) => e.ok).length} muvaffaqiyatli / ${ttsEvents.length} (pauza ${TTS_GAP_MS} ms — o'lchovga kirmaydi)`,
    `Lokal tarmoq (DNS) uzilishi tufayli qayta yuborilgan navbatlar: ${networkRetries}`,
    `Zaxiraga o'tishlar: ${events.filter((e) => e.ok && e.provider === 'openai-compatible').length}`,
  ];
  const report = [...lines, ...summary].join('\n');
  console.log(`\n${report}`);
  const transcript = rows.map((r) => `s${r.session}t${r.turn}\n  S: ${r.seller}\n  M: ${r.reply || r.error}`).join('\n');
  writeFileSync(resolve(OUT_DIR, 'report.md'), `${report}\n\n## Suhbat\n\n${transcript}\n`);
  console.log(`\nHisobot: ${resolve(OUT_DIR, 'report.md')}`);
}

main().catch((err: unknown) => {
  console.error(`XATO: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
