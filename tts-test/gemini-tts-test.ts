/**
 * MUSTAQIL Gemini TTS sinovi (loyihaning qolgan qismiga tegmaydi).
 *
 * Rasmiy hujjat (2026-11-10 da o'qildi):
 *   https://aistudio.google.com/docs/speech-generation
 *   https://aistudio.google.com/api-reference/interactions-api
 *  - Endpoint: POST https://generativelanguage.googleapis.com/v1beta/interactions
 *  - Uslub: matn elementining `annotations: [{type:'speech_metadata', style}]` maydonida
 *    (matn o'zi so'zma-so'z o'qiladi).
 *  - Ovoz: `generation_config.speech_config: [{ voice }]`.
 *  - Oqim: `stream: true` -> SSE, `step.delta` (delta.type === 'audio', base64 PCM 24 kHz mono 16-bit).
 *  - Usage: `total_input_tokens`, `output_tokens_by_modality[{modality:'audio', tokens}]`.
 *
 * SDK o'rniga to'g'ridan-to'g'ri REST (`fetch`) — yangi paket o'rnatilmaydi.
 *
 * Ishga tushirish (loyiha ildizidan):
 *   node --env-file=harness/.env --import tsx tts-test/gemini-tts-test.ts
 *
 * Kalit FAQAT `x-goog-api-key` header'ida; hech qachon chop etilmaydi.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MODEL = 'gemini-3.8-flash-tts';
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const RUNS = 3;
const TIMEOUT_MS = 90_000;
/** Bepul tarif: daqiqasiga 3 so'rov — so'rovlar orasida pauza (o'lchovga kirmaydi). */
const GAP_MS = Number(process.env.TTS_GAP_MS ?? 21_000);
const PRICE_TEXT_IN_PER_M = 0.5;
const PRICE_AUDIO_OUT_PER_M = 9.0;
const OUT_DIR = resolve(process.cwd(), 'tts_test_output');

interface Case {
  id: string;
  voice: string;
  style: string;
  text: string;
}

const CASES: Case[] = [
  {
    id: 'a_cruz_ota',
    voice: 'Cruz',
    style:
      'A 40-year-old Uzbek father from Sirdaryo region. Natural colloquial Uzbek, no foreign accent. Practical and calm, hesitant about the price, slightly skeptical.',
    text: "To'qqiz yuz ming oyigami? Hmm... biroz qimmat-ku, uka. Boshqa joylarda arzonroq ekan.",
  },
  {
    id: 'b_fola_ona',
    voice: 'Fola',
    style: 'A worried 35-year-old Uzbek mother, soft but cautious, hesitant.',
    text: "Ha, eshityapman... Lekin men eri bilan maslahatlashmay, bunaqa pulni to'lay olmayman. O'g'lim hali kichkina, ikki oy yetarlimi o'zi?",
  },
];

// ---------------------------------------------------------------------------
// Xatolar: o'qiladigan xabar, kalitsiz.
// ---------------------------------------------------------------------------
class TtsError extends Error {}

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    throw new TtsError(
      "GEMINI_API_KEY topilmadi. Ishga tushirish: node --env-file=harness/.env --import tsx tts-test/gemini-tts-test.ts",
    );
  }
  return key;
}

function redact(text: string): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  let out = key ? text.split(key).join('***') : text;
  out = out.replace(/AIza[0-9A-Za-z_-]{20,}/g, '***');
  return out;
}

