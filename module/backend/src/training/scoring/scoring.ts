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
import { z } from 'zod';

import { getArchetype } from '../archetypes.js';
import {
  classifyLlmError,
  describeLlmError,
  isCorrectableLlmError,
  TrainingError,
} from '../errors.js';
import { findScriptViolations, scriptCorrectionNote, type ScriptViolation } from '../language.js';
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
export function userFacingScoringText(
  processed: ProcessedScoring,
): Array<{ field: string; text: string }> {
  const fields: Array<{ field: string; text: string }> = [];
  for (const c of processed.criteria) fields.push({ field: `criteria.${c.code}.comment`, text: c.comment });
  fields.push({ field: 'coaching.summary', text: processed.coaching.summary });
  processed.coaching.strengths.forEach((text, i) => fields.push({ field: `coaching.strengths.${i}`, text }));
  processed.coaching.improvements.forEach((item, i) => {
    fields.push({ field: `coaching.improvements.${i}.title`, text: item.title });
    fields.push({ field: `coaching.improvements.${i}.why`, text: item.why });
    fields.push({ field: `coaching.improvements.${i}.betterPhrasing`, text: item.betterPhrasing });
  });
  for (const m of processed.keyMoments) {
    fields.push({ field: `keyMoments.T${m.turnSeq}`, text: m.explanation });
  }
  (processed.coaching.redLineViolations ?? []).forEach((v, i) =>
    fields.push({ field: `redLineViolations.${i}.explanation`, text: v.explanation }),
  );
  (processed.coaching.scriptAdherence ?? []).forEach((s, i) =>
    fields.push({ field: `scriptAdherence.${i}.comment`, text: s.comment }),
  );
  return fields;
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
  /** Debrief tili; `uz` — lotin yozuvi kodda tekshiriladi. Default `uz`. */
  language?: 'uz' | 'ru' | 'mixed';
  priceCall?: PriceCall;
  now?: () => Date;
  logger?: TrainingLogger;
}

export interface ScoreSessionResult {
  resultId: string;
  version: number;
  status: 'done' | 'failed';
  quality: ScoringQuality;
  skillScore: number | null;
}

export interface ScoringService {
  /** Tugagan sessiyani baholaydi va YANGI versiya yozadi. */
  scoreSession(ctx: TrainingContext, sessionId: string): Promise<ScoreSessionResult>;
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
}

export function createScoringService(deps: ScoringDeps): ScoringService {
  const { withTenant, llm, priceCall } = deps;
  const getPlaybook: GetPlaybook = deps.getPlaybook ?? (async () => null);
  const now = deps.now ?? ((): Date => new Date());

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
      };
    });
  }

  return {
    async scoreSession(ctx, sessionId) {
      const { session, persona, turns } = await load(ctx, sessionId);
      const archetype = getArchetype(session.archetypeKey);
      const metrics: SessionMetrics = computeMetrics(session, turns, archetype, persona);
      const candidates = keyMomentCandidates(turns, persona);

      // 1. Versiya band qilinadi (pending). Eski versiyalar tegilmaydi.
      const { resultId, version } = await withTenant(ctx.businessId, async (tx) => {
        const nextVersion = (await repo.maxResultVersion(tx, sessionId)) + 1;
        const id = await repo.insertPendingResult(tx, {
          businessId: ctx.businessId,
          sessionId,
          version: nextVersion,
          metrics,
          createdAt: now(),
        });
        return { resultId: id, version: nextVersion };
      });

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
      const processContext: ProcessScoringContext = { redLines: profile?.redLines ?? [], script };
      const language = deps.language ?? 'uz';
      const scriptIssues = (p: ProcessedScoring): ScriptViolation[] =>
        language === 'uz' ? findScriptViolations(userFacingScoringText(p)) : [];

      // 4. LLM (tranzaksiyadan TASHQARIDA — tarmoq chaqiruvi qulf ushlab turmasin).
      let usage: TokenUsage | undefined;
      let costUsd = 0;

      const call = async (correction?: string): Promise<LlmScoring> => {
        const promptInput: ScoringPromptInput = {
          criteria: rubric.criteria,
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
        let processed = processLlmScoring(raw, rubric.criteria, turns, candidates, processContext);

        // 5. Dalillar ko'p yiqilsa YOKI matnda lotin bo'lmagan harflar bo'lsa —
        //    BITTA qayta urinish (ikkala tuzatish izohi bitta so'rovda).
        const evidenceBad = processed.evidenceFailureRatio > EVIDENCE_FAILURE_RETRY_RATIO;
        const scriptBad = scriptIssues(processed);
        if (evidenceBad || scriptBad.length > 0) {
          const correction = [
            ...(evidenceBad
              ? [
                  'Your evidence quotes failed verification. Problems:',
                  ...processed.failureNotes.map((note) => `- ${note}`),
                  'Copy the quotes character-by-character from SELLER lines in the transcript.',
                  'If you cannot find a real quote for a criterion, set its score to null instead of inventing one.',
                ]
              : []),
            ...(scriptBad.length > 0 ? [scriptCorrectionNote(scriptBad)] : []),
          ].join('\n');
          try {
            raw = await call(correction);
            const retried = processLlmScoring(raw, rubric.criteria, turns, candidates, processContext);
            const retriedScript = scriptIssues(retried).length;
            // Dalillar yomonlashmasa va yozuv xatolari ko'paymasa — yangisini olamiz.
            if (
              retried.evidenceFailureRatio <= processed.evidenceFailureRatio &&
              retriedScript <= scriptBad.length
            ) {
              processed = retried;
            }
          } catch (err) {
            deps.logger?.warn({ err }, 'baholashni qayta urinish muvaffaqiyatsiz');
          }
        }

        const remainingScript = scriptIssues(processed);
        if (remainingScript.length > 0) {
          deps.logger?.warn(
            { sessionId, scriptViolations: remainingScript },
            `debriefda lotin bo'lmagan harflar qoldi (qayta urinishdan keyin): ${remainingScript
              .map((v) => `${v.field}: ${v.words.join(', ')}`)
              .join('; ')}`.slice(0, 500),
          );
        }
        if (processed.droppedNotes.length > 0) {
          deps.logger?.warn(
            { sessionId, dropped: processed.droppedNotes },
            'baholash: tekshiruvdan o\'tmagan qismlar olib tashlandi',
          );
        }

        const quality: ScoringQuality =
          processed.evidenceFailureRatio > EVIDENCE_FAILURE_RETRY_RATIO ? 'low' : 'ok';
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
