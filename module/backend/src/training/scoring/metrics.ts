/**
 * Deterministik o'lchovlar va "muhim lahza" nomzodlari — SOF funksiyalar.
 *
 * Qoida (Step 4, 3-qoida): LLM tushuntiradi va baho qo'yadi, KOD esa
 * hisoblaydi va tekshiradi. Shu fayldagi hamma raqam faqat saqlangan
 * navbatlar va `state_after` tarixidan olinadi — LLM'ga hech narsa
 * ishonilmaydi.
 */
import type { Archetype } from '../archetypes.js';
import type { PersonaCard } from '../persona.js';
import { trainingStateSchema, type TrainingState } from '../state.js';

export interface ScoringTurn {
  seq: number;
  speaker: 'seller' | 'customer';
  text: string;
  /** Mijoz navbatlarida — navbatdan keyingi holat (+ `meta` telemetriyasi). */
  stateAfter?: unknown;
  createdAt?: Date | string | null;
}

export interface ScoringSession {
  id: string;
  archetypeKey: string;
  status: string;
  outcome: string | null;
  endReason: string | null;
  turnCount: number;
  startedAt?: Date | string | null;
  endedAt?: Date | string | null;
}

export interface StatePoint {
  turnSeq: number;
  patience: number;
  trust: number;
  interest: number;
}

export interface SessionMetrics {
  outcome: string | null;
  endReason: string | null;
  /** Sotuvchi navbatlari soni. */
  sellerTurns: number;
  customerTurns: number;
  /** Sotuvchi so'zlarining umumiy so'zlardagi ulushi (0..1). */
  sellerWordShare: number;
  sellerWords: number;
  customerWords: number;
  /** Sotuvchining o'rtacha navbat uzunligi (so'z). */
  avgSellerTurnWords: number;
  longestSellerTurnWords: number;
  durationSec: number | null;
  /** Holat egri chizig'i (grafik uchun). */
  series: StatePoint[];
  finalState: TrainingState | null;
  objections: {
    planned: number;
    raised: string[];
    resolved: string[];
    unresolved: string[];
  };
  /** Yashirin ehtiyojli arxetiplarda — ochildimi; boshqalarda `null`. */
  needRevealed: boolean | null;
  guardViolations: number;
  /** Ovozli mashqda "qaytaring" so'rovlari soni (bo'lmasa 0). */
  voiceRepeatRequests: number;
}

export type KeyMomentKind =
  | 'objection_raised'
  | 'objection_resolved'
  | 'trust_drop'
  | 'trust_rise'
  | 'patience_drop'
  | 'final_turn';

export interface KeyMomentCandidate {
  turnSeq: number;
  kind: KeyMomentKind;
  /** Kodda hisoblangan o'zgarish — LLM tushuntirishi shunga tayanadi. */
  trustDelta?: number;
  patienceDelta?: number;
  objectionKeys?: string[];
}

export const MAX_KEY_MOMENTS = 8;

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseState(raw: unknown): TrainingState | null {
  if (raw === null || typeof raw !== 'object') return null;
  const parsed = trainingStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** `state_after` ichidagi `meta` (Step 2/3 telemetriyasi). */
function parseMeta(raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== 'object') return null;
  const meta = (raw as { meta?: unknown }).meta;
  return meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : null;
}

