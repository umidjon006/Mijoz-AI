/**
 * Baholash uchun DB so'rovlari. Hamma so'rov tashqaridan berilgan
 * `withTenant` tranzaksiyasi ichida bajariladi (RLS shu yerda ishlaydi).
 *
 * MUHIM: hech qachon `delete` qilinmaydi — natijalar versiyalanadi.
 */
import { and, desc, eq, lt, sql } from 'drizzle-orm';

import { trainingResult, trainingSession, trainingTurn } from '../../db/schema/training.js';
import type { TrainingTx } from '../ports.js';
import type { ScoringTurn } from './metrics.js';
import type {
  CoachingResult,
  CriterionResult,
  KeyMomentResult,
  ScoringQuality,
  ScoringStatus,
} from './scoring-types.js';
import type { SessionMetrics } from './metrics.js';

export type TrainingResultRow = typeof trainingResult.$inferSelect;
export type ScoringSessionRow = typeof trainingSession.$inferSelect;

export async function getSessionForScoring(
  tx: TrainingTx,
  sessionId: string,
): Promise<ScoringSessionRow | undefined> {
  const rows = await tx
    .select()
    .from(trainingSession)
    .where(eq(trainingSession.id, sessionId))
    .limit(1);
  return rows[0];
}

/**
 * Sessiya qatorini tranzaksiya oxirigacha qulflaydi (`FOR UPDATE`): bir
 * sessiyani parallel baholash so'rovlari shu yerda navbatga turadi.
 */
export async function lockSessionForScoring(tx: TrainingTx, sessionId: string): Promise<void> {
  await tx
    .select({ id: trainingSession.id })
    .from(trainingSession)
    .where(eq(trainingSession.id, sessionId))
    .for('update');
}

export async function getTurnsForScoring(
  tx: TrainingTx,
  sessionId: string,
): Promise<ScoringTurn[]> {
  const rows = await tx
    .select({
      seq: trainingTurn.seq,
      speaker: trainingTurn.speaker,
      text: trainingTurn.text,
      stateAfter: trainingTurn.stateAfter,
      createdAt: trainingTurn.createdAt,
    })
    .from(trainingTurn)
    .where(eq(trainingTurn.sessionId, sessionId))
    .orderBy(trainingTurn.seq);

  return rows.map((row) => ({
    seq: row.seq,
    speaker: row.speaker === 'customer' ? ('customer' as const) : ('seller' as const),
    text: row.text,
    stateAfter: row.stateAfter,
    createdAt: row.createdAt,
  }));
}

export async function maxResultVersion(tx: TrainingTx, sessionId: string): Promise<number> {
  const rows = await tx
    .select({ maxVersion: sql<number>`coalesce(max(${trainingResult.version}), 0)` })
    .from(trainingResult)
    .where(eq(trainingResult.sessionId, sessionId));
  return Number(rows[0]?.maxVersion ?? 0);
}

export interface InsertPendingInput {
  businessId: string;
  sessionId: string;
  version: number;
  metrics: SessionMetrics;
  createdAt: Date;
}

export async function insertPendingResult(
  tx: TrainingTx,
  input: InsertPendingInput,
): Promise<string> {
  const rows = await tx
    .insert(trainingResult)
    .values({
      businessId: input.businessId,
      sessionId: input.sessionId,
      version: input.version,
      status: 'pending',
      quality: 'ok',
      metrics: input.metrics,
      createdAt: input.createdAt,
    })
    .returning({ id: trainingResult.id });

  const id = rows[0]?.id;
  if (!id) throw new Error('training_result yozilmadi');
  return id;
}

export interface FinishResultInput {
  resultId: string;
  status: ScoringStatus;
  quality: ScoringQuality;
  skillScore: number | null;
  criteria: CriterionResult[];
  coaching: CoachingResult | null;
  keyMoments: KeyMomentResult[];
  model: string | null;
  promptVersion: string;
  costUsd: number;
  error: string | null;
}

export async function finishResult(tx: TrainingTx, input: FinishResultInput): Promise<void> {
  await tx
    .update(trainingResult)
    .set({
      status: input.status,
      quality: input.quality,
      skillScore: input.skillScore === null ? null : String(input.skillScore),
      criteria: input.criteria,
      coaching: input.coaching,
      keyMoments: input.keyMoments,
      model: input.model,
      promptVersion: input.promptVersion,
      costUsd: String(input.costUsd),
      error: input.error,
    })
    .where(eq(trainingResult.id, input.resultId));
}

/**
 * `olderThan` dan oldin yaratilgan va hali `pending` turgan natijalarni
 * `failed` qiladi (o'chirmaydi — versiya saqlanadi, qayta baholash yangi
 * versiya qo'shadi). Tranzaksiya RLS ostida bo'lsa — faqat o'sha tenant'niki.
 * Qaytaradi: nechta qator o'zgardi.
 */
