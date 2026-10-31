/**
 * Ovozli navbat: sotuvchi GAPIRADI, mijoz OVOZDA javob beradi.
 *
 * Tamoyillar:
 *  - audio HECH QAYERDA SAQLANMAYDI. `training_turn` ga faqat MATN yoziladi
 *    (sotuvchi — STT matni, mijoz — javob matni), audio esa javob bilan
 *    bir marta qaytariladi va unutiladi;
 *  - mantiq motorda qoladi: bu fayl `engine.takeTurn` ni CHAQIRADI, holat
 *    qoidalarini qaytadan yozmaydi;
 *  - provayder bilinmaydi: STT/TTS faqat portlar orqali (adapterlar
 *    `harness/src/voice/` da, asosiy repoda esa host tomonda);
 *  - ohangni model taklif qiladi, KOD chegaralaydi (`tone.ts`).
 *
 * Zanjir: WAV tekshiruvi -> STT -> (tanilmasa "takrorlaysizmi") -> motor ->
 * ovozga moslash -> TTS.
 */
import { getArchetype } from '../archetypes.js';
import type { TrainingEngine } from '../engine.js';
import { TrainingError } from '../errors.js';
import { offerTopic } from '../offer-facts.js';
import type {
  GetBusinessProfile,
  TrainingContext,
  TrainingLogger,
  TrainingTx,
  WithTenant,
} from '../ports.js';
import * as turnRepo from '../repo.js';
import type { TrainingState } from '../state.js';
import {
  VOICE_AUDIO,
  VOICE_BUDGET_LINE,
  VOICE_DEFAULT_MAX_MINUTES,
  VOICE_MAX_REPEATS,
  VOICE_MIN_TEXT_CHARS,
  VOICE_REPEAT_LINE,
  type SttPort,
  type TtsPort,
  type VoiceLang,
} from './ports.js';
import * as voiceRepo from './repo.js';
import { normalizeForSpeech } from './speech-text.js';
import { clampTone, DEFAULT_TONE, toneInstruction, type VoiceTone } from './tone.js';
import { checkWav, parseWav } from './wav.js';

/** Narxlar foydalanuvchi tomonidan to'ldiriladi (provayderning narx sahifasidan). */
export interface VoiceCostRates {
  /** STT: bir DAQIQA audio uchun USD. */
  sttPerMinuteUsd?: number | undefined;
  /** TTS: 1 000 000 BELGI uchun USD. */
  ttsPerMillionCharsUsd?: number | undefined;
}

/** Faqat hisobot/telemetriya uchun: qaysi model ishlatildi. */
export interface VoiceModels {
  stt: string;
  tts: string;
  /** Provayderdagi ovoz nomi (bo'lsa). */
  voice?: string | undefined;
}

export interface VoiceTurnDeps {
  engine: TrainingEngine;
  withTenant: WithTenant;
  stt: SttPort;
  tts: TtsPort;
  models: VoiceModels;
  /** STT ga so'z yordamchilari (`vocabulary`, taklif nomlari) uchun. */
  getBusinessProfile?: GetBusinessProfile | undefined;
  /** Berilmasa — narx 0 qoladi, sarf (sekund/belgi) baribir yoziladi. */
  cost?: VoiceCostRates | undefined;
  /** Sessiyadagi audio chegarasi (daqiqa). Default `VOICE_DEFAULT_MAX_MINUTES`. */
  maxMinutesPerSession?: number | undefined;
  logger?: TrainingLogger | undefined;
  now?: (() => Date) | undefined;
}

export interface VoiceTurnInput {
  sessionId: string;
  audio: Buffer;
  mime: string;
}

export interface VoiceTimings {
  sttMs: number;
  llmMs: number;
  ttsMs: number;
  totalMs: number;
}

export interface VoiceTurnResult {
  /** STT tanigan matn ("takrorlaysizmi" yo'lida bo'sh bo'ladi). */
  sellerText: string;
  customerText: string;
  tone: VoiceTone;
  audio: Buffer;
  audioMime: string;
  timings: VoiceTimings;
  /** `true` — nutq tanilmadi: holat O'ZGARMADI, navbat sanalmadi. */
  needsRepeat: boolean;
  ended: boolean;
  outcome?: string | undefined;
  endReason?: string | undefined;
  turnCount: number;
  /** Shu navbatning AUDIO narxi (LLM narxi motorda hisoblanadi). */
  costUsd: number;
}

