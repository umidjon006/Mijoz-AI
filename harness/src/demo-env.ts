/**
 * FAQAT LOKAL HARNESS. `play` va `smoke-llm` uchun umumiy tayyorgarlik:
 * demo biznes/foydalanuvchi qatorlari va demo profilni o'qish.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import {
  profileSchema,
  type BusinessProfile,
} from '../../module/backend/src/training/profile-schema.js';
import { ARCHETYPE_KEYS, type ArchetypeKey } from '../../module/backend/src/training/archetypes.js';
import type { TrainingContext } from '../../module/backend/src/training/ports.js';
import { superuserDatabaseUrl } from './withTenant.js';

const here = dirname(fileURLToPath(import.meta.url));
const profilesPath = resolve(
  here,
  '../../module/backend/src/training/demo-profiles.json',
);

/** Barqaror demo id'lar — har ishga tushirishda bir xil. */
export const DEMO_BUSINESS_ID = '11111111-1111-1111-1111-111111111111';
export const DEMO_USER_ID = '22222222-2222-2222-2222-222222222222';

export const DEMO_CONTEXT: TrainingContext = {
  businessId: DEMO_BUSINESS_ID,
  userId: DEMO_USER_ID,
  seatId: null,
};

export function listDemoProfileKeys(): string[] {
  const raw: unknown = JSON.parse(readFileSync(profilesPath, 'utf8'));
  if (!raw || typeof raw !== 'object') return [];
  return Object.keys(raw as Record<string, unknown>).filter((key) => !key.startsWith('_'));
}

export function loadDemoProfile(key: string): BusinessProfile {
  const raw: unknown = JSON.parse(readFileSync(profilesPath, 'utf8'));
  if (!raw || typeof raw !== 'object') throw new Error('demo-profiles.json buzuq');
  const entry = (raw as Record<string, unknown>)[key];
  if (!entry) {
    throw new Error(
      `"${key}" profili yo'q. Mavjud: ${listDemoProfileKeys().join(', ')}`,
    );
  }
  return profileSchema.parse(entry);
}

/** Demo biznes/foydalanuvchini yaratadi (idempotent, superuser bilan). */
export async function ensureDemoRows(): Promise<void> {
  const client = new Client({ connectionString: superuserDatabaseUrl() });
  await client.connect();
  try {
    await client.query(
      `insert into business (id, name) values ($1, 'Demo biznes')
         on conflict (id) do nothing`,
      [DEMO_BUSINESS_ID],
    );
    await client.query(
      `insert into app_user (id, business_id, email) values ($1, $2, 'demo@local')
         on conflict (id) do nothing`,
      [DEMO_USER_ID, DEMO_BUSINESS_ID],
    );
  } finally {
    await client.end();
  }
}

export interface CliArgs {
  archetype: string;
  /** Demo profil kaliti — faqat `--profile` berilganda; aks holda `harness/data/`. */
  profile?: string;
  direction?: 'inbound' | 'outbound';
  debug: boolean;
  sessions?: number;
}

/**
 * `DEMO_ARCHETYPES=ready_buyer,negotiator` — UI'da ko'rsatiladigan mijoz turlari.
 * Bo'sh -> `undefined` (hammasi). Noma'lum kalit jim o'tkazilmaydi — xato.
 */
export function parseArchetypeList(raw: string | undefined): ArchetypeKey[] | undefined {
  const keys = (raw ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  if (keys.length === 0) return undefined;
  const unknown = keys.filter((k) => !(ARCHETYPE_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    throw new Error(
      `DEMO_ARCHETYPES da noma'lum mijoz turi: ${unknown.join(', ')}. Mavjud: ${ARCHETYPE_KEYS.join(', ')}`,
    );
  }
  return [...new Set(keys)] as ArchetypeKey[];
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    if (index === -1) return undefined;
    return argv[index + 1];
  };

  const rawDirection = get('direction');
  const direction =
    rawDirection === 'inbound' || rawDirection === 'outbound' ? rawDirection : undefined;
  if (rawDirection !== undefined && direction === undefined) {
    throw new Error('--direction faqat inbound yoki outbound');
  }
  const sessions = get('sessions');

  return {
    archetype: get('archetype') ?? 'negotiator',
    ...(get('profile') ? { profile: get('profile') as string } : {}),
    ...(direction ? { direction } : {}),
    debug: argv.includes('--debug'),
    ...(sessions ? { sessions: Number(sessions) } : {}),
  };
}
