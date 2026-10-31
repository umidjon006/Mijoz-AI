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
import { findScriptViolations, nonLatinWords, scriptCorrectionNote } from './language.js';
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
  type Readiness,
  type TrainingOutcome,
  type TrainingState,
  type TurnResult,
} from './state.js';

export interface StartSessionInput {
  archetypeKey: string;
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
}

export interface TrainingEngine {
  startSession(ctx: TrainingContext, input: StartSessionInput): Promise<StartSessionResult>;
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

  return {
    async startSession(ctx, input) {
      const archetype = archetypeOf(input.archetypeKey);
      const archetypeKey = archetype.key as ArchetypeKey;

      const profile = await getBusinessProfile(ctx.businessId);
      if (!profile) {
        throw new TrainingError(
          'profile_missing',
          "biznes profili to'ldirilmagan — mashq boshlanmaydi",
        );
      }

      const direction = resolveDirection(profile, random, input.direction);
      const persona = await generatePersonaCard({
        llm,
        profile,
        archetype,
        direction,
        language: input.language ?? 'uz',
        random,
        ...(deps.logger ? { logger: deps.logger } : {}),
      });

      const state = initState(archetype, persona);
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
      };
    },

    async takeTurn(ctx, input) {
      const sellerText = input.sellerText.trim();
      if (sellerText.length === 0) {
        throw new TrainingError('session_not_active', "sotuvchi matni bo'sh");
      }

      return await withTenant(ctx.businessId, async (tx) => {
        const { row, persona, state } = await loadActiveSession(tx, ctx, input.sessionId);
        const archetype = archetypeOf(row.archetypeKey);

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

        // Yozuv: o'zbekcha mijoz javobida kirill/boshqa alifbo harflari bo'lmasin.
        // Bitta tuzatish urinishi; o'tmasa — javob qoladi, lekin logga yoziladi.
        if (persona.language === 'uz') {
          const badWords = nonLatinWords(result.reply);
          if (badWords.length > 0) {
            let fixed = false;
            try {
              const retryResult = await call(
                scriptCorrectionNote(findScriptViolations([{ field: 'reply', text: result.reply }])),
              );
              if (nonLatinWords(retryResult.reply).length === 0) {
                result = retryResult;
                applied = applyTurnResult(state, retryResult, persona, archetype);
                fixed = true;
              }
            } catch {
              // Tuzatish muvaffaqiyatsiz — birinchi javob bilan davom etamiz.
            }
            if (!fixed) {
              deps.logger?.warn(
                { sessionId: input.sessionId, words: badWords },
                `mijoz javobida lotin bo'lmagan harflar qoldi: ${badWords.join(', ')}`,
              );
            }
          }
        }

        // Hali ham buzayotgan bo'lsa: matnni olamiz, natijani O'ZGARTIRMAYMIZ.
        if (isGuardViolation(applied, result, archetype, persona)) {
          guardViolated = true;
          applied = recordGuardViolation(applied);
          result = { ...result, intent: 'continue' };
        }

        const latencyMs = Date.now() - startedMs;
        const sellerTurnCount = row.turnCount + 1;

        const end = evaluateEnd({
          state: applied,
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
              ...(usage ? { usage } : {}),
              ...(guardViolated ? { guardViolated: true } : {}),
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
        };
      });
    },
  };
}
