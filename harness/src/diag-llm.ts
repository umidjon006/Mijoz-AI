/**
 * FAQAT HARNESS. Sozlangan provayderga KICHIK HAQIQIY so'rovlar yuborib,
 * qaysi so'rov shakllari qo'llanishini o'lchaydi:
 *
 *   npm run diag:llm
 *   npm run diag:llm -- --scoring      (TRAINER_SCORING_MODEL ni sinash)
 *
 * Variantlar (har biri bitta qisqa chaqiruv, jami 7 ta):
 *   text            oddiy matn, response_format yo'q
 *   json_object     response_format: json_object
 *   schema/type[]   response_format: json_schema (strict), null — `type: [x, "null"]`
 *   schema/anyOf    response_format: json_schema (strict), null — `anyOf`
 *   effort=none     json_object + reasoning_effort: none
 *   effort=minimal  json_object + reasoning_effort: minimal
 *   effort=low      json_object + reasoning_effort: low
 *
 * Har biri uchun: HTTP status, kechikish, tokenlar (reasoning bo'lsa alohida),
 * javob o'qildimi, rad etilgan bo'lsa provayderning qisqa xabari.
 * Kalit HECH QACHON chiqmaydi (faqat env NOMI); provayder xabarlari ham tozalanadi.
 */
// ENG BIRINCHI: harness/.env ni yuklaydi (yo'l harness papkasiga nisbatan).
import { envInt } from './env.js';

import { z } from 'zod';

import { LlmCallError } from '../../module/backend/src/training/errors.js';
import {
  ProviderConfigError,
  resolveProviderConfig,
  startupLine,
} from './llm-factory.js';
import {
  buildChatBody,
  parseContentJson,
  postChatCompletion,
  type JsonMode,
} from './llm-openai-compatible.js';
import type { NullableStyle } from './zod-json-schema.js';

const diagSchema = z.object({
  name: z.string().min(1),
  age: z.number().int(),
  mood: z.enum(['calm', 'angry', 'curious']),
  note: z.string().nullable(),
  tags: z.array(z.string()),
});

const SYSTEM_JSON =
  'You are a test fixture. Invent a short customer: fields name (string), age (integer), ' +
  'mood (one of calm|angry|curious), note (string or null), tags (array of 1-2 short strings).';
const USER_JSON = 'Return the JSON now. Keep every string under 5 words.';

interface Variant {
  name: string;
  kind: 'text' | 'json';
  jsonMode: JsonMode;
  nullableStyle?: NullableStyle;
  reasoningEffort?: string;
}

const VARIANTS: Variant[] = [
  { name: 'text', kind: 'text', jsonMode: 'prompt' },
  { name: 'json_object', kind: 'json', jsonMode: 'object' },
  { name: 'schema/type[]', kind: 'json', jsonMode: 'schema', nullableStyle: 'type-array' },
  { name: 'schema/anyOf', kind: 'json', jsonMode: 'schema', nullableStyle: 'anyOf' },
  { name: 'effort=none', kind: 'json', jsonMode: 'object', reasoningEffort: 'none' },
  { name: 'effort=minimal', kind: 'json', jsonMode: 'object', reasoningEffort: 'minimal' },
  { name: 'effort=low', kind: 'json', jsonMode: 'object', reasoningEffort: 'low' },
];

interface Row {
  variant: string;
  status: string;
  latency: string;
  tokens: string;
  parsed: string;
  note: string;
}