async function httpError(res: Response): Promise<TtsError> {
  const raw = await res.text().catch(() => '');
  let message = raw.slice(0, 400);
  let status = '';
  try {
    const body = JSON.parse(raw) as { error?: { message?: string; status?: string; code?: unknown } };
    message = body.error?.message ?? message;
    status = body.error?.status ?? String(body.error?.code ?? '');
  } catch {
    // JSON emas
  }
  const lower = `${status} ${message}`.toLowerCase();
  let hint: string;
  if (res.status === 429 || lower.includes('resource_exhausted') || lower.includes('quota')) {
    hint = "Limitga yetildi (rate limit / kvota). Biroz kutib qayta urinib ko'ring yoki kvotani tekshiring.";
  } else if (
    res.status === 401 ||
    res.status === 403 ||
    lower.includes('api key not valid') ||
    lower.includes('api_key_invalid') ||
    lower.includes('permission_denied')
  ) {
    hint = "API kalit noto'g'ri yoki bu model/API uchun ruxsat yo'q (GEMINI_API_KEY ni tekshiring).";
  } else if (res.status === 404 || lower.includes('not found') || lower.includes('not_found')) {
    hint = `Model yoki resurs topilmadi ("${MODEL}" nomini va API versiyasini tekshiring).`;
  } else if (res.status === 400) {
    hint = "So'rov rad etildi (400) — parametrlar yoki ovoz nomi noto'g'ri bo'lishi mumkin.";
  } else {
    hint = `Server xatosi (HTTP ${res.status}).`;
  }
  return new TtsError(redact(`${hint}\n   Server javobi: [${res.status}${status ? ` ${status}` : ''}] ${message}`));
}

