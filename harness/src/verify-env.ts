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
 *   5. kirish nuqtalari `.env` ni haqiqatan import qiladimi (statik tekshiruv).
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
  harnessEnvPath,
  harnessRoot,
  loadHarnessEnv,
  parseEnvFile,
} from './env.js';
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

  console.log(
    `\nNatija: ${report.passed} o'tdi, ${report.failed} xato, ${report.skipped} tashlab ketildi.`,
  );
  if (report.failed > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
