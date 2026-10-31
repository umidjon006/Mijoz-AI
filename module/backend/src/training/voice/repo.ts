/**
 * Ovozli navbat uchun DB yordamchilari. Boshqa repo'lar kabi hammasi
 * tashqaridan berilgan `withTenant` tranzaksiyasi ichida bajariladi.
 *
 * Mavjud `training_turn.state_after` ustuni ishlatiladi: unda allaqachon
 * `meta` kaliti bor (motorning telemetriyasi), `scoring/metrics.ts` ham
 * shundan `voiceRepeatRequests` ni sanaydi. Shuning uchun YANGI USTUN
 * QO'SHILMAYDI — ovoz telemetriyasi o'sha `meta` ga qo'shiladi.
 */
import { and, eq, sql } from 'drizzle-orm';

import { trainingSession, trainingTurn } from '../../db/schema/training.js';
import type { TrainingTx } from '../ports.js';

/**
 * Sessiya uchun ovozli navbat QULFI (bir vaqtda bitta navbat).
 *
 * Nega advisory lock, `SELECT ... FOR UPDATE` emas: motor (`engine.takeTurn`)
 * O'ZINING tranzaksiyasida sessiya qatorini `FOR UPDATE` bilan oladi. Agar
 * biz ham o'sha qatorni ushlab tursak, motor o'zimizni kutib qolardi
 * (deadlock). Advisory lock qatorga TEGMAYDI, shuning uchun motor
 * bemalol ishlaydi, parallel ikkinchi ovozli navbat esa darhol `false` oladi.
 *
 * Qulf TRANZAKSIYA tugashi bilan o'zi bo'shaydi (`_xact_`) — jarayon
 * o'lib qolsa ham osilib qolmaydi.
 */
export async function tryLockSessionForVoice(
  tx: TrainingTx,
  sessionId: string,
): Promise<boolean> {
  const result = await tx.execute(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${`voice:${sessionId}`}, 0)) as locked`,
  );
  // Drayverga qarab `execute` yo massiv, yo `{ rows }` qaytaradi
  // (node-postgres — `QueryResult`). Ikkalasini ham qo'llaymiz, aks holda
  // qulf JIM ravishda "band" bo'lib ko'rinardi.
  const rows = (Array.isArray(result)
    ? result
    : ((result as { rows?: unknown[] }).rows ?? [])) as Array<{ locked?: boolean | string }>;
  const locked = rows[0]?.locked;
  return locked === true || locked === 't';
}

/**
 * Navbat yozuvining `state_after.meta` siga qo'shimcha maydonlar qo'shadi
 * (mavjudlarini o'chirmaydi).
 *
 * Sotuvchi navbatida `state_after` umuman `null` bo'ladi — shuning uchun
 * `coalesce`.
 */
export async function mergeTurnMeta(
  tx: TrainingTx,
  input: { sessionId: string; seq: number; meta: Record<string, unknown> },
): Promise<void> {
  const patch = JSON.stringify(input.meta);
  await tx
    .update(trainingTurn)
    .set({
      stateAfter: sql`
        coalesce(${trainingTurn.stateAfter}, '{}'::jsonb)
        || jsonb_build_object(
             'meta',
             coalesce(${trainingTurn.stateAfter} -> 'meta', '{}'::jsonb) || ${patch}::jsonb
           )
      ` as never,
    })
    .where(and(eq(trainingTurn.sessionId, input.sessionId), eq(trainingTurn.seq, input.seq)));
}

/** Sessiyadagi eng katta `seq` (motor yozib bo'lgandan keyin chaqiriladi). */
export async function maxTurnSeq(tx: TrainingTx, sessionId: string): Promise<number> {
  const rows = await tx
    .select({ maxSeq: sql<number>`coalesce(max(${trainingTurn.seq}), 0)` })
    .from(trainingTurn)
    .where(eq(trainingTurn.sessionId, sessionId));
  return Number(rows[0]?.maxSeq ?? 0);
}

/**
 * Shu sessiyada shu paytgacha qancha AUDIO ishlatilgan (sekund).
 * Byudjet qo'riqchisi shu songa qaraydi. Yozuvlar `meta.voiceSec` da.
 */
export async function usedVoiceSeconds(tx: TrainingTx, sessionId: string): Promise<number> {
  const rows = await tx
    .select({
      total: sql<string>`coalesce(sum((${trainingTurn.stateAfter} -> 'meta' ->> 'voiceSec')::numeric), 0)`,
    })
    .from(trainingTurn)
    .where(eq(trainingTurn.sessionId, sessionId));
  return Number(rows[0]?.total ?? 0);
}

/** Shu sessiyada nechta "takrorlaysizmi" bo'lgan (cheklovni shu sanaydi). */
export async function countRepeatTurns(tx: TrainingTx, sessionId: string): Promise<number> {
  const rows = await tx
    .select({ total: sql<string>`count(*)` })
    .from(trainingTurn)
    .where(
      and(
        eq(trainingTurn.sessionId, sessionId),
        sql`${trainingTurn.stateAfter} -> 'meta' ->> 'needsRepeat' = 'true'`,
      ),
    );
  return Number(rows[0]?.total ?? 0);
}

/** Ovoz narxini sessiya hisobiga QO'SHADI (LLM narxi motor tomonidan qo'shiladi). */
export async function addSessionCost(
  tx: TrainingTx,
  sessionId: string,
  costUsd: number,
): Promise<void> {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return;
  await tx
    .update(trainingSession)
    .set({ costUsd: sql`${trainingSession.costUsd} + ${costUsd}` })
    .where(eq(trainingSession.id, sessionId));
}
