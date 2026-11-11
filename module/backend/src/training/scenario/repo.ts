/**
 * Ssenariylar DB qatlami (`training_scenario`, RLS bilan). Hamma funksiya
 * tashqaridan berilgan `withTenant` tranzaksiyasini oladi.
 * Yozishdan OLDIN va o'qishdan KEYIN ssenariy sxema bilan tekshiriladi.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { trainingScenario } from '../../db/schema/training.js';
import type { TrainingTx } from '../ports.js';
import { contentFlag, parseScenario, type ContentFlag, type Scenario } from './schema.js';

export interface ScenarioSummary {
  id: string;
  title: string;
  description: string;
  difficulty: number;
  callDirection: Scenario['call_direction'];
  relationship: Scenario['relationship'];
  content: ContentFlag;
  version: number;
}

export function summarize(s: Scenario, version = 1): ScenarioSummary {
  return {
    id: s.id,
    title: s.title_uz,
    description: s.description_uz,
    difficulty: s.difficulty,
    callDirection: s.call_direction,
    relationship: s.relationship,
    content: contentFlag(s),
    version,
  };
}

/** Qo'shadi yoki yangilaydi (ma'lumot o'zgargan bo'lsa versiya +1). */
export async function upsertScenario(
  tx: TrainingTx,
  businessId: string,
  raw: unknown,
  source = 'scenario',
): Promise<{ scenario: Scenario; changed: boolean }> {
  const scenario = parseScenario(raw, source);
  const existing = await tx
    .select({ data: trainingScenario.data, version: trainingScenario.version })
    .from(trainingScenario)
    .where(and(eq(trainingScenario.businessId, businessId), eq(trainingScenario.id, scenario.id)))
    .limit(1);
  const prev = existing[0];
  if (prev && JSON.stringify(prev.data) === JSON.stringify(scenario)) return { scenario, changed: false };
  const values = {
    title: scenario.title_uz,
    difficulty: scenario.difficulty,
    insultLevel: scenario.behavior.insult_level,
    data: scenario,
    isActive: true,
    updatedAt: new Date(),
  };
  if (prev) {
    await tx
      .update(trainingScenario)
      .set({ ...values, version: sql`${trainingScenario.version} + 1` })
      .where(and(eq(trainingScenario.businessId, businessId), eq(trainingScenario.id, scenario.id)));
  } else {
    await tx.insert(trainingScenario).values({ businessId, id: scenario.id, ...values });
  }
  return { scenario, changed: true };
}

export async function getScenario(tx: TrainingTx, id: string): Promise<Scenario | null> {
  const rows = await tx
    .select({ data: trainingScenario.data })
    .from(trainingScenario)
    .where(and(eq(trainingScenario.id, id), eq(trainingScenario.isActive, true)))
    .limit(1);
  const row = rows[0];
  return row ? parseScenario(row.data, `training_scenario:${id}`) : null;
}

