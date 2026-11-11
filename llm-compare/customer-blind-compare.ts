/**
 * MUSTAQIL ko'r (blind) taqqoslash: ikki LLM o'zbek mijoz rolida.
 * Loyihaning qolgan qismiga tegmaydi.
 *
 * Modellar:
 *  - "Luna": loyiha konfiguratsiyasi bilan bir xil — TRAINER_BASE_URL (/chat/completions),
 *    TRAINER_MODEL, kalit TRAINER_API_KEY_ENV dagi env nomidan, reasoning_effort =
 *    TRAINER_REASONING_EFFORT, max_completion_tokens (api.openai.com).
 *  - "Gemini": gemini-3.8-flash, Interactions API (POST /v1beta/interactions),
 *    stateless (store:false), system_instruction, generation_config.thinking_level = "low"
 *    (hujjat: bu modelda faqat low|medium|high; o'chirib bo'lmaydi; default medium).
 *
 * Ishga tushirish (loyiha ildizidan). Luna kaliti SHAXSIY — ikkinchi --env-file:
 *   node --env-file=harness/.env --env-file=$HOME/.config/sales-copilot-personal.env \
 *     --import tsx llm-compare/customer-blind-compare.ts
 * Shaxsiy fayl berilmasa — birinchi so'rovdan OLDIN aniq xabar bilan to'xtaydi.
 *
 * Kalitlar FAQAT header'da; hech qachon chop etilmaydi.
 */
import { randomInt } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RUNS = 2;
const OUT_DIR = resolve(process.cwd(), 'llm_compare_output');
const MAX_OUT = 400;
const TIMEOUT_MS = 60_000;
/** Bepul tarif uchun Gemini so'rovlari orasidagi pauza (o'lchovga kirmaydi). */
const GEMINI_GAP_MS = Number(process.env.COMPARE_GEMINI_GAP_MS ?? 13_000);
const LUNA_GAP_MS = 1_000;

// Narxlar ($ / 1M token), rasmiy sahifalardan 2026-11-10:
//  gemini-3.8-flash (Standard): input $0.75, output (thinking bilan) $3.75 (2026-12-31 gacha)
//  gpt-6-luna (Standard, <=272K): input $0.10, cached $0.01, output $0.50
const PRICES = {
  gemini: { input: 0.75, cached: 0.75, output: 3.75 },
  luna: { input: 0.1, cached: 0.01, output: 0.5 },
} as const;

const SYSTEM_PROMPT =
  'You are a 40-year-old Uzbek father from Sirdaryo region, speaking natural colloquial Uzbek (Latin script). You want your 15-year-old son to take an AI course, you know AI is needed, but the price (900,000 UZS/month, 2 months) feels a bit high; you like that it is only 2 months. Be skeptical, a little picky, and show emotion. Ask concrete questions (what exactly will he learn, what result at the end). If the seller dodges your question, notice it and press again. Keep replies to 1-3 short spoken sentences. Never break character.';

const SELLER_LINES = [
  "Assalomu alaykum, men IT Live akademiyasidan Maktuba bo'laman. Sizga gaplashish qulaymi?",
  "O'g'lingiz necha yoshda, avval IT bilan shug'ullanganmi?",
  "Bizda AI kursi bor, oyiga 900 ming so'm, ikki oy davom etadi.",
  "Bizda amaliyot ko'p, oxirida o'quvchi o'z loyihasini yaratadi.",
  "Bizning o'qituvchilarimiz juda tajribali.",
  "Bugun ro'yxatdan o'tsangiz o'n foiz chegirma beramiz.",
];

type ModelKey = 'luna' | 'gemini';

