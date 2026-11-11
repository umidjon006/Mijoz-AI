/**
 * AI mijoz trenajyori uchun jadvallar.
 *
 * MUHIM: mashq sessiyalari asosiy `conversation` jadvaliga YOZILMAYDI —
 * faqat shu ikki jadval ishlatiladi. Ikkisi ham tenant jadvallari, ya'ni
 * `rls.sql` ichidagi `tenant_tables` ro'yxatiga qo'shilishi SHART
 * (qarang: `module/integration/rls-training.sql`).
 */
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { ARCHETYPE_KEYS } from '../../training/archetypes.js';
import type { PersonaCard } from '../../training/persona.js';
import type {
  CoachingResult,
  CriterionResult,
  KeyMomentResult,
} from '../../training/scoring/scoring-types.js';
import type { SessionMetrics } from '../../training/scoring/metrics.js';
import type { TrainingState } from '../../training/state.js';
import type { Scenario, SellerProfile } from '../../training/scenario/schema.js';
// INTEGRATSIYA: `host-tables.js` o'rniga asosiy repodagi sxemalarni import qiling.
import { appUser, business, seat } from './host-tables.js';

const keyList = ARCHETYPE_KEYS.map((key) => `'${key}'`).join(', ');

/**
 * `state` ustunining shakli — yagona manba `training/state.ts`
 * (`trainingStateSchema`). Deterministik holat mashinasi shu obyektni
 * qaytaradi, DB esa aynan shuni saqlaydi.
 */
export type TrainingSessionState = TrainingState;

/** `persona_card` ustunining shakli — `training/persona.ts` dagi sxema. */
export type TrainingPersonaCard = PersonaCard;

export const trainingSession = pgTable(
  'training_session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => business.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    seatId: uuid('seat_id').references(() => seat.id, { onDelete: 'set null' }),
    archetypeKey: text('archetype_key').notNull(),
    personaCard: jsonb('persona_card').$type<TrainingPersonaCard>(),
    state: jsonb('state').$type<TrainingSessionState>().notNull(),
    status: text('status').notNull().default('active'),
    outcome: text('outcome'),
    endReason: text('end_reason'),
    turnCount: integer('turn_count').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** Ssenariy sessiyasi: id va boshlanish paytidagi NUSXA (keyingi tahrir ta'sir qilmaydi). */
    scenarioId: text('scenario_id'),
    scenario: jsonb('scenario').$type<Scenario>(),
    /** Sotuvchi profili (ism, jins, yosh) — sessiya boshida beriladi, taxmin qilinmaydi. */
    sellerProfile: jsonb('seller_profile').$type<SellerProfile>(),
  },
  (table) => [
    index('training_session_business_user_started_idx').on(
      table.businessId,
      table.userId,
      table.startedAt.desc(),
    ),
    check('training_session_archetype_key_check', sql.raw(`archetype_key in (${keyList})`)),
    check(
      'training_session_status_check',
      sql.raw(`status in ('active', 'ended', 'abandoned')`),
    ),
    check(
      'training_session_outcome_check',
      sql.raw(`outcome is null or outcome in ('won', 'lost', 'timeout')`),
    ),
  ],
);

/** Tenant ssenariylari (`module/integration/training-scenarios.sql`). */
export const trainingScenario = pgTable(
  'training_scenario',
  {
    businessId: uuid('business_id')
      .notNull()
      .references(() => business.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    version: integer('version').notNull().default(1),
    title: text('title').notNull(),
    difficulty: smallint('difficulty').notNull(),
    insultLevel: smallint('insult_level').notNull(),
    data: jsonb('data').$type<Scenario>().notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.businessId, table.id] }),
    check('training_scenario_difficulty_check', sql.raw('difficulty between 1 and 5')),
    check('training_scenario_insult_level_check', sql.raw('insult_level between 0 and 2')),
  ],
);

export const trainingTurn = pgTable(
  'training_turn',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => trainingSession.id, { onDelete: 'cascade' }),
    businessId: uuid('business_id')
      .notNull()
      .references(() => business.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    speaker: text('speaker').notNull(),
    text: text('text').notNull(),
    stateAfter: jsonb('state_after').$type<TrainingSessionState>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('training_turn_session_seq_key').on(table.sessionId, table.seq),
    check('training_turn_speaker_check', sql.raw(`speaker in ('seller', 'customer')`)),
  ],
);

/**
 * Baholash natijasi (Step 4). MUHIM: natija VERSIYALANADI — qayta baholash
 * eski versiyani O'CHIRMAYDI, `version + 1` qo'shadi. `training_session`
 * baholash tufayli o'zgarmaydi.
 */
export const trainingResult = pgTable(
  'training_result',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => business.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => trainingSession.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: text('status').notNull().default('pending'),
    quality: text('quality').notNull().default('ok'),
    /** 0..100; hech bir mezon baholanmasa `null` (nolga aylantirilmaydi). */
    skillScore: numeric('skill_score', { precision: 5, scale: 1 }),
    criteria: jsonb('criteria').$type<CriterionResult[]>(),
    metrics: jsonb('metrics').$type<SessionMetrics>(),
    coaching: jsonb('coaching').$type<CoachingResult>(),
    keyMoments: jsonb('key_moments').$type<KeyMomentResult[]>(),
    model: text('model'),
    promptVersion: text('prompt_version'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('training_result_session_version_key').on(table.sessionId, table.version),
    index('training_result_business_session_idx').on(
      table.businessId,
      table.sessionId,
      table.version.desc(),
    ),
    check(
      'training_result_status_check',
      sql.raw(`status in ('pending', 'done', 'failed')`),
    ),
    check(
      'training_result_quality_check',
      sql.raw(`quality in ('ok', 'low', 'insufficient')`),
    ),
  ],
);

export type TrainingResultRow = typeof trainingResult.$inferSelect;
export type NewTrainingResult = typeof trainingResult.$inferInsert;

export type TrainingSessionRow = typeof trainingSession.$inferSelect;
export type NewTrainingSession = typeof trainingSession.$inferInsert;
export type TrainingTurnRow = typeof trainingTurn.$inferSelect;
export type NewTrainingTurn = typeof trainingTurn.$inferInsert;
