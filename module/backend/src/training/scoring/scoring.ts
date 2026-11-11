/**
 * Baholash xizmati.
 *
 * Mas'uliyat taqsimoti (Step 4, 3-qoida):
 *  - LLM: har mezonga 0-3 baho, izoh, iqtibos, maslahat va muhim lahza izohi;
 *  - KOD: iqtiboslarni tekshirish, umumiy ballni hisoblash, o'lchovlar,
 *    muhim lahza nomzodlari, natija (outcome) — hammasi shu faylda/`metrics.ts` da.
 *
 * LLM hech qachon umumiy ballni ham, sessiya natijasini ham aniqlamaydi.
 */
import { computeScenarioReport } from './scenario-report.js';
import { parseScenario, sellerProfileSchema } from '../scenario/schema.js';
import { z } from 'zod';

import { getArchetype } from '../archetypes.js';
import {
  classifyLlmError,
  describeLlmError,
  isCorrectableLlmError,
  TrainingError,
} from '../errors.js';
import {
  enforceUzLatin,
  LANGUAGE_PLACEHOLDER,
  UZ_LATIN_REWRITE_SYSTEM,
  type EditableText,
  type RegenerateFields,
  type UzLatinReport,
} from '../language.js';
import { findPriceMismatches, hasPriceFacts, isPriceRedLine, PRICE_ACCURACY_CRITERION } from '../offer-facts.js';
import { personaCardSchema, type PersonaCard } from '../persona.js';
import type { BusinessProfile } from '../profile-schema.js';
import type {
  GetBusinessProfile,
  PriceCall,
  TokenUsage,
  TrainerLlm,
  TrainingContext,
  TrainingLogger,
  WithTenant,
} from '../ports.js';
import {
  EVIDENCE_REJECT_MESSAGE,
  normalizeForEvidence,
  verifyEvidence,
  type EvidenceTurn,
} from './evidence.js';
import {
  computeMetrics,
  keyMomentCandidates,
  type KeyMomentCandidate,
  type ScoringSession,
  type ScoringTurn,
  type SessionMetrics,
} from './metrics.js';
import * as repo from './repo.js';
import {
  buildScoringSystemPrompt,
  buildScoringUserPrompt,
  SCORING_PROMPT_VERSION,
  type ScoringPromptInput,
} from './scoring-prompts.js';
import { resolveRubric, type PlaybookCriterion, type PlaybookSubset } from './rubric.js';
import type { SalesScript } from './sales-script.js';
import type {
  CoachingResult,
  CriterionResult,
  ImprovementResult,
  KeyMomentResult,
  RedLineViolation,
  ScoringQuality,
  ScriptStageResult,
} from './scoring-types.js';

/** Tenant playbook'ini beradigan chok (host ulaydi). `null` -> standart rubrika. */
export type GetPlaybook = (businessId: string) => Promise<PlaybookSubset | null>;

/** Tenant'ning sotuv skripti (host ulaydi). `null` -> "Skriptga moslik" bo'limi yo'q. */
export type GetSalesScript = (businessId: string) => Promise<SalesScript | null>;

/** Osilib qolgan `pending` natijaga yoziladigan xato (UI "Qayta baholash" taklif qiladi). */
export const STALE_PENDING_ERROR = 'server qayta ishga tushdi';

/** Shundan kam sotuvchi navbati bo'lsa LLM chaqirilmaydi. */
export const MIN_SELLER_TURNS_FOR_SCORING = 3;

/** Dalil tekshiruvidan shu nisbatdan ko'proq yiqilsa — bitta qayta urinish. */
export const EVIDENCE_FAILURE_RETRY_RATIO = 0.4;

// ---------------------------------------------------------------------------
// LLM javobining sxemasi
// ---------------------------------------------------------------------------
const scoreValueSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.null()]);

export const llmCriterionSchema = z.object({
  code: z.string().min(1),
  score: scoreValueSchema,
  evidenceQuote: z.string().nullable().default(null),
  evidenceTurnSeq: z.number().int().nullable().default(null),
  comment: z.string().min(1).max(600),
});

export const llmImprovementSchema = z.object({
  title: z.string().min(1).max(160),
  why: z.string().min(1).max(600),
  evidenceQuote: z.string().nullable().default(null),
  evidenceTurnSeq: z.number().int().nullable().default(null),
  betterPhrasing: z.string().min(1).max(600),
});

export const llmScoringSchema = z.object({
  criteria: z.array(llmCriterionSchema).min(1),
  coaching: z.object({
    summary: z.string().min(1).max(1200),
    strengths: z.array(z.string().min(1).max(300)).max(3).default([]),
    improvements: z.array(llmImprovementSchema).max(3).default([]),
  }),
  keyMoments: z
    .array(
      z.object({
        turnSeq: z.number().int(),
        kind: z.string().min(1).max(40),
        explanation: z.string().min(1).max(600),
      }),
    )
    .default([]),
  redLineViolations: z
    .array(
      z.object({
        rule: z.string().min(1).max(300),
        evidenceQuote: z.string().nullable().default(null),
        evidenceTurnSeq: z.number().int().nullable().default(null),
        explanation: z.string().min(1).max(600),
      }),
    )
    .default([]),
  scriptAdherence: z
    .array(
      z.object({
        stage: z.string().min(1).max(200),
        status: z.enum(['followed', 'partly', 'missed']),
        evidenceQuote: z.string().nullable().default(null),
        evidenceTurnSeq: z.number().int().nullable().default(null),
        comment: z.string().min(1).max(600),
      }),
    )
    .default([]),
});