class CallError extends Error {
  constructor(
    message: string,
    readonly fatal = false,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Kalitlar (faqat nomi bo'yicha) va yashirish
// ---------------------------------------------------------------------------
function envKey(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    const personal = name !== 'GEMINI_API_KEY';
    throw new CallError(
      personal
        ? `${name} env'da yo'q. Bu SHAXSIY kalit — harness/.env da saqlanmaydi. Ikkinchi --env-file bilan bering:\n` +
            '  node --env-file=harness/.env --env-file=$HOME/.config/sales-copilot-personal.env --import tsx llm-compare/customer-blind-compare.ts'
        : `${name} env'da topilmadi (harness/.env).`,
      true,
    );
  }
  return v;
}
const lunaKeyName = (): string => process.env.TRAINER_API_KEY_ENV?.trim() || 'OPENAI_API_KEY';

function redact(text: string): string {
  let out = text;
  for (const name of [lunaKeyName(), 'GEMINI_API_KEY']) {
    const v = process.env[name]?.trim();
    if (v) out = out.split(v).join('***');
  }
  return out.replace(/(sk-[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{20,})/g, '***');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** HTTP so'rov; 429 da kutib qayta (2 martagacha), kunlik kvota — to'xtatadi. */
async function post(url: string, headers: Record<string, string>, body: unknown, who: string): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') throw new CallError(`${who}: vaqt tugadi (${TIMEOUT_MS / 1000} s).`);
      throw new CallError(redact(`${who}: tarmoq xatosi — ${err instanceof Error ? err.message : String(err)}`));
    }
    const text = await res.text().catch(() => '');
    clearTimeout(timer);
    if (res.ok) return JSON.parse(text) as unknown;

    let message = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: { message?: string } };
      message = j.error?.message ?? message;
    } catch {
      // JSON emas
    }
    message = redact(message);
    if (res.status === 429) {
      const perDay = /per day|daily|RPD/i.test(message);
      const m = /retry in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/i.exec(message);
      const waitS = m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3]) : 20;
      if (perDay || attempt >= 2 || waitS > 120) {
        throw new CallError(`${who}: LIMIT (429)${perDay ? ' — kunlik kvota tugadi' : ''}. ${message}`, true);
      }
      console.log(`    ${who}: 429 (rate limit) — ${Math.ceil(waitS + 1)} s kutib qayta urinilyapti`);
      await sleep((waitS + 1) * 1000);
      continue;
    }
    if ((res.status === 503 || res.status === 500 || res.status === 502) && attempt < 4) {
      const waitS = 10 * 2 ** attempt;
      console.log(`    ${who}: HTTP ${res.status} (vaqtinchalik) — ${waitS} s kutib qayta urinilyapti`);
      await sleep(waitS * 1000);
      continue;
    }
    const hint =
      res.status === 401 || res.status === 403
        ? "kalit noto'g'ri yoki ruxsat yo'q"
        : res.status === 404
          ? 'model topilmadi'
          : res.status === 400
            ? "so'rov rad etildi"
            : 'server xatosi';
    throw new CallError(`${who}: ${hint} (HTTP ${res.status}): ${message}`, res.status === 401 || res.status === 403 || res.status === 404);
  }
}

// ---------------------------------------------------------------------------
// Bitta javob: matn + o'lchovlar
// ---------------------------------------------------------------------------
interface Reply {
  text: string;
  latencyS: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  costUsd: number;
}

interface Conversation {
  model: ModelKey;
  replies: Reply[];
  error?: string;
}

// --- Luna (loyiha usuli: OpenAI-mos /chat/completions) ---------------------
async function lunaConversation(): Promise<Conversation> {
  const base = (process.env.TRAINER_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = process.env.TRAINER_MODEL?.trim() || 'gpt-6-luna';
  const effort = process.env.TRAINER_REASONING_EFFORT?.trim();
  const host = new URL(base).host;
  const maxParam =
    process.env.TRAINER_MAX_TOKENS_PARAM?.trim() || (host === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens');
  const key = envKey(lunaKeyName());
  const messages: Array<{ role: string; content: string }> = [{ role: 'system', content: SYSTEM_PROMPT }];
  const conv: Conversation = { model: 'luna', replies: [] };

  for (const line of SELLER_LINES) {
    messages.push({ role: 'user', content: line });
    const body: Record<string, unknown> = { model, messages, [maxParam]: MAX_OUT };
    if (effort) body.reasoning_effort = effort;
    const t0 = performance.now();
    try {
      const json = (await post(`${base}/chat/completions`, { authorization: `Bearer ${key}` }, body, 'Luna')) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
          completion_tokens_details?: { reasoning_tokens?: number };
        };
      };
      const latencyS = (performance.now() - t0) / 1000;
      const text = json.choices?.[0]?.message?.content?.trim() ?? '';
      const input = json.usage?.prompt_tokens ?? 0;
      const cached = json.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const output = json.usage?.completion_tokens ?? 0; // reasoning ichida
      const thought = json.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      const p = PRICES.luna;
      const costUsd = ((input - cached) * p.input + cached * p.cached + output * p.output) / 1e6;
      conv.replies.push({ text, latencyS, inputTokens: input, cachedTokens: cached, outputTokens: output - thought, thoughtTokens: thought, costUsd });
      messages.push({ role: 'assistant', content: text });
    } catch (err) {
      conv.error = err instanceof Error ? err.message : String(err);
      if (err instanceof CallError && err.fatal) throw err;
      break;
    }
    await sleep(LUNA_GAP_MS);
  }
  return conv;
}

