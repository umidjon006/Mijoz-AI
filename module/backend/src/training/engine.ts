/**
 * Mashq motori: sessiya ochish, navbat o'ynash, sessiyani tugatish.
 *
 * Tamoyillar:
 *  - har mijoz navbatiga BITTA LLM chaqiruvi (+ ko'pi bilan bitta tuzatish
 *    uchun qayta urinish) — keyinchalik ovoz uchun kechikish muhim;
 *  - LLM taklif qiladi, KOD qaror qiladi: g'alaba/yutqazish/timeout
 *    `state.ts` da hisoblanadi;
 *  - "agreement guard": model qoidani buzib rozi bo'lsa, matni olinadi,
 *    lekin NATIJA o'zgarmaydi va `flags.guardViolations` oshadi;
 *  - hamma DB ishi tashqaridan berilgan `withTenant` orqali, bitta
 *    tranzaksiyada.
 */
import { getArchetype, type Archetype, type ArchetypeKey } from './archetypes.js';
import {
  describeLlmError,
  isCorrectableLlmError,
  TrainingError,
  trainingErrorFromLlm,
} from './errors.js';
import {
  generatePersonaCard,
  personaCardSchema,
  resolveDirection,
  type PersonaCard,
  type PersonaDirection,
  type PersonaLanguage,
} from './persona.js';
import {
  findScriptViolations,
  guardCustomerReply,
  nonLatinWords,
  scriptCorrectionNote,
} from './language.js';
import type {
  PriceCall,
  TokenUsage,
  TrainerLlm,
  TrainerLlmRequest,
  TrainingContext,
  TrainingDeps,
  TrainingTx,
} from './ports.js';
import {
  buildTurnSystemPrompt,
  buildTurnUserPrompt,
  TRANSCRIPT_WINDOW,
  type TranscriptTurn,
} from './prompts.js';
import * as repo from './repo.js';
import {
  applyTurnResult,
  coerceTurnResult,
  computeReadiness,
  evaluateEnd,
  initState,
  isGuardViolation,
  recordGuardViolation,
  trainingStateSchema,
  turnResultSchema,
  type EndEvaluation,
  type Readiness,
  type TrainingOutcome,
  type TrainingState,
  type TurnResult,
} from './state.js';
import { clampTone, type VoiceTone } from './voice/tone.js';
import { scenarioPersonaConstraints } from './scenario/prompt.js';
import { draftScenarioWithLlm, type DraftResult } from './scenario/draft.js';
import type { DifficultyLevel } from './scenario/content-rules.js';
import * as scenarioRepo from './scenario/repo.js';
import { runScenarioTurn, type ScenarioTurnMeta, type ScenarioTurnOutcome } from './scenario/scenario-turn.js';
import {
  contentFlag,
  parseScenario,
  scenarioArchetype,
  scenarioVoiceStyle,
  ScenarioValidationError,
  sellerProfileSchema,
  type ContentFlag,
  type Scenario,
  type SellerProfile,
} from './scenario/schema.js';

export interface StartSessionInput {
  /** Arxetip rejimi uchun. Ssenariy berilsa — ssenariyning asosiy arxetipi ishlatiladi. */
  archetypeKey?: string;
  /** Ssenariy rejimi: `training_scenario.id`. */
  scenarioId?: string;
  /** Sotuvchi profili — ssenariy rejimida MAJBURIY (taxmin qilinmaydi). */
  seller?: SellerProfile;
  /** Ssenariy rejimi: sotuvchi tanlagan daraja (Oson/O'rta/Qiyin). Default — medium. */
  level?: DifficultyLevel;
  direction?: PersonaDirection;
  language?: PersonaLanguage;
}

export interface StartSessionResult {
  sessionId: string;
  archetypeKey: ArchetypeKey;
  persona: PersonaCard;
  state: TrainingState;
  /** `inbound` bo'lsa mijoz birinchi gapiradi — shu matn 1-navbat sifatida yoziladi. */
  openingLine: string | null;
  /** Ssenariy sessiyasi: id va kontent ogohlantirishi. */
  scenarioId?: string;
  content?: ContentFlag;
}

