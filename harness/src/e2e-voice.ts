/**
 * FAQAT HARNESS. Ovozli zanjir kechikishi: sotuvchi ovozi (haqiqiy 10 s klip)
 *   -> lokal STT (stt/serve.py, HTTP) -> Gemini miya (haqiqiy engine + DB)
 *   -> Gemini TTS (oqim, birinchi audio bo'lagi).
 *
 * "Sotuvchi gapi tugadi" = audio to'liq tayyor bo'lgan payt (STT so'rovi yuborilishi).
 * Har yugurish — yangi sessiya (persona yaratish o'lchovga KIRMAYDI).
 *
 *   npm run e2e:voice -- --clip ../stt/out/clips/clip_10s.wav --runs 5
 *   STT_LOCAL_URL=http://127.0.0.1:5191 npm run e2e:voice   # boshqa servis (masalan CPU)
 */
import { envStr } from './env.js';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getArchetype } from '../../module/backend/src/training/archetypes.js';
import { createTrainingEngine } from '../../module/backend/src/training/engine.js';
import type { GetBusinessProfile } from '../../module/backend/src/training/ports.js';
import type { VoiceLang } from '../../module/backend/src/training/voice/ports.js';
import { normalizeForSpeech } from '../../module/backend/src/training/voice/speech-text.js';
import { toneInstruction } from '../../module/backend/src/training/voice/tone.js';
import { speakerOf } from '../../module/backend/src/training/voice/voice-turn.js';
import type { LlmCallEvent } from './bakeoff/types.js';
import { resolveBusinessData } from './business-data.js';
import { DEMO_CONTEXT, ensureDemoRows } from './demo-env.js';
import { harnessRoot } from './env.js';
import { createTrainerLlm, describeLlm } from './llm-factory.js';
import { priceCall } from './pricing.js';
import type { GeminiTtsEvent } from './voice/gemini-tts.js';
import { checkLocalStt, type LocalSttResponse } from './voice/local-stt.js';
import { resolveStt } from './voice/stt-select.js';
import { resolveTts } from './voice/tts-select.js';
import { appDatabaseUrl, createPool, createWithTenant } from './withTenant.js';