// --- Gemini (Interactions API, stateless) ----------------------------------
let geminiRequests = 0;

async function geminiConversation(): Promise<Conversation> {
  const key = envKey('GEMINI_API_KEY');
  const input: unknown[] = [];
  const conv: Conversation = { model: 'gemini', replies: [] };

  for (const line of SELLER_LINES) {
    input.push({ type: 'user_input', content: [{ type: 'text', text: line }] });
    const body = {
      model: 'gemini-3.8-flash',
      store: false,
      system_instruction: SYSTEM_PROMPT,
      input,
      generation_config: { thinking_level: 'low', max_output_tokens: MAX_OUT },
    };
    if (geminiRequests > 0) await sleep(GEMINI_GAP_MS);
    geminiRequests += 1;
    const t0 = performance.now();
    try {
      const json = (await post(
        'https://generativelanguage.googleapis.com/v1beta/interactions',
        { 'x-goog-api-key': key },
        body,
        'Gemini',
      )) as {
        output_text?: string;
        steps?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
        usage?: {
          total_input_tokens?: number;
          total_cached_tokens?: number;
          total_output_tokens?: number;
          total_thought_tokens?: number;
        };
      };
      const latencyS = (performance.now() - t0) / 1000;
      const steps = json.steps ?? [];
      const text = (
        json.output_text ??
        steps
          .filter((s) => s.type === 'model_output')
          .flatMap((s) => s.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('')
      ).trim();
      const u = json.usage ?? {};
      const inputT = u.total_input_tokens ?? 0;
      const cached = u.total_cached_tokens ?? 0;
      const output = u.total_output_tokens ?? 0;
      const thought = u.total_thought_tokens ?? 0;
      const p = PRICES.gemini;
      // Hujjat: "response pricing is the sum of output tokens and thinking tokens".
      const costUsd = (inputT * p.input + (output + thought) * p.output) / 1e6;
      conv.replies.push({ text, latencyS, inputTokens: inputT, cachedTokens: cached, outputTokens: output, thoughtTokens: thought, costUsd });
      // Hujjat: modelning barcha qadamlari (thought ham) aynan qaytarib yuboriladi.
      if (steps.length > 0) input.push(...steps);
      else input.push({ type: 'model_output', content: [{ type: 'text', text }] });
    } catch (err) {
      conv.error = err instanceof Error ? err.message : String(err);
      if (err instanceof CallError && err.fatal) throw err;
      break;
    }
  }
  return conv;
}

// ---------------------------------------------------------------------------
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');

async function main(): Promise<void> {
  envKey(lunaKeyName());
  envKey('GEMINI_API_KEY');
  mkdirSync(OUT_DIR, { recursive: true });

  // Ko'rsatkichlar uchun ALOHIDA anonim nom (X/Y) — A/B bilan bog'liq emas.
  const statName: Record<ModelKey, 'X' | 'Y'> = randomInt(2) === 0 ? { luna: 'X', gemini: 'Y' } : { luna: 'Y', gemini: 'X' };
  const mapping: Record<string, unknown> = { metrics: statName, runs: [] as unknown[] };
  const results: string[] = [
    '# Ko\'r taqqoslash: mijoz roli (A / B)',
    '',
    'Har yugurishda A/B qaytadan tasodifiy belgilanadi. Kimligi `mapping_DO_NOT_OPEN.json` da (baholab bo\'lgach oching).',
    '',
    '**System prompt (ikkalasiga bir xil):**',
    '',
    `> ${SYSTEM_PROMPT}`,
    '',
  ];
  const all: Conversation[] = [];

  for (let run = 1; run <= RUNS; run += 1) {
    console.log(`\n=== Yugurish ${run}/${RUNS}`);
    const order: ModelKey[] = randomInt(2) === 0 ? ['luna', 'gemini'] : ['gemini', 'luna'];
    const convs: Partial<Record<ModelKey, Conversation>> = {};
    for (const m of order) {
      console.log(`  ${statName[m]} suhbati...`);
      convs[m] = m === 'luna' ? await lunaConversation() : await geminiConversation();
      const c = convs[m] as Conversation;
      console.log(`  ${statName[m]}: ${c.replies.length}/${SELLER_LINES.length} javob${c.error ? ` · XATO: ${c.error}` : ''}`);
      all.push(c);
    }
    const label: Record<'A' | 'B', ModelKey> = randomInt(2) === 0 ? { A: 'luna', B: 'gemini' } : { A: 'gemini', B: 'luna' };
    (mapping.runs as unknown[]).push({ run, ...label });

    const a = convs[label.A] as Conversation;
    const b = convs[label.B] as Conversation;
    results.push(`## Yugurish ${run}`, '', '| # | Sotuvchi | Mijoz A | Mijoz B |', '|---|---|---|---|');
    SELLER_LINES.forEach((line, i) => {
      const ra = a.replies[i]?.text ?? (a.error ? '(xato)' : '—');
      const rb = b.replies[i]?.text ?? (b.error ? '(xato)' : '—');
      results.push(`| ${i + 1}${i === 4 ? ' (savoldan qochish)' : ''} | ${cell(line)} | ${cell(ra)} | ${cell(rb)} |`);
    });
    // Xato matni modelni oshkor qilmasin — faylga faqat umumiy belgi.
    if (a.error || b.error) results.push('', `Diqqat: ${a.error ? 'A' : ''}${a.error && b.error ? ' va ' : ''}${b.error ? 'B' : ''} suhbati to'liq emas (texnik xato).`);
    results.push('', 'Baho (o\'zingiz to\'ldiring): A = __/10, B = __/10. 5-qatorda qochishni sezdimi? A: __ B: __', '');
  }

  // Ko'rsatkichlar (X/Y).
  const metrics: string[] = [
    '# Ko\'rsatkichlar (X / Y — A/B bilan bog\'liq emas)',
    '',
    '| model | javoblar | o\'rt. kechikish / javob (s) | kirish tok / suhbat | shundan kesh | chiqish tok / suhbat | fikrlash tok / suhbat | narx / suhbat ($) |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const m of (['luna', 'gemini'] as ModelKey[]).sort((p, q) => statName[p].localeCompare(statName[q]))) {
    const convs = all.filter((c) => c.model === m);
    const replies = convs.flatMap((c) => c.replies);
    const n = convs.length || 1;
    const sum = (f: (r: Reply) => number): number => replies.reduce((s, r) => s + f(r), 0);
    const avgLat = replies.length ? sum((r) => r.latencyS) / replies.length : NaN;
    metrics.push(
      `| ${statName[m]} | ${replies.length}/${convs.length * SELLER_LINES.length} | ${avgLat.toFixed(2)} | ` +
        `${Math.round(sum((r) => r.inputTokens) / n)} | ${Math.round(sum((r) => r.cachedTokens) / n)} | ` +
        `${Math.round(sum((r) => r.outputTokens) / n)} | ${Math.round(sum((r) => r.thoughtTokens) / n)} | ` +
        `${(sum((r) => r.costUsd) / n).toFixed(5)} |`,
    );
  }
  metrics.push(
    '',
    'Narxlar ($/1M): gemini-3.8-flash kirish 0.75, chiqish+fikrlash 3.75 (2026-12-31 gacha; 2027 dan 2x); gpt-6-luna kirish 0.10, kesh 0.01, chiqish 0.50.',
    'Gemini bepul tarifda haqiqatda pul olinmaydi — narx pullik tarif bo\'yicha taxmin.',
  );

  // Bir model umuman javob bermagan bo'lsa — ko'r baholash ma'nosiz (va qaysi ustun
  // bo'shligi kimligini oshkor qiladi): hech narsa yozilmaydi.
  const empty = (['luna', 'gemini'] as ModelKey[]).filter((m) => !all.some((c) => c.model === m && c.replies.length > 0));
  if (empty.length > 0) {
    console.error(
      `\nXATO: ${empty.length} ta model birorta ham javob bermadi (yuqoridagi xatolarga qarang). ` +
        "Natija fayllari YOZILMADI — keyinroq qayta ishga tushiring.",
    );
    process.exit(2);
  }
  writeFileSync(resolve(OUT_DIR, 'results.md'), results.join('\n'));
  writeFileSync(resolve(OUT_DIR, 'metrics.md'), metrics.join('\n'));
  writeFileSync(resolve(OUT_DIR, 'mapping_DO_NOT_OPEN.json'), JSON.stringify(mapping, null, 2));
  console.log(`\nSaqlandi:\n  ${resolve(OUT_DIR, 'results.md')}\n  ${resolve(OUT_DIR, 'metrics.md')}\n  ${resolve(OUT_DIR, 'mapping_DO_NOT_OPEN.json')} (OCHMANG)`);
  console.log(`\n${metrics.slice(2, 6).join('\n')}`);
}

main().catch((err: unknown) => {
  console.error(`XATO: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
