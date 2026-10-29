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
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { ARCHETYPE_KEYS } from '../../training/archetypes.js';
// INTEGRATSIYA: `host-tables.js` o'rniga asosiy repodagi sxemalarni import qiling.
import { appUser, business, seat } from './host-tables.js';

const keyList = ARCHETYPE_KEYS.map((key) => `'${key}'`).join(', ');

/** Sessiya holati (deterministik mantiq — Step 2 da to'ldiriladi). */
export interface TrainingSessionState {
  patience: number;
  trust: number;
  interest: number;
  /** Yechilgan e'tirozlar soni / yashirin ehtiyoj ochildimi va h.k. */
  objectionsRaised?: number;
  objectionsResolved?: number;
  needDiscovered?: boolean;
  flags?: Record<string, boolean | number | string>;
}

/** AI mijoz tomonidan o'ynaladigan persona (Step 2). */
export type TrainingPersonaCard = Record<string, unknown>;

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

export type TrainingSessionRow = typeof trainingSession.$inferSelect;
export type NewTrainingSession = typeof trainingSession.$inferInsert;
export type TrainingTurnRow = typeof trainingTurn.$inferSelect;
export type NewTrainingTurn = typeof trainingTurn.$inferInsert;
