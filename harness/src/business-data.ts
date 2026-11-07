/**
 * FAQAT HARNESS. Haqiqiy biznes ma'lumotlari fayllardan:
 *
 *   harness/data/business-profile.json   — biznes profili (MAJBURIY manba)
 *   harness/data/sales-script.md         — sotuv skripti (ixtiyoriy)
 *
 * Ikkalasi ham zod bilan tekshiriladi; xato bo'lsa — fayl yo'li va aniq
 * maydon/bosqich ko'rsatilgan tushunarli xabar (`BusinessDataError`).
 *
 * Demo profillar (`demo-profiles.json`) faqat ANIQ so'ralganda ishlatiladi:
 * `HARNESS_PROFILE=<kalit>` (server) yoki `--profile <kalit>` (play/smoke).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  profileSchema,
  type BusinessProfile,
} from '../../module/backend/src/training/profile-schema.js';
import {
  parseSalesScriptMarkdown,
  SalesScriptFormatError,
  type SalesScript,
} from '../../module/backend/src/training/scoring/sales-script.js';
import { listDemoProfileKeys, loadDemoProfile } from './demo-env.js';
import { harnessRoot } from './env.js';

export const dataDir = resolve(harnessRoot, 'data');
/** Haqiqiy profil — git'da IGNORE qilingan, faqat shu kompyuterda. */
export const businessProfilePath = resolve(dataDir, 'business-profile.json');
/** Demo namuna (git'da) — haqiqiy fayl bo'lmasa shu yuklanadi va "DEMO MA'LUMOT" deb belgilanadi. */
export const demoProfilePath = resolve(dataDir, 'business-profile.demo.json');
export const salesScriptPath = resolve(dataDir, 'sales-script.md');

export class BusinessDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusinessDataError';
  }
}

function shortPath(path: string): string {
  const at = path.lastIndexOf('harness/');
  return at >= 0 ? path.slice(at) : path;
}

/** JSON matnidan profil; xato bo'lsa `BusinessDataError` (fayl nomi bilan). */
export function parseBusinessProfileJson(text: string, label: string): BusinessProfile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new BusinessDataError(
      `${label}: JSON emas — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `  - ${issue.path.join('.') || '(ildiz)'}: ${issue.message}`,
    );
    throw new BusinessDataError(`${label}: biznes profili noto'g'ri:\n${issues.join('\n')}`);
  }
  return parsed.data;
}

export function loadBusinessProfileFile(path = businessProfilePath): BusinessProfile {
  if (!existsSync(path)) {
    throw new BusinessDataError(
      `${shortPath(path)} topilmadi. Namuna: README'dagi "Biznes ma'lumotlari" bo'limi.`,
    );
  }
  return parseBusinessProfileJson(readFileSync(path, 'utf8'), shortPath(path));
}

/** Skript fayli bo'lmasa `null` (ixtiyoriy); bo'lsa — tekshirilgan skript. */
export function loadSalesScriptFile(path = salesScriptPath): SalesScript | null {
  if (!existsSync(path)) return null;
  try {
    return parseSalesScriptMarkdown(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err instanceof SalesScriptFormatError) {
      throw new BusinessDataError(`${shortPath(path)}: ${err.message}`);
    }
    throw err;
  }
}

export interface ResolvedBusinessData {
  profile: BusinessProfile;
  /**
   * Qaysi manbadan: `harness/data/business-profile.json`,
   * `harness/data/business-profile.demo.json` yoki `demo:<kalit>`.
   */
  source: string;
  script: SalesScript | null;
  /**
   * DEMO ma'lumot ishlatilyaptimi: demo kalit, demo namuna fayli, yoki
   * `business-profile.json` aslida demo profilning nusxasi. UI shunda
   * "DEMO MA'LUMOT" belgisini ko'rsatadi — demo hech qachon haqiqiy deb ko'rinmasin.
   */
  isDemo: boolean;
}

/** Ikki profil mazmunan bir xilmi (kalitlar tartibidan qat'i nazar). */
function sameProfile(a: BusinessProfile, b: BusinessProfile): boolean {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
        : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/** Profil demo ma'lumotmi: demo namuna yoki `demo-profiles.json` dagi biror profil bilan bir xil. */
export function isDemoProfile(profile: BusinessProfile, demoPath = demoProfilePath): boolean {
  const candidates: BusinessProfile[] = listDemoProfileKeys().map((key) => loadDemoProfile(key));
  if (existsSync(demoPath)) {
    try {
      candidates.push(parseBusinessProfileJson(readFileSync(demoPath, 'utf8'), shortPath(demoPath)));
    } catch {
      // buzuq namuna — taqqoslanmaydi
    }
  }
  return candidates.some((demo) => sameProfile(profile, demo));
}

export interface BusinessDataPaths {
  profilePath?: string;
  demoPath?: string;
  scriptPath?: string;
}

/**
 * Harness uchun profil + skript. `demoKey` berilsa — demo profil (skriptsiz);
 * aks holda `harness/data/business-profile.json` (bo'lmasa — demo namuna
 * `business-profile.demo.json`, "DEMO MA'LUMOT" belgisi bilan).
 */
export function resolveBusinessData(demoKey?: string, paths: BusinessDataPaths = {}): ResolvedBusinessData {
  if (demoKey) {
    if (!listDemoProfileKeys().includes(demoKey)) {
      throw new BusinessDataError(
        `"${demoKey}" demo profili yo'q. Mavjud: ${listDemoProfileKeys().join(', ')}`,
      );
    }
    return { profile: loadDemoProfile(demoKey), source: `demo:${demoKey}`, script: null, isDemo: true };
  }
  const profilePath = paths.profilePath ?? businessProfilePath;
  const demoPath = paths.demoPath ?? demoProfilePath;
  const scriptPath = paths.scriptPath ?? salesScriptPath;
  if (!existsSync(profilePath) && existsSync(demoPath)) {
    return {
      profile: loadBusinessProfileFile(demoPath),
      source: shortPath(demoPath),
      script: loadSalesScriptFile(scriptPath),
      isDemo: true,
    };
  }
  const profile = loadBusinessProfileFile(profilePath);
  return {
    profile,
    source: shortPath(profilePath),
    script: loadSalesScriptFile(scriptPath),
    isDemo: isDemoProfile(profile, demoPath),
  };
}

/** Startda bir qator: qaysi FAYL o'qildi, demo-mi, skript bormi (nechta bosqich). */
export function describeBusinessData(data: ResolvedBusinessData): string {
  return (
    `Biznes: ${data.source} (${data.profile.industry})` +
    (data.isDemo ? " · DEMO MA'LUMOT (haqiqiy profil emas)" : '') +
    ` · skript: ${data.script ? `${data.script.stages.length} bosqich` : "yo'q"}`
  );
}