export type LlmScoring = z.infer<typeof llmScoringSchema>;

/** Model ortiqcha maydon qo'shsa ham yiqilmaslik uchun yumshoq tozalash. */
export function coerceLlmScoring(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object') return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  if (!Array.isArray(obj.keyMoments)) obj.keyMoments = [];
  if (!Array.isArray(obj.redLineViolations)) obj.redLineViolations = [];
  if (!Array.isArray(obj.scriptAdherence)) obj.scriptAdherence = [];
  const coaching = obj.coaching;
  if (coaching && typeof coaching === 'object') {
    const c = { ...(coaching as Record<string, unknown>) };
    if (!Array.isArray(c.strengths)) c.strengths = [];
    if (!Array.isArray(c.improvements)) c.improvements = [];
    obj.coaching = c;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Ball hisobi
// ---------------------------------------------------------------------------
export interface SkillScoreResult {
  /** 0..100 yoki `null` (hech bir mezon baholanmagan). */
  skillScore: number | null;
  scoredWeight: number;
  scoredCount: number;
}

/**
 * `skillScore` = Σ(score/3 × weight) / Σ(baholangan mezonlar vazni) × 100.
 * `null` baho NOLGA aylantirilmaydi — u shunchaki hisobga kirmaydi.
 */
export function computeSkillScore(criteria: readonly CriterionResult[]): SkillScoreResult {
  let weighted = 0;
  let scoredWeight = 0;
  let scoredCount = 0;

  for (const c of criteria) {
    if (c.score === null) continue;
    weighted += (c.score / 3) * c.weight;
    scoredWeight += c.weight;
    scoredCount += 1;
  }

  if (scoredWeight === 0) return { skillScore: null, scoredWeight: 0, scoredCount: 0 };
  return {
    skillScore: Number(((weighted / scoredWeight) * 100).toFixed(1)),
    scoredWeight,
    scoredCount,
  };
}

// ---------------------------------------------------------------------------
// LLM javobini tekshirish va natijaga aylantirish
// ---------------------------------------------------------------------------
export interface ProcessedScoring {
  criteria: CriterionResult[];
  coaching: CoachingResult;
  keyMoments: KeyMomentResult[];
  /** Dalil tekshiruvidan yiqilgan mezonlar nisbati (0..1). */
  evidenceFailureRatio: number;
  failureNotes: string[];
  /** Qabul qilinmagan qizil chiziq da'volari va olib tashlangan "kuchli tomonlar" (audit/log). */
  droppedNotes: string[];
}

export interface PriceScope {
  criteria: readonly PlaybookCriterion[];
  redLines: readonly string[];
  /** Profil bo'lmasa — `undefined` (faktlar umuman tekshirilmaydi). */
  priceCheck: 'checked' | 'skipped_no_data' | undefined;
}

/**
 * Narxsiz rejim: profilda narx/chegirma fakti yo'q bo'lsa, narx aniqligi
 * mezoni olib tashlanadi (ball qo'yilmaydi, vazni `computeSkillScore` da
 * qolganlarga taqsimlanadi) va narx qizil chiziqlari tekshirilmaydi.
 */
export function resolvePriceScope(
  profile: BusinessProfile | null,
  criteria: readonly PlaybookCriterion[],
): PriceScope {
  if (!profile) return { criteria, redLines: [], priceCheck: undefined };
  if (hasPriceFacts(profile)) return { criteria, redLines: profile.redLines, priceCheck: 'checked' };
  return {
    criteria: criteria.filter((c) => c.code !== PRICE_ACCURACY_CRITERION),
    redLines: profile.redLines.filter((rule) => !isPriceRedLine(rule)),
    priceCheck: 'skipped_no_data',
  };
}

export interface ProcessScoringContext {
  /** Profildagi qizil chiziqlar — `redLineViolations.rule` shulardan biri bo'lishi shart. */
  redLines?: readonly string[];
  /** Sotuv skripti; `null`/yo'q — `scriptAdherence: null`. */
  script?: SalesScript | null;
}

/** Iqtibos qisqa bo'lsa (tasodifiy moslik) kuchli tomonni o'chirishda ishlatilmaydi. */
function containsQuote(text: string, quote: string): boolean {
  const normalizedQuote = normalizeForEvidence(quote);
  return normalizedQuote.length >= 12 && normalizeForEvidence(text).includes(normalizedQuote);
}

export function processLlmScoring(
  llm: LlmScoring,
  rubricCriteria: readonly PlaybookCriterion[],
  turns: readonly EvidenceTurn[],
  candidates: readonly KeyMomentCandidate[],
  context: ProcessScoringContext = {},
): ProcessedScoring {
  const droppedNotes: string[] = [];
  const byCode = new Map(llm.criteria.map((c) => [c.code, c]));
  const criteria: CriterionResult[] = [];
  const failureNotes: string[] = [];
  let proposed = 0;
  let failed = 0;

  for (const rubric of rubricCriteria) {
    const fromLlm = byCode.get(rubric.code);

    if (!fromLlm) {
      criteria.push({
        code: rubric.code,
        name: rubric.name,
        weight: rubric.weight,
        score: null,
        comment: "Model bu mezon uchun baho bermadi.",
        evidenceQuote: null,
        evidenceTurnSeq: null,
      });
      continue;
    }

    if (fromLlm.score === null) {
      criteria.push({
        code: rubric.code,
        name: rubric.name,
        weight: rubric.weight,
        score: null,
        comment: fromLlm.comment,
        evidenceQuote: null,
        evidenceTurnSeq: null,
      });
      continue;
    }

    proposed += 1;
    const check = verifyEvidence(fromLlm.evidenceQuote, turns, fromLlm.evidenceTurnSeq);

    if (check.ok) {
      criteria.push({
        code: rubric.code,
        name: rubric.name,
        weight: rubric.weight,
        score: fromLlm.score,
        comment: fromLlm.comment,
        evidenceQuote: fromLlm.evidenceQuote,
        evidenceTurnSeq: check.turnSeq,
      });
    } else {
      failed += 1;
      failureNotes.push(
        `${rubric.code}: ${EVIDENCE_REJECT_MESSAGE[check.reason]} ("${(fromLlm.evidenceQuote ?? '').slice(0, 80)}")`,
      );
      criteria.push({
        code: rubric.code,
        name: rubric.name,
        weight: rubric.weight,
        // Dalil tekshiruvdan o'tmadi -> baho bekor qilinadi.
        score: null,
        comment: fromLlm.comment,
        evidenceQuote: null,
        evidenceTurnSeq: null,
        rejectedQuote: fromLlm.evidenceQuote ?? null,
        rejectReason: check.reason,
      });
    }
  }

  const improvements: ImprovementResult[] = llm.coaching.improvements.map((item) => {
    const check = verifyEvidence(item.evidenceQuote, turns, item.evidenceTurnSeq);
    if (check.ok) {
      return {
        title: item.title,
        why: item.why,
        betterPhrasing: item.betterPhrasing,
        evidenceQuote: item.evidenceQuote,
        evidenceTurnSeq: check.turnSeq,
      };
    }
    return {
      title: item.title,
      why: item.why,
      betterPhrasing: item.betterPhrasing,
      evidenceQuote: null,
      evidenceTurnSeq: null,
      rejectedQuote: item.evidenceQuote ?? null,
      rejectReason: check.reason,
    };
  });

  const allowedSeqs = new Set(candidates.map((c) => c.turnSeq));
  const keyMoments: KeyMomentResult[] = llm.keyMoments
    .filter((m) => allowedSeqs.has(m.turnSeq))
    .map((m) => ({ turnSeq: m.turnSeq, kind: m.kind, explanation: m.explanation }))
    .sort((a, b) => a.turnSeq - b.turnSeq);

  // Qizil chiziqlar: qoida profildagisi bo'lishi VA iqtibos tekshiruvdan o'tishi shart.
  const redLines = context.redLines ?? [];
  const redLineViolations: RedLineViolation[] = [];
  for (const item of llm.redLineViolations) {
    const rule = redLines.find((r) => {
      const a = normalizeForEvidence(r);
      const b = normalizeForEvidence(item.rule);
      return a.length > 0 && (a === b || a.includes(b) || b.includes(a));
    });
    if (!rule) {
      droppedNotes.push(`redLine: "${item.rule.slice(0, 60)}" profildagi qizil chiziqlardan emas`);
      continue;
    }
    const check = verifyEvidence(item.evidenceQuote, turns, item.evidenceTurnSeq);
    if (!check.ok) {
      droppedNotes.push(`redLine "${rule}": ${EVIDENCE_REJECT_MESSAGE[check.reason]}`);
      continue;
    }
    redLineViolations.push({
      rule,
      explanation: item.explanation,
      evidenceQuote: item.evidenceQuote as string,
      evidenceTurnSeq: check.turnSeq,
    });
  }

  // Kuchli tomonlar qizil chiziqni buzgan gapni HECH QACHON maqtamasligi kerak
  // (promptda qoida bor; bu — mexanik himoya).
  const strengths = llm.coaching.strengths.filter((strength) => {
    const bad = redLineViolations.find((v) => containsQuote(strength, v.evidenceQuote));
    if (bad) droppedNotes.push(`strength olib tashlandi (qizil chiziq "${bad.rule}" ni maqtagan)`);
    return !bad;
  });

  return {
    criteria,
    coaching: {
      summary: llm.coaching.summary,
      strengths,
      improvements,
      redLineViolations,
      scriptAdherence: processScriptAdherence(llm, context.script ?? null, turns),
    },
    keyMoments,
    evidenceFailureRatio: proposed === 0 ? 0 : failed / proposed,
    failureNotes,
    droppedNotes,
  };
}

/**
 * Skript bosqichlari — SKRIPT tartibida (modelniki emas). `followed` faqat
 * tekshirilgan iqtibos bilan qoladi; iqtibos o'tmasa `partly` ga tushiriladi.
 */
export function processScriptAdherence(
  llm: LlmScoring,
  script: SalesScript | null,
  turns: readonly EvidenceTurn[],
): ScriptStageResult[] | null {
  if (!script) return null;
  const byName = new Map(llm.scriptAdherence.map((item) => [normalizeForEvidence(item.stage), item]));

  return script.stages.map((stage): ScriptStageResult => {
    const item = byName.get(normalizeForEvidence(stage.name));
    if (!item) {
      return {
        stage: stage.name,
        status: null,
        comment: 'Model bu bosqichni baholamadi.',
        evidenceQuote: null,
        evidenceTurnSeq: null,
      };
    }
    if (item.status === 'missed') {
      return {
        stage: stage.name,
        status: 'missed',
        comment: item.comment,
        evidenceQuote: null,
        evidenceTurnSeq: null,
      };
    }
    const check = verifyEvidence(item.evidenceQuote, turns, item.evidenceTurnSeq);
    if (check.ok) {
      return {
        stage: stage.name,
        status: item.status,
        comment: item.comment,
        evidenceQuote: item.evidenceQuote,
        evidenceTurnSeq: check.turnSeq,
      };
    }
    return {
      stage: stage.name,
      // Tekshirilmagan "followed" — ishonchli emas: `partly` ga tushiriladi.
      status: 'partly',
      comment: item.comment,
      evidenceQuote: null,
      evidenceTurnSeq: null,
      ...(item.evidenceQuote ? { rejectedQuote: item.evidenceQuote, rejectReason: check.reason } : {}),
    };
  });
}

/**
 * Sotuvchiga ko'rinadigan, MODEL YOZGAN matnlar (iqtiboslar emas — ular
 * transkriptdan aynan olinadi). Til `uz` bo'lganda yozuv tekshiruvi uchun.
 */
export function userFacingScoringFields(processed: ProcessedScoring): EditableText[] {
  const fields: EditableText[] = [];
  const add = (id: string, text: string, set: (value: string) => void): void => {
    fields.push({ id, text, set });
  };
  for (const c of processed.criteria) {
    add(`criteria.${c.code}.comment`, c.comment, (v) => (c.comment = v));
  }
  const coaching = processed.coaching;
  add('coaching.summary', coaching.summary, (v) => (coaching.summary = v));
  coaching.strengths.forEach((text, i) => add(`coaching.strengths.${i}`, text, (v) => (coaching.strengths[i] = v)));
  coaching.improvements.forEach((item, i) => {
    add(`coaching.improvements.${i}.title`, item.title, (v) => (item.title = v));
    add(`coaching.improvements.${i}.why`, item.why, (v) => (item.why = v));
    add(`coaching.improvements.${i}.betterPhrasing`, item.betterPhrasing, (v) => (item.betterPhrasing = v));
  });
  for (const m of processed.keyMoments) {
    add(`keyMoments.T${m.turnSeq}.explanation`, m.explanation, (v) => (m.explanation = v));
  }
  (coaching.redLineViolations ?? []).forEach((r, i) =>
    add(`redLineViolations.${i}.explanation`, r.explanation, (v) => (r.explanation = v)),
  );
  (coaching.scriptAdherence ?? []).forEach((st, i) =>
    add(`scriptAdherence.${i}.comment`, st.comment, (v) => (st.comment = v)),
  );
  return fields;
}

/** Faqat matnlar (tekshiruv/log uchun). */
export function userFacingScoringText(
  processed: ProcessedScoring,
): Array<{ field: string; text: string }> {
  return userFacingScoringFields(processed).map((f) => ({ field: f.id, text: f.text }));
}

const rewriteSchema = z.object({
  fields: z.array(z.object({ id: z.string().min(1), text: z.string().min(1).max(1200) })).max(80),
});

/**
 * Til `uz`: debriefdagi model yozgan HAR maydon — kirill bo'lsa lotinga
 * o'giriladi, begona til bo'lsa FAQAT o'sha maydonlar bitta chaqiruvda qayta
 * yaratiladi, baribir yaroqsiz bo'lsa yashiriladi (`LANGUAGE_PLACEHOLDER`).
 */
export async function enforceScoringLanguage(
  processed: ProcessedScoring,
  regenerate: RegenerateFields,
): Promise<UzLatinReport> {
  return await enforceUzLatin(userFacingScoringFields(processed), regenerate, LANGUAGE_PLACEHOLDER);
}

// ---------------------------------------------------------------------------
// Xizmat
// ---------------------------------------------------------------------------
export interface ScoringDeps {
  withTenant: WithTenant;
  llm: TrainerLlm;
  getPlaybook?: GetPlaybook;
  /**
   * Biznes faktlari (takliflar, narxlar, shartlar, qizil chiziqlar) —
   * sotuvchining da'volari shular bilan tekshiriladi. Berilmasa faktlar
   * baholanmaydi va `redLineViolations` bo'sh qoladi.
   */
  getBusinessProfile?: GetBusinessProfile;
  /** Sotuv skripti — bo'lsa "Skriptga moslik" bo'limi qo'shiladi. */
  getSalesScript?: GetSalesScript;
  /**
   * Shundan eski `pending` "o'lik" hisoblanadi (jarayon to'xtagan) va yangi
   * baholashga to'sqinlik qilmaydi. Default 10 daqiqa.
   */
  pendingStaleAfterMs?: number;
  /** Debrief tili; `uz` — lotin yozuvi kodda tekshiriladi. Default `uz`. */
  language?: 'uz' | 'ru' | 'mixed';
  priceCall?: PriceCall;
  now?: () => Date;
  logger?: TrainingLogger;
}

export interface ScoreSessionResult {
  resultId: string;
  version: number;
  /** `pending` — shu sessiya uchun boshqa baholash allaqachon ketmoqda (`alreadyRunning`). */
  status: 'done' | 'failed' | 'pending';
  quality: ScoringQuality;
  skillScore: number | null;
  alreadyRunning?: boolean;
}

export interface ScoringRequest {
  resultId: string;
  version: number;
  /** `true` — yangi run boshlanmadi, mavjud `pending` qaytarildi. */
  alreadyRunning: boolean;
  /** Yangi run bo'lsa — uning tugashi; mavjud bo'lsa `null`. */
  done: Promise<ScoreSessionResult> | null;
}

interface Reservation {
  alreadyRunning: false;
  resultId: string;
  version: number;
  persona: PersonaCard;
  turns: ScoringTurn[];
  archetype: ReturnType<typeof getArchetype>;
  metrics: SessionMetrics;
  candidates: KeyMomentCandidate[];
  session: ScoringSession;
  scenario: unknown;
  seller: unknown;
}

interface ExistingRun {
  alreadyRunning: true;
  resultId: string;
  version: number;
}

export interface ScoringService {
  /**
   * Tugagan sessiyani baholaydi va YANGI versiya yozadi. Shu sessiya uchun
   * baholash allaqachon ketayotgan bo'lsa — yangisini boshlamaydi
   * (`status: 'pending', alreadyRunning: true`).
   */
  scoreSession(ctx: TrainingContext, sessionId: string): Promise<ScoreSessionResult>;
  /**
   * Route uchun: versiyani DARHOL band qiladi (yoki mavjud `pending` ni
   * qaytaradi), bajarish esa `done` da — fon rejimida kutiladi.
   */
  requestScoring(ctx: TrainingContext, sessionId: string): Promise<ScoringRequest>;
  /** Oxirgi tugallangan natija (yo'q bo'lsa `null`). */
  getLatestResult(ctx: TrainingContext, sessionId: string): Promise<repo.TrainingResultRow | null>;
  /**
   * Jarayon to'xtab qolgani sababli osilib qolgan `pending` natijalarni
   * `failed` qiladi ("server qayta ishga tushdi"). Server STARTIDA chaqiring:
   * baholash shu jarayon ichida fon rejimida ketadi, jarayon o'lsa natija
   * abadiy `pending` qolardi. `olderThanMs` — baholash timeout'i.
   */
  failStalePending(businessId: string, options: { olderThanMs: number }): Promise<number>;
  /** Har qanday holatdagi oxirgi versiya (pending ham) — UI poll qilishi uchun. */
  getLatestAnyResult(
    ctx: TrainingContext,
    sessionId: string,
  ): Promise<repo.TrainingResultRow | null>;
}

interface LoadedSession {
  session: ScoringSession;
  persona: PersonaCard;
  turns: ScoringTurn[];
  /** Ssenariy sessiyasi: boshlanishdagi nusxa va sotuvchi profili (xom). */
  scenario: unknown;
  seller: unknown;
}

export function createScoringService(deps: ScoringDeps): ScoringService {
  const { withTenant, llm, priceCall } = deps;
  const getPlaybook: GetPlaybook = deps.getPlaybook ?? (async () => null);
  const now = deps.now ?? ((): Date => new Date());
  const pendingStaleAfterMs = deps.pendingStaleAfterMs ?? 10 * 60 * 1000;

  async function load(ctx: TrainingContext, sessionId: string): Promise<LoadedSession> {
    return await withTenant(ctx.businessId, async (tx) => {
      const row = await repo.getSessionForScoring(tx, sessionId);
      if (!row) throw new TrainingError('session_not_found', `sessiya topilmadi: ${sessionId}`);
      if (row.userId !== ctx.userId) {
        throw new TrainingError('session_forbidden', 'sessiya boshqa foydalanuvchiga tegishli');
      }
      if (row.status === 'active') {
        throw new TrainingError(
          'session_not_active',
          "sessiya hali tugamagan — baholash faqat tugagan sessiya uchun",
        );
      }
      const turns = await repo.getTurnsForScoring(tx, sessionId);
      return {
        session: {
          id: row.id,
          archetypeKey: row.archetypeKey,
          status: row.status,
          outcome: row.outcome,
          endReason: row.endReason,
          turnCount: row.turnCount,
          startedAt: row.startedAt,
          endedAt: row.endedAt,
        },
        persona: personaCardSchema.parse(row.personaCard),
        turns,
        scenario: row.scenario ?? null,
        seller: row.sellerProfile ?? null,
      };
    });
  }

  /**
   * Bitta sessiya uchun bir vaqtda FAQAT BITTA baholash.
   *
   * DB darajasida: sessiya qatori `SELECT ... FOR UPDATE` bilan qulflanadi
   * (parallel so'rovlar shu yerda navbatga turadi), keyin `pending` versiya
   * bor-yo'qligi tekshiriladi. Bor bo'lsa — yangisi boshlanmaydi, o'sha
   * qaytariladi. Faqat `pendingStaleAfterMs` dan eski `pending` (jarayon
   * o'lgan) `failed` qilinib, yangisi boshlanadi.
   */
  async function reserve(
    ctx: TrainingContext,
    sessionId: string,
  ): Promise<Reservation | ExistingRun> {
    const { session, persona, turns, scenario, seller } = await load(ctx, sessionId);
    const archetype = getArchetype(session.archetypeKey);
    const metrics: SessionMetrics = computeMetrics(session, turns, archetype, persona);
    const candidates = keyMomentCandidates(turns, persona);

    return await withTenant(ctx.businessId, async (tx): Promise<Reservation | ExistingRun> => {
      await repo.lockSessionForScoring(tx, sessionId);
      const pending = await repo.getLatestResult(tx, sessionId, 'pending');
      if (pending) {
        const age = now().getTime() - new Date(pending.createdAt).getTime();
        if (age < pendingStaleAfterMs) {
          return { alreadyRunning: true, resultId: pending.id, version: pending.version };
        }
        await repo.failStalePendingResults(tx, {
          olderThan: new Date(now().getTime() - pendingStaleAfterMs),
          error: STALE_PENDING_ERROR,
        });
      }
      // Versiya band qilinadi (pending). Eski versiyalar tegilmaydi.
      const nextVersion = (await repo.maxResultVersion(tx, sessionId)) + 1;
      const id = await repo.insertPendingResult(tx, {
        businessId: ctx.businessId,
        sessionId,
        version: nextVersion,
        metrics,
        createdAt: now(),
      });
      return {
        alreadyRunning: false,
        resultId: id,
        version: nextVersion,
        persona,
        turns,
        archetype,
        metrics,
        candidates,
        session,
        scenario,
        seller,
      };
    });
  }

  /** Band qilingan (pending) versiyani bajaradi: LLM, tekshiruvlar, natijani yozish. */
  async function execute(
    ctx: TrainingContext,
    sessionId: string,
    r: Reservation,
  ): Promise<ScoreSessionResult> {
    const { persona, turns, archetype, metrics, candidates, resultId, version } = r;

    // 2. Juda kam mazmun -> LLM chaqirilmaydi.
    if (metrics.sellerTurns < MIN_SELLER_TURNS_FOR_SCORING) {
      const coaching: CoachingResult = {
        summary:
          `Bu sessiyada sotuvchining faqat ${metrics.sellerTurns} ta navbati bor — ` +
          'baholash uchun yetarli emas. Kamida 3-4 marta gaplashib ko\'ring, ' +
          'keyin natija to\'liq chiqadi.',
        strengths: [],
        improvements: [],
      };
      await withTenant(ctx.businessId, async (tx) => {
        await repo.finishResult(tx, {
          resultId,
          status: 'done',
          quality: 'insufficient',
          skillScore: null,
          criteria: [],
          coaching,
          keyMoments: [],
          model: null,
          promptVersion: SCORING_PROMPT_VERSION,
          costUsd: 0,
          error: null,
        });
      });
      return { resultId, version, status: 'done', quality: 'insufficient', skillScore: null };
    }

    // 3. Rubrika.
    let playbook: PlaybookSubset | null = null;
    try {
      playbook = await getPlaybook(ctx.businessId);
    } catch (err) {
      deps.logger?.warn({ err }, 'getPlaybook xato berdi — standart rubrika ishlatiladi');
    }
    const rubric = resolveRubric(playbook);

    // Biznes faktlari va skript (xato bo'lsa — ularsiz davom etamiz, lekin logga yozamiz).
    let profile: BusinessProfile | null = null;
    let script: SalesScript | null = null;
    try {
      profile = (await deps.getBusinessProfile?.(ctx.businessId)) ?? null;
    } catch (err) {
      deps.logger?.warn({ err }, 'getBusinessProfile xato berdi — faktlar tekshirilmaydi');
    }
    try {
      script = (await deps.getSalesScript?.(ctx.businessId)) ?? null;
    } catch (err) {
      deps.logger?.warn({ err }, 'getSalesScript xato berdi — skriptga moslik baholanmaydi');
    }
    // Narxsiz rejim: profilda narx/chegirma fakti yo'q — narx aniqligi mezoni
    // baholanmaydi (vazni qolganlarga taqsimlanadi), narx qizil chiziqlari
    // tekshirilmaydi; debrief "tekshirilmadi" deydi.
    const { criteria, redLines, priceCheck } = resolvePriceScope(profile, rubric.criteria);
    const processContext: ProcessScoringContext = { redLines, script };
    const language = deps.language ?? 'uz';

    // 4. LLM (tranzaksiyadan TASHQARIDA — tarmoq chaqiruvi qulf ushlab turmasin).
    let usage: TokenUsage | undefined;
    let costUsd = 0;

    const call = async (correction?: string): Promise<LlmScoring> => {
      const promptInput: ScoringPromptInput = {
        criteria,
        archetype,
        persona,
        metrics,
        turns,
        candidates,
        profile,
        script,
        ...(correction ? { correction } : {}),
      };
      const req = {
        stage: 'training.scoring',
        system: buildScoringSystemPrompt(promptInput),
        user: buildScoringUserPrompt(promptInput),
        schema: { parse: (raw: unknown): LlmScoring => llmScoringSchema.parse(coerceLlmScoring(raw)) },
        outputSchema: llmScoringSchema,
      };
      if (typeof llm.completeJsonWithUsage === 'function') {
        const out = await llm.completeJsonWithUsage(req);
        usage = out.usage;
        costUsd += priceCall && out.usage ? Math.max(0, priceCall(out.usage)) : 0;
        return out.value;
      }
      return await llm.completeJson(req);
    };

    try {
      let raw: LlmScoring;
      try {
        raw = await call();
      } catch (err) {
        // Faqat javob SHAKLI xato bo'lsa — bitta tuzatuvchi qayta so'rov.
        // Timeout / HTTP xato darhol `failed` ga tushadi (haqiqiy toifasi bilan).
        if (!isCorrectableLlmError(err)) throw err;
        raw = await call(
          `Your previous answer was rejected: ${describeLlmError(err)}. Return a single valid JSON object with all required fields.`,
        );
      }
      let processed = processLlmScoring(raw, criteria, turns, candidates, processContext);

      // 5. Dalillar ko'p yiqilsa — bitta qayta urinish.
      if (processed.evidenceFailureRatio > EVIDENCE_FAILURE_RETRY_RATIO) {
        const correction = [
          'Your evidence quotes failed verification. Problems:',
          ...processed.failureNotes.map((note) => `- ${note}`),
          'Copy the quotes character-by-character from SELLER lines in the transcript.',
          'If you cannot find a real quote for a criterion, set its score to null instead of inventing one.',
        ].join('\n');
        try {
          raw = await call(correction);
          const retried = processLlmScoring(raw, criteria, turns, candidates, processContext);
          if (retried.evidenceFailureRatio <= processed.evidenceFailureRatio) {
            processed = retried;
          }
        } catch (err) {
          deps.logger?.warn({ err }, 'baholashni qayta urinish muvaffaqiyatsiz');
        }
      }

      // 6. Til (uz): foydalanuvchi HECH QACHON lotin bo'lmagan matn ko'rmaydi.
      //    Kirill -> lotin (kod); begona til -> faqat o'sha maydonlar bitta
      //    chaqiruvda qayta; baribir yaroqsiz -> yashiriladi, quality=low.
      let languageReport: UzLatinReport | null = null;
      if (language === 'uz') {
        const regenerate: RegenerateFields = async (bad) => {
          const req = {
            stage: 'training.scoring.language',
            system: UZ_LATIN_REWRITE_SYSTEM,
            user: JSON.stringify({ fields: bad }),
            schema: rewriteSchema,
            outputSchema: rewriteSchema,
          };
          let out: z.infer<typeof rewriteSchema>;
          if (typeof llm.completeJsonWithUsage === 'function') {
            const res = await llm.completeJsonWithUsage(req);
            costUsd += priceCall && res.usage ? Math.max(0, priceCall(res.usage)) : 0;
            out = res.value;
          } else {
            out = await llm.completeJson(req);
          }
          const wanted = new Set(bad.map((f) => f.id));
          return new Map(out.fields.filter((f) => wanted.has(f.id)).map((f) => [f.id, f.text]));
        };
        languageReport = await enforceScoringLanguage(processed, regenerate);
        if (languageReport.hidden.length > 0 || languageReport.regenerated.length > 0) {
          deps.logger?.warn(
            { sessionId, language: languageReport },
            `debrief tili: ${languageReport.transliterated.length} o'girildi, ` +
              `${languageReport.regenerated.length} qayta yaratildi, ${languageReport.hidden.length} yashirildi`,
          );
        }
      }
      const languageLow = (languageReport?.hidden.length ?? 0) > 0;
      const evidenceLow = processed.evidenceFailureRatio > EVIDENCE_FAILURE_RETRY_RATIO;
      if (languageReport) {
        processed.coaching.languageCheck = {
          transliterated: languageReport.transliterated.length,
          regenerated: languageReport.regenerated.length,
          hidden: languageReport.hidden,
        };
      }
      if (priceCheck) processed.coaching.priceCheck = priceCheck;
      if (priceCheck === 'checked' && profile) {
        // Mexanik tekshiruv: sotuvchi profilda yo'q narx aytdimi (LLM bahosidan tashqari).
        processed.coaching.priceMismatches = findPriceMismatches(turns, profile).map((m) => ({
          turnSeq: m.turnSeq,
          figure: m.figure,
        }));
      }
      // Ssenariy hisobot kartasi (xato bo'lsa — asosiy natija buzilmaydi, faqat logga).
      if (r.scenario) {
        try {
          const scenario = parseScenario(r.scenario, `session:${sessionId}`);
          const sellerParsed = sellerProfileSchema.safeParse(r.seller);
          const lastState = [...turns].reverse().find((t) => t.speaker === 'customer')?.stateAfter as
            | { emotion?: { level?: string } }
            | undefined;
          const rep = await computeScenarioReport({
            llm,
            priceCall,
            scenario,
            persona,
            seller: sellerParsed.success ? sellerParsed.data : null,
            turns,
            outcome: r.session.outcome,
            endReason: r.session.endReason,
            level: lastState?.emotion?.level ?? 'medium',
          });
          costUsd += rep.costUsd;
          processed.coaching.scenarioReport = rep.report;
        } catch (err) {
          deps.logger?.warn({ err, sessionId }, 'ssenariy hisobot kartasi yaratilmadi');
        }
      }
      processed.coaching.lowQualityReasons = [
        ...(evidenceLow ? (['evidence'] as const) : []),
        ...(languageLow ? (['language'] as const) : []),
      ];
      if (processed.droppedNotes.length > 0) {
        deps.logger?.warn(
          { sessionId, dropped: processed.droppedNotes },
          'baholash: tekshiruvdan o\'tmagan qismlar olib tashlandi',
        );
      }

      const quality: ScoringQuality = evidenceLow || languageLow ? 'low' : 'ok';
      const { skillScore } = computeSkillScore(processed.criteria);

      await withTenant(ctx.businessId, async (tx) => {
        await repo.finishResult(tx, {
          resultId,
          status: 'done',
          quality,
          skillScore,
          criteria: processed.criteria,
          coaching: processed.coaching,
          keyMoments: processed.keyMoments,
          model: usage?.model ?? null,
          promptVersion: SCORING_PROMPT_VERSION,
          costUsd,
          error: null,
        });
      });

      return { resultId, version, status: 'done', quality, skillScore };
    } catch (err) {
      // Haqiqiy toifa bilan: `[timeout] ...`, `[http] ... HTTP 429 ...`, `[schema] ...`.
      const message = describeLlmError(err);
      await withTenant(ctx.businessId, async (tx) => {
        await repo.finishResult(tx, {
          resultId,
          status: 'failed',
          quality: 'ok',
          skillScore: null,
          criteria: [],
          coaching: null,
          keyMoments: [],
          model: usage?.model ?? null,
          promptVersion: SCORING_PROMPT_VERSION,
          costUsd,
          error: message.slice(0, 1000),
        });
      });
      deps.logger?.error(
        { err, sessionId, llmErrorKind: classifyLlmError(err) },
        `baholash muvaffaqiyatsiz: ${message}`,
      );
      return { resultId, version, status: 'failed', quality: 'ok', skillScore: null };
    }
  }

  return {
    async requestScoring(ctx, sessionId) {
      const r = await reserve(ctx, sessionId);
      if (r.alreadyRunning) {
        return { resultId: r.resultId, version: r.version, alreadyRunning: true, done: null };
      }
      return {
        resultId: r.resultId,
        version: r.version,
        alreadyRunning: false,
        done: execute(ctx, sessionId, r),
      };
    },

    async scoreSession(ctx, sessionId) {
      const r = await reserve(ctx, sessionId);
      if (r.alreadyRunning) {
        return {
          resultId: r.resultId,
          version: r.version,
          status: 'pending',
          quality: 'ok',
          skillScore: null,
          alreadyRunning: true,
        };
      }
      return await execute(ctx, sessionId, r);
    },

    async getLatestResult(ctx, sessionId) {
      return await withTenant(ctx.businessId, async (tx) => {
        const row = await repo.getSessionForScoring(tx, sessionId);
        if (!row) throw new TrainingError('session_not_found', `sessiya topilmadi: ${sessionId}`);
        if (row.userId !== ctx.userId) {
          throw new TrainingError('session_forbidden', 'sessiya boshqa foydalanuvchiga tegishli');
        }
        return await repo.getLatestResult(tx, sessionId, 'done');
      });
    },

    async failStalePending(businessId, { olderThanMs }) {
      const olderThan = new Date(now().getTime() - olderThanMs);
      const count = await withTenant(businessId, async (tx) =>
        repo.failStalePendingResults(tx, { olderThan, error: STALE_PENDING_ERROR }),
      );
      if (count > 0) {
        deps.logger?.warn({ businessId, count }, `osilib qolgan baholashlar failed qilindi: ${count}`);
      }
      return count;
    },

    async getLatestAnyResult(ctx, sessionId) {
      return await withTenant(ctx.businessId, async (tx) => {
        const row = await repo.getSessionForScoring(tx, sessionId);
        if (!row) throw new TrainingError('session_not_found', `sessiya topilmadi: ${sessionId}`);
        if (row.userId !== ctx.userId) {
          throw new TrainingError('session_forbidden', 'sessiya boshqa foydalanuvchiga tegishli');
        }
        return await repo.getLatestResult(tx, sessionId);
      });
    },
  };
}
