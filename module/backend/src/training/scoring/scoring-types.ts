/**
 * Baholash natijasining shakllari (DB jsonb ustunlari uchun yagona manba).
 * LLM javobining sxemasi `scoring.ts` da; bu yerda SAQLANADIGAN natija.
 */
import { z } from 'zod';

import { type EvidenceRejectReason } from './evidence.js';
import { type KeyMomentKind } from './metrics.js';

export type ScoringStatus = 'pending' | 'done' | 'failed';
export type ScoringQuality = 'ok' | 'low' | 'insufficient';

/** Bitta mezon natijasi. */
export interface CriterionResult {
  code: string;
  name: string;
  weight: number;
  /** 0..3 yoki `null` (baholanmadi — nolga AYLANTIRILMAYDI). */
  score: 0 | 1 | 2 | 3 | null;
  comment: string;
  /** Tekshiruvdan o'tgan iqtibos. */
  evidenceQuote: string | null;
  /** Iqtibos haqiqatda topilgan navbat. */
  evidenceTurnSeq: number | null;
  /** Tekshiruvdan o'tmagan iqtibos — audit uchun SAQLANADI, o'chirilmaydi. */
  rejectedQuote?: string | null;
  rejectReason?: EvidenceRejectReason | null;
}

export interface ImprovementResult {
  title: string;
  why: string;
  betterPhrasing: string;
  evidenceQuote: string | null;
  evidenceTurnSeq: number | null;
  rejectedQuote?: string | null;
  rejectReason?: EvidenceRejectReason | null;
}

/**
 * Qizil chiziq buzilishi (biznes profilidagi `redLines` dan). FAQAT
 * tekshiruvdan o'tgan sotuvchi iqtibosi bilan saqlanadi — debrief tepasida
 * ko'rsatiladi.
 */
export interface RedLineViolation {
  /** Buzilgan qoida — profildagi `redLines` satri. */
  rule: string;
  explanation: string;
  evidenceQuote: string;
  evidenceTurnSeq: number;
}

export type ScriptStageStatus = 'followed' | 'partly' | 'missed';

/** "Skriptga moslik": bitta bosqich natijasi. */
export interface ScriptStageResult {
  stage: string;
  /** `null` — model bu bosqichni baholamadi. */
  status: ScriptStageStatus | null;
  comment: string;
  /** `followed` uchun tekshirilgan iqtibos MAJBURIY. */
  evidenceQuote: string | null;
  evidenceTurnSeq: number | null;
  rejectedQuote?: string | null;
  rejectReason?: EvidenceRejectReason | null;
}

/**
 * Debrief (`training_result.coaching` jsonb). Yangi bo'limlar shu yerda —
 * DB migratsiyasisiz; eski natijalarda ular yo'q (UI `?? []` bilan o'qiydi).
 */
export interface CoachingResult {
  summary: string;
  strengths: string[];
  improvements: ImprovementResult[];
  /** Qizil chiziq buzilishlari (tekshirilgan iqtibos bilan). */
  redLineViolations?: RedLineViolation[];
  /** Skript berilgan bo'lsa — har bosqich natijasi; aks holda `null`/yo'q. */
  scriptAdherence?: ScriptStageResult[] | null;
}

export interface KeyMomentResult {
  turnSeq: number;
  kind: KeyMomentKind | string;
  explanation: string;
}

/** Sotuvchiga oshkor qilinadigan "yashirin kartalar" (faqat sessiya tugagach). */
export const revealedPersonaSchema = z.object({
  name: z.string(),
  role: z.string(),
  situation: z.string(),
  goal: z.string(),
  focusOffer: z.string(),
  hiddenNeed: z.string().nullable(),
  hiddenFacts: z.array(z.string()),
  objections: z.array(
    z.object({
      key: z.string(),
      text: z.string(),
      severity: z.number(),
      raised: z.boolean(),
      resolved: z.boolean(),
    }),
  ),
});

export type RevealedPersona = z.infer<typeof revealedPersonaSchema>;

/** Sessiya davomida ko'rsatiladigan QISQA persona (yashirin ma'lumotsiz). */
export interface PersonaSummary {
  name: string;
  age: number;
  role: string;
  direction: 'inbound' | 'outbound';
  openingLine: string | null;
}