export async function listScenarios(tx: TrainingTx): Promise<ScenarioSummary[]> {
  const rows = await tx
    .select({ data: trainingScenario.data, version: trainingScenario.version })
    .from(trainingScenario)
    .where(eq(trainingScenario.isActive, true))
    .orderBy(asc(trainingScenario.difficulty), asc(trainingScenario.id));
  const out: ScenarioSummary[] = [];
  for (const r of rows) {
    try {
      out.push(summarize(parseScenario(r.data), r.version));
    } catch {
      // DB'da yaroqsiz qator — ro'yxatda ko'rsatilmaydi (yozishda tekshiriladi).
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rahbar (manager) amallari — har yozuvdan OLDIN to'liq sxema tekshiruvi.
// ---------------------------------------------------------------------------
export interface ScenarioRecord {
  scenario: Scenario;
  version: number;
  isActive: boolean;
  updatedAt: Date;
}

export async function getScenarioRecord(tx: TrainingTx, id: string): Promise<ScenarioRecord | null> {
  const rows = await tx
    .select({
      data: trainingScenario.data,
      version: trainingScenario.version,
      isActive: trainingScenario.isActive,
      updatedAt: trainingScenario.updatedAt,
    })
    .from(trainingScenario)
    .where(eq(trainingScenario.id, id))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return { scenario: parseScenario(r.data, `training_scenario:${id}`), version: r.version, isActive: r.isActive, updatedAt: r.updatedAt };
}

/** Rahbar ro'yxati: arxivlanganlar ham (belgisi bilan). */
export async function listAllScenarios(tx: TrainingTx): Promise<Array<ScenarioSummary & { isActive: boolean }>> {
  const rows = await tx
    .select({ data: trainingScenario.data, version: trainingScenario.version, isActive: trainingScenario.isActive })
    .from(trainingScenario)
    .orderBy(asc(trainingScenario.difficulty), asc(trainingScenario.id));
  const out: Array<ScenarioSummary & { isActive: boolean }> = [];
  for (const r of rows) {
    try {
      out.push({ ...summarize(parseScenario(r.data), r.version), isActive: r.isActive });
    } catch {
      // yaroqsiz qator — ko'rsatilmaydi
    }
  }
  return out;
}

export class ScenarioExistsError extends Error {
  constructor(id: string) {
    super(`"${id}" ID li ssenariy allaqachon bor`);
    this.name = 'ScenarioExistsError';
  }
}

export async function createScenario(tx: TrainingTx, businessId: string, raw: unknown): Promise<Scenario> {
  const scenario = parseScenario(raw, 'ssenariy');
  if (await getScenarioRecord(tx, scenario.id)) throw new ScenarioExistsError(scenario.id);
  await tx.insert(trainingScenario).values({
    businessId,
    id: scenario.id,
    title: scenario.title_uz,
    difficulty: scenario.difficulty,
    insultLevel: scenario.behavior.insult_level,
    data: scenario,
    isActive: true,
  });
  return scenario;
}

/** Tahrir: id o'zgarmaydi; versiya +1. Ketayotgan sessiyalar o'z nusxasida qoladi. */
export async function updateScenario(tx: TrainingTx, id: string, raw: unknown): Promise<Scenario | null> {
  const scenario = parseScenario({ ...(raw as Record<string, unknown>), id }, 'ssenariy');
  const updated = await tx
    .update(trainingScenario)
    .set({
      title: scenario.title_uz,
      difficulty: scenario.difficulty,
      insultLevel: scenario.behavior.insult_level,
      data: scenario,
      version: sql`${trainingScenario.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(trainingScenario.id, id))
    .returning({ id: trainingScenario.id });
  return updated.length ? scenario : null;
}

export async function setScenarioActive(tx: TrainingTx, id: string, active: boolean): Promise<boolean> {
  const r = await tx
    .update(trainingScenario)
    .set({ isActive: active, updatedAt: new Date() })
    .where(eq(trainingScenario.id, id))
    .returning({ id: trainingScenario.id });
  return r.length > 0;
}

/** Nusxa: yangi id (`<id>_nusxa`, band bo'lsa `_nusxa2` ...), nom "(nusxa)". */
export async function duplicateScenario(tx: TrainingTx, businessId: string, id: string): Promise<Scenario | null> {
  const src = await getScenarioRecord(tx, id);
  if (!src) return null;
  const base = `${id.slice(0, 52)}_nusxa`;
  let newId = base;
  for (let i = 2; await getScenarioRecord(tx, newId); i += 1) newId = `${base}${i}`;
  return await createScenario(tx, businessId, {
    ...src.scenario,
    id: newId,
    title_uz: `${src.scenario.title_uz} (nusxa)`.slice(0, 120),
  });
}

/** Nomdan id: lotin harflar, "_" bilan; band bo'lsa raqam qo'shiladi. */
export async function freeScenarioId(tx: TrainingTx, title: string): Promise<string> {
  const map: Record<string, string> = { "o'": 'o', "g'": 'g', sh: 'sh', ch: 'ch' };
  let slug = title
    .toLowerCase()
    .replace(/[ʻʼ’‘`´]/g, "'")
    .replace(/o'|g'/g, (m) => map[m] ?? m)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
  if (!/^[a-z]/.test(slug)) slug = `ssenariy_${slug}`.replace(/_+$/, '');
  if (slug.length < 3) slug = 'ssenariy';
  let id = slug;
  for (let i = 2; await getScenarioRecord(tx, id); i += 1) id = `${slug}_${i}`;
  return id;
}