export function computeMetrics(
  session: ScoringSession,
  turns: readonly ScoringTurn[],
  archetype: Archetype,
  persona: PersonaCard,
): SessionMetrics {
  const ordered = [...turns].sort((a, b) => a.seq - b.seq);
  const sellerTurns = ordered.filter((t) => t.speaker === 'seller');
  const customerTurns = ordered.filter((t) => t.speaker === 'customer');

  const sellerWordCounts = sellerTurns.map((t) => countWords(t.text));
  const sellerWords = sellerWordCounts.reduce((a, b) => a + b, 0);
  const customerWords = customerTurns.reduce((sum, t) => sum + countWords(t.text), 0);
  const totalWords = sellerWords + customerWords;

  const series: StatePoint[] = [];
  let finalState: TrainingState | null = null;
  let voiceRepeatRequests = 0;

  for (const turn of ordered) {
    const state = parseState(turn.stateAfter);
    if (state) {
      series.push({
        turnSeq: turn.seq,
        patience: state.patience,
        trust: state.trust,
        interest: state.interest,
      });
      finalState = state;
    }
    const meta = parseMeta(turn.stateAfter);
    if (meta && (meta.needsRepeat === true || meta.repeatRequested === true)) {
      voiceRepeatRequests += 1;
    }
  }

  const plannedKeys = persona.objections.map((o) => o.key);
  const raised = finalState?.flags.objectionsRaised ?? [];
  const resolved = finalState?.flags.objectionsResolved ?? [];

  const startedAt = toDate(session.startedAt);
  const endedAt = toDate(session.endedAt) ?? toDate(ordered[ordered.length - 1]?.createdAt);
  const durationSec =
    startedAt && endedAt ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)) : null;

  return {
    outcome: session.outcome,
    endReason: session.endReason,
    sellerTurns: sellerTurns.length,
    customerTurns: customerTurns.length,
    sellerWordShare: totalWords === 0 ? 0 : Number((sellerWords / totalWords).toFixed(3)),
    sellerWords,
    customerWords,
    avgSellerTurnWords:
      sellerTurns.length === 0 ? 0 : Number((sellerWords / sellerTurns.length).toFixed(1)),
    longestSellerTurnWords: sellerWordCounts.length === 0 ? 0 : Math.max(...sellerWordCounts),
    durationSec,
    series,
    finalState,
    objections: {
      planned: plannedKeys.length,
      raised: [...raised],
      resolved: [...resolved],
      unresolved: plannedKeys.filter((key) => !resolved.includes(key)),
    },
    needRevealed: archetype.hiddenNeed ? (finalState?.flags.needRevealed ?? false) : null,
    guardViolations: finalState?.flags.guardViolations ?? 0,
    voiceRepeatRequests,
  };
}

/**
 * Muhim lahza NOMZODLARI. LLM faqat shu ro'yxatdagi `turnSeq` larni
 * izohlashi mumkin — boshqasini kod tashlab yuboradi.
 *
 * Nomzodlar: ishonch/sabr eng ko'p o'zgargan navbatlar, e'tiroz ko'tarilgan
 * yoki yechilgan navbatlar va oxirgi navbat. Ko'pi bilan 8 ta, `seq` bo'yicha.
 */
export function keyMomentCandidates(
  turns: readonly ScoringTurn[],
  persona: PersonaCard,
): KeyMomentCandidate[] {
  const ordered = [...turns].sort((a, b) => a.seq - b.seq);
  const known = new Set(persona.objections.map((o) => o.key));

  interface Scored extends KeyMomentCandidate {
    weight: number;
  }
  const found: Scored[] = [];

  let prev: TrainingState | null = null;
  for (const turn of ordered) {
    const state = parseState(turn.stateAfter);
    if (!state) continue;

    if (prev) {
      const trustDelta = state.trust - prev.trust;
      const patienceDelta = state.patience - prev.patience;

      const newlyRaised = state.flags.objectionsRaised.filter(
        (key) => !prev?.flags.objectionsRaised.includes(key) && known.has(key),
      );
      const newlyResolved = state.flags.objectionsResolved.filter(
        (key) => !prev?.flags.objectionsResolved.includes(key) && known.has(key),
      );

      if (newlyResolved.length > 0) {
        found.push({
          turnSeq: turn.seq,
          kind: 'objection_resolved',
          trustDelta,
          patienceDelta,
          objectionKeys: newlyResolved,
          weight: 1000 + Math.abs(trustDelta),
        });
      } else if (newlyRaised.length > 0) {
        found.push({
          turnSeq: turn.seq,
          kind: 'objection_raised',
          trustDelta,
          patienceDelta,
          objectionKeys: newlyRaised,
          weight: 900 + Math.abs(trustDelta),
        });
      } else if (Math.abs(trustDelta) >= Math.abs(patienceDelta) && trustDelta !== 0) {
        found.push({
          turnSeq: turn.seq,
          kind: trustDelta < 0 ? 'trust_drop' : 'trust_rise',
          trustDelta,
          patienceDelta,
          weight: Math.abs(trustDelta),
        });
      } else if (patienceDelta < 0) {
        found.push({
          turnSeq: turn.seq,
          kind: 'patience_drop',
          trustDelta,
          patienceDelta,
          weight: Math.abs(patienceDelta),
        });
      }
    }
    prev = state;
  }

  const lastTurn = ordered[ordered.length - 1];
  const picked = found.sort((a, b) => b.weight - a.weight).slice(0, MAX_KEY_MOMENTS);

  if (lastTurn && !picked.some((c) => c.turnSeq === lastTurn.seq)) {
    if (picked.length >= MAX_KEY_MOMENTS) picked.pop();
    picked.push({ turnSeq: lastTurn.seq, kind: 'final_turn', weight: 0 });
  }

  return picked
    .sort((a, b) => a.turnSeq - b.turnSeq)
    .map(({ weight: _weight, ...candidate }) => candidate);
}
