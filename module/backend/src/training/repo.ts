/**
 * DB qatlami. Hamma so'rov tashqaridan berilgan `withTenant` tranzaksiyasi
 * ichida bajariladi (RLS shu tranzaksiyada ishlaydi), shuning uchun bu
 * funksiyalar `tx` ni argument sifatida oladi va hech qachon o'zi ulanmaydi.
 */
import { and, desc, eq, sql } from 'drizzle-orm';

import { trainingSession, trainingTurn } from '../db/schema/training.js';
import type { PersonaCard } from './persona.js';
import type { TrainingTx } from './ports.js';
import type { TranscriptTurn } from './prompts.js';
import type { TrainingState } from './state.js';

export type TrainingSessionRow = typeof trainingSession.$inferSelect;

export interface InsertSessionInput {
  businessId: string;
  userId: string;
  seatId: string | null;
  archetypeKey: string;
  persona: PersonaCard;
  state: TrainingState;
  startedAt: Date;
}

export async function insertSession(
  tx: TrainingTx,
  input: InsertSessionInput,
): Promise<TrainingSessionRow> {
  const rows = await tx
    .insert(trainingSession)
    .values({
      businessId: input.businessId,
      userId: input.userId,
      seatId: input.seatId,
      archetypeKey: input.archetypeKey,
      personaCard: input.persona,
      state: input.state,
      status: 'active',
      turnCount: 0,
      startedAt: input.startedAt,
    })
    .returning();

  const row = rows[0];
  if (!row) throw new Error('training_session yozilmadi');
  return row;
}

/**
 * Sessiyani qulflab o'qiydi (`for update`). Qulf shu sessiya uchun
 * parallel `takeTurn` chaqiruvlarini ketma-ket qiladi — seq'lar bo'shliqsiz
 * va unikal bo'lib qoladi (unique index esa oxirgi himoya).
 */
export async function getSessionForUpdate(
  tx: TrainingTx,
  sessionId: string,
): Promise<TrainingSessionRow | undefined> {
  const rows = await tx
    .select()
    .from(trainingSession)
    .where(eq(trainingSession.id, sessionId))
    .for('update')
    .limit(1);
  return rows[0];
}

export async function getSession(
  tx: TrainingTx,
  sessionId: string,
): Promise<TrainingSessionRow | undefined> {
  const rows = await tx
    .select()
    .from(trainingSession)
    .where(eq(trainingSession.id, sessionId))
    .limit(1);
  return rows[0];
}

/** Oxirgi N navbat, vaqt tartibida (eski -> yangi). */
export async function getRecentTurns(
  tx: TrainingTx,
  sessionId: string,
  limit: number,
): Promise<TranscriptTurn[]> {
  const rows = await tx
    .select({ speaker: trainingTurn.speaker, text: trainingTurn.text })
    .from(trainingTurn)
    .where(eq(trainingTurn.sessionId, sessionId))
    .orderBy(desc(trainingTurn.seq))
    .limit(limit);

  return rows
    .map((row) => ({
      speaker: row.speaker === 'customer' ? ('customer' as const) : ('seller' as const),
      text: row.text,
    }))
    .reverse();
}

/** Keyingi bo'sh seq (1 dan boshlanadi). */
export async function nextSeq(tx: TrainingTx, sessionId: string): Promise<number> {
  const rows = await tx
    .select({ maxSeq: sql<number>`coalesce(max(${trainingTurn.seq}), 0)` })
    .from(trainingTurn)
    .where(eq(trainingTurn.sessionId, sessionId));
  return Number(rows[0]?.maxSeq ?? 0) + 1;
}

export interface InsertTurnInput {
  sessionId: string;
  businessId: string;
  seq: number;
  speaker: 'seller' | 'customer';
  text: string;
  /** Mijoz navbatida — navbatdan keyingi holat + telemetriya. */
  stateAfter?: unknown;
  createdAt: Date;
}

export async function insertTurn(tx: TrainingTx, input: InsertTurnInput): Promise<void> {
  await tx.insert(trainingTurn).values({
    sessionId: input.sessionId,
    businessId: input.businessId,
    seq: input.seq,
    speaker: input.speaker,
    text: input.text,
    stateAfter: (input.stateAfter ?? null) as never,
    createdAt: input.createdAt,
  });
}

export interface UpdateSessionInput {
  sessionId: string;
  state: TrainingState;
  turnCount: number;
  /** Shu navbatning narxi (USD) — mavjud qiymatga QO'SHILADI. */
  addCostUsd: number;
  ended: boolean;
  outcome?: string;
  endReason?: string;
  endedAt?: Date;
}

export async function updateSessionAfterTurn(
  tx: TrainingTx,
  input: UpdateSessionInput,
): Promise<void> {
  await tx
    .update(trainingSession)
    .set({
      state: input.state,
      turnCount: input.turnCount,
      costUsd: sql`${trainingSession.costUsd} + ${input.addCostUsd}`,
      ...(input.ended
        ? {
            status: 'ended',
            outcome: input.outcome ?? null,
            endReason: input.endReason ?? null,
            endedAt: input.endedAt ?? new Date(),
          }
        : {}),
    })
    .where(eq(trainingSession.id, input.sessionId));
}

export async function markAbandoned(
  tx: TrainingTx,
  sessionId: string,
  reason: string,
  endedAt: Date,
): Promise<void> {
  await tx
    .update(trainingSession)
    .set({ status: 'abandoned', endReason: reason, endedAt })
    .where(and(eq(trainingSession.id, sessionId), eq(trainingSession.status, 'active')));
}
