/**
 * FAQAT HARNESS. `harness/scenarios/*.json` -> tekshirish -> DB (`training_scenario`).
 * Yaroqsiz fayl RAD ETILADI (aniq xabar bilan) — boshqalari yuklanaveradi.
 * (Part 3 — menejer UI'si ham shu `upsertScenario` orqali yozadi.)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { WithTenant } from '../../module/backend/src/training/ports.js';
import { upsertScenario } from '../../module/backend/src/training/scenario/repo.js';
import { validateScenario, type Scenario } from '../../module/backend/src/training/scenario/schema.js';
import { harnessRoot } from './env.js';

export const scenariosDir = resolve(harnessRoot, 'scenarios');

export interface ScenarioFiles {
  valid: Array<{ file: string; scenario: Scenario }>;
  errors: string[];
}

export function loadScenarioFiles(dir = scenariosDir): ScenarioFiles {
  const out: ScenarioFiles = { valid: [], errors: [] };
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.schema.json')).sort();
  } catch {
    return out;
  }
  const seen = new Set<string>();
  for (const f of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch (err) {
      out.errors.push(`${f}: JSON xato — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const v = validateScenario(raw, f);
    if (!v.ok) {
      out.errors.push(...v.errors);
      continue;
    }
    if (seen.has(v.scenario.id)) {
      out.errors.push(`${f}: id "${v.scenario.id}" takrorlangan`);
      continue;
    }
    seen.add(v.scenario.id);
    out.valid.push({ file: f, scenario: v.scenario });
  }
  return out;
}

/** Fayllarni DB'ga yozadi (o'zgarganlarini). Natija — log uchun qisqa matn. */
export async function syncScenarios(withTenant: WithTenant, businessId: string, dir = scenariosDir): Promise<string> {
  const { valid, errors } = loadScenarioFiles(dir);
  let changed = 0;
  for (const { file, scenario } of valid) {
    const r = await withTenant(businessId, (tx) => upsertScenario(tx, businessId, scenario, file));
    if (r.changed) changed += 1;
  }
  return (
    `Ssenariylar: ${valid.length} ta yuklandi (${changed} ta yangilandi)` +
    (errors.length ? `; RAD ETILDI:\n  - ${errors.join('\n  - ')}` : '')
  );
}
