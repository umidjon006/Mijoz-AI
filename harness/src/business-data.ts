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
export const businessProfilePath = resolve(dataDir, 'business-profile.json');
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
  /** Qaysi manbadan: `harness/data/business-profile.json` yoki `demo:<kalit>`. */
  source: string;
  script: SalesScript | null;
}

/**
 * Harness uchun profil + skript. `demoKey` berilsa — demo profil (skriptsiz);
 * aks holda `harness/data/` dagi fayllar.
 */
export function resolveBusinessData(demoKey?: string): ResolvedBusinessData {
  if (demoKey) {
    if (!listDemoProfileKeys().includes(demoKey)) {
      throw new BusinessDataError(
        `"${demoKey}" demo profili yo'q. Mavjud: ${listDemoProfileKeys().join(', ')}`,
      );
    }
    return { profile: loadDemoProfile(demoKey), source: `demo:${demoKey}`, script: null };
  }
  return {
    profile: loadBusinessProfileFile(),
    source: shortPath(businessProfilePath),
    script: loadSalesScriptFile(),
  };
}

/** Startda bir qator: qaysi profil, skript bormi (nechta bosqich). */
export function describeBusinessData(data: ResolvedBusinessData): string {
  return (
    `Biznes: ${data.source} (${data.profile.industry}) · skript: ` +
    (data.script ? `${data.script.stages.length} bosqich` : "yo'q")
  );
}