async function call(path: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { 'x-goog-api-key': apiKey(), 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    if (!res.ok) throw await httpError(res);
    return res;
  } catch (err) {
    if (err instanceof TtsError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new TtsError(`Vaqt tugadi (${TIMEOUT_MS / 1000} s) — server javob bermadi.`);
    }
    throw new TtsError(redact(`Tarmoq xatosi: ${err instanceof Error ? err.message : String(err)}`));
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Ovoz nomini tekshirish: prebuilt ro'yxatida "Cruz"/"Fola" yo'q — Extended
// Voice Library (GET /v1beta/voices) dan qidiramiz.
// ---------------------------------------------------------------------------
interface VoiceInfo {
  id?: string;
  display_name?: string;
  language_code?: string;
  gender?: string;
  accent?: string;
}

async function listVoices(): Promise<VoiceInfo[]> {
  const all: VoiceInfo[] = [];
  let token = '';
  for (let page = 0; page < 20; page += 1) {
    const qs = new URLSearchParams({ page_size: '1000', ...(token ? { page_token: token } : {}) });
    const res = await call(`/voices?${qs.toString()}`, { method: 'GET' });
    const body = (await res.json()) as { voices?: VoiceInfo[]; next_page_token?: string; nextPageToken?: string };
    all.push(...(body.voices ?? []));
    token = body.next_page_token ?? body.nextPageToken ?? '';
    if (!token) break;
  }
  return all;
}

function findVoice(voices: VoiceInfo[], name: string): VoiceInfo | undefined {
  const n = name.toLowerCase();
  return (
    voices.find((v) => v.display_name?.toLowerCase() === n) ??
    voices.find((v) => v.id?.toLowerCase() === n) ??
    voices.find((v) => v.id?.toLowerCase().endsWith(`/${n}`))
  );
}

// ---------------------------------------------------------------------------
// TTS (oqim bilan): birinchi audio bo'lagigacha vaqt + umumiy vaqt + usage.
// ---------------------------------------------------------------------------
interface Usage {
  total_input_tokens?: number;
  total_output_tokens?: number;
  input_tokens_by_modality?: Array<{ modality: string; tokens: number }>;
  output_tokens_by_modality?: Array<{ modality: string; tokens: number }>;
}

interface RunResult {
  totalS: number;
  firstChunkS: number | null;
  inputTokens: number | null;
  audioTokens: number | null;
  costUsd: number | null;
  pcm: Buffer;
  sampleRate: number;
  wavHeader: boolean;
}

function wav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function synthesize(c: Case, voice: string): Promise<RunResult> {
  const body = {
    model: MODEL,
    input: [
      {
        type: 'user_input',
        content: [{ type: 'text', text: c.text, annotations: [{ type: 'speech_metadata', style: c.style }] }],
      },
    ],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice }] },
    stream: true,
    store: false,
  };

  const t0 = performance.now();
  const res = await call('/interactions', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { accept: 'text/event-stream' },
  });
  if (!res.body) throw new TtsError("Server bo'sh javob qaytardi.");

  const chunks: Buffer[] = [];
  let firstChunkS: number | null = null;
  let usage: Usage | null = null;
  let sampleRate = 24_000;
  let streamError: string | null = null;

  const handle = (event: Record<string, unknown>): void => {
    const type = event.event_type;
    if (type === 'step.delta') {
      const delta = event.delta as { type?: string; data?: string; sample_rate?: number } | undefined;
      if (delta?.type === 'audio' && delta.data) {
        if (firstChunkS === null) firstChunkS = (performance.now() - t0) / 1000;
        chunks.push(Buffer.from(delta.data, 'base64'));
        if (delta.sample_rate) sampleRate = delta.sample_rate;
      }
      const meta = event.metadata as { total_usage?: Usage } | undefined;
      if (meta?.total_usage) usage = meta.total_usage;
    } else if (type === 'step.stop' || type === 'interaction.status_update') {
      if (event.usage) usage = event.usage as Usage;
    } else if (type === 'interaction.completed') {
      const it = event.interaction as { usage?: Usage } | undefined;
      if (it?.usage) usage = it.usage;
    } else if (type === 'error') {
      const e = event.error as { code?: string; message?: string } | undefined;
      streamError = `${e?.code ?? 'error'}: ${e?.message ?? ''}`;
    }
  };

  // SSE: bo'sh qator bilan ajratilgan bloklar, har birida `data: {...}`.
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = (block: string): void => {
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    try {
      handle(JSON.parse(data) as Record<string, unknown>);
    } catch {
      // to'liq bo'lmagan / JSON emas — o'tkazib yuboriladi
    }
  };
  try {
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(part, { stream: true }).replace(/\r\n/g, '\n');
      let at: number;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        flush(buffer.slice(0, at));
        buffer = buffer.slice(at + 2);
      }
    }
  } catch (err) {
    throw new TtsError(
      redact(`Oqim yarim yo'lda uzildi (${err instanceof Error ? err.message : String(err)}) — tarmoq/proksi muammosi.`),
    );
  }
  if (buffer.trim()) flush(buffer);
  const totalS = (performance.now() - t0) / 1000;

  if (streamError) throw new TtsError(redact(`Oqimda xato: ${streamError}`));
  if (chunks.length === 0) throw new TtsError('Audio kelmadi (oqimda audio bo\'lagi yo\'q).');

  const u = usage as Usage | null;
  const inputTokens = u?.total_input_tokens ?? null;
  const audioTokens =
    u?.output_tokens_by_modality?.find((m) => m.modality.toLowerCase() === 'audio')?.tokens ??
    u?.total_output_tokens ??
    null;
  const costUsd =
    inputTokens !== null && audioTokens !== null
      ? (inputTokens / 1e6) * PRICE_TEXT_IN_PER_M + (audioTokens / 1e6) * PRICE_AUDIO_OUT_PER_M
      : null;

  const pcm = Buffer.concat(chunks);
  return {
    totalS,
    firstChunkS,
    inputTokens,
    audioTokens,
    costUsd,
    pcm,
    sampleRate,
    wavHeader: pcm.subarray(0, 4).toString('ascii') === 'RIFF',
  };
}

// ---------------------------------------------------------------------------
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const fmt = (v: number | null, d = 2): string => (v === null ? '—' : v.toFixed(d));
const avg = (xs: Array<number | null>): number | null => {
  const ok = xs.filter((x): x is number => x !== null);
  return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
};

