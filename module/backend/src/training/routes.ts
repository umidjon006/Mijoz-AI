/**
 * HTTP route'lar — Fastify plagini.
 *
 * MUHIM: bu fayl Fastify'dan FAQAT TIP sifatida foydalanadi (runtime
 * bog'liqlik yo'q), auth va ruxsatlarni esa tashqaridan oladi:
 *   - `getContext(req)` -> TrainingContext (host auth qatlami);
 *   - `authorize(ctx, permission)` -> ruxsat yo'q bo'lsa xato tashlaydi.
 *
 * Ruxsatlar (teammate'lar asosiy repodagi `permissions.ts` ga qo'shadi):
 *   - `training:use`       — o'z mashqlarini boshlash/ko'rish;
 *   - `training:view:all`  — boshqalarning natijalarini ko'rish (rahbar).
 *
 * Kengaytirish: Step 3 Phase B tayyor bo'lganda `voice` deps'i va
 * `POST /sessions/:id/voice-turn` SHU plaginga qo'shiladi — yangi plagin
 * yaratilmaydi (pastdagi `registerVoiceRoute` chokiga qarang).
 */
import { Readable } from 'node:stream';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { ARCHETYPE_KEYS, getArchetype, listArchetypes, type ArchetypeKey } from './archetypes.js';
import type { TrainingEngine } from './engine.js';
import { isTrainingError, TrainingError, type TrainingErrorCode } from './errors.js';
import type { PersonaCard } from './persona.js';
import type { TrainingContext, TrainingLogger } from './ports.js';
import type { SessionMetrics } from './scoring/metrics.js';
import type { ScoringService } from './scoring/scoring.js';
import * as scoringRepo from './scoring/repo.js';
import type {
  CriterionResult,
  PersonaSummary,
  RevealedPersona,
} from './scoring/scoring-types.js';
import type { WithTenant } from './ports.js';
import { VOICE_AUDIO, VOICE_LIMITS } from './voice/ports.js';
import type { VoiceService } from './voice/voice-turn.js';
import * as scenarioRepo from './scenario/repo.js';
import { ScenarioValidationError, sellerProfileSchema, validateScenario } from './scenario/schema.js';

export type TrainingPermission = 'training:use' | 'training:view:all' | 'training:scenario:manage';

export const TRAINING_PERMISSIONS: TrainingPermission[] = [
  'training:use',
  'training:view:all',
  // Rahbar: ssenariy yaratish/tahrirlash/arxivlash (sotuvchi faqat o'ynaydi).
  'training:scenario:manage',
];

/** `authorize` ruxsat bermasa shu xatoni tashlasa — 403 (401 emas). */
export class TrainingForbiddenError extends Error {
  readonly permission: TrainingPermission;
  constructor(permission: TrainingPermission, message = "bu amal uchun ruxsat yo'q") {
    super(message);
    this.name = 'TrainingForbiddenError';
    this.permission = permission;
  }
}

/** `code` -> HTTP status. DIQQAT: boshqa tenant sessiyasi uchun 404 (403 EMAS). */
const STATUS_BY_CODE: Record<TrainingErrorCode, number> = {
  profile_missing: 409,
  persona_generation_failed: 502,
  llm_invalid_output: 502,
  llm_timeout: 504,
  llm_provider_error: 502,
  session_not_found: 404,
  session_forbidden: 404,
  session_not_active: 409,
  scenario_not_found: 404,
  scenario_invalid: 422,
  seller_profile_required: 400,
  // Ovoz: format/hajm xatosi — mijoz tomonning xatosi, qayta urinish mantiqsiz.
  voice_unsupported_media: 415,
  voice_audio_too_large: 413,
  // Qulf va byudjet — vaqtinchalik/holat xatosi.
  voice_turn_in_progress: 409,
  voice_budget_exhausted: 409,
  // Audio keldi, lekin nutq tanilmadi (chegara tugadi) — matnga o'tish kerak.
  voice_not_recognized: 422,
  // Provayder (STT/TTS) xatosi — bizning tomonda emas.
  voice_stt_failed: 502,
  voice_tts_failed: 502,
  voice_failed: 500,
  voice_review_expired: 409,
};

/** Xato qaysi BOSQICHDA bo'ldi — UI foydalanuvchiga shuni o'zbekcha aytadi. */
export type ErrorStage = 'audio' | 'stt' | 'llm' | 'tts' | 'session' | 'server';