export interface VoiceSpeech {
  text: string;
  audio: Buffer;
  audioMime: string;
  tone: VoiceTone;
  ttsMs: number;
  costUsd: number;
}

export interface VoiceService {
  takeVoiceTurn(ctx: TrainingContext, input: VoiceTurnInput): Promise<VoiceTurnResult>;
  /** `inbound` sessiyada mijozning birinchi gapini ovozda beradi. */
  speakOpeningLine(
    ctx: TrainingContext,
    input: { sessionId: string },
  ): Promise<VoiceSpeech | null>;
}

// ---------------------------------------------------------------------------
// Narx
// ---------------------------------------------------------------------------
export interface VoiceUsage {
  audioSec: number;
  chars: number;
}

export interface VoiceCost {
  usd: number;
  /** `false` — tarif berilmagan: sarf yozildi, narx 0 qoldi. */
  priced: boolean;
}

export function voiceCost(rates: VoiceCostRates | undefined, usage: VoiceUsage): VoiceCost {
  const sttRate = rates?.sttPerMinuteUsd;
  const ttsRate = rates?.ttsPerMillionCharsUsd;
  if (!sttRate && !ttsRate) return { usd: 0, priced: false };

  const stt = sttRate ? (usage.audioSec / 60) * sttRate : 0;
  const tts = ttsRate ? (usage.chars / 1_000_000) * ttsRate : 0;
  const usd = stt + tts;
  return { usd: Number.isFinite(usd) && usd > 0 ? usd : 0, priced: true };
}

/** Startda chiqadigan bir qator: tariflar to'ldirilganmi. */
export function describeVoiceCostRates(rates: VoiceCostRates | undefined): string {
  const stt = rates?.sttPerMinuteUsd;
  const tts = rates?.ttsPerMillionCharsUsd;
  if (!stt && !tts) {
    return (
      "ovoz narxi: TARIF YO'Q — sarf (sekund/belgi) yoziladi, narx 0 qoladi " +
      '(OPENAI_STT_PRICE_PER_MIN, OPENAI_TTS_PRICE_PER_1M_CHARS)'
    );
  }
  return `ovoz narxi: STT ${stt ?? 0}$/daq · TTS ${tts ?? 0}$/1M belgi`;
}

// ---------------------------------------------------------------------------
// Kirish tekshiruvi
// ---------------------------------------------------------------------------
/** `audio/wav` (parametrlari bilan ham) qabul qilinadi. */
export function isAcceptedVoiceMime(mime: string): boolean {
  const base = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  return base === VOICE_AUDIO.mime || base === 'audio/x-wav' || base === 'audio/wave';
}

/**
 * Audio kutilgan formatda va chegaralardami.
 * `tooShort` — xato EMAS: "eshitolmadim" yo'liga tushadi (STT chaqirilmaydi,
 * ya'ni tasodifiy bosilish uchun pul to'lanmaydi).
 */
export function validateVoiceAudio(
  audio: Buffer,
  mime: string,
): { tooShort: boolean; durationSec: number } {
  if (!isAcceptedVoiceMime(mime)) {
    throw new TrainingError(
      'voice_unsupported_media',
      `kutilgan ${VOICE_AUDIO.mime}, kelgan "${mime.slice(0, 80)}"`,
    );
  }

  const problem = checkWav(audio);
  if (problem) {
    if (problem.code === 'too_large' || problem.code === 'too_long') {
      throw new TrainingError('voice_audio_too_large', problem.message);
    }
    if (problem.code === 'bad_format') {
      throw new TrainingError('voice_unsupported_media', problem.message);
    }
    return { tooShort: true, durationSec: 0 };
  }

  return { tooShort: false, durationSec: parseWav(audio).durationSec };
}