async function main(): Promise<void> {
  apiKey();
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Model: ${MODEL} · har holat ${RUNS} marta · chiqish: ${OUT_DIR}\n`);

  let voices: VoiceInfo[] = [];
  try {
    voices = await listVoices();
    console.log(`Ovozlar katalogi: ${voices.length} ta ovoz topildi.`);
  } catch (err) {
    console.log(`Ovozlar katalogini olib bo'lmadi: ${err instanceof Error ? err.message : String(err)}`);
  }

  const summary: string[] = [];
  let requestCount = 0;
  // `--case b` — faqat id'si shu bilan boshlanadigan holat(lar).
  const only = process.argv.indexOf('--case') >= 0 ? process.argv[process.argv.indexOf('--case') + 1] : undefined;
  for (const c of CASES.filter((x) => !only || x.id.startsWith(only))) {
    const found = findVoice(voices, c.voice);
    const voiceParam = found?.id ?? c.voice;
    console.log(
      `\n=== ${c.id} · ovoz "${c.voice}" ${
        found
          ? `-> katalogda: id=${found.id} (${found.gender ?? '?'}, ${found.language_code ?? '?'}${found.accent ? `, ${found.accent}` : ''})`
          : "-> katalogda TOPILMADI, nom bilan yuborilyapti"
      }`,
    );
    const runs: RunResult[] = [];
    for (let i = 1; i <= RUNS; i += 1) {
      try {
        if (requestCount > 0 && GAP_MS > 0) await sleep(GAP_MS);
        requestCount += 1;
        let r: RunResult;
        try {
          r = await synthesize(c, voiceParam);
        } catch (err) {
          // 429 bo'lsa — bir marta kutib qayta (natijaga faqat muvaffaqiyatli urinish kiradi).
          if (!(err instanceof TtsError && err.message.includes('Limitga yetildi'))) throw err;
          console.log(`  #${i}: 429 — ${GAP_MS / 1000} s kutib qayta urinilyapti`);
          await sleep(GAP_MS);
          r = await synthesize(c, voiceParam);
        }
        runs.push(r);
        const seconds = (r.wavHeader ? r.pcm.length - 44 : r.pcm.length) / (r.sampleRate * 2);
        console.log(
          `  #${i}: umumiy ${fmt(r.totalS)} s · birinchi bo'lak ${fmt(r.firstChunkS)} s · ` +
            `kirish ${r.inputTokens ?? '—'} tok · audio ${r.audioTokens ?? '—'} tok · ` +
            `$${fmt(r.costUsd, 6)} · audio ${seconds.toFixed(1)} s`,
        );
      } catch (err) {
        console.log(`  #${i}: XATO — ${err instanceof Error ? err.message : String(err)}`);
        if (err instanceof TtsError && /kalit|Model yoki resurs/.test(err.message)) break;
      }
    }
    const last = runs.at(-1);
    if (last) {
      const file = resolve(OUT_DIR, `${c.id}.wav`);
      writeFileSync(file, last.wavHeader ? last.pcm : wav(last.pcm, last.sampleRate));
      console.log(`  saqlandi: ${file}`);
    }
    summary.push(
      `| ${c.id} | ${c.voice} | ${runs.length}/${RUNS} | ${fmt(avg(runs.map((r) => r.totalS)))} | ` +
        `${fmt(avg(runs.map((r) => r.firstChunkS)))} | ${fmt(avg(runs.map((r) => r.inputTokens)), 0)} | ` +
        `${fmt(avg(runs.map((r) => r.audioTokens)), 0)} | ${fmt(avg(runs.map((r) => r.costUsd)), 6)} |`,
    );
  }

  console.log('\n| holat | ovoz | muvaffaqiyatli | o\'rt. umumiy (s) | o\'rt. birinchi bo\'lak (s) | kirish tok | audio tok | o\'rt. narx ($) |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const line of summary) console.log(line);
}

main().catch((err: unknown) => {
  console.error(`XATO: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