export function errorStage(code: TrainingErrorCode | 'internal_error'): ErrorStage {
  switch (code) {
    case 'voice_unsupported_media':
    case 'voice_audio_too_large':
      return 'audio';
    case 'voice_stt_failed':
    case 'voice_not_recognized':
      return 'stt';
    case 'voice_tts_failed':
      return 'tts';
    case 'llm_invalid_output':
    case 'llm_timeout':
    case 'llm_provider_error':
    case 'persona_generation_failed':
      return 'llm';
    case 'profile_missing':
    case 'session_not_found':
    case 'session_forbidden':
    case 'session_not_active':
    case 'scenario_not_found':
    case 'scenario_invalid':
    case 'seller_profile_required':
    case 'voice_turn_in_progress':
    case 'voice_budget_exhausted':
    case 'voice_review_expired':
      return 'session';
    default:
      return 'server';
  }
}

export interface TrainingRoutesConfig {
  /** Marshrut prefiksi. Default `/api/v1/training`. */
  prefix?: string;
  /** Sessiya tugaganda baholashni avtomatik boshlash. Default `true`. */
  autoScoreOnEnd?: boolean;
  /** Bir foydalanuvchi uchun daqiqadagi so'rov chegarasi. Default 60. */
  rateLimitPerMinute?: number;
  /**
   * UI'da ko'rsatiladigan mijoz turlari (tartib saqlanadi). Berilmasa — hammasi.
   * Faqat ro'yxatni cheklaydi; arxetiplar mantig'i o'zgarmaydi.
   */
  archetypes?: readonly ArchetypeKey[];
  /**
   * Debug ma'lumotini (holat sonlari, blockers) javobga qo'shish.
   * FAQAT harness uchun; modul o'zi hech qachon `true` qilmaydi.
   */
  allowDebug?: boolean;
}

export interface TrainingRoutesDeps {
  engine: TrainingEngine;
  scoring: ScoringService;
  withTenant: WithTenant;
  /** Host auth: so'rovdan tenant/foydalanuvchini oladi. */
  getContext: (req: FastifyRequest) => Promise<TrainingContext> | TrainingContext;
  /** Ruxsat tekshiruvi; ruxsat bo'lmasa xato tashlashi kerak. */
  authorize?: (ctx: TrainingContext, permission: TrainingPermission) => Promise<void> | void;
  /**
   * Ovozli navbat. Berilmasa `/voice-turn` route'i UMUMAN ro'yxatga
   * olinmaydi (matnli rejim o'zgarmaydi).
   */
  voice?: VoiceService;
  config?: TrainingRoutesConfig;
  logger?: TrainingLogger;
}

// ---------------------------------------------------------------------------
// Yordamchilar
// ---------------------------------------------------------------------------
const startSessionBody = z
  .object({
    archetypeKey: z.enum(ARCHETYPE_KEYS).optional(),
    /** Ssenariy rejimi (`GET /scenarios`). Berilsa `seller` MAJBURIY. */
    scenarioId: z.string().regex(/^[a-z][a-z0-9_]{2,60}$/).optional(),
    /** Sotuvchi profili: ism, jins, yosh — formadan; ovozdan/ismdan taxmin qilinmaydi. */
    seller: sellerProfileSchema.optional(),
    /** Ssenariy darajasi: easy (Oson) | medium (O'rta) | hard (Qiyin). */
    level: z.enum(['easy', 'medium', 'hard']).optional(),
    direction: z.enum(['inbound', 'outbound']).optional(),
    language: z.enum(['uz', 'ru', 'mixed']).optional(),
  })
  .refine((b) => b.archetypeKey || b.scenarioId, { message: 'archetypeKey yoki scenarioId kerak' })
  .refine((b) => !b.scenarioId || b.seller, {
    message: "ssenariy uchun sotuvchi profili (seller: name, gender, age) majburiy",
    path: ['seller'],
  });

const turnBody = z.object({ text: z.string().min(1).max(4000) });
const voiceReplyBody = z.object({
  transcriptId: z.string().uuid(),
  text: z.string().trim().min(1).max(4000),
});
const endBody = z.object({ reason: z.string().min(1).max(200).optional() });
const idParams = z.object({ id: z.string().uuid() });
const statsQuery = z.object({ userId: z.string().uuid().optional() });

/** Sessiya davomida ko'rsatiladigan persona (yashirin ma'lumotsiz). */
export function personaSummary(persona: PersonaCard, openingLine: string | null): PersonaSummary {
  return {
    name: persona.name,
    age: persona.age,
    role: persona.role,
    direction: persona.direction,
    openingLine,
  };
}