export interface TakeTurnInput {
  sessionId: string;
  sellerText: string;
}

export interface TakeTurnResult {
  customerReply: string;
  state: TrainingState;
  ended: boolean;
  outcome?: TrainingOutcome;
  endReason?: string;
  /** Sotuvchining shu sessiyadagi navbatlari soni. */
  turnCount: number;
  /** Debug/telemetriya. */
  meta: {
    latencyMs: number;
    usage?: TokenUsage;
    costUsd: number;
    readiness: Readiness;
    guardRetried: boolean;
    guardViolated: boolean;
    intent: TurnResult['intent'];
    /** Ovoz uchun ohang — model taklifi HOLATGA moslangandan keyin. */
    tone: VoiceTone;
    /** Model taklifi holatga to'g'ri kelmagani uchun o'zgartirildimi. */
    toneClamped: boolean;
    /** Ssenariy rejimi: emotsiya, forma, haqorat, tuzatishlar, xavfsizlik bloklari. */
    scenario?: ScenarioTurnMeta;
  };
}

export interface GetSessionResult {
  sessionId: string;
  archetypeKey: string;
  status: string;
  outcome: string | null;
  endReason: string | null;
  turnCount: number;
  costUsd: string;
  persona: PersonaCard;
  state: TrainingState;
  transcript: TranscriptTurn[];
  scenarioId?: string;
  content?: ContentFlag;
}

/** "Sinab ko'rish": saqlanmagan qoralama bilan bitta navbat (DB'ga yozilmaydi). */
export interface TryScenarioTurnInput {
  scenario: unknown;
  seller: SellerProfile;
  /** Oldingi javobdan qaytgan persona/holat (birinchi navbatda bo'lmaydi). */
  persona?: unknown;
  state?: unknown;
  transcript: TranscriptTurn[];
  sellerText: string;
  level?: DifficultyLevel;
}

export interface TryScenarioTurnResult {
  customerReply: string;
  persona: PersonaCard;
  state: TrainingState;
  ended: boolean;
  endReason: string | null;
  /** `inbound` ssenariyda birinchi chaqiruvda mijozning ochilish gapi. */
  openingLine: string | null;
  meta: ScenarioTurnMeta & { latencyMs: number; costUsd: number; tone: VoiceTone };
}

export interface TrainingEngine {
  startSession(ctx: TrainingContext, input: StartSessionInput): Promise<StartSessionResult>;
  /** Rahbar: erkin matndan ssenariy taklifi (SAQLANMAYDI). */
  draftScenario(ctx: TrainingContext, input: { text: string }): Promise<DraftResult>;
  /** Rahbar: qoralamani saqlamasdan sinab ko'rish. */
  tryScenarioTurn(ctx: TrainingContext, input: TryScenarioTurnInput): Promise<TryScenarioTurnResult>;
  takeTurn(ctx: TrainingContext, input: TakeTurnInput): Promise<TakeTurnResult>;
  endSession(ctx: TrainingContext, input: { sessionId: string; reason: string }): Promise<void>;
  getSession(ctx: TrainingContext, input: { sessionId: string }): Promise<GetSessionResult>;
}

/** `completeJsonWithUsage` bo'lsa undan foydalanadi, bo'lmasa oddiy chaqiruv. */
async function callLlm<T>(
  llm: TrainerLlm,
  req: TrainerLlmRequest<T>,
): Promise<{ value: T; usage?: TokenUsage }> {
  if (typeof llm.completeJsonWithUsage === 'function') {
    return await llm.completeJsonWithUsage(req);
  }
  return { value: await llm.completeJson(req) };
}