// ---------------------------------------------------------------------------
// Xizmat
// ---------------------------------------------------------------------------
export function createVoiceService(deps: VoiceTurnDeps): VoiceService {
  const { engine, withTenant, stt, tts, models } = deps;
  const now = deps.now ?? ((): Date => new Date());
  // Eng kam 1 SEKUND (daqiqa emas) — testlar kichik byudjetni ham sinay olsin.
  const maxSeconds = Math.max(
    1,
    (deps.maxMinutesPerSession ?? VOICE_DEFAULT_MAX_MINUTES) * 60,
  );

  /** Tarif yo'qligi haqida bir marta ogohlantiramiz (logni to'ldirmaslik uchun). */
  let costWarned = false;
  function warnOnceAboutCost(): void {
    if (costWarned) return;
    costWarned = true;
    deps.logger?.warn({}, describeVoiceCostRates(deps.cost));
  }

  /** Matnni ovozga moslab (raqamlar -> so'z) TTS'ga beradi. */
  async function speak(
    text: string,
    lang: VoiceLang,
    tone: VoiceTone,
  ): Promise<{ audio: Buffer; mime: string; ms: number; chars: number }> {
    const speech = normalizeForSpeech(text, lang);
    const startedMs = Date.now();
    const out = await tts.synthesize({
      text: speech,
      lang,
      tone,
      instructions: toneInstruction(tone),
      ...(models.voice ? { voice: models.voice } : {}),
    });
    return {
      audio: out.audio,
      mime: out.mime,
      ms: out.latencyMs > 0 ? out.latencyMs : Date.now() - startedMs,
      chars: speech.length,
    };
  }

  /** STT ga beriladigan so'z yordamchilari: lug'at + taklif NOMLARI. */
  async function sttHints(businessId: string): Promise<string[]> {
    if (!deps.getBusinessProfile) return [];
    const profile = await deps.getBusinessProfile(businessId);
    if (!profile) return [];
    return [...profile.vocabulary, ...profile.primaryOffers.map(offerTopic)]
      .map((word) => word.trim())
      .filter((word) => word.length > 0)
      .slice(0, 100);
  }

  /** "Eshitolmadim" yo'li: TTS bor, LLM yo'q, holat o'zgarmaydi. */
  async function askToRepeat(
    tx: TrainingTx,
    ctx: TrainingContext,
    sessionId: string,
    state: TrainingState,
    lang: VoiceLang,
    timing: { sttMs: number; durationSec: number; totalStartedMs: number },
  ): Promise<VoiceTurnResult> {
    const already = await voiceRepo.countRepeatTurns(tx, sessionId);
    if (already >= VOICE_MAX_REPEATS) {
      throw new TrainingError(
        'voice_not_recognized',
        `nutq ${VOICE_MAX_REPEATS + 1} marta tanilmadi — matn bilan yozib ko'ring`,
      );
    }

    const spoken = await speak(VOICE_REPEAT_LINE, lang, DEFAULT_TONE);
    const cost = voiceCost(deps.cost, { audioSec: timing.durationSec, chars: spoken.chars });
    if (!cost.priced) warnOnceAboutCost();

    const seq = await turnRepo.nextSeq(tx, sessionId);
    await turnRepo.insertTurn(tx, {
      sessionId,
      businessId: ctx.businessId,
      seq,
      speaker: 'customer',
      text: VOICE_REPEAT_LINE,
      // Holat AYNAN o'sha qoladi; `needsRepeat` esa
      // `metrics.voiceRepeatRequests` ni sanashga xizmat qiladi.
      stateAfter: {
        ...state,
        meta: {
          voice: true,
          needsRepeat: true,
          sttMs: timing.sttMs,
          sttModel: models.stt,
          ttsMs: spoken.ms,
          ttsModel: models.tts,
          voiceSec: Number(timing.durationSec.toFixed(2)),
          voiceCostUsd: cost.usd,
        },
      },
      createdAt: now(),
    });
    await voiceRepo.addSessionCost(tx, sessionId, cost.usd);

    return {
      sellerText: '',
      customerText: VOICE_REPEAT_LINE,
      tone: DEFAULT_TONE,
      audio: spoken.audio,
      audioMime: spoken.mime,
      timings: {
        sttMs: timing.sttMs,
        llmMs: 0,
        ttsMs: spoken.ms,
        totalMs: Date.now() - timing.totalStartedMs,
      },
      needsRepeat: true,
      ended: false,
      turnCount: 0,
      costUsd: cost.usd,
    };
  }

  /** Byudjet tugadi: mijoz xushmuomala tugatadi (LLM'siz). */
  async function endOnBudget(
    tx: TrainingTx,
    ctx: TrainingContext,
    sessionId: string,
    state: TrainingState,
    lang: VoiceLang,
    timing: { usedSec: number; totalStartedMs: number },
  ): Promise<VoiceTurnResult> {
    const spoken = await speak(VOICE_BUDGET_LINE, lang, DEFAULT_TONE);
    const cost = voiceCost(deps.cost, { audioSec: 0, chars: spoken.chars });

    const seq = await turnRepo.nextSeq(tx, sessionId);
    await turnRepo.insertTurn(tx, {
      sessionId,
      businessId: ctx.businessId,
      seq,
      speaker: 'customer',
      text: VOICE_BUDGET_LINE,
      stateAfter: {
        ...state,
        meta: {
          voice: true,
          voiceBudgetExhausted: true,
          usedSec: Number(timing.usedSec.toFixed(1)),
          maxSec: maxSeconds,
          ttsMs: spoken.ms,
          voiceCostUsd: cost.usd,
        },
      },
      createdAt: now(),
    });
    await voiceRepo.addSessionCost(tx, sessionId, cost.usd);

    deps.logger?.warn(
      { sessionId, usedSec: timing.usedSec, maxSec: maxSeconds },
      'ovoz byudjeti tugadi — sessiya tugatildi',
    );
    // DIQQAT: `engine.endSession` ni chaqirib BO'LMAYDI. U o'z tranzaksiyasida
    // sessiya qatorini `FOR UPDATE` bilan oladi, biz esa shu tranzaksiyada
    // allaqachon `training_turn` qo'shdik — bu FK tufayli ota qatorga
    // `KEY SHARE` qulfini qo'yadi va ikkisi bir-birini abadiy kutadi.
    // Shuning uchun holatni SHU tranzaksiyada o'zgartiramiz (`endSession` ham
    // aynan shuni qiladi).
    await turnRepo.markAbandoned(tx, sessionId, 'voice_budget_exhausted', now());

    return {
      sellerText: '',
      customerText: VOICE_BUDGET_LINE,
      tone: DEFAULT_TONE,
      audio: spoken.audio,
      audioMime: spoken.mime,
      timings: {
        sttMs: 0,
        llmMs: 0,
        ttsMs: spoken.ms,
        totalMs: Date.now() - timing.totalStartedMs,
      },
      needsRepeat: false,
      ended: true,
      endReason: 'voice_budget_exhausted',
      turnCount: 0,
      costUsd: cost.usd,
    };
  }

  return {
    async takeVoiceTurn(ctx, input) {
      const totalStartedMs = Date.now();
      const { tooShort, durationSec } = validateVoiceAudio(input.audio, input.mime);

      // Sessiyani oldin o'qiymiz: til, holat va arxetip kerak.
      const session = await engine.getSession(ctx, { sessionId: input.sessionId });
      if (session.status !== 'active') {
        throw new TrainingError('session_not_active', `sessiya holati: ${session.status}`);
      }
      const lang = session.persona.language as VoiceLang;

      // DIQQAT: qulf tashqi tranzaksiyada turadi, motor esa O'ZINING
      // tranzaksiyasini oladi — ya'ni bir navbatga 2 ta ulanish kerak.
      return await withTenant(ctx.businessId, async (tx) => {
        // Bir sessiyada bir vaqtda BITTA ovozli navbat (DB qulfi).
        if (!(await voiceRepo.tryLockSessionForVoice(tx, input.sessionId))) {
          throw new TrainingError(
            'voice_turn_in_progress',
            'shu sessiyada ovozli navbat allaqachon ketmoqda',
          );
        }

        // --- Byudjet qo'riqchisi (sinov xarajatini cheklaydi) --------------
        const usedSec = await voiceRepo.usedVoiceSeconds(tx, input.sessionId);
        if (usedSec + durationSec > maxSeconds) {
          return await endOnBudget(tx, ctx, input.sessionId, session.state, lang, {
            usedSec,
            totalStartedMs,
          });
        }

        // --- STT ----------------------------------------------------------
        let sellerText = '';
        let sttMs = 0;
        if (!tooShort) {
          const hints = await sttHints(ctx.businessId);
          const heard = await stt.transcribeShort({
            audio: input.audio,
            mime: VOICE_AUDIO.mime,
            lang,
            ...(hints.length > 0 ? { hints } : {}),
          });
          sellerText = heard.text.trim();
          sttMs = heard.latencyMs;
        }

        // --- Tanilmadi: "takrorlaysizmi" ----------------------------------
        if (sellerText.length < VOICE_MIN_TEXT_CHARS) {
          return await askToRepeat(tx, ctx, input.sessionId, session.state, lang, {
            sttMs,
            durationSec,
            totalStartedMs,
          });
        }

        // --- Motor (bitta LLM chaqiruvi) ----------------------------------
        const llmStartedMs = Date.now();
        const turn = await engine.takeTurn(ctx, {
          sessionId: input.sessionId,
          sellerText,
        });
        const llmMs = Date.now() - llmStartedMs;

        // --- Ovoz ---------------------------------------------------------
        const tone = turn.meta.tone;
        const spoken = await speak(turn.customerReply, lang, tone);

        // --- Telemetriya: IKKI navbatga ham `meta` ------------------------
        // Motor ikki qatorni ketma-ket yozdi; qulf ostida ekanmiz, demak
        // eng katta seq — mijoz, undan bittasi oldin — sotuvchi.
        const customerSeq = await voiceRepo.maxTurnSeq(tx, input.sessionId);
        const sellerSeq = customerSeq - 1;
        const totalMs = Date.now() - totalStartedMs;
        const cost = voiceCost(deps.cost, { audioSec: durationSec, chars: spoken.chars });
        if (!cost.priced) warnOnceAboutCost();

        await voiceRepo.mergeTurnMeta(tx, {
          sessionId: input.sessionId,
          seq: sellerSeq,
          meta: {
            voice: true,
            sttMs,
            sttModel: models.stt,
            voiceSec: Number(durationSec.toFixed(2)),
          },
        });
        await voiceRepo.mergeTurnMeta(tx, {
          sessionId: input.sessionId,
          seq: customerSeq,
          meta: {
            voice: true,
            ttsMs: spoken.ms,
            ttsModel: models.tts,
            ...(models.voice ? { ttsVoice: models.voice } : {}),
            ttsChars: spoken.chars,
            tone,
            ...(turn.meta.toneClamped ? { toneClamped: true } : {}),
            totalMs,
            voiceCostUsd: cost.usd,
          },
        });
        await voiceRepo.addSessionCost(tx, input.sessionId, cost.usd);

        return {
          sellerText,
          customerText: turn.customerReply,
          tone,
          audio: spoken.audio,
          audioMime: spoken.mime,
          timings: { sttMs, llmMs, ttsMs: spoken.ms, totalMs },
          needsRepeat: false,
          ended: turn.ended,
          outcome: turn.outcome,
          endReason: turn.endReason,
          turnCount: turn.turnCount,
          costUsd: cost.usd,
        };
      });
    },

    async speakOpeningLine(ctx, { sessionId }) {
      const session = await engine.getSession(ctx, { sessionId });
      if (session.persona.direction !== 'inbound') return null;

      // Birinchi gap — mijozning (motor `startSession` da yozgan) 1-navbati.
      const first = session.transcript[0];
      if (!first || first.speaker !== 'customer') return null;

      const lang = session.persona.language as VoiceLang;
      const tone = clampTone(undefined, session.state, getArchetype(session.archetypeKey)).tone;
      const spoken = await speak(first.text, lang, tone);
      const cost = voiceCost(deps.cost, { audioSec: 0, chars: spoken.chars });
      if (!cost.priced) warnOnceAboutCost();

      await withTenant(ctx.businessId, async (tx) => {
        await voiceRepo.addSessionCost(tx, sessionId, cost.usd);
        await voiceRepo.mergeTurnMeta(tx, {
          sessionId,
          seq: 1,
          meta: { voice: true, ttsMs: spoken.ms, ttsModel: models.tts, ttsChars: spoken.chars, tone },
        });
      });

      return {
        text: first.text,
        audio: spoken.audio,
        audioMime: spoken.mime,
        tone,
        ttsMs: spoken.ms,
        costUsd: cost.usd,
      };
    },
  };
}