/** Sessiya TUGAGANDAN keyin oshkor qilinadigan "yashirin kartalar". */
export function revealPersona(persona: PersonaCard, metrics: SessionMetrics | null): RevealedPersona {
  const raised = metrics?.objections.raised ?? [];
  const resolved = metrics?.objections.resolved ?? [];
  return {
    name: persona.name,
    role: persona.role,
    situation: persona.situation,
    goal: persona.goal,
    focusOffer: persona.focusOffer,
    hiddenNeed: persona.hiddenNeed,
    hiddenFacts: [...persona.hiddenFacts],
    objections: persona.objections.map((o) => ({
      key: o.key,
      text: o.text,
      severity: o.severity,
      raised: raised.includes(o.key),
      resolved: resolved.includes(o.key),
    })),
  };
}

function resultPayload(row: scoringRepo.TrainingResultRow): Record<string, unknown> {
  return {
    version: row.version,
    status: row.status,
    quality: row.quality,
    skillScore: row.skillScore === null ? null : Number(row.skillScore),
    criteria: row.criteria ?? [],
    metrics: row.metrics ?? null,
    coaching: row.coaching ?? null,
    keyMoments: row.keyMoments ?? [],
    model: row.model,
    promptVersion: row.promptVersion,
    error: row.error,
    createdAt: row.createdAt,
  };
}

/**
 * Juda sodda, xotiradagi rate-limit. Asosiy repoda `@fastify/rate-limit`
 * yoki o'z middleware'ingiz bilan almashtiring (INTEGRATION.md ga qarang).
 */
function createRateLimiter(perMinute: number) {
  const hits = new Map<string, number[]>();
  return function check(userId: string): boolean {
    const now = Date.now();
    const windowStart = now - 60_000;
    const previous = (hits.get(userId) ?? []).filter((t) => t > windowStart);
    if (previous.length >= perMinute) {
      hits.set(userId, previous);
      return false;
    }
    previous.push(now);
    hits.set(userId, previous);
    return true;
  };
}