function priceOf(usage: TokenUsage | undefined, priceCall: PriceCall | undefined): number {
  if (!usage || !priceCall) return 0;
  const value = priceCall(usage);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function parseTurnJson(raw: unknown): TurnResult {
  return turnResultSchema.parse(coerceTurnResult(raw));
}

/** LLM javobini o'qiydigan "sxema": avval tozalaydi, keyin tekshiradi. */
const turnResultParser = { parse: parseTurnJson };

/** Ssenariy sessiyasining boshlang'ich holati (emotsiya, sabr, hisoblagichlar). */
export function scenarioInitialState(
  base: TrainingState,
  scenario: Scenario,
  level: DifficultyLevel = 'medium',
): TrainingState {
  const b = scenario.emotion.baseline;
  return {
    ...base,
    trust: b.trust,
    interest: b.interest,
    patience: b.patience,
    emotion: {
      anger: b.anger,
      formality: 'siz',
      warned: false,
      goodQuestions: 0,
      revealed: false,
      objectionAddressed: false,
      level,
    },
  };
}

export function createTrainingEngine(deps: TrainingDeps): TrainingEngine {
  const { withTenant, getBusinessProfile, llm, priceCall } = deps;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? ((): Date => new Date());

  function archetypeOf(key: string): Archetype {
    return getArchetype(key);
  }

  async function loadActiveSession(
    tx: TrainingTx,
    ctx: TrainingContext,
    sessionId: string,
  ): Promise<{ row: repo.TrainingSessionRow; persona: PersonaCard; state: TrainingState }> {
    const row = await repo.getSessionForUpdate(tx, sessionId);
    // RLS tufayli boshqa tenant sessiyasi shunchaki "yo'q" ko'rinadi.
    if (!row) {
      throw new TrainingError('session_not_found', `sessiya topilmadi: ${sessionId}`);
    }
    if (row.userId !== ctx.userId) {
      throw new TrainingError('session_forbidden', 'sessiya boshqa foydalanuvchiga tegishli');
    }
    if (row.status !== 'active') {
      throw new TrainingError('session_not_active', `sessiya holati: ${row.status}`);
    }
    const persona = personaCardSchema.parse(row.personaCard);
    const state = trainingStateSchema.parse(row.state);
    return { row, persona, state };
  }

  /** Ssenariy uchun persona: ism/yosh KOD tanlaydi, qolganini model (cheklovlar bilan). */
  async function generateScenarioPersona(scenario: Scenario, profile: NonNullable<Awaited<ReturnType<typeof getBusinessProfile>>>): Promise<PersonaCard> {
    const archetype = scenarioArchetype(scenario);
    const picked = {
      name: scenario.persona.name_pool[Math.floor(random() * scenario.persona.name_pool.length)] as string,
      age: scenario.persona.age.min + Math.floor(random() * (scenario.persona.age.max - scenario.persona.age.min + 1)),
    };
    return await generatePersonaCard({
      llm,
      profile,
      archetype,
      direction: scenario.call_direction,
      language: 'uz',
      random,
      ...(deps.logger ? { logger: deps.logger } : {}),
      extraConstraints: scenarioPersonaConstraints(scenario, picked),
      overrides: {
        name: picked.name,
        age: picked.age,
        gender: scenario.persona.gender,
        voice: { profile: scenario.voice.profile, baseStyle: scenarioVoiceStyle(scenario) },
      },
    });
  }

  return {
    async draftScenario(ctx, { text }) {
      const trimmed = text.trim();
      if (trimmed.length < 10) {
        throw new TrainingError('scenario_invalid', "vaziyatni kamida bir-ikki gap bilan yozing (10+ belgi)");
      }
      const profile = await getBusinessProfile(ctx.businessId);
      return await draftScenarioWithLlm({ llm, text: trimmed.slice(0, 2000), profile });
    },

    async tryScenarioTurn(ctx, input) {
      let scenario: Scenario;
      try {
        scenario = parseScenario(input.scenario, 'qoralama');
      } catch (err) {
        if (err instanceof ScenarioValidationError) throw new TrainingError('scenario_invalid', err.message, err);
        throw err;
      }
      const seller = sellerProfileSchema.parse(input.seller);
      const profile = await getBusinessProfile(ctx.businessId);
      if (!profile) throw new TrainingError('profile_missing', "biznes profili to'ldirilmagan");
      const archetype = scenarioArchetype(scenario);
      const persona = input.persona
        ? personaCardSchema.parse(input.persona)
        : await generateScenarioPersona(scenario, profile);
      const state: TrainingState = input.state
        ? trainingStateSchema.parse(input.state)
        : scenarioInitialState(initState(archetype, persona), scenario, input.level ?? 'medium');
      const openingLine =
        !input.persona && scenario.call_direction === 'inbound' ? persona.openingLine : null;
      const transcript = [...input.transcript];
      if (openingLine && transcript.length === 0) transcript.push({ speaker: 'customer', text: openingLine });
      const startedMs = Date.now();
      const out = await runScenarioTurn({
        llm,
        scenario,
        seller,
        persona,
        archetype,
        state,
        readiness: computeReadiness(state, persona, archetype),
        user: buildTurnUserPrompt({ transcript: transcript.slice(-TRANSCRIPT_WINDOW), sellerText: input.sellerText.trim() }),
        priceCall,
        logger: deps.logger,
        turnIndex: transcript.length,
      });
      const agreed =
        (out.result.intent === 'agrees' || out.result.intent === 'agrees_next_step') &&
        !isGuardViolation({ ...out.state, patience: 100 }, out.result, archetype, persona);
      const endReason = out.meta.hangup
        ? out.meta.hangup === 'anger'
          ? 'customer_hung_up_angry'
          : 'hangup_condition_met'
        : agreed
          ? 'agreed'
          : null;
      return {
        customerReply: out.result.reply,
        persona,
        state: out.state,
        ended: endReason !== null,
        endReason,
        openingLine,
        meta: { ...out.meta, latencyMs: Date.now() - startedMs, costUsd: out.costUsd, tone: out.tone },
      };
    },

    async startSession(ctx, input) {
      let scenario: Scenario | null = null;
      let seller: SellerProfile | null = null;
      if (input.scenarioId) {
        if (!input.seller) {
          throw new TrainingError(
            'seller_profile_required',
            "ssenariy uchun sotuvchi profili (ism, jins, yosh) majburiy — taxmin qilinmaydi",
          );
        }
        seller = sellerProfileSchema.parse(input.seller);
        const id = input.scenarioId;
        try {
          scenario = await withTenant(ctx.businessId, (tx) => scenarioRepo.getScenario(tx, id));
        } catch (err) {
          if (err instanceof ScenarioValidationError) {
            throw new TrainingError('scenario_invalid', err.message, err);
          }
          throw err;
        }
        if (!scenario) throw new TrainingError('scenario_not_found', `ssenariy topilmadi: ${id}`);
      } else if (!input.archetypeKey) {
        throw new TrainingError('scenario_not_found', 'archetypeKey yoki scenarioId kerak');
      }
      const archetype = scenario ? scenarioArchetype(scenario) : archetypeOf(input.archetypeKey as string);
      const archetypeKey = archetype.key as ArchetypeKey;

      const profile = await getBusinessProfile(ctx.businessId);
      if (!profile) {
        throw new TrainingError(
          'profile_missing',
          "biznes profili to'ldirilmagan — mashq boshlanmaydi",
        );
      }

      const direction = scenario ? scenario.call_direction : resolveDirection(profile, random, input.direction);
      const persona = scenario
        ? await generateScenarioPersona(scenario, profile)
        : await generatePersonaCard({
            llm,
            profile,
            archetype,
            direction,
            language: input.language ?? 'uz',
            random,
            ...(deps.logger ? { logger: deps.logger } : {}),
          });

      const base = initState(archetype, persona);
      const state: TrainingState = scenario ? scenarioInitialState(base, scenario, input.level ?? 'medium') : base;
      const startedAt = now();

      const sessionId = await withTenant(ctx.businessId, async (tx) => {
        const row = await repo.insertSession(tx, {
          businessId: ctx.businessId,
          userId: ctx.userId,
          seatId: ctx.seatId,
          archetypeKey,
          persona,
          state,
          startedAt,
          ...(scenario ? { scenario } : {}),
          ...(seller ? { sellerProfile: seller } : {}),
        });

        // `inbound`: mijoz o'zi qo'ng'iroq qilgan — birinchi gap uning gapi.
        if (direction === 'inbound') {
          await repo.insertTurn(tx, {
            sessionId: row.id,
            businessId: ctx.businessId,
            seq: 1,
            speaker: 'customer',
            text: persona.openingLine,
            stateAfter: state,
            createdAt: startedAt,
          });
        }
        return row.id;
      });

      return {
        sessionId,
        archetypeKey,
        persona,
        state,
        openingLine: direction === 'inbound' ? persona.openingLine : null,
        ...(scenario ? { scenarioId: scenario.id, content: contentFlag(scenario) } : {}),
      };
    },

    async takeTurn(ctx, input) {
      const sellerText = input.sellerText.trim();
      if (sellerText.length === 0) {
        throw new TrainingError('session_not_active', "sotuvchi matni bo'sh");
      }

      return await withTenant(ctx.businessId, async (tx) => {
        const { row, persona, state } = await loadActiveSession(tx, ctx, input.sessionId);
        const sessionScenario = row.scenario ? parseScenario(row.scenario, `session:${row.id}`) : null;
        const archetype = sessionScenario ? scenarioArchetype(sessionScenario) : archetypeOf(row.archetypeKey);

        const transcript = await repo.getRecentTurns(tx, row.id, TRANSCRIPT_WINDOW);
        const sellerSeq = await repo.nextSeq(tx, row.id);
        const turnStartedAt = now();

        await repo.insertTurn(tx, {
          sessionId: row.id,
          businessId: ctx.businessId,
          seq: sellerSeq,
          speaker: 'seller',
          text: sellerText,
          createdAt: turnStartedAt,
        });

        const readiness = computeReadiness(state, persona, archetype);
        const user = buildTurnUserPrompt({ transcript, sellerText });

        const startedMs = Date.now();
        let usage: TokenUsage | undefined;
        let costUsd = 0;
        let guardRetried = false;
        let guardViolated = false;

        const scenario = sessionScenario;
        const sellerProfile = row.sellerProfile ? sellerProfileSchema.parse(row.sellerProfile) : null;
        let scenarioTurn: ScenarioTurnOutcome | null = null;
        let result: TurnResult;
        let applied: TrainingState;

        if (scenario && sellerProfile) {
          // Ssenariy rejimi: emotsiya, forma, murojaat, kontent chegaralari (scenario/*).
          scenarioTurn = await runScenarioTurn({
            llm,
            scenario,
            seller: sellerProfile,
            persona,
            archetype,
            state,
            readiness,
            user,
            priceCall,
            logger: deps.logger,
            sessionId: row.id,
            turnIndex: row.turnCount,
          });
          result = scenarioTurn.result;
          applied = scenarioTurn.state;
          usage = scenarioTurn.usage;
          costUsd += scenarioTurn.costUsd;
          guardRetried = scenarioTurn.meta.corrections.length > 0;
        } else {
          const archetypeTurn = async (): Promise<{ result: TurnResult; applied: TrainingState }> => {
            const call = async (correction?: string): Promise<TurnResult> => {
              const req: TrainerLlmRequest<TurnResult> = {
                stage: 'training.turn',
                system: buildTurnSystemPrompt({
                  persona,
                  archetype,
                  state,
                  readiness,
                  ...(correction ? { correction } : {}),
                }),
                user,
                schema: turnResultParser,
                outputSchema: turnResultSchema,
              };
              const out = await callLlm(llm, req);
              if (out.usage) {
                usage = out.usage;
                costUsd += priceOf(out.usage, priceCall);
              }
              return out.value;
            };

            // 1-urinish. Sxemaga tushmasa yoki guard buzilsa — bitta tuzatish urinishi.
            let result: TurnResult;
            let applied: TrainingState;
            try {
              result = await call();
            } catch (err) {
              // Timeout / HTTP xato — shakl muammosi emas: tuzatuvchi qayta so'rov yo'q.
              if (!isCorrectableLlmError(err)) {
                throw trainingErrorFromLlm('llm_invalid_output', 'mijoz navbati olinmadi', err);
              }
              guardRetried = true;
              const detail = describeLlmError(err);
              try {
                result = await call(
                  `Your previous answer did not match the required JSON shape: ${detail}. Return valid JSON with all required fields.`,
                );
              } catch (err2) {
                if (!isCorrectableLlmError(err2)) {
                  throw trainingErrorFromLlm('llm_invalid_output', 'mijoz navbati olinmadi', err2);
                }
                throw new TrainingError(
                  'llm_invalid_output',
                  `model javobi sxemaga tushmadi (qayta urinishdan keyin ham): ${describeLlmError(err2)}`,
                  err2,
                );
              }
            }
            applied = applyTurnResult(state, result, persona, archetype);

            if (!guardRetried && isGuardViolation(applied, result, archetype, persona)) {
              guardRetried = true;
              const blockers = computeReadiness(applied, persona, archetype).blockers;
              try {
                const retryResult = await call(
                  [
                    `You returned intent "${result.intent}", but that is not allowed right now.`,
                    blockers.length > 0 ? `Reasons: ${blockers.join('; ')}` : '',
                    'Stay in character, do NOT agree and do NOT end the call. Continue the conversation: raise your next concern or ask what you still need to know.',
                  ]
                    .filter((line) => line.length > 0)
                    .join(' '),
                );
                result = retryResult;
                applied = applyTurnResult(state, retryResult, persona, archetype);
              } catch {
                // Tuzatish urinishi muvaffaqiyatsiz — birinchi javob bilan davom etamiz.
              }
            }

            // Til (uz): sotuvchi HECH QACHON lotin bo'lmagan javob ko'rmaydi.
            //  - o'zbek kirill -> kodda lotinga o'giriladi (LLM'siz);
            //  - begona til -> bitta tuzatish urinishi; yana begona bo'lsa javob
            //    neytral gapga almashtiriladi (holat o'zgarishlari saqlanadi) va logga yoziladi.
            if (persona.language === 'uz') {
              const badWords = nonLatinWords(result.reply);
              const first = result;
              const guarded = await guardCustomerReply(first, () =>
                call(scriptCorrectionNote(findScriptViolations([{ field: 'reply', text: first.reply }]))),
              );
              result = guarded.result;
              if (guarded.outcome === 'regenerated') {
                applied = applyTurnResult(state, guarded.stateSource, persona, archetype);
              }
              if (guarded.outcome === 'fallback') {
                deps.logger?.warn(
                  { sessionId: input.sessionId, words: badWords },
                  `mijoz javobi begona tilda qoldi — neytral gap bilan almashtirildi: ${badWords.join(', ')}`,
                );
              }
            }
            return { result, applied };
          };
          ({ result, applied } = await archetypeTurn());
        }

        // Hali ham buzayotgan bo'lsa: matnni olamiz, natijani O'ZGARTIRMAYMIZ.
        const scenarioHangup = scenarioTurn?.meta.hangup ?? null;
        // Ssenariy: sabr (patience) mag'lubiyat sababi emas — go'shak faqat jahl/shart bo'yicha.
        const guardState = scenarioTurn ? { ...applied, patience: 100 } : applied;
        const violation = scenarioTurn
          ? !scenarioHangup &&
            (result.intent === 'refuses' ||
              result.intent === 'ends_call' ||
              isGuardViolation(guardState, result, archetype, persona))
          : isGuardViolation(applied, result, archetype, persona);
        if (violation) {
          guardViolated = true;
          applied = recordGuardViolation(applied);
          result = { ...result, intent: 'continue' };
        }

        const latencyMs = Date.now() - startedMs;
        const sellerTurnCount = row.turnCount + 1;

        // Ohang: model TAKLIF qiladi, kod holatga moslaydi (matnli rejimda
        // ham yoziladi — keyin ovozga o'tilganda tarix mos bo'lsin).
        const toneDecision = scenarioTurn
          ? { tone: scenarioTurn.tone, clamped: false }
          : clampTone(result.tone, applied, archetype);

        const end: EndEvaluation = scenarioHangup
          ? {
              ended: true,
              outcome: 'lost',
              reason: scenarioHangup === 'anger' ? 'customer_hung_up_angry' : 'hangup_condition_met',
            }
          : evaluateEnd({
          state: guardState,
          result,
          turnCount: sellerTurnCount,
          archetype,
          persona,
        });

        const finishedAt = now();
        await repo.insertTurn(tx, {
          sessionId: row.id,
          businessId: ctx.businessId,
          seq: sellerSeq + 1,
          speaker: 'customer',
          text: result.reply,
          stateAfter: {
            ...applied,
            meta: {
              latencyMs,
              intent: result.intent,
              tone: toneDecision.tone,
              ...(usage ? { usage } : {}),
              ...(guardViolated ? { guardViolated: true } : {}),
              ...(toneDecision.clamped ? { toneClamped: true } : {}),
              ...(scenarioTurn ? { scenario: scenarioTurn.meta } : {}),
            },
          },
          createdAt: finishedAt,
        });

        await repo.updateSessionAfterTurn(tx, {
          sessionId: row.id,
          state: applied,
          turnCount: sellerTurnCount,
          addCostUsd: costUsd,
          ended: end.ended,
          ...(end.outcome ? { outcome: end.outcome } : {}),
          ...(end.reason ? { endReason: end.reason } : {}),
          endedAt: finishedAt,
        });

        return {
          customerReply: result.reply,
          state: applied,
          ended: end.ended,
          ...(end.outcome ? { outcome: end.outcome } : {}),
          ...(end.reason ? { endReason: end.reason } : {}),
          turnCount: sellerTurnCount,
          meta: {
            latencyMs,
            ...(usage ? { usage } : {}),
            costUsd,
            readiness,
            guardRetried,
            guardViolated,
            intent: result.intent,
            tone: toneDecision.tone,
            toneClamped: toneDecision.clamped,
            ...(scenarioTurn ? { scenario: scenarioTurn.meta } : {}),
          },
        };
      });
    },

    async endSession(ctx, { sessionId, reason }) {
      await withTenant(ctx.businessId, async (tx) => {
        const row = await repo.getSessionForUpdate(tx, sessionId);
        if (!row) throw new TrainingError('session_not_found', `sessiya topilmadi: ${sessionId}`);
        if (row.userId !== ctx.userId) {
          throw new TrainingError('session_forbidden', 'sessiya boshqa foydalanuvchiga tegishli');
        }
        if (row.status !== 'active') {
          throw new TrainingError('session_not_active', `sessiya holati: ${row.status}`);
        }
        await repo.markAbandoned(tx, sessionId, reason, now());
      });
    },

    async getSession(ctx, { sessionId }) {
      return await withTenant(ctx.businessId, async (tx) => {
        const row = await repo.getSession(tx, sessionId);
        if (!row) throw new TrainingError('session_not_found', `sessiya topilmadi: ${sessionId}`);
        if (row.userId !== ctx.userId) {
          throw new TrainingError('session_forbidden', 'sessiya boshqa foydalanuvchiga tegishli');
        }
        const transcript = await repo.getRecentTurns(tx, sessionId, 1000);
        return {
          sessionId: row.id,
          archetypeKey: row.archetypeKey,
          status: row.status,
          outcome: row.outcome,
          endReason: row.endReason,
          turnCount: row.turnCount,
          costUsd: row.costUsd,
          persona: personaCardSchema.parse(row.personaCard),
          state: trainingStateSchema.parse(row.state),
          transcript,
          ...(row.scenario && row.scenarioId
            ? { scenarioId: row.scenarioId, content: contentFlag(parseScenario(row.scenario)) }
            : {}),
        };
      });
    },
  };
}
