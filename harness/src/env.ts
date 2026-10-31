/**
 * FAQAT HARNESS. `harness/.env` ni YUKLAYDI — har bir kirish nuqtasida ENG BIRINCHI.
 *
 * Nega alohida modul: avval hamma skript `tsx --env-file-if-exists=.env` ga
 * tayanardi. Ikki muammosi bor edi:
 *   1. `.env` yo'li `process.cwd()` ga nisbatan izlanadi — harness papkasidan
 *      boshqa joydan ishga tushirilsa (repo ildizi, IDE, debugger, `npx tsx`)
 *      fayl TOPILMAYDI va skript jim-jitlik bilan env'siz ishlayverardi;
 *   2. bitta skriptda (`dev`) flag tushib qolgan edi — natijada `npm run dev`
 *      `.env` ni butunlay ko'rmay, "provider anthropic, kalit yo'q" deb to'xtardi.
 *
 * Shu modul yo'lni `import.meta.url` dan, ya'ni HARNESS PAPKASIGA nisbatan
 * hisoblaydi — cwd qanday bo'lishidan qat'i nazar.
 *
 * Ustunlik tartibi (Node'ning `--env-file` i bilan bir xil):
 * SHELL / CI env'i faylidan ustun turadi. Ya'ni
 * `TRAINER_MODEL=x npm run play` `.env` dagi qiymatni bosib o'tadi.
 *
 * Faylda `KEY=` (BO'SH qiymat) — "sozlanmagan" degani: bunday nom process.env ga
 * UMUMAN qo'yilmaydi. Aks holda `process.env.HARNESS_PORT ?? 5180` kabi joylar
 * bo'sh satrni "qiymat bor" deb qabul qilib, port/model bo'sh bo'lib qolardi.
 *
 * MUHIM: bu modul hech qachon qiymat chop etmaydi — faqat NOMLARNI qaytaradi.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `harness/` papkasining absolyut yo'li (cwd'ga bog'liq emas). */
export const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Yuklanadigan fayl: `harness/.env`. */
export const harnessEnvPath = resolve(harnessRoot, '.env');

export interface EnvLoadResult {
  /** Fayl topildimi. */
  found: boolean;
  /** Qaysi fayl o'qildi. */
  path: string;
  /** Fayldan olib, process.env ga QO'YILGAN nomlar. */
  applied: readonly string[];
  /** Faylda bor, lekin env'da allaqachon bo'lgani uchun TEGILMAGAN nomlar. */
  overridden: readonly string[];
  /** Faylda bor, lekin qiymati BO'SH bo'lgani uchun qo'yilmagan nomlar. */
  empty: readonly string[];
}

/**
 * `.env` matnini ajratadi. Qo'llaydi: izohlar (`#`), bo'sh qatorlar,
 * `export KEY=...`, qo'shtirnoq/bir tirnoq, qiymat ichidagi `=`,
 * qo'shtirnoq ichida `\n` va `\t`.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
      }
    } else {
      // Tirnoqsiz qiymatda " #" dan keyingi qism — izoh.
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }

    out[key] = value;
  }

  return out;
}

let cached: EnvLoadResult | null = null;

export interface LoadHarnessEnvOptions {
  /** Boshqa fayl (testlar uchun). Default: `harness/.env`. */
  path?: string;
  /** Qaysi obyektga yozish (testlar uchun). Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Keshni chetlab o'tish (testlar uchun). */
  force?: boolean;
}

/**
 * `harness/.env` ni o'qib, process.env da HALI YO'Q nomlarni qo'yadi.
 * Bir sessiyada bir marta o'qiladi (keshlanadi).
 */
export function loadHarnessEnv(options: LoadHarnessEnvOptions = {}): EnvLoadResult {
  const path = options.path ?? harnessEnvPath;
  const env = options.env ?? process.env;
  const useCache = !options.force && !options.path && !options.env;

  if (useCache && cached) return cached;

  const applied: string[] = [];
  const overridden: string[] = [];
  const empty: string[] = [];
  const found = existsSync(path);

  if (found) {
    const parsed = parseEnvFile(readFileSync(path, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      // `tsx --env-file-if-exists=.env` faylni BIZDAN OLDIN o'qib, `KEY=` ni
      // bo'sh satr qilib qo'yadi. Bo'sh = sozlanmagan: uni olib tashlaymiz,
      // aks holda `?? default` lar bo'sh satrni "qiymat bor" deb oladi.
      if (value === '' && env[key] === '') delete env[key];
      // Shell/CI env'i ustun: allaqachon berilgan qiymatga tegmaymiz.
      if (env[key] !== undefined && env[key] !== '') {
        overridden.push(key);
        continue;
      }
      // `KEY=` — sozlanmagan: qo'ymaymiz, aks holda `?? default` buziladi.
      if (value === '') {
        empty.push(key);
        continue;
      }
      env[key] = value;
      applied.push(key);
    }
  }

  const result: EnvLoadResult = { found, path, applied, overridden, empty };
  if (useCache) cached = result;
  return result;
}

// ---------------------------------------------------------------------------
// Env'dan o'qish yordamchilari: BO'SH qiymat hamma joyda "default" degani.
// ---------------------------------------------------------------------------

/** Qiymat (trim qilingan) yoki `undefined` — bo'sh satr ham `undefined`. */
export function envStr(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Butun son. Bo'sh/yo'q -> `fallback`. Noto'g'ri (son emas yoki chegaradan
 * tashqari) qiymat jim e'tiborsiz qoldirilMAYDI — xato tashlanadi.
 */
export function envInt(
  name: string,
  fallback: number,
  { min = 0, max = Number.MAX_SAFE_INTEGER, env = process.env }: {
    min?: number;
    max?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): number {
  const raw = envStr(name, env);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name}="${raw}" noto'g'ri: ${min}..${max} oralig'idagi butun son kutiladi`);
  }
  return n;
}

/** Bayroq: bo'sh/yo'q -> `fallback`; `1/true/yes/on` -> true; `0/false/no/off` -> false. */
export function envBool(name: string, fallback: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = envStr(name, env)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name}="${raw}" noto'g'ri: 1 yoki 0 kutiladi`);
}

/** Faqat testlar uchun: keshni tozalaydi. */
export function resetEnvCacheForTests(): void {
  cached = null;
}

// ---------------------------------------------------------------------------
// Import qilinishi bilan yuklanadi: shu modul kirish nuqtalarida ENG BIRINCHI
// import qilinadi, shuning uchun env boshqa modullar baholanishidan oldin tayyor.
// ---------------------------------------------------------------------------
export const harnessEnv = loadHarnessEnv();