async function runVariant(
  variant: Variant,
  ctx: { url: string; apiKey: string; model: string; timeoutMs: number },
): Promise<Row> {
  const body =
    variant.kind === 'text'
      ? {
          model: ctx.model,
          max_tokens: 256,
          messages: [
            { role: 'system', content: 'Reply in plain text.' },
            { role: 'user', content: "Say 'salom' and nothing else." },
          ],
          ...(variant.reasoningEffort ? { reasoning_effort: variant.reasoningEffort } : {}),
        }
      : buildChatBody(
          { system: SYSTEM_JSON, user: USER_JSON, outputSchema: diagSchema, stage: 'diag' },
          {
            model: ctx.model,
            maxTokens: 512,
            jsonMode: variant.jsonMode,
            ...(variant.reasoningEffort ? { reasoningEffort: variant.reasoningEffort } : {}),
            ...(variant.nullableStyle ? { nullableStyle: variant.nullableStyle } : {}),
          },
        );

  const startedAt = Date.now();
  try {
    const raw = await postChatCompletion({
      url: ctx.url,
      apiKey: ctx.apiKey,
      body,
      timeoutMs: ctx.timeoutMs,
    });
    const tokens =
      `${raw.usage.inputTokens}/${raw.usage.outputTokens}` +
      (raw.usage.reasoningTokens ? ` (r ${raw.usage.reasoningTokens})` : '');

    let parsed = 'ha';
    let note = raw.finishReason ? `finish=${raw.finishReason}` : '';
    if (variant.kind === 'text') {
      if (raw.content.trim().length === 0) parsed = "yo'q (bo'sh)";
      else note = `${note} "${raw.content.trim().slice(0, 30)}"`.trim();
    } else {
      try {
        const result = diagSchema.safeParse(parseContentJson(raw.content, raw.finishReason));
        if (!result.success) {
          parsed = "JSON ha, sxema yo'q";
          note = `${note} ${result.error.issues[0]?.path.join('.')}: ${result.error.issues[0]?.message}`.trim();
        }
      } catch (err) {
        parsed = "yo'q";
        note = `${note} ${err instanceof Error ? err.message : String(err)}`.trim();
      }
    }
    return {
      variant: variant.name,
      status: String(raw.status),
      latency: `${raw.latencyMs}`,
      tokens,
      parsed,
      note,
    };
  } catch (err) {
    const latency = `${Date.now() - startedAt}`;
    if (err instanceof LlmCallError) {
      return {
        variant: variant.name,
        status: err.status !== undefined ? String(err.status) : err.kind,
        latency,
        tokens: '-',
        parsed: '-',
        note: (err.providerMessage ?? err.message).slice(0, 120),
      };
    }
    throw err;
  }
}

function printTable(rows: Row[]): void {
  const headers: Row = {
    variant: 'variant',
    status: 'HTTP',
    latency: 'ms',
    tokens: 'tokens in/out',
    parsed: "o'qildi",
    note: 'izoh',
  };
  const keys = Object.keys(headers) as Array<keyof Row>;
  const widths = keys.map((k) =>
    k === 'note' ? 0 : Math.max(...[headers, ...rows].map((r) => [...r[k]].length)),
  );
  const line = (r: Row): string =>
    keys.map((k, i) => (k === 'note' ? r[k] : r[k].padEnd(widths[i] ?? 0))).join(' | ');
  console.log(line(headers));
  console.log(keys.map((k, i) => (k === 'note' ? '----' : '-'.repeat(widths[i] ?? 0))).join('-|-'));
  for (const row of rows) console.log(line(row));
}

async function main(): Promise<void> {
  const useScoring = process.argv.includes('--scoring');
  const config = resolveProviderConfig();
  console.log(startupLine(config));

  if (config.demoRequested) {
    console.error('\nDEMO_LLM=1 qo\'yilgan — diagnostika haqiqiy provayder uchun. DEMO_LLM ni o\'chiring.');
    process.exit(1);
  }
  if (config.provider !== 'openai-compatible' || !config.baseUrl) {
    console.error(
      "\ndiag:llm hozircha faqat TRAINER_PROVIDER=openai-compatible uchun (response_format / reasoning_effort shu API'da).",
    );
    process.exit(1);
  }
  if (!config.hasKey) {
    console.error(`\n${config.keyEnv} bo'sh yoki yo'q — harness/.env ni to'ldiring.`);
    process.exit(1);
  }

  const model = useScoring ? config.scoringModel : config.model;
  const timeoutMs = envInt('DIAG_TIMEOUT_MS', 60_000, { min: 1_000, max: 600_000 });
  const ctx = {
    url: `${config.baseUrl.replace(/\/$/, '')}/chat/completions`,
    apiKey: (process.env[config.keyEnv] as string).trim(),
    model,
    timeoutMs,
  };

  console.log(`\nModel: ${model} · har chaqiruv chegarasi ${timeoutMs} ms · ${VARIANTS.length} ta chaqiruv\n`);

  const rows: Row[] = [];
  for (const variant of VARIANTS) {
    process.stderr.write(`  ${variant.name} ... `);
    const row = await runVariant(variant, ctx);
    process.stderr.write(`${row.status} · ${row.latency} ms · ${row.parsed}\n`);
    rows.push(row);
  }

  console.log('');
  printTable(rows);
  console.log(
    "\nO'qish: HTTP 200 + o'qildi=ha — shu shakl ishlaydi. 400 — endpoint parametrni rad etdi " +
      '(izohda provayder xabari). `r N` — reasoning tokenlari (max_tokens ga kiradi).',
  );
}

main().catch((err: unknown) => {
  if (err instanceof ProviderConfigError) {
    console.error(`\n[sozlama xatosi] ${err.message}\n`);
    process.exit(1);
  }
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
