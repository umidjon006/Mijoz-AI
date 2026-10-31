/**
 * FAQAT HARNESS. `.env` yuklash va provayder aniqlash testlari.
 * HAQIQIY LLM CHAQIRILMAYDI; kalit sifatida faqat SOXTA qiymat ishlatiladi.
 *
 *   npm run verify:env
 *
 * Qamrov:
 *   1. `.env` matnini ajratish (izoh, tirnoq, `export`, qiymatdagi `=`);
 *   2. yuklash: yo'l harness papkasiga nisbatan, cwd o'zgarsa ham ishlaydi,
 *      shell env'i fayldan ustun turadi;
 *   3. provayder aniqlash (anthropic, openai-compatible, DEMO_LLM, xatolar);
 *   4. startup qatori: kalitning QIYMATI va to'liq URL hech qachon chiqmaydi;
 *   5. kirish nuqtalari `.env` ni haqiqatan import qiladimi (statik tekshiruv);
 *   6. bo'sh qiymat = default (port, auth, JSON rejimi, reasoning, timeout);
 *   7. so'rov tanasi: TRAINER_JSON_MODE haqiqatan formatni almashtiradi;
 *   8. adapter xato toifalari, timeout qayta urinishi, log qatori (soxta fetch);
 *   9. token chegarasi parametri (auto), "parametr qo'llanmaydi" fallback'i,
 *      reasoning zaxirasi va reasoning tokenlari hisobi (soxta fetch).
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assert,
  assertEqual,
  check,
  checkAsync,
  createReport,
  section,
} from '../../module/backend/src/training/testing/assert.js';
import {
  envBool,
  envInt,
  envStr,
  harnessEnvPath,
  harnessRoot,
  loadHarnessEnv,
  parseEnvFile,
} from './env.js';
import { LlmCallError } from '../../module/backend/src/training/errors.js';
import { personaCardSchema } from '../../module/backend/src/training/persona.js';
import { turnResultSchema } from '../../module/backend/src/training/state.js';
import { llmScoringSchema } from '../../module/backend/src/training/scoring/scoring.js';
import {
  applyParamFix,
  billableOutputTokens,
  detectUnsupportedParam,
  ProviderHttpError,
  buildChatBody,
  createOpenAiCompatibleLlm,
  reasoningHeadroom,
  resetParamFixesForTests,
  resolveMaxTokensParam,
} from './llm-openai-compatible.js';
import { zodToJsonSchema } from './zod-json-schema.js';
import { z } from 'zod';
import {
  baseUrlHost,
  createTrainerLlm,
  MissingLlmKeyError,
  ProviderConfigError,
  resolveProviderConfig,
  startupLine,
} from './llm-factory.js';
import type { BusinessProfile } from '../../module/backend/src/training/profile-schema.js';

/** Testlarda hech qachon haqiqiy kalit ishlatilmaydi. */
const FAKE_KEY = 'sk-fake-TEST-0000000000-not-a-real-key';

const fakeProfile = {
  businessId: '00000000-0000-0000-0000-000000000001',
  industry: 'Test',
  callDirection: 'mixed',
  primaryOffers: [{ name: 'Test kurs', price: '1 000 000', details: null }],
  commonObjections: [],
  tone: null,
  languages: ['uz'],
} as unknown as BusinessProfile;