export async function failStalePendingResults(
  tx: TrainingTx,
  input: { olderThan: Date; error: string },
): Promise<number> {
  const rows = await tx
    .update(trainingResult)
    .set({ status: 'failed', error: input.error })
    .where(and(eq(trainingResult.status, 'pending'), lt(trainingResult.createdAt, input.olderThan)))
    .returning({ id: trainingResult.id });
  return rows.length;
}

/** Oxirgi versiya; `status` berilsa faqat shu holatdagilar orasidan. */
export async function getLatestResult(
  tx: TrainingTx,
  sessionId: string,
  status?: ScoringStatus,
): Promise<TrainingResultRow | null> {
  const rows = await tx
    .select()
    .from(trainingResult)
    .where(
      status
        ? and(eq(trainingResult.sessionId, sessionId), eq(trainingResult.status, status))
        : eq(trainingResult.sessionId, sessionId),
    )
    .orderBy(desc(trainingResult.version))
    .limit(1);
  return rows[0] ?? null;
}

export async function listResultVersions(
  tx: TrainingTx,
  sessionId: string,
): Promise<TrainingResultRow[]> {
  return await tx
    .select()
    .from(trainingResult)
    .where(eq(trainingResult.sessionId, sessionId))
    .orderBy(desc(trainingResult.version));
}

// ---------------------------------------------------------------------------
// Statistika
// ---------------------------------------------------------------------------
export interface SessionListRow {
  id: string;
  archetypeKey: string;
  status: string;
  outcome: string | null;
  endReason: string | null;
  turnCount: number;
  startedAt: Date;
  endedAt: Date | null;
  skillScore: string | null;
  resultStatus: string | null;
  resultQuality: string | null;
}

/** Foydalanuvchining sessiyalari + har biriga oxirgi tugallangan natija balli. */
export async function listSessionsWithScore(
  tx: TrainingTx,
  userId: string,
  limit = 50,
): Promise<SessionListRow[]> {
  /**
   * Har sessiya uchun oxirgi TUGALLANGAN natija.
   *
   * DIQQAT: subquery ichida `${trainingSession.id}` YOZILMAYDI — Drizzle uni
   * jadval nomisiz `"id"` qilib chiqaradi, u esa subquery ichida
   * `training_result.id` ga tegib ketadi va shart HECH QACHON bajarilmaydi
   * (natija jim-jitlik bilan `null` bo'ladi). Shuning uchun ustun to'liq
   * nomi bilan yoziladi.
   */
  const sessionIdRef = sql.raw('"training_session"."id"');
  const latestField = (column: 'skill_score' | 'status' | 'quality') => sql<string | null>`(
    select r.${sql.raw(column)}
      from training_result r
     where r.session_id = ${sessionIdRef}
       and r.status = 'done'
     order by r.version desc
     limit 1
  )`;

  const rows = await tx
    .select({
      id: trainingSession.id,
      archetypeKey: trainingSession.archetypeKey,
      status: trainingSession.status,
      outcome: trainingSession.outcome,
      endReason: trainingSession.endReason,
      turnCount: trainingSession.turnCount,
      startedAt: trainingSession.startedAt,
      endedAt: trainingSession.endedAt,
      skillScore: latestField('skill_score'),
      resultStatus: latestField('status'),
      resultQuality: latestField('quality'),
    })
    .from(trainingSession)
    .where(eq(trainingSession.userId, userId))
    .orderBy(desc(trainingSession.startedAt))
    .limit(limit);

  return rows;
}

export interface CriterionAverage {
  code: string;
  name: string;
  avgScore: number;
  samples: number;
}

/**
 * Mezonlar bo'yicha o'rtacha ball (eng zaif tomonlarni topish uchun).
 * jsonb ichidan ochib hisoblanadi; `null` baholar hisobga kirmaydi.
 */
export async function criterionAverages(
  tx: TrainingTx,
  userId: string,
): Promise<CriterionAverage[]> {
  const result = await tx.execute(sql`
    with latest as (
      select r.*
        from training_result r
        join training_session s on s.id = r.session_id
       where s.user_id = ${userId}
         and r.status = 'done'
         and r.version = (
           select max(r2.version) from training_result r2
            where r2.session_id = r.session_id and r2.status = 'done'
         )
    )
    select item->>'code' as code,
           max(item->>'name') as name,
           avg((item->>'score')::numeric) as avg_score,
           count(*) as samples
      from latest, jsonb_array_elements(coalesce(latest.criteria, '[]'::jsonb)) as item
     where item->>'score' is not null
     group by item->>'code'
     order by avg((item->>'score')::numeric) asc
  `);

  const rows = (result as unknown as { rows?: unknown[] }).rows ?? [];
  return rows.map((raw) => {
    const row = raw as { code: string; name: string | null; avg_score: string; samples: string };
    return {
      code: row.code,
      name: row.name ?? row.code,
      avgScore: Number(Number(row.avg_score).toFixed(2)),
      samples: Number(row.samples),
    };
  });
}