// ---------------------------------------------------------------------------
// Plagin
// ---------------------------------------------------------------------------
export async function registerTrainingRoutes(
  app: FastifyInstance,
  deps: TrainingRoutesDeps,
): Promise<void> {
  const prefix = deps.config?.prefix ?? '/api/v1/training';
  const autoScore = deps.config?.autoScoreOnEnd ?? true;
  const allowDebug = deps.config?.allowDebug ?? false;
  const visibleArchetypes = deps.config?.archetypes;
  const rateLimit = createRateLimiter(deps.config?.rateLimitPerMinute ?? 60);
  const authorize = deps.authorize ?? ((): void => undefined);

  /** Har handler uchun umumiy qobiq: auth, ruxsat, rate-limit, xato xaritasi. */
  async function guard(
    req: FastifyRequest,
    reply: FastifyReply,
    permission: TrainingPermission,
    handler: (ctx: TrainingContext) => Promise<unknown>,
  ): Promise<unknown> {
    let ctx: TrainingContext;
    try {
      ctx = await deps.getContext(req);
      await authorize(ctx, permission);
    } catch (err) {
      if (err instanceof TrainingForbiddenError) {
        return reply.code(403).send({
          error: 'forbidden',
          stage: 'session',
          message:
            permission === 'training:scenario:manage'
              ? 'Bu amal faqat rahbar (sotuv bo\'limi boshlig\'i) uchun.'
              : err.message,
        });
      }
      deps.logger?.warn({ err }, 'training: auth rad etildi');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    if (!rateLimit(ctx.userId)) {
      return reply.code(429).send({ error: 'rate_limited' });
    }

    try {
      return await handler(ctx);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ error: 'validation_failed', issues: err.issues });
      }
      if (err instanceof ScenarioValidationError) {
        return reply.code(422).send({ error: 'scenario_invalid', stage: 'session', message: err.message, issues: err.issues });
      }
      if (err instanceof scenarioRepo.ScenarioExistsError) {
        return reply.code(409).send({ error: 'scenario_exists', stage: 'session', message: err.message });
      }
      if (isTrainingError(err) && err.code === 'scenario_invalid' && err.details instanceof ScenarioValidationError) {
        return reply
          .code(422)
          .send({ error: 'scenario_invalid', stage: 'session', message: err.details.message, issues: err.details.issues });
      }
      if (isTrainingError(err)) {
        const status = STATUS_BY_CODE[err.code];
        if (status >= 500) {
          deps.logger?.warn(
            { code: err.code, llmErrorKind: err.llmErrorKind },
            `training: ${err.code}: ${err.message}`,
          );
        }
        return reply.code(status).send({
          error: err.code,
          stage: errorStage(err.code),
          message: err.message,
          ...(err.llmErrorKind ? { category: err.llmErrorKind } : {}),
        });
      }
      deps.logger?.error({ err }, 'training: kutilmagan xato');
      // Xom stack/JSON emas: bosqich va qisqa o'zbekcha xabar (tafsilot — server logida).
      return reply.code(500).send({
        error: 'internal_error',
        stage: 'server',
        message: "kutilmagan server xatosi — tafsilot server logida",
      });
    }
  }

  /** Fon rejimida baholash (javobni kutmasdan). */
  function scoreInBackground(ctx: TrainingContext, sessionId: string): void {
    void deps.scoring.scoreSession(ctx, sessionId).catch((err: unknown) => {
      deps.logger?.error({ err, sessionId }, 'fon rejimidagi baholash muvaffaqiyatsiz');
    });
  }

  app.get(`${prefix}/archetypes`, async (req, reply) =>
    guard(req, reply, 'training:use', async () => ({
      archetypes: listArchetypes()
        .filter((a) => !visibleArchetypes || (visibleArchetypes as readonly string[]).includes(a.key))
        .map((a) => ({
          key: a.key,
          title: a.title,
          description: a.description,
          difficulty: a.difficulty,
          intent: a.intent,
          maxTurns: a.maxTurns,
        })),
    })),
  );

  // --- Kim: rahbarmi (ssenariy yaratish sahifasini ko'rsatish uchun) ----------
  app.get(`${prefix}/me`, async (req, reply) =>
    guard(req, reply, 'training:use', async (ctx) => {
      let canManageScenarios = true;
      try {
        await authorize(ctx, 'training:scenario:manage');
      } catch {
        canManageScenarios = false;
      }
      return { userId: ctx.userId, canManageScenarios };
    }),
  );

  // --- Ssenariy yaratish (FAQAT rahbar) ---------------------------------------
  const scenarioIdParams = z.object({ id: z.string().regex(/^[a-z][a-z0-9_]{2,60}$/) });
  const scenarioBody = z.object({ scenario: z.record(z.unknown()) });

  app.get(`${prefix}/scenarios/manage`, async (req, reply) =>
    guard(req, reply, 'training:scenario:manage', async (ctx) => ({
      scenarios: await deps.withTenant(ctx.businessId, (tx) => scenarioRepo.listAllScenarios(tx)),
    })),
  );

  app.get(`${prefix}/scenarios/:id`, async (req, reply) =>
    guard(req, reply, 'training:scenario:manage', async (ctx) => {
      const { id } = scenarioIdParams.parse(req.params);
      const rec = await deps.withTenant(ctx.businessId, (tx) => scenarioRepo.getScenarioRecord(tx, id));
      if (!rec) throw new TrainingError('scenario_not_found', `ssenariy topilmadi: ${id}`);
      return rec;
    }),
  );

  /** Formani saqlamasdan tekshirish (jonli xatolar va ogohlantirishlar). */
  app.post(`${prefix}/scenarios/validate`, async (req, reply) =>
    guard(req, reply, 'training:scenario:manage', async () => {
      const { scenario } = scenarioBody.parse(req.body ?? {});
      const v = validateScenario(scenario, 'forma');
      return v.ok ? { ok: true, warnings: v.warnings, issues: [] } : { ok: false, warnings: [], issues: v.issues };
    }),
  );

  app.post(`${prefix}/scenarios`, async (req, reply) =>
    guard(req, reply, 'training:scenario:manage', async (ctx) => {
      const { scenario } = scenarioBody.parse(req.body ?? {});
      const saved = await deps.withTenant(ctx.businessId, async (tx) => {
        const id =
          typeof scenario.id === 'string' && scenario.id
            ? scenario.id
            : await scenarioRepo.freeScenarioId(tx, String(scenario.title_uz ?? 'ssenariy'));
        return await scenarioRepo.createScenario(tx, ctx.businessId, { ...scenario, id });
      });
      const v = validateScenario(saved);
      return reply.code(201).send({ scenario: saved, warnings: v.ok ? v.warnings : [] });
    }),
  );

  app.put(`${prefix}/scenarios/:id`, async (req, reply) =>
    guard(req, reply, 'training:scenario:manage', async (ctx) => {
      const { id } = scenarioIdParams.parse(req.params);
      const { scenario } = scenarioBody.parse(req.body ?? {});
      const saved = await deps.withTenant(ctx.businessId, (tx) => scenarioRepo.updateScenario(tx, id, scenario));
      if (!saved) throw new TrainingError('scenario_not_found', `ssenariy topilmadi: ${id}`);
      const v = validateScenario(saved);
      return { scenario: saved, warnings: v.ok ? v.warnings : [] };
    }),
  );

  app.post(`${prefix}/scenarios/:id/duplicate`, async (req, reply) =>
    guard(req, reply, 'training:scenario:manage', async (ctx) => {
      const { id } = scenarioIdParams.parse(req.params);
      const copy = await deps.withTenant(ctx.businessId, (tx) => scenarioRepo.duplicateScenario(tx, ctx.businessId, id));
      if (!copy) throw new TrainingError('scenario_not_found', `ssenariy topilmadi: ${id}`);
      return reply.code(201).send({ scenario: copy });
    }),
  );

  app.post(`${prefix}/scenarios/:id/archive`, async (req, reply) =>
    guard(req, reply, 'training:scenario:manage', async (ctx) => {
      const { id } = scenarioIdParams.parse(req.params);
      const { archived } = z.object({ archived: z.boolean().default(true) }).parse(req.body ?? {});
      const ok = await deps.withTenant(ctx.businessId, (tx) => scenarioRepo.setScenarioActive(tx, id, !archived));
      if (!ok) throw new TrainingError('scenario_not_found', `ssenariy topilmadi: ${id}`);
      return { id, archived };
    }),
  );

  /** "AI bilan to'ldirish": erkin matn -> to'liq taklif (SAQLANMAYDI). */
  app.post(`${prefix}/scenarios/ai-draft`, async (req, reply) =>
    guard(req, reply, 'training:scenario:manage', async (ctx) => {
      const { text } = z.object({ text: z.string().max(2000) }).parse(req.body ?? {});
      const d = await deps.engine.draftScenario(ctx, { text });
      return { ok: d.ok, scenario: d.scenario ?? d.raw, warnings: d.warnings, issues: d.issues, attempts: d.attempts };
    }),
  );

  /** "Sinab ko'rish": saqlanmagan qoralama bilan navbat (holat klientda saqlanadi). */
  app.post(`${prefix}/scenarios/try`, async (req, reply) =>
    guard(req, reply, 'training:scenario:manage', async (ctx) => {
      const body = z
        .object({
          scenario: z.record(z.unknown()),
          seller: sellerProfileSchema,
          persona: z.unknown().optional(),
          state: z.unknown().optional(),
          transcript: z.array(z.object({ speaker: z.enum(['seller', 'customer']), text: z.string().max(2000) })).max(20),
          sellerText: z.string().trim().min(1).max(2000),
        })
        .parse(req.body ?? {});
      return await deps.engine.tryScenarioTurn(ctx, {
        scenario: body.scenario,
        seller: body.seller,
        ...(body.persona !== undefined ? { persona: body.persona } : {}),
        ...(body.state !== undefined ? { state: body.state } : {}),
        transcript: body.transcript,
        sellerText: body.sellerText,
      });
    }),
  );

  // Ssenariylar ro'yxati (faqat faollari) + kontent ogohlantirishi (UI boshlashdan oldin ko'rsatadi).
  app.get(`${prefix}/scenarios`, async (req, reply) =>
    guard(req, reply, 'training:use', async (ctx) => ({
      scenarios: await deps.withTenant(ctx.businessId, (tx) => scenarioRepo.listScenarios(tx)),
    })),
  );

  app.post(`${prefix}/sessions`, async (req, reply) =>
    guard(req, reply, 'training:use', async (ctx) => {
      const body = startSessionBody.parse(req.body ?? {});
      const started = await deps.engine.startSession(ctx, {
        ...(body.archetypeKey ? { archetypeKey: body.archetypeKey } : {}),
        ...(body.scenarioId ? { scenarioId: body.scenarioId } : {}),
        ...(body.seller ? { seller: body.seller } : {}),
        ...(body.level ? { level: body.level } : {}),
        ...(body.direction ? { direction: body.direction } : {}),
        ...(body.language ? { language: body.language } : {}),
      });
      const archetype = getArchetype(started.archetypeKey);
      return {
        sessionId: started.sessionId,
        archetype: {
          key: archetype.key,
          title: archetype.title,
          difficulty: archetype.difficulty,
          maxTurns: archetype.maxTurns,
        },
        // Yashirin ma'lumot YUBORILMAYDI.
        persona: personaSummary(started.persona, started.openingLine),
        openingLine: started.openingLine,
        ...(started.scenarioId ? { scenarioId: started.scenarioId, content: started.content } : {}),
      };
    }),
  );

  app.get(`${prefix}/sessions`, async (req, reply) =>
    guard(req, reply, 'training:use', async (ctx) => {
      const rows = await deps.withTenant(ctx.businessId, async (tx) =>
        scoringRepo.listSessionsWithScore(tx, ctx.userId),
      );
      return {
        sessions: rows.map((row) => ({
          ...row,
          skillScore: row.skillScore === null ? null : Number(row.skillScore),
          scenarioScore: row.scenarioScore === null ? null : Number(row.scenarioScore),
        })),
      };
    }),
  );

  app.get(`${prefix}/sessions/:id`, async (req, reply) =>
    guard(req, reply, 'training:use', async (ctx) => {
      const { id } = idParams.parse(req.params);
      const session = await deps.engine.getSession(ctx, { sessionId: id });
      const ended = session.status !== 'active';
      const latest = ended ? await deps.scoring.getLatestAnyResult(ctx, id) : null;
      const metrics = (latest?.metrics ?? null) as SessionMetrics | null;

      return {
        sessionId: session.sessionId,
        archetypeKey: session.archetypeKey,
        status: session.status,
        outcome: session.outcome,
        endReason: session.endReason,
        turnCount: session.turnCount,
        transcript: session.transcript,
        persona: personaSummary(session.persona, null),
        // 7-qoida: yashirin kartalar FAQAT sessiya tugagach.
        revealed: ended ? revealPersona(session.persona, metrics) : null,
        ...(session.scenarioId ? { scenarioId: session.scenarioId, content: session.content } : {}),
        ...(allowDebug ? { debug: { state: session.state } } : {}),
      };
    }),
  );

  app.post(`${prefix}/sessions/:id/turn`, async (req, reply) =>
    guard(req, reply, 'training:use', async (ctx) => {
      const { id } = idParams.parse(req.params);
      const body = turnBody.parse(req.body ?? {});
      const result = await deps.engine.takeTurn(ctx, { sessionId: id, sellerText: body.text });

      if (result.ended && autoScore) scoreInBackground(ctx, id);

      return {
        customerReply: result.customerReply,
        ended: result.ended,
        outcome: result.outcome ?? null,
        endReason: result.endReason ?? null,
        turnCount: result.turnCount,
        ...(allowDebug
          ? {
              debug: {
                state: result.state,
                readiness: result.meta.readiness,
                intent: result.meta.intent,
                latencyMs: result.meta.latencyMs,
                guardRetried: result.meta.guardRetried,
                guardViolated: result.meta.guardViolated,
                ...(result.meta.scenario ? { scenario: result.meta.scenario } : {}),
                ...(result.meta.usage ? { usage: result.meta.usage } : {}),
                costUsd: result.meta.costUsd,
              },
            }
          : {}),
      };
    }),
  );

  app.post(`${prefix}/sessions/:id/end`, async (req, reply) =>
    guard(req, reply, 'training:use', async (ctx) => {
      const { id } = idParams.parse(req.params);
      const body = endBody.parse(req.body ?? {});
      await deps.engine.endSession(ctx, { sessionId: id, reason: body.reason ?? 'user_ended' });
      if (autoScore) scoreInBackground(ctx, id);
      return { ok: true };
    }),
  );

  app.post(`${prefix}/sessions/:id/score`, async (req, reply) =>
    guard(req, reply, 'training:use', async (ctx) => {
      const { id } = idParams.parse(req.params);
      // Versiya DARHOL band qilinadi (sessiya qulfi ostida). Shu sessiya uchun
      // baholash allaqachon ketayotgan bo'lsa — yangisi boshlanmaydi, mavjudi
      // qaytariladi (tugmani ko'p bosish parallel run'lar yaratmaydi).
      const request = await deps.scoring.requestScoring(ctx, id);
      request.done?.catch((err: unknown) => {
        deps.logger?.error({ err, sessionId: id }, 'fon rejimidagi baholash muvaffaqiyatsiz');
      });
      return reply.code(202).send({
        status: 'pending',
        version: request.version,
        alreadyRunning: request.alreadyRunning,
      });
    }),
  );

  app.get(`${prefix}/sessions/:id/result`, async (req, reply) =>
    guard(req, reply, 'training:use', async (ctx) => {
      const { id } = idParams.parse(req.params);
      const session = await deps.engine.getSession(ctx, { sessionId: id });
      const ended = session.status !== 'active';
      const done = await deps.scoring.getLatestResult(ctx, id);
      const latest = await deps.scoring.getLatestAnyResult(ctx, id);
      const any = done ?? latest;

      if (!any) {
        return reply.code(404).send({ error: 'result_not_found' });
      }

      const metrics = (any.metrics ?? null) as SessionMetrics | null;
      return {
        sessionId: id,
        archetypeKey: session.archetypeKey,
        outcome: session.outcome,
        endReason: session.endReason,
        transcript: session.transcript,
        result: resultPayload(any),
        // Oxirgi run holati (pending/failed bo'lishi mumkin) — `result` esa
        // oxirgi TUGALLANGAN natija. UI qayta baholash jarayonini shundan ko'radi.
        latestRun: latest
          ? {
              version: latest.version,
              status: latest.status,
              error: latest.error,
              createdAt: latest.createdAt,
            }
          : null,
        revealed: ended ? revealPersona(session.persona, metrics) : null,
      };
    }),
  );

  // -------------------------------------------------------------------------
  // Ovozli navbat (Step 3 Phase B). `deps.voice` berilmasa — route yo'q.
  // -------------------------------------------------------------------------
  if (deps.voice) {
    const voice = deps.voice;

    // Xom WAV. Fastify'da bunday parser bo'lmasa `audio/wav` 415 bo'lardi.
    // Bir ildiz instansiyada ikki marta ro'yxatga olinmasligi uchun tekshiramiz.
    for (const mime of [VOICE_AUDIO.mime, 'audio/x-wav', 'audio/wave']) {
      if (!app.hasContentTypeParser(mime)) {
        app.addContentTypeParser(mime, { parseAs: 'buffer' }, (_req, body, done) => {
          done(null, body);
        });
      }
    }

    app.post(
      `${prefix}/sessions/:id/voice-turn`,
      // Hajm chegarasi Fastify darajasida: katta yozuv handler'ga YETIB
      // kelmaydi (413), ya'ni xotira ham band qilinmaydi.
      { bodyLimit: VOICE_LIMITS.maxBytes },
      async (req, reply) =>
        guard(req, reply, 'training:use', async (ctx) => {
          const { id } = idParams.parse(req.params);
          const mime = (req.headers['content-type'] ?? '').toString();
          const body = req.body;

          // Parser `audio/wav` bo'lmasa (masalan JSON yuborilgan) — 415.
          if (!Buffer.isBuffer(body)) {
            throw new TrainingError(
              'voice_unsupported_media',
              `kutilgan ${VOICE_AUDIO.mime}, kelgan "${mime.slice(0, 80)}"`,
            );
          }

          const result = await voice.takeVoiceTurn(ctx, {
            sessionId: id,
            audio: body,
            mime,
          });

          if (result.ended && autoScore) scoreInBackground(ctx, id);
          return voiceTurnPayload(result);
        }),
    );

    /** Ovozli navbat javobi (bir bosqichli va tekshirilgan yo'l uchun bir xil). */
    function voiceTurnPayload(result: Awaited<ReturnType<typeof voice.takeVoiceTurn>>): Record<string, unknown> {
      return {
        sellerText: result.sellerText,
        customerText: result.customerText,
        tone: result.tone,
        // Audio FAQAT shu javobda (yoki bir martalik oqim URL'ida) va saqlanmaydi.
        audio: result.audio.toString('base64'),
        audioMime: result.audioMime,
        ...(result.audioStream ? { audioStreamUrl: `${prefix}/voice-audio/${result.audioStream.id}` } : {}),
        needsRepeat: result.needsRepeat,
        ended: result.ended,
        outcome: result.outcome ?? null,
        endReason: result.endReason ?? null,
        turnCount: result.turnCount,
        ...(allowDebug ? { debug: { timings: result.timings, costUsd: result.costUsd } } : {}),
      };
    }

    /**
     * Tekshirish rejimi, 1-qadam: yozuv -> tanilgan matn (LLM/TTS yo'q, holat
     * o'zgarmaydi). Foydalanuvchi matnni tuzatib `voice-reply` bilan yuboradi.
     */
    app.post(
      `${prefix}/sessions/:id/voice-transcribe`,
      { bodyLimit: VOICE_LIMITS.maxBytes },
      async (req, reply) =>
        guard(req, reply, 'training:use', async (ctx) => {
          const { id } = idParams.parse(req.params);
          const mime = (req.headers['content-type'] ?? '').toString();
          if (!Buffer.isBuffer(req.body)) {
            throw new TrainingError(
              'voice_unsupported_media',
              `kutilgan ${VOICE_AUDIO.mime}, kelgan "${mime.slice(0, 80)}"`,
            );
          }
          const result = await voice.transcribeVoice(ctx, { sessionId: id, audio: req.body, mime });
          return {
            transcriptId: result.transcriptId,
            sttText: result.sttText,
            recognized: result.recognized,
            ...(result.rejected ? { rejected: result.rejected } : {}),
            ...(allowDebug ? { debug: { sttMs: result.sttMs, durationSec: result.durationSec } } : {}),
          };
        }),
    );

    /** Tekshirish rejimi, 2-qadam: tasdiqlangan matn -> mijoz javobi (ovozda). */
    app.post(`${prefix}/sessions/:id/voice-reply`, async (req, reply) =>
      guard(req, reply, 'training:use', async (ctx) => {
        const { id } = idParams.parse(req.params);
        const body = voiceReplyBody.parse(req.body);
        const result = await voice.replyToText(ctx, { sessionId: id, transcriptId: body.transcriptId, text: body.text });
        if (result.ended && autoScore) scoreInBackground(ctx, id);
        return voiceTurnPayload(result);
      }),
    );

    /**
     * Mijoz audiosi OQIMI (bir marta, 60 s). `<audio src>` maxsus sarlavha
     * (Authorization) yubora olmaydi, shuning uchun auth o'rniga id'ning
     * o'zi ruxsatnoma: tasodifiy UUID, bir martalik, qisqa muddatli
     * (presigned URL kabi). Boshqa sessiya ma'lumoti bu yerdan olinmaydi.
     */
    app.get(`${prefix}/voice-audio/:streamId`, async (req, reply) => {
      const parsed = z.object({ streamId: z.string().uuid() }).safeParse(req.params);
      const stream = parsed.success ? voice.openAudioStream(parsed.data.streamId) : null;
      if (!stream) return reply.code(404).send({ error: 'audio_not_found', stage: 'tts' });
      const iterator = stream.chunks;
      async function* asBuffers(): AsyncGenerator<Buffer> {
        for await (const chunk of iterator) yield Buffer.from(chunk);
      }
      reply.header('content-type', stream.mime);
      reply.header('cache-control', 'no-store');
      return reply.send(Readable.from(asBuffers()));
    });

    /** `inbound` sessiyada mijozning birinchi gapi — ovozda. */
    app.post(`${prefix}/sessions/:id/opening-audio`, async (req, reply) =>
      guard(req, reply, 'training:use', async (ctx) => {
        const { id } = idParams.parse(req.params);
        const spoken = await voice.speakOpeningLine(ctx, { sessionId: id });
        if (!spoken) return reply.code(204).send();
        return {
          text: spoken.text,
          tone: spoken.tone,
          audio: spoken.audio.toString('base64'),
          audioMime: spoken.audioMime,
          ...(allowDebug ? { debug: { ttsMs: spoken.ttsMs, costUsd: spoken.costUsd } } : {}),
        };
      }),
    );
  }

  /** O'z statistikasi. */
  app.get(`${prefix}/me/stats`, async (req, reply) =>
    guard(req, reply, 'training:use', async (ctx) => buildStats(ctx, ctx.userId)),
  );

  /** Boshqa foydalanuvchining statistikasi — `training:view:all` kerak. */
  app.get(`${prefix}/stats`, async (req, reply) =>
    guard(req, reply, 'training:view:all', async (ctx) => {
      const query = statsQuery.parse(req.query ?? {});
      return await buildStats(ctx, query.userId ?? ctx.userId);
    }),
  );

  async function buildStats(ctx: TrainingContext, userId: string): Promise<unknown> {
    const { sessions, weakest } = await deps.withTenant(ctx.businessId, async (tx) => ({
      sessions: await scoringRepo.listSessionsWithScore(tx, userId),
      weakest: await scoringRepo.criterionAverages(tx, userId),
    }));

    const byArchetype = new Map<string, { total: number; won: number }>();
    const trend: Array<{ sessionId: string; startedAt: Date; skillScore: number }> = [];

    for (const row of sessions) {
      const bucket = byArchetype.get(row.archetypeKey) ?? { total: 0, won: 0 };
      if (row.status !== 'active') {
        bucket.total += 1;
        if (row.outcome === 'won') bucket.won += 1;
      }
      byArchetype.set(row.archetypeKey, bucket);

      if (row.skillScore !== null) {
        trend.push({
          sessionId: row.id,
          startedAt: row.startedAt,
          skillScore: Number(row.skillScore),
        });
      }
    }

    trend.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
    const scores = trend.map((t) => t.skillScore);

    return {
      userId,
      totalSessions: sessions.length,
      endedSessions: sessions.filter((s) => s.status !== 'active').length,
      winRateByArchetype: [...byArchetype.entries()].map(([key, value]) => ({
        archetypeKey: key,
        total: value.total,
        won: value.won,
        winRate: value.total === 0 ? null : Number((value.won / value.total).toFixed(2)),
      })),
      skillScoreTrend: trend,
      avgSkillScore:
        scores.length === 0
          ? null
          : Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)),
      weakestCriteria: weakest.slice(0, 3),
    };
  }
}

/** Yordamchi: mezonlar ro'yxatidan eng zaiflarini olish (UI uchun). */
export function weakestCriteria(criteria: readonly CriterionResult[], limit = 3): CriterionResult[] {
  return criteria
    .filter((c) => c.score !== null)
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
    .slice(0, limit);
}

export { TrainingError };