const TTS_GAP_MS = Number(process.env.E2E_TTS_GAP_MS ?? 6_500);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Row {
  run: number;
  sttMs: number;
  sttServiceMs: number;
  llmMs: number;
  ttsFirstChunkMs: number;
  totalMs: number;
  sellerText: string;
  reply: string;
  llmCost: number;
  ttsCost: number;
  error?: string;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const val = (n: string): string | undefined => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const clip = resolve(val('--clip') ?? resolve(harnessRoot, '..', 'stt', 'out', 'clips', 'clip_10s.wav'));
  const runs = Number(val('--runs') ?? 5);
  const audio = readFileSync(clip);

  const sttChoice = resolveStt();
  if (!sttChoice.ok) throw new Error(`STT: ${sttChoice.reason}`);
  const stt = sttChoice.value;
  if (stt.url) {
    const h = await checkLocalStt(stt.url); // ishlamasa — aniq xato + buyruq
    console.log(`STT: ${stt.describe} · qurilma=${h.device}`);
  }
  const ttsEvents: GeminiTtsEvent[] = [];
  const ttsChoice = resolveTts({ onSynth: (e) => ttsEvents.push(e) });
  if (!ttsChoice.ok) throw new Error(`TTS: ${ttsChoice.reason}`);
  const tts = ttsChoice.value;
  if (!tts.tts.synthesizeStream) throw new Error("TTS oqimni qo'llamaydi");

  const business = resolveBusinessData(envStr('HARNESS_PROFILE'));
  const profile = business.profile;
  const events: LlmCallEvent[] = [];
  const resolved = createTrainerLlm({ profile, onCall: (e) => events.push(e) });
  console.log(`LLM: ${describeLlm(resolved)} · TTS: ${tts.describe}\nKlip: ${clip}`);

  await ensureDemoRows();
  const pool = createPool(appDatabaseUrl());
  const withTenant = createWithTenant(pool);
  const getBusinessProfile: GetBusinessProfile = async () => profile;
  const engine = createTrainingEngine({ withTenant, getBusinessProfile, llm: resolved.llm, priceCall });

  const rows: Row[] = [];
  let lastTts = 0;
  try {
    for (let i = 1; i <= runs; i += 1) {
      const started = await engine.startSession(DEMO_CONTEXT, {
        archetypeKey: getArchetype('negotiator').key,
        direction: 'outbound',
      });
      const lang = started.persona.language as VoiceLang;
      const wait = lastTts + TTS_GAP_MS - Date.now();
      if (lastTts > 0 && wait > 0) await sleep(wait); // TTS limiti (o'lchovga KIRMAYDI)

      const row: Row = { run: i, sttMs: 0, sttServiceMs: 0, llmMs: 0, ttsFirstChunkMs: 0, totalMs: 0, sellerText: '', reply: '', llmCost: 0, ttsCost: 0 };
      try {
        const tEnd = Date.now(); // sotuvchi gapi tugadi
        const heard = await stt.stt.transcribeShort({ audio, mime: 'audio/wav', lang });
        const tStt = Date.now();
        row.sttMs = tStt - tEnd;
        row.sttServiceMs = (heard.raw as LocalSttResponse | undefined)?.stt_ms ?? row.sttMs;
        row.sellerText = heard.text;

        const evStart = events.length;
        const turn = await engine.takeTurn(DEMO_CONTEXT, { sessionId: started.sessionId, sellerText: heard.text });
        const tLlm = Date.now();
        row.llmMs = tLlm - tStt;
        row.reply = turn.customerReply;
        row.llmCost = events.slice(evStart).reduce((s, e) => s + (e.usage ? priceCall(e.usage) : 0), 0);

        lastTts = Date.now();
        const ttsBefore = ttsEvents.length;
        let first = 0;
        for await (const _chunk of tts.tts.synthesizeStream({
          text: normalizeForSpeech(turn.customerReply, lang),
          lang,
          tone: turn.meta.tone,
          instructions: toneInstruction(turn.meta.tone),
          speaker: speakerOf(started.persona),
        }).chunks) {
          if (!first) first = Date.now();
        }
        row.ttsFirstChunkMs = first - tLlm;
        row.totalMs = first - tEnd;
        row.ttsCost = ttsEvents[ttsBefore]?.costUsd ?? 0;
      } catch (err) {
        row.error = err instanceof Error ? err.message : String(err);
      }
      rows.push(row);
      console.log(
        `#${i}: STT ${row.sttMs} ms (servis ${row.sttServiceMs}) · LLM ${row.llmMs} ms · TTS 1-bo'lak ${row.ttsFirstChunkMs} ms · JAMI ${row.totalMs} ms` +
          (row.error ? ` · XATO: ${row.error}` : `\n    S: ${row.sellerText}\n    M: ${row.reply}`),
      );
    }
  } finally {
    await pool.end();
  }

  const ok = rows.filter((r) => !r.error);
  const stat = (f: (r: Row) => number): string =>
    ok.length ? `${median(ok.map(f))} / ${Math.max(...ok.map(f))}` : '—';
  console.log(`\n| Bosqich | median / eng yomon (ms) |\n|---|---|`);
  console.log(`| STT (HTTP, jami) | ${stat((r) => r.sttMs)} |`);
  console.log(`| STT (servis ichida) | ${stat((r) => r.sttServiceMs)} |`);
  console.log(`| Gemini miya (takeTurn) | ${stat((r) => r.llmMs)} |`);
  console.log(`| Gemini TTS birinchi bo'lak | ${stat((r) => r.ttsFirstChunkMs)} |`);
  console.log(`| JAMI: gap tugashidan 1-audio bo'lakgacha | ${stat((r) => r.totalMs)} |`);
  console.log(`Muvaffaqiyatli: ${ok.length}/${rows.length}; o'rtacha narx/navbat: $${ok.length ? (ok.reduce((s, r) => s + r.llmCost + r.ttsCost, 0) / ok.length).toFixed(6) : '—'} (STT lokal — $0)`);
}

main().catch((err: unknown) => {
  console.error(`XATO: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