async function main(): Promise<void> {
  const report = createReport();
  const dir = await mkdtemp(join(tmpdir(), 'verify-env-'));

  // -------------------------------------------------------------------------
  section('[1] .env matnini ajratish');

  check(report, 'oddiy KEY=VALUE', () => {
    const parsed = parseEnvFile('A=1\nB=two\n');
    assertEqual(parsed.A, '1', 'A');
    assertEqual(parsed.B, 'two', 'B');
  });

  check(report, "izohlar va bo'sh qatorlar tashlab ketiladi", () => {
    const parsed = parseEnvFile('# izoh\n\n  # yana izoh\nA=1\n');
    assertEqual(Object.keys(parsed).length, 1, 'faqat A qoladi');
    assertEqual(parsed.A, '1', 'A');
  });

  check(report, 'tirnoqlar olib tashlanadi', () => {
    const parsed = parseEnvFile(`A="ikki so'z"\nB='bir tirnoq'\n`);
    assertEqual(parsed.A, "ikki so'z", 'qo\'shtirnoq');
    assertEqual(parsed.B, 'bir tirnoq', 'bir tirnoq');
  });

  check(report, 'qiymat ichidagi = saqlanadi (URL, base64 kalitlar)', () => {
    const parsed = parseEnvFile('URL=https://a.b/c?x=1&y=2\nK=abc==\n');
    assertEqual(parsed.URL, 'https://a.b/c?x=1&y=2', 'URL butun');
    assertEqual(parsed.K, 'abc==', 'tenglik belgilari');
  });

  check(report, '`export KEY=` shakli', () => {
    assertEqual(parseEnvFile('export A=1\n').A, '1', 'export olib tashlanadi');
  });

  check(report, "bo'sh qiymat va tirnoqsiz izoh", () => {
    const parsed = parseEnvFile('A=\nB=val # izoh\n');
    assertEqual(parsed.A, '', "bo'sh qiymat");
    assertEqual(parsed.B, 'val', 'izoh kesiladi');
  });

  check(report, "noto'g'ri nomlar e'tiborsiz qoldiriladi", () => {
    const parsed = parseEnvFile('1BAD=x\nBAD-NAME=x\n=x\nOK=1\n');
    assertEqual(Object.keys(parsed).join(','), 'OK', 'faqat OK');
  });

  // -------------------------------------------------------------------------
  section('[2] yuklash: yo\'l, cwd va ustunlik tartibi');

  await checkAsync(report, 'soxta kalitli vaqtinchalik fayl yuklanadi', async () => {
    const path = join(dir, 'basic.env');
    await writeFile(path, `GEMINI_API_KEY=${FAKE_KEY}\nTRAINER_MODEL=gemini-3.8-flash\n`);
    const env: NodeJS.ProcessEnv = {};
    const result = loadHarnessEnv({ path, env });
    assert(result.found, 'fayl topildi');
    assertEqual(env.GEMINI_API_KEY, FAKE_KEY, 'kalit qo\'yildi');
    assertEqual(env.TRAINER_MODEL, 'gemini-3.8-flash', 'model qo\'yildi');
    assertEqual(result.applied.length, 2, "2 ta o'zgaruvchi qo'yildi");
  });

  await checkAsync(report, 'SHELL env\'i fayldan USTUN turadi', async () => {
    const path = join(dir, 'prec.env');
    await writeFile(path, 'TRAINER_MODEL=from_file\nOTHER=from_file\n');
    const env: NodeJS.ProcessEnv = { TRAINER_MODEL: 'from_shell' };
    const result = loadHarnessEnv({ path, env });
    assertEqual(env.TRAINER_MODEL, 'from_shell', 'shell qiymati saqlanadi');
    assertEqual(env.OTHER, 'from_file', 'yo\'q bo\'lgani fayldan olinadi');
    assertEqual(result.overridden.join(','), 'TRAINER_MODEL', 'tegilmagan nom qaytadi');
  });

  await checkAsync(report, "faylda KEY= (bo'sh) → process.env ga QO'YILMAYDI", async () => {
    const path = join(dir, 'empty.env');
    await writeFile(path, 'HARNESS_PORT=\nBENCH_PORT=\nTRAINER_MODEL=real\n');
    const env: NodeJS.ProcessEnv = {};
    const result = loadHarnessEnv({ path, env });
    assert(!('HARNESS_PORT' in env), "bo'sh nom qo'yilmadi");
    assertEqual(env.TRAINER_MODEL, 'real', "to'ldirilgani qo'yildi");
    assertEqual(result.empty.length, 2, '2 ta bo\'sh nom');
    // Aynan shu holat `Number(process.env.HARNESS_PORT ?? 5180)` ni buzgan edi.
    assertEqual(Number(env.HARNESS_PORT ?? 5180), 5180, 'default port saqlanadi');
  });

  await checkAsync(report, "`--env-file` qo'ygan bo'sh satr process.env dan OLIB TASHLANADI", async () => {
    const path = join(dir, 'node-empty.env');
    await writeFile(path, 'HARNESS_PORT=\nHARNESS_AUTH=\n');
    // tsx --env-file-if-exists=.env aynan shunday qiladi: KEY= -> ''.
    const env: NodeJS.ProcessEnv = { HARNESS_PORT: '', HARNESS_AUTH: '' };
    loadHarnessEnv({ path, env });
    assert(!('HARNESS_PORT' in env), "HARNESS_PORT o'chirildi");
    assert(!('HARNESS_AUTH' in env), "HARNESS_AUTH o'chirildi");
  });

  check(report, "bo'sh shell qiymati fayl qiymatiga yo'l beradi", () => {
    const env: NodeJS.ProcessEnv = { TRAINER_MODEL: '' };
    loadHarnessEnv({ path: join(dir, 'prec.env'), env });
    assertEqual(env.TRAINER_MODEL, 'from_file', "bo'sh satr qiymat emas");
  });

  check(report, 'yo\'q fayl xato bermaydi', () => {
    const result = loadHarnessEnv({ path: join(dir, 'yoq.env'), env: {} });
    assert(!result.found, 'found=false');
    assertEqual(result.applied.length, 0, 'hech narsa qo\'yilmadi');
  });

  check(report, 'yo\'l HARNESS papkasiga nisbatan (cwd\'ga emas)', () => {
    assert(
      harnessEnvPath.startsWith(harnessRoot),
      'harnessEnvPath harness papkasi ichida',
    );
    assert(harnessEnvPath.endsWith('/.env'), '.env bilan tugaydi');
    assert(!harnessEnvPath.includes('/src/'), 'src/ ichida emas');
  });

  await checkAsync(report, 'cwd boshqa papka bo\'lsa ham ishlaydi', async () => {
    const path = join(dir, 'cwd.env');
    await writeFile(path, 'CWD_TEST=ok\n');
    const before = process.cwd();
    try {
      process.chdir(tmpdir());
      const env: NodeJS.ProcessEnv = {};
      loadHarnessEnv({ path, env });
      assertEqual(env.CWD_TEST, 'ok', 'absolyut yo\'l bilan topildi');
      assert(
        harnessEnvPath.startsWith(harnessRoot),
        'cwd o\'zgarsa ham harnessEnvPath o\'zgarmaydi',
      );
    } finally {
      process.chdir(before);
    }
  });

  // -------------------------------------------------------------------------
  section("[2b] bo'sh qiymat = default");

  check(report, "envStr/envInt/envBool: bo'sh va bo'shliq -> default", () => {
    const env: NodeJS.ProcessEnv = { A: '', B: '   ', P: '', F: '' };
    assertEqual(envStr('A', env), undefined, "bo'sh -> undefined");
    assertEqual(envStr('B', env), undefined, "bo'shliq -> undefined");
    assertEqual(envInt('P', 5180, { env }), 5180, "bo'sh port -> 5180 (0 EMAS)");
    assertEqual(envBool('F', true, env), true, "bo'sh HARNESS_AUTH -> yoqilgan");
    assertEqual(envBool('F', true, { F: '0' }), false, 'aniq 0 -> o\'chirilgan');
    assertEqual(envInt('P', 1, { env: { P: ' 42 ' } }), 42, 'trim');
  });

  check(report, "envInt: noto'g'ri qiymat jim o'tmaydi", () => {
    let caught = false;
    try {
      envInt('P', 1, { min: 1, max: 65535, env: { P: 'abc' } });
    } catch {
      caught = true;
    }
    assert(caught, 'xato tashlandi');
  });

  // -------------------------------------------------------------------------
  section('[3] provayder aniqlash');

  check(report, 'default: anthropic + ANTHROPIC_API_KEY', () => {
    const config = resolveProviderConfig({ ANTHROPIC_API_KEY: FAKE_KEY });
    assertEqual(config.provider, 'anthropic', 'provider');
    assertEqual(config.keyEnv, 'ANTHROPIC_API_KEY', 'keyEnv');
    assertEqual(config.model, 'claude-haiku-5-5', 'default model');
    assertEqual(config.scoringModel, 'claude-sonnet-5-5', 'default baholash modeli');
    assert(config.hasKey, 'kalit bor');
  });

  check(report, 'openai-compatible: Gemini sozlamasi', () => {
    const config = resolveProviderConfig({
      TRAINER_PROVIDER: 'openai-compatible',
      TRAINER_API_KEY_ENV: 'GEMINI_API_KEY',
      TRAINER_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      TRAINER_MODEL: 'gemini-3.8-flash',
      TRAINER_SCORING_MODEL: 'gemini-3.8-flash',
      GEMINI_API_KEY: FAKE_KEY,
    });
    assertEqual(config.provider, 'openai-compatible', 'provider');
    assertEqual(config.keyEnv, 'GEMINI_API_KEY', 'keyEnv');
    assertEqual(config.model, 'gemini-3.8-flash', 'model');
    assertEqual(config.scoringModel, 'gemini-3.8-flash', 'baholash modeli');
    assert(config.hasKey, 'kalit bor');
  });

  const geminiBase = {
    TRAINER_PROVIDER: 'openai-compatible',
    TRAINER_API_KEY_ENV: 'GEMINI_API_KEY',
    TRAINER_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    TRAINER_MODEL: 'gemini-3.8-flash',
    GEMINI_API_KEY: FAKE_KEY,
  };

  check(report, "yangi sozlamalar: bo'sh qiymat -> xavfsiz default", () => {
    const config = resolveProviderConfig({
      ...geminiBase,
      TRAINER_JSON_MODE: '',
      TRAINER_REASONING_EFFORT: '',
      TRAINER_SCORING_REASONING_EFFORT: '',
      TRAINER_TIMEOUT_MS: '',
      TRAINER_SCORING_TIMEOUT_MS: '',
      TRAINER_SCORING_MODEL: '',
      DEMO_LLM: '',
    });
    assertEqual(config.jsonMode, 'object', 'json default');
    assertEqual(config.reasoningEffort, null, 'reasoning yuborilmaydi');
    assertEqual(config.scoringReasoningEffort, null, 'baholash reasoning yuborilmaydi');
    assertEqual(config.timeoutMs, 60_000, 'timeout default');
    assertEqual(config.scoringTimeoutMs, 120_000, 'baholash timeout default');
    assertEqual(config.scoringModel, 'gemini-3.8-flash', "bo'sh baholash modeli -> TRAINER_MODEL");
  });

  check(report, 'TRAINER_JSON_MODE / reasoning / timeout qiymatlari o\'qiladi', () => {
    const config = resolveProviderConfig({
      ...geminiBase,
      TRAINER_JSON_MODE: 'schema',
      TRAINER_REASONING_EFFORT: 'minimal',
      TRAINER_SCORING_REASONING_EFFORT: 'low',
      TRAINER_TIMEOUT_MS: '30000',
      TRAINER_SCORING_TIMEOUT_MS: '180000',
    });
    assertEqual(config.jsonMode, 'schema', 'schema');
    assertEqual(config.reasoningEffort, 'minimal', 'mijoz reasoning');
    assertEqual(config.scoringReasoningEffort, 'low', 'baholash reasoning');
    assertEqual(config.timeoutMs, 30_000, 'timeout');
    assertEqual(config.scoringTimeoutMs, 180_000, 'baholash timeout');
    assertEqual(
      resolveProviderConfig({ ...geminiBase, TRAINER_JSON_MODE: 'json_object' }).jsonMode,
      'object',
      'eski nom json_object -> object',
    );
  });

  for (const [name, value] of [
    ['TRAINER_JSON_MODE', 'yaml'],
    ['TRAINER_REASONING_EFFORT', 'max'],
    ['TRAINER_TIMEOUT_MS', 'abc'],
    ['TRAINER_SCORING_TIMEOUT_MS', '10'],
  ] as const) {
    check(report, `${name}=${value} -> ProviderConfigError`, () => {
      let caught: unknown;
      try {
        resolveProviderConfig({ ...geminiBase, [name]: value });
      } catch (err) {
        caught = err;
      }
      assert(caught instanceof ProviderConfigError, 'ProviderConfigError');
    });
  }

  check(report, "kalit bo'sh bo'lsa hasKey=false", () => {
    const config = resolveProviderConfig({ ANTHROPIC_API_KEY: '   ' });
    assert(!config.hasKey, "bo'sh satr kalit emas");
  });

  check(report, 'DEMO_LLM=1 aniqlanadi', () => {
    assert(resolveProviderConfig({ DEMO_LLM: '1' }).demoRequested, 'demoRequested');
    assert(!resolveProviderConfig({ DEMO_LLM: '0' }).demoRequested, 'DEMO_LLM=0 emas');
  });

  check(report, "noto'g'ri TRAINER_PROVIDER → ProviderConfigError", () => {
    let caught: unknown;
    try {
      resolveProviderConfig({ TRAINER_PROVIDER: 'gemini' });
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof ProviderConfigError, 'ProviderConfigError');
  });

  check(report, 'openai-compatible: TRAINER_BASE_URL majburiy', () => {
    let caught: unknown;
    try {
      resolveProviderConfig({
        TRAINER_PROVIDER: 'openai-compatible',
        TRAINER_API_KEY_ENV: 'GROQ_API_KEY',
        TRAINER_MODEL: 'x',
      });
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof ProviderConfigError, 'baseUrl yo\'q → xato');
  });

  check(report, 'openai-compatible: TRAINER_MODEL majburiy', () => {
    let caught: unknown;
    try {
      resolveProviderConfig({
        TRAINER_PROVIDER: 'openai-compatible',
        TRAINER_API_KEY_ENV: 'GROQ_API_KEY',
        TRAINER_BASE_URL: 'https://api.groq.com/openai/v1',
      });
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof ProviderConfigError, 'model yo\'q → xato');
  });

  check(report, "kalitsiz createTrainerLlm → MissingLlmKeyError (demo'ga o'tmaydi)", () => {
    let caught: unknown;
    try {
      createTrainerLlm({ profile: fakeProfile, config: resolveProviderConfig({}) });
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof MissingLlmKeyError, 'MissingLlmKeyError');
    assertEqual(
      (caught as MissingLlmKeyError).config.keyEnv,
      'ANTHROPIC_API_KEY',
      'qaysi env kutilgani aytiladi',
    );
  });

  check(report, 'DEMO_LLM=1 → isDemo, kalit talab qilinmaydi', () => {
    const resolved = createTrainerLlm({
      profile: fakeProfile,
      config: resolveProviderConfig({ DEMO_LLM: '1' }),
    });
    assert(resolved.isDemo, 'isDemo');
    assertEqual(resolved.provider, 'demo', 'provider=demo');
  });

  // -------------------------------------------------------------------------
  section('[4] startup qatori sirni oshkor qilmaydi');

  const emptyLoad = {
    found: true,
    path: harnessEnvPath,
    applied: [] as string[],
    overridden: [] as string[],
    empty: [] as string[],
  };

  const geminiConfig = resolveProviderConfig({
    TRAINER_PROVIDER: 'openai-compatible',
    TRAINER_API_KEY_ENV: 'GEMINI_API_KEY',
    TRAINER_BASE_URL: `https://generativelanguage.googleapis.com/v1beta/openai?key=${FAKE_KEY}`,
    TRAINER_MODEL: 'gemini-3.8-flash',
    GEMINI_API_KEY: FAKE_KEY,
  });

  check(report, 'kalitning QIYMATI chiqmaydi', () => {
    const line = startupLine(geminiConfig, emptyLoad);
    assert(!line.includes(FAKE_KEY), 'qatorda kalit yo\'q');
    assert(line.includes('GEMINI_API_KEY'), 'kalit NOMI bor');
    assert(line.includes("o'rnatilgan"), 'holat ko\'rsatilgan');
  });

  check(report, 'faqat host chiqadi, to\'liq URL emas', () => {
    assertEqual(
      baseUrlHost('https://generativelanguage.googleapis.com/v1beta/openai'),
      'generativelanguage.googleapis.com',
      'host',
    );
    const line = startupLine(geminiConfig, emptyLoad);
    assert(line.includes('generativelanguage.googleapis.com'), 'host bor');
    assert(!line.includes('/v1beta/openai'), 'yo\'l qismi yo\'q');
    assert(!line.includes('key='), 'query yo\'q');
  });

  check(report, 'model nomlari va env fayl holati ko\'rinadi', () => {
    const line = startupLine(geminiConfig, { ...emptyLoad, applied: ['A', 'B'] });
    assert(line.includes('gemini-3.8-flash'), 'model');
    assert(line.includes('harness/.env'), 'env fayl yo\'li');
    assert(line.includes('2 ta'), 'nechta o\'zgaruvchi yuklangani');
  });

  check(report, 'kalit yo\'q bo\'lsa qatorda YO\'Q deb turadi', () => {
    const line = startupLine(resolveProviderConfig({}), { ...emptyLoad, found: false });
    assert(line.includes("YO'Q"), 'kalit yo\'qligi aytiladi');
    assert(line.includes('TOPILMADI'), '.env topilmagani aytiladi');
  });

  check(report, 'startup qatorida json/reasoning/timeout ko\'rinadi', () => {
    const line = startupLine(
      resolveProviderConfig({ ...geminiBase, TRAINER_REASONING_EFFORT: 'none' }),
      emptyLoad,
    );
    assert(line.includes('json=object'), 'json rejimi');
    assert(line.includes('reasoning=none/default'), 'reasoning');
    assert(line.includes('timeout=60s/120s'), 'timeout');
  });

  // -------------------------------------------------------------------------
  section('[5] kirish nuqtalari env.js ni import qiladi');

  const entryPoints = [
    'apply-sql',
    'withTenant',
    'play',
    'smoke-llm',
    'calibrate',
    'bench-voices',
    'record-server',
    'bench-stt',
    'bench-tts',
    'server',
    'dev',
    'bakeoff',
    'bakeoff-report',
    'bakeoff-score',
    'verify-bakeoff',
    'db-local',
    'diag-llm',
  ];

  for (const name of entryPoints) {
    await checkAsync(report, `${name}.ts → env.js ENG BIRINCHI import`, async () => {
      const source = await readFile(join(harnessRoot, 'src', `${name}.ts`), 'utf8');
      const imports = [...source.matchAll(/^import\s.*?;$/gm)].map((m) => m[0]);
      const first = imports[0];
      assert(first !== undefined, 'import bor');
      assert(
        first.includes("'./env.js'"),
        `birinchi import env.js bo'lishi kerak, hozir: ${first.slice(0, 60)}`,
      );
    });
  }

  await checkAsync(report, 'package.json: hamma tsx skriptida --env-file-if-exists', async () => {
    const pkg = JSON.parse(await readFile(join(harnessRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const missing = Object.entries(pkg.scripts)
      .filter(([, cmd]) => cmd.startsWith('tsx ') && !cmd.includes('--env-file-if-exists=.env'))
      .map(([name]) => name);
    assertEqual(missing.join(','), '', `flag tushib qolgan skriptlar: ${missing.join(', ')}`);
  });

  // -------------------------------------------------------------------------
  section("[6] so'rov tanasi: TRAINER_JSON_MODE formatni almashtiradi");

  const input = { system: 'S', user: 'U', outputSchema: personaCardSchema, stage: 'training.persona' };
  const base = { model: 'm', maxTokens: 100 };

  check(report, 'schema -> response_format json_schema (strict)', () => {
    const body = buildChatBody(input, { ...base, jsonMode: 'schema' });
    const rf = body.response_format as { type: string; json_schema: { strict: boolean; schema: unknown } };
    assertEqual(rf.type, 'json_schema', 'type');
    assertEqual(rf.json_schema.strict, true, 'strict');
    assert(rf.json_schema.schema !== null, 'sxema bor');
  });

  check(report, 'object -> json_object; prompt -> response_format yo\'q', () => {
    const obj = buildChatBody(input, { ...base, jsonMode: 'object' });
    assertEqual((obj.response_format as { type: string }).type, 'json_object', 'object');
    const prompt = buildChatBody(input, { ...base, jsonMode: 'prompt' });
    assert(!('response_format' in prompt), 'prompt rejimida response_format yo\'q');
  });

  check(report, 'schema, lekin outputSchema yo\'q -> json_object ga tushadi', () => {
    const body = buildChatBody({ ...input, outputSchema: undefined }, { ...base, jsonMode: 'schema' });
    assertEqual((body.response_format as { type: string }).type, 'json_object', 'fallback');
  });

  check(report, 'reasoning_effort faqat berilganda yuboriladi', () => {
    assert(!('reasoning_effort' in buildChatBody(input, { ...base, jsonMode: 'object' })), 'yo\'q');
    const body = buildChatBody(input, { ...base, jsonMode: 'object', reasoningEffort: 'minimal' });
    assertEqual(body.reasoning_effort, 'minimal', 'bor');
  });

  check(report, 'modulning 3 ta sxemasi JSON Schema ga aylanadi', () => {
    for (const [name, schema] of [
      ['persona', personaCardSchema],
      ['turn', turnResultSchema],
      ['scoring', llmScoringSchema],
    ] as const) {
      const json = zodToJsonSchema(schema) as {
        type: string;
        required: string[];
        properties: Record<string, unknown>;
        additionalProperties: boolean;
      } | null;
      assert(json !== null, `${name}: sxema yasaldi`);
      assertEqual(json.type, 'object', `${name}: object`);
      assertEqual(json.additionalProperties, false, `${name}: additionalProperties=false`);
      assertEqual(
        json.required.join(','),
        Object.keys(json.properties).join(','),
        `${name}: hamma maydon majburiy (strict)`,
      );
    }
  });

  check(report, 'nullable: type[] va anyOf uslublari', () => {
    const schema = z.object({ note: z.string().nullable() });
    const a = zodToJsonSchema(schema, 'type-array') as { properties: { note: unknown } };
    assertEqual(JSON.stringify(a.properties.note), '{"type":["string","null"]}', 'type[]');
    const b = zodToJsonSchema(schema, 'anyOf') as { properties: { note: unknown } };
    assertEqual(
      JSON.stringify(b.properties.note),
      '{"anyOf":[{"type":"string"},{"type":"null"}]}',
      'anyOf',
    );
  });

  // -------------------------------------------------------------------------
  section('[7] adapter: xato toifalari, timeout qayta urinishi, log (soxta fetch)');

  const realFetch = globalThis.fetch;
  const okBody = (content: string) =>
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  const tinySchema = z.object({ a: z.number() });
  const req = { stage: 'training.turn', system: 's', user: 'u', schema: tinySchema };

  /** Skriptlangan fetch: har chaqiruvga navbatdagi javob; 'hang' — abort'gacha kutadi. */
  function stubFetch(script: Array<{ status: number; body: string } | 'hang'>) {
    const seen: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const step = script.shift();
      if (step === 'hang' || step === undefined) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('This operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      return new Response(step.body, { status: step.status });
    }) as typeof fetch;
    return seen;
  }

  function makeLlm(
    lines: string[],
    timeoutMs = 50,
    extra: Partial<Parameters<typeof createOpenAiCompatibleLlm>[0]> = {},
  ) {
    return createOpenAiCompatibleLlm({
      baseUrl: 'https://example.invalid/v1',
      apiKey: FAKE_KEY,
      model: 'gemini-3.8-flash',
      timeoutMs,
      log: (line) => lines.push(line),
      ...extra,
    });
  }

  async function caught(fn: () => Promise<unknown>): Promise<unknown> {
    try {
      await fn();
    } catch (err) {
      return err;
    }
    throw new Error('xato kutilgan edi');
  }

  try {
    await checkAsync(report, 'timeout: BIR marta qayta, keyin LlmCallError(timeout)', async () => {
      const seen = stubFetch(['hang', 'hang']);
      const lines: string[] = [];
      const err = await caught(() => makeLlm(lines).completeJson(req));
      assert(err instanceof LlmCallError && err.kind === 'timeout', 'timeout toifasi');
      assertEqual(seen.length, 2, '2 ta so\'rov (1 + 1 qayta)');
      assertEqual(lines.length, 2, 'har urinishga bitta log qatori');
      assert(lines[0]?.includes('outcome=timeout'), 'logda outcome=timeout');
    });

    await checkAsync(report, 'timeout, keyin muvaffaqiyat -> qiymat qaytadi', async () => {
      const seen = stubFetch(['hang', { status: 200, body: okBody('{"a":1}') }]);
      const value = await makeLlm([]).completeJson(req);
      assertEqual(value.a, 1, 'qiymat');
      assertEqual(seen.length, 2, '2 ta so\'rov');
    });

    await checkAsync(report, 'HTTP 429: qayta urinilmaydi, status va qisqa xabar, kalit YO\'Q', async () => {
      const seen = stubFetch([
        {
          status: 429,
          body: JSON.stringify({ error: { message: `Quota exceeded for key ${FAKE_KEY}` } }),
        },
      ]);
      const lines: string[] = [];
      const err = await caught(() => makeLlm(lines).completeJson(req));
      assert(err instanceof LlmCallError && err.kind === 'http', 'http toifasi');
      assertEqual((err as LlmCallError).status, 429, 'status');
      assert((err as LlmCallError).providerMessage?.includes('Quota exceeded') ?? false, 'provayder xabari');
      assert(!(err as Error).message.includes(FAKE_KEY), 'xato matnida kalit yo\'q');
      assert(!lines.join('\n').includes(FAKE_KEY), 'logda kalit yo\'q');
      assertEqual(seen.length, 1, 'bitta so\'rov');
      assert(lines[0]?.includes('outcome=http_429'), 'logda outcome=http_429');
    });

    await checkAsync(report, 'JSON emas -> invalid_json; kesilgan javob shuni aytadi', async () => {
      stubFetch([
        {
          status: 200,
          body: JSON.stringify({ choices: [{ message: { content: '{"a":' }, finish_reason: 'length' }] }),
        },
      ]);
      const err = await caught(() => makeLlm([]).completeJson(req));
      assert(err instanceof LlmCallError && err.kind === 'invalid_json', 'invalid_json');
      assert((err as Error).message.includes('token chegarasida kesildi'), 'kesilgani aytiladi');
    });

    await checkAsync(report, 'sxemaga tushmasa -> ZodError, adapter qayta so\'ramaydi', async () => {
      const seen = stubFetch([{ status: 200, body: okBody('{"a":"bir"}') }]);
      const lines: string[] = [];
      const err = await caught(() => makeLlm(lines).completeJson(req));
      assert(err instanceof Error && err.name === 'ZodError', 'ZodError');
      assertEqual(seen.length, 1, 'bitta so\'rov (tuzatish modulda)');
      assert(lines[0]?.includes('outcome=schema'), 'logda outcome=schema');
    });

    await checkAsync(report, 'log qatori: stage, model, latency, tokens, outcome', async () => {
      stubFetch([{ status: 200, body: okBody('{"a":2}') }]);
      const lines: string[] = [];
      await makeLlm(lines).completeJson(req);
      assertEqual(lines.length, 1, 'bitta qator');
      const line = lines[0] ?? '';
      for (const part of ['[llm]', 'stage=training.turn', 'model=gemini-3.8-flash', 'latency=', 'tokens=10/5', 'outcome=ok']) {
        assert(line.includes(part), `qatorda "${part}"`);
      }
    });
    // -----------------------------------------------------------------------
    section("[8] token chegarasi parametri, parametr fallback'i, reasoning");

    check(report, 'auto: api.openai.com -> max_completion_tokens, boshqalar -> max_tokens', () => {
      assertEqual(resolveMaxTokensParam('auto', 'https://api.openai.com/v1'), 'max_completion_tokens', 'openai');
      assertEqual(resolveMaxTokensParam(undefined, 'https://api.openai.com/v1'), 'max_completion_tokens', 'default');
      assertEqual(
        resolveMaxTokensParam('auto', 'https://generativelanguage.googleapis.com/v1beta/openai'),
        'max_tokens',
        'gemini',
      );
      assertEqual(resolveMaxTokensParam('auto', 'https://api.groq.com/openai/v1'), 'max_tokens', 'groq');
      assertEqual(resolveMaxTokensParam('auto', 'https://api.z.ai/api/paas/v4'), 'max_tokens', 'glm');
      assertEqual(resolveMaxTokensParam('max_tokens', 'https://api.openai.com/v1'), 'max_tokens', 'aniq qiymat ustun');
    });

    check(report, "TRAINER_MAX_TOKENS_PARAM: bo'sh -> auto, noto'g'ri -> xato", () => {
      assertEqual(resolveProviderConfig({ ...geminiBase, TRAINER_MAX_TOKENS_PARAM: '' }).maxTokensParam, 'auto', "bo'sh");
      assertEqual(
        resolveProviderConfig({ ...geminiBase, TRAINER_MAX_TOKENS_PARAM: 'max_completion_tokens' }).maxTokensParam,
        'max_completion_tokens',
        'aniq',
      );
      let caught: unknown;
      try {
        resolveProviderConfig({ ...geminiBase, TRAINER_MAX_TOKENS_PARAM: 'tokens' });
      } catch (err) {
        caught = err;
      }
      assert(caught instanceof ProviderConfigError, 'ProviderConfigError');
    });

    await checkAsync(report, 'adapter: openai hostida tanada max_completion_tokens, gemini da max_tokens', async () => {
      resetParamFixesForTests();
      let seen = stubFetch([{ status: 200, body: okBody('{"a":1}') }]);
      await makeLlm([], 1000, { baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna' }).completeJson(req);
      assert('max_completion_tokens' in (seen[0] ?? {}), 'openai: max_completion_tokens');
      assert(!('max_tokens' in (seen[0] ?? {})), "openai: max_tokens yo'q");

      seen = stubFetch([{ status: 200, body: okBody('{"a":1}') }]);
      await makeLlm([], 1000, {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      }).completeJson(req);
      assert('max_tokens' in (seen[0] ?? {}), 'gemini: max_tokens');
      assert(!('max_completion_tokens' in (seen[0] ?? {})), "gemini: max_completion_tokens yo'q");
    });

    const openAiMaxTokens400 = {
      status: 400,
      body: JSON.stringify({
        error: {
          message:
            "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
          type: 'invalid_request_error',
          param: 'max_tokens',
          code: 'unsupported_parameter',
        },
      }),
    };

    await checkAsync(report, "fallback: 400 max_tokens -> max_completion_tokens bilan 1 marta qayta, eslab qolinadi", async () => {
      resetParamFixesForTests();
      const lines: string[] = [];
      const llm = makeLlm(lines, 1000, {
        baseUrl: 'https://proxy.example/v1',
        model: 'gpt-6-luna',
        maxTokensParam: 'max_tokens',
        maxTokens: 100,
        reasoningEffort: 'low',
      });
      const seen = stubFetch([openAiMaxTokens400, { status: 200, body: okBody('{"a":1}') }]);
      assertEqual((await llm.completeJson(req)).a, 1, 'qiymat');
      assertEqual(seen.length, 2, '2 ta so\'rov');
      assertEqual(seen[1]?.max_completion_tokens, seen[0]?.max_tokens, 'qiymat yangi nomga ko\'chdi');
      assert(!('max_tokens' in (seen[1] ?? {})), "ikkinchisida max_tokens yo'q");
      const fallbackLines = lines.filter((l) => l.includes('param-fallback'));
      assertEqual(fallbackLines.length, 1, 'bitta fallback log qatori');
      assert(fallbackLines[0]?.includes('max_tokens -> max_completion_tokens') ?? false, 'qatorda nima qilingani');
      assert(!lines.join('\n').includes(FAKE_KEY), "logda kalit yo'q");

      // Keyingi chaqiruv: eslab qolingan — darhol to'g'ri nom, 400 siz.
      const seen2 = stubFetch([{ status: 200, body: okBody('{"a":2}') }]);
      assertEqual((await llm.completeJson(req)).a, 2, 'ikkinchi chaqiruv');
      assertEqual(seen2.length, 1, 'bitta so\'rov (eslab qolingan)');
      assert('max_completion_tokens' in (seen2[0] ?? {}), 'darhol max_completion_tokens');

      // Boshqa model — eslab qolinmagan.
      const seen3 = stubFetch([{ status: 200, body: okBody('{"a":3}') }]);
      await makeLlm([], 1000, {
        baseUrl: 'https://proxy.example/v1',
        model: 'boshqa-model',
        maxTokensParam: 'max_tokens',
      }).completeJson(req);
      assert('max_tokens' in (seen3[0] ?? {}), 'boshqa model uchun o\'zgarmagan');
    });

    for (const [name, message, param] of [
      ['reasoning_effort (OpenAI)', 'Unrecognized request argument supplied: reasoning_effort', undefined],
      ['reasoning_effort (Gemini)', 'Thinking level MINIMAL is not supported for this model. Please retry with other thinking level.', undefined],
      ['response_format', "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.", 'response_format'],
    ] as const) {
      await checkAsync(report, `fallback: ${name} -> parametrsiz qayta yuboriladi`, async () => {
        resetParamFixesForTests();
        const key = name.startsWith('reasoning') ? 'reasoning_effort' : name;
        const seen = stubFetch([
          { status: 400, body: JSON.stringify({ error: { message, ...(param ? { param } : {}) } }) },
          { status: 200, body: okBody('{"a":1}') },
        ]);
        const llm = makeLlm([], 1000, { reasoningEffort: 'minimal', jsonMode: 'object' });
        assertEqual((await llm.completeJson(req)).a, 1, 'qiymat');
        assertEqual(seen.length, 2, '2 ta so\'rov');
        assert(key in (seen[0] ?? {}), `birinchisida ${key} bor`);
        assert(!(key in (seen[1] ?? {})), `ikkinchisida ${key} yo'q`);
      });
    }

    check(report, "fallback: temperature (adapter yubormaydi — aniqlash funksiyasi)", () => {
      const err = new ProviderHttpError(
        400,
        "Unsupported value: 'temperature' does not support 0.2 with this model.",
        'temperature',
      );
      const body = { model: 'm', temperature: 0.2, max_tokens: 10 };
      const fix = detectUnsupportedParam(err, body);
      assertEqual(fix?.param, 'temperature', 'temperature topildi');
      assertEqual(fix?.replacement ?? null, null, 'almashtirish yo\'q');
      assert(!('temperature' in applyParamFix(body, fix!)), 'olib tashlandi');
      assertEqual(detectUnsupportedParam(err, { model: 'm' }), null, "tanada bo'lmasa — tuzatish yo'q");
    });

    await checkAsync(report, "fallback: boshqa 400 (parametr emas) -> qayta yuborilmaydi", async () => {
      resetParamFixesForTests();
      const seen = stubFetch([
        { status: 400, body: JSON.stringify({ error: { message: 'Request contains an invalid argument.' } }) },
      ]);
      const err = await caught(() => makeLlm([]).completeJson(req));
      assert(err instanceof LlmCallError && err.status === 400, 'HTTP 400 chiqdi');
      assertEqual(seen.length, 1, 'bitta so\'rov');
    });

    await checkAsync(report, 'fallback: faqat BIR marta (ikkinchi 400 xato bo\'lib chiqadi)', async () => {
      resetParamFixesForTests();
      const seen = stubFetch([
        openAiMaxTokens400,
        {
          status: 400,
          body: JSON.stringify({ error: { message: 'Unrecognized request argument supplied: reasoning_effort' } }),
        },
      ]);
      const err = await caught(() =>
        makeLlm([], 1000, { maxTokensParam: 'max_tokens', reasoningEffort: 'low' }).completeJson(req),
      );
      assert(err instanceof LlmCallError && err.status === 400, 'HTTP 400');
      assertEqual(seen.length, 2, '2 ta so\'rov, uchinchisi yo\'q');
    });

    await checkAsync(report, 'reasoning zaxirasi: chegara = javob byudjeti + headroom', async () => {
      resetParamFixesForTests();
      assertEqual(reasoningHeadroom('none'), 0, 'none');
      assert(reasoningHeadroom('low') > 0 && reasoningHeadroom('high') > reasoningHeadroom('low'), 'oshib boradi');
      assert(reasoningHeadroom(undefined) >= reasoningHeadroom('medium'), 'default — saxiy');
      let seen = stubFetch([{ status: 200, body: okBody('{"a":1}') }]);
      await makeLlm([], 1000, { maxTokens: 1024, reasoningEffort: 'none' }).completeJson(req);
      assertEqual(seen[0]?.max_tokens, 1024, 'none: zaxirasiz');
      seen = stubFetch([{ status: 200, body: okBody('{"a":1}') }]);
      await makeLlm([], 1000, { maxTokens: 1024, reasoningEffort: 'low' }).completeJson(req);
      assertEqual(seen[0]?.max_tokens, 1024 + reasoningHeadroom('low'), 'low: zaxira qo\'shildi');
    });

    check(report, 'narx uchun chiqish tokenlari reasoning BILAN (ikkala uslub)', () => {
      // OpenAI: completion reasoning'ni o'z ichiga oladi.
      assertEqual(
        billableOutputTokens({
          prompt_tokens: 10,
          completion_tokens: 300,
          total_tokens: 310,
          completion_tokens_details: { reasoning_tokens: 250 },
        }),
        300,
        'openai',
      );
      // Gemini uslubi: reasoning faqat total'da.
      assertEqual(
        billableOutputTokens({ prompt_tokens: 10, completion_tokens: 50, total_tokens: 310 }),
        300,
        'gemini',
      );
      assertEqual(billableOutputTokens({ prompt_tokens: 10, completion_tokens: 50 }), 50, "total yo'q");
    });

    await checkAsync(report, 'reasoning tokenlari usage va log qatorida alohida', async () => {
      resetParamFixesForTests();
      stubFetch([
        {
          status: 200,
          body: JSON.stringify({
            choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 300,
              total_tokens: 310,
              completion_tokens_details: { reasoning_tokens: 250 },
            },
          }),
        },
      ]);
      const lines: string[] = [];
      const llm = makeLlm(lines, 1000);
      const out = await llm.completeJsonWithUsage?.(req);
      assertEqual(out?.usage.outputTokens, 300, 'outputTokens reasoning bilan');
      assertEqual(out?.usage.reasoningTokens, 250, 'reasoningTokens alohida');
      assert(lines[0]?.includes('tokens=10/300') ?? false, 'tokens');
      assert(lines[0]?.includes('reasoning=250') ?? false, 'reasoning=250');
    });
  } finally {
    globalThis.fetch = realFetch;
    resetParamFixesForTests();
  }

  console.log(
    `\nNatija: ${report.passed} o'tdi, ${report.failed} xato, ${report.skipped} tashlab ketildi.`,
  );
  if (report.failed > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
