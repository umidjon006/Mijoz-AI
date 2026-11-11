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
import { randomUUID } from 'node:crypto';

import { getArchetype } from '../archetypes.js';
import type { TrainingEngine } from '../engine.js';
import { describeLlmError, isTrainingError, TrainingError } from '../errors.js';
import { classifyHeardUzText, transliterateUzCyrillic } from '../language.js';
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
  type TtsSpeaker,
  type VoiceLang,
} from './ports.js';
import * as voiceRepo from './repo.js';
import { normalizeForSpeech } from './speech-text.js';
import { clampTone, DEFAULT_TONE, toneInstruction, type VoiceTone } from './tone.js';
import { checkWav, concatWav, parseWav } from './wav.js';
import {
  AudioStreamRegistry,
  splitForParallelTts,
  type AudioStreamHandle,
} from './audio-stream.js';

/** Tekshirilayotgan STT natijasi shuncha vaqt saqlanadi. */
export const REVIEW_TTL_MS = 15 * 60 * 1000;

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
  /**
   * Mijoz audiosini OQIM bilan uzatish (`tts.synthesizeStream` bo'lsa).
   * Default `true`: navbat javobi LLM tugashi bilan qaytadi, audio esa
   * `audioStream` URL'idan kelishi bilan ijro etiladi.
   */
  streamTts?: boolean | undefined;
  /** Testlar uchun; default — xizmatning o'z registri. */
  audioStreams?: AudioStreamRegistry | undefined;
}

export interface VoiceTurnInput {
  sessionId: string;
  audio: Buffer;
  mime: string;
}

export interface VoiceTimings {
  sttMs: number;
  llmMs: number;
  /** Oqimli TTS'da 0 — audio javobdan KEYIN, URL orqali keladi (`ttsStreamed`). */
  ttsMs: number;
  totalMs: number;
  /** `true` — TTS oqim bilan: ijro birinchi bo'lak kelishi bilan boshlanadi. */
  ttsStreamed?: boolean;
}

export interface VoiceTurnResult {
  /** STT tanigan matn ("takrorlaysizmi" yo'lida bo'sh bo'ladi). */
  sellerText: string;
  customerText: string;
  tone: VoiceTone;
  audio: Buffer;
  audioMime: string;
  /** Oqimli TTS: audio shu id bo'yicha (bir marta) olinadi; `audio` bo'sh bo'ladi. */
  audioStream?: AudioStreamHandle;
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

/** STT natijasi foydalanuvchi tekshiruvi uchun (javob hali so'ralmagan). */
export interface VoiceTranscription {
  /** `replyToText` ga beriladi (bir martalik, 15 daqiqa). */
  transcriptId: string;
  /** STT tanigan matn (lotin); tanilmasa bo'sh. */
  sttText: string;
  /** Matn tanildimi. `false` — qayta yozish yoki matn bilan yozish taklif qilinadi. */
  recognized: boolean;
  /** Nega tanilmadi: juda qisqa, bo'sh yoki boshqa tilda. */
  rejected?: 'too_short' | 'empty' | 'foreign_language';
  sttMs: number;
  durationSec: number;
}

export interface VoiceService {
  takeVoiceTurn(ctx: TrainingContext, input: VoiceTurnInput): Promise<VoiceTurnResult>;
  /**
   * TEKSHIRISH rejimi, 1-qadam: faqat STT. Holat o'zgarmaydi, LLM/TTS yo'q.
   * Foydalanuvchi matnni ko'rib, tuzatib, `replyToText` bilan yuboradi.
   */
  transcribeVoice(ctx: TrainingContext, input: VoiceTurnInput): Promise<VoiceTranscription>;
  /**
   * TEKSHIRISH rejimi, 2-qadam: tasdiqlangan (tahrirlangan bo'lishi mumkin)
   * matn bilan mijoz javobi. Asl STT matni meta'da (`sttText`, `edited`).
   */
  replyToText(
    ctx: TrainingContext,
    input: { sessionId: string; transcriptId: string; text: string },
  ): Promise<VoiceTurnResult>;
  /** `inbound` sessiyada mijozning birinchi gapini ovozda beradi. */
  speakOpeningLine(
    ctx: TrainingContext,
    input: { sessionId: string },
  ): Promise<VoiceSpeech | null>;
  /**
   * Oqimli audio (bir marta). Id — taxmin qilib bo'lmaydigan UUID, 60 s yashaydi.
   * Topilmasa `null` (route 404 beradi).
   */
  openAudioStream(id: string): { mime: string; chunks: AsyncIterable<Uint8Array> } | null;
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
/** Persona'dan TTS uchun "kim gapiryapti" ishorasi (ovoz/uslub tanlash). */
export function speakerOf(persona: {
  gender?: 'male' | 'female' | undefined;
  age: number;
  role: string;
  speakingStyle: string;
  voice?: { profile: string; baseStyle: string } | undefined;
}): TtsSpeaker {
  return {
    ...(persona.gender ? { gender: persona.gender } : {}),
    age: persona.age,
    role: persona.role,
    speakingStyle: persona.speakingStyle,
    ...(persona.voice ? { profile: persona.voice.profile, baseStyle: persona.voice.baseStyle } : {}),
  };
}

export function createVoiceService(deps: VoiceTurnDeps): VoiceService {
  const { engine, withTenant, stt, tts, models } = deps;
  const now = deps.now ?? ((): Date => new Date());
  // Eng kam 1 SEKUND (daqiqa emas) — testlar kichik byudjetni ham sinay olsin.
  const streaming = deps.streamTts ?? true;
  const audioStreams = deps.audioStreams ?? new AudioStreamRegistry();
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
    speaker?: TtsSpeaker,
  ): Promise<{ audio: Buffer; mime: string; ms: number; chars: number }> {
    const speech = normalizeForSpeech(text, lang);
    const startedMs = Date.now();
    const request = (part: string) =>
      tts.synthesize({
        text: part,
        lang,
        tone,
        instructions: toneInstruction(tone),
        ...(models.voice ? { voice: models.voice } : {}),
        ...(speaker ? { speaker } : {}),
      });
    try {
      // Oqimsiz TTS: gaplar PARALLEL sintez qilinadi (vaqt ≈ eng uzun gap,
      // yig'indi emas). MP3 bo'laklarini ketma-ket qo'shish to'g'ri fayl
      // beradi; boshqa formatda (WAV sarlavhasi) — bitta so'rov.
      const parts = splitForParallelTts(speech);
      let audio: Buffer;
      let mime: string;
      const outs = parts.length > 1 ? await Promise.all(parts.map(request)) : [];
      const wavJoined =
        outs.length > 1 && outs.every((o) => o.mime === 'audio/wav') ? concatWav(outs.map((o) => o.audio)) : null;
      if (outs.length > 1 && outs.every((o) => o.mime === 'audio/mpeg')) {
        audio = Buffer.concat(outs.map((o) => o.audio));
        mime = 'audio/mpeg';
      } else if (wavJoined) {
        // WAV: PCM bo'laklari bitta sarlavha ostida qo'shiladi (avval bu
        // bo'laklar tashlab yuborilib, matn QAYTA sintez qilinardi — ikki barobar narx).
        audio = wavJoined;
        mime = 'audio/wav';
      } else {
        // Bitta gap yoki MP3 emas (bo'laklarni qo'shib bo'lmaydi) — bitta so'rov.
        const out = await request(speech);
        audio = out.audio;
        mime = out.mime;
      }
      return { audio, mime, ms: Date.now() - startedMs, chars: speech.length };
    } catch (err) {
      throw new TrainingError('voice_tts_failed', `ovoz yaratilmadi: ${describeLlmError(err)}`, err);
    }
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
    timing: {
      sttMs: number;
      durationSec: number;
      totalStartedMs: number;
      /** STT matn qaytardi, lekin u rad etildi (masalan boshqa tilda). */
      sttRejected?: string;
    },
    speaker?: TtsSpeaker,
  ): Promise<VoiceTurnResult> {
    const already = await voiceRepo.countRepeatTurns(tx, sessionId);
    if (already >= VOICE_MAX_REPEATS) {
      throw new TrainingError(
        'voice_not_recognized',
        `nutq ${VOICE_MAX_REPEATS + 1} marta tanilmadi — matn bilan yozib ko'ring`,
      );
    }

    const spoken = await speak(VOICE_REPEAT_LINE, lang, DEFAULT_TONE, speaker);
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
          ...(timing.sttRejected ? { sttRejected: timing.sttRejected } : {}),
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
    speaker?: TtsSpeaker,
  ): Promise<VoiceTurnResult> {
    const spoken = await speak(VOICE_BUDGET_LINE, lang, DEFAULT_TONE, speaker);
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

  // --- Tekshirish rejimi ----------------------------------------------------
  /**
   * Tekshirilayotgan STT natijalari (xotirada, bir martalik). Tashlangan
   * ("Qayta yozish") yozuvlarning sekundlari ham keyingi tasdiqlangan
   * navbatda byudjetga yoziladi.
   */
  const pending = new Map<
    string,
    { businessId: string; userId: string; sessionId: string; sttText: string; sttMs: number; durationSec: number; at: number }
  >();
  const pruneExpired = (): void => {
    const cutoff = Date.now() - REVIEW_TTL_MS;
    for (const [id, entry] of pending) if (entry.at < cutoff) pending.delete(id);
  };
  const pendingSeconds = (sessionId: string): number =>
    [...pending.values()].filter((e) => e.sessionId === sessionId).reduce((s, e) => s + e.durationSec, 0);

  /**
   * Foydalanuvchi HECH QACHON umumiy "internal_error" olmasin: kutilmagan
   * xato ham bosqichli `TrainingError` ga aylantiriladi (route `stage` beradi).
   */
  function asVoiceError(err: unknown): unknown {
    if (isTrainingError(err)) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new TrainingError('voice_failed', `ovozli navbat bajarilmadi: ${message.slice(0, 200)}`, err);
  }

  return {
    async takeVoiceTurn(ctx, input) {
      try {
        return await takeVoiceTurnInner(ctx, input);
      } catch (err) {
        throw asVoiceError(err);
      }
    },

    async transcribeVoice(ctx, input) {
      try {
        return await transcribeVoiceInner(ctx, input);
      } catch (err) {
        throw asVoiceError(err);
      }
    },

    async replyToText(ctx, input) {
      try {
        return await replyToTextInner(ctx, input);
      } catch (err) {
        throw asVoiceError(err);
      }
    },

    async speakOpeningLine(ctx, input) {
      try {
        return await speakOpeningLineInner(ctx, input);
      } catch (err) {
        throw asVoiceError(err);
      }
    },

    openAudioStream(id) {
      return audioStreams.take(id);
    },
  };

  async function takeVoiceTurnInner(
    ctx: Parameters<VoiceService['takeVoiceTurn']>[0],
    input: Parameters<VoiceService['takeVoiceTurn']>[1],
  ): ReturnType<VoiceService['takeVoiceTurn']> {
    const totalStartedMs = Date.now();
    const { tooShort, durationSec } = validateVoiceAudio(input.audio, input.mime);

    // Sessiya (til, holat) va STT so'z ishoralari bir-biriga bog'liq emas —
    // PARALLEL o'qiladi.
    const [session, hints] = await Promise.all([
      engine.getSession(ctx, { sessionId: input.sessionId }),
      tooShort ? Promise.resolve<string[]>([]) : sttHints(ctx.businessId),
    ]);
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
        return await endOnBudget(
          tx,
          ctx,
          input.sessionId,
          session.state,
          lang,
          { usedSec, totalStartedMs },
          speakerOf(session.persona),
        );
      }

      // --- STT ----------------------------------------------------------
      let sellerText = '';
      let sttMs = 0;
      let sttRejected: string | undefined;
      if (!tooShort) {
        let heard;
        try {
          heard = await stt.transcribeShort({
            audio: input.audio,
            mime: VOICE_AUDIO.mime,
            lang,
            ...(hints.length > 0 ? { hints } : {}),
          });
        } catch (err) {
          throw new TrainingError('voice_stt_failed', `nutq tanilmadi: ${describeLlmError(err)}`, err);
        }
        sellerText = heard.text.trim();
        sttMs = heard.latencyMs;

        // Transkript o'zbek LOTIN bo'lishi shart: kirill -> o'giriladi;
        // aniq boshqa til (qozoq, turk, rus...) — ishonchsiz, "takrorlaysizmi".
        if (lang === 'uz' && sellerText.length > 0) {
          const kind = classifyHeardUzText(sellerText);
          if (kind === 'uz_cyrillic') {
            sellerText = transliterateUzCyrillic(sellerText);
          } else if (kind === 'foreign') {
            sttRejected = 'foreign_language';
            deps.logger?.warn(
              { sessionId: input.sessionId, sttModel: models.stt },
              "STT boshqa tilda matn qaytardi — 'takrorlaysizmi' so'raladi",
            );
            sellerText = '';
          }
        }
      }

      // --- Tanilmadi: "takrorlaysizmi" ----------------------------------
      if (sellerText.length < VOICE_MIN_TEXT_CHARS) {
        return await askToRepeat(
          tx,
          ctx,
          input.sessionId,
          session.state,
          lang,
          { sttMs, durationSec, totalStartedMs, ...(sttRejected ? { sttRejected } : {}) },
          speakerOf(session.persona),
        );
      }

      return await replyWithText(tx, ctx, {
        sessionId: input.sessionId,
        lang,
        speaker: speakerOf(session.persona),
        sellerText,
        sttText: sellerText,
        sttMs,
        voiceSec: durationSec,
        sttCostSec: durationSec,
        totalStartedMs,
      });
    });
  }

  /**
   * Sotuvchi matni ma'lum (STT yoki foydalanuvchi tahrirlagan) — motor navbati,
   * TTS va telemetriya. Qulf CHAQIRUVCHI tranzaksiyasida olingan bo'lishi shart.
   * `sttText` — asl STT matni (meta'da saqlanadi), transkript va baholash esa
   * yakuniy `sellerText` dan foydalanadi.
   */
  async function replyWithText(
    tx: TrainingTx,
    ctx: TrainingContext,
    input: {
      sessionId: string;
      lang: VoiceLang;
      /** Persona'dan: TTS ovoz/uslubi. */
      speaker?: TtsSpeaker;
      sellerText: string;
      sttText: string;
      sttMs: number;
      /** Byudjetga yoziladigan audio sekundlari (tashlangan yozuvlar ham). */
      voiceSec: number;
      /** STT narxi shu navbatda hisoblanadimi (sekund); oldindan hisoblangan bo'lsa 0. */
      sttCostSec: number;
      totalStartedMs: number;
    },
  ): Promise<VoiceTurnResult> {
    const { sellerText, sttMs, lang, totalStartedMs, speaker } = input;
    const durationSec = input.sttCostSec;
    // --- Motor (bitta LLM chaqiruvi) ----------------------------------
    const llmStartedMs = Date.now();
    const turn = await engine.takeTurn(ctx, {
      sessionId: input.sessionId,
      sellerText,
    });
    const llmMs = Date.now() - llmStartedMs;

    // --- Ovoz ---------------------------------------------------------
    // Oqimli TTS bo'lsa — sintez SHU ZAHOTI boshlanadi va javob uni
    // kutmasdan qaytadi; brauzer `audioStream` URL'idan birinchi bo'lak
    // kelishi bilan ijroni boshlaydi.
    const tone = turn.meta.tone;
    let spoken: Awaited<ReturnType<typeof speak>>;
    let audioStream: AudioStreamHandle | undefined;
    if (streaming && tts.synthesizeStream) {
      const speech = normalizeForSpeech(turn.customerReply, lang);
      const stream = tts.synthesizeStream({
        text: speech,
        lang,
        tone,
        instructions: toneInstruction(tone),
        ...(models.voice ? { voice: models.voice } : {}),
        ...(speaker ? { speaker } : {}),
      });
      const sessionId = input.sessionId;
      audioStream = audioStreams.open({
        mime: stream.mime,
        source: stream.chunks,
        onDone: (stats) => {
          if (stats.error !== undefined) {
            deps.logger?.warn(
              { sessionId, stage: 'tts' },
              `TTS oqimi xato bilan tugadi: ${describeLlmError(stats.error)}`,
            );
          } else {
            deps.logger?.info(
              { sessionId, ttsFirstByteMs: stats.firstByteMs, ttsTotalMs: stats.totalMs, bytes: stats.bytes },
              `[voice] tts oqimi: birinchi bayt ${stats.firstByteMs ?? '-'} ms, jami ${stats.totalMs} ms`,
            );
          }
        },
      });
      spoken = { audio: Buffer.alloc(0), mime: stream.mime, ms: 0, chars: speech.length };
    } else {
      spoken = await speak(turn.customerReply, lang, tone, speaker);
    }

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
        voiceSec: Number(input.voiceSec.toFixed(2)),
        // Asl STT matni (tahrirdan oldin) va tahrirlanganmi — tahlil uchun.
        sttText: input.sttText,
        edited: input.sellerText !== input.sttText,
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
      timings: { sttMs, llmMs, ttsMs: spoken.ms, totalMs, ...(audioStream ? { ttsStreamed: true } : {}) },
      ...(audioStream ? { audioStream } : {}),
      needsRepeat: false,
      ended: turn.ended,
      outcome: turn.outcome,
      endReason: turn.endReason,
      turnCount: turn.turnCount,
      costUsd: cost.usd,
    };
  }

  async function transcribeVoiceInner(
    ctx: TrainingContext,
    input: VoiceTurnInput,
  ): Promise<VoiceTranscription> {
    pruneExpired();
    const { tooShort, durationSec } = validateVoiceAudio(input.audio, input.mime);
    const [session, hints] = await Promise.all([
      engine.getSession(ctx, { sessionId: input.sessionId }),
      tooShort ? Promise.resolve<string[]>([]) : sttHints(ctx.businessId),
    ]);
    if (session.status !== 'active') {
      throw new TrainingError('session_not_active', `sessiya holati: ${session.status}`);
    }
    const lang = session.persona.language as VoiceLang;

    // Byudjet: saqlangan + tekshirilayotgan + shu yozuv.
    const usedSec = await withTenant(ctx.businessId, (tx) => voiceRepo.usedVoiceSeconds(tx, input.sessionId));
    if (usedSec + pendingSeconds(input.sessionId) + durationSec > maxSeconds) {
      throw new TrainingError('voice_budget_exhausted', "sessiyaning ovoz byudjeti tugadi — matn bilan davom eting");
    }

    let sttText = '';
    let sttMs = 0;
    let rejected: VoiceTranscription['rejected'];
    if (tooShort) {
      rejected = 'too_short';
    } else {
      let heard;
      try {
        heard = await stt.transcribeShort({
          audio: input.audio,
          mime: VOICE_AUDIO.mime,
          lang,
          ...(hints.length > 0 ? { hints } : {}),
        });
      } catch (err) {
        throw new TrainingError('voice_stt_failed', `nutq tanilmadi: ${describeLlmError(err)}`, err);
      }
      sttText = heard.text.trim();
      sttMs = heard.latencyMs;
      if (lang === 'uz' && sttText.length > 0) {
        const kind = classifyHeardUzText(sttText);
        if (kind === 'uz_cyrillic') sttText = transliterateUzCyrillic(sttText);
        else if (kind === 'foreign') {
          rejected = 'foreign_language';
          sttText = '';
        }
      }
      if (!rejected && sttText.length < VOICE_MIN_TEXT_CHARS) {
        rejected = 'empty';
        sttText = '';
      }
      // STT narxi shu yerda (yozuv keyin tashlansa ham sarflangan).
      const cost = voiceCost(deps.cost, { audioSec: durationSec, chars: 0 });
      if (!cost.priced) warnOnceAboutCost();
      await withTenant(ctx.businessId, (tx) => voiceRepo.addSessionCost(tx, input.sessionId, cost.usd));
    }

    const transcriptId = randomUUID();
    pending.set(transcriptId, {
      businessId: ctx.businessId,
      userId: ctx.userId,
      sessionId: input.sessionId,
      sttText,
      sttMs,
      durationSec,
      at: Date.now(),
    });
    return {
      transcriptId,
      sttText,
      recognized: !rejected,
      ...(rejected ? { rejected } : {}),
      sttMs,
      durationSec,
    };
  }

  async function replyToTextInner(
    ctx: TrainingContext,
    input: { sessionId: string; transcriptId: string; text: string },
  ): Promise<VoiceTurnResult> {
    pruneExpired();
    const totalStartedMs = Date.now();
    const entry = pending.get(input.transcriptId);
    // Boshqa tenant/foydalanuvchi/sessiyaning yozuvi — xuddi yo'qdek.
    if (
      !entry ||
      entry.businessId !== ctx.businessId ||
      entry.userId !== ctx.userId ||
      entry.sessionId !== input.sessionId
    ) {
      throw new TrainingError('voice_review_expired', 'yozuv topilmadi yoki eskirdi — qayta yozing');
    }
    const sellerText = input.text.trim();
    if (sellerText.length === 0) {
      throw new TrainingError('voice_review_expired', "bo'sh matn yuborib bo'lmaydi");
    }

    const session = await engine.getSession(ctx, { sessionId: input.sessionId });
    if (session.status !== 'active') {
      throw new TrainingError('session_not_active', `sessiya holati: ${session.status}`);
    }
    const lang = session.persona.language as VoiceLang;

    return await withTenant(ctx.businessId, async (tx) => {
      if (!(await voiceRepo.tryLockSessionForVoice(tx, input.sessionId))) {
        throw new TrainingError('voice_turn_in_progress', 'shu sessiyada ovozli navbat allaqachon ketmoqda');
      }
      // Shu va tashlangan barcha yozuvlar sekundlari — shu navbatga.
      let voiceSec = 0;
      for (const [id, e] of pending) {
        if (e.sessionId === input.sessionId && e.businessId === ctx.businessId) {
          voiceSec += e.durationSec;
          pending.delete(id);
        }
      }
      return await replyWithText(tx, ctx, {
        sessionId: input.sessionId,
        lang,
        speaker: speakerOf(session.persona),
        sellerText,
        sttText: entry.sttText,
        sttMs: entry.sttMs,
        voiceSec,
        sttCostSec: 0, // STT narxi transkripsiyada hisoblangan
        totalStartedMs,
      });
    });
  }

  async function speakOpeningLineInner(
    ctx: Parameters<VoiceService['speakOpeningLine']>[0],
    { sessionId }: Parameters<VoiceService['speakOpeningLine']>[1],
  ): ReturnType<VoiceService['speakOpeningLine']> {
    const session = await engine.getSession(ctx, { sessionId });
    if (session.persona.direction !== 'inbound') return null;

    // Birinchi gap — mijozning (motor `startSession` da yozgan) 1-navbati.
    const first = session.transcript[0];
    if (!first || first.speaker !== 'customer') return null;

    const lang = session.persona.language as VoiceLang;
    const tone = clampTone(undefined, session.state, getArchetype(session.archetypeKey)).tone;
    const spoken = await speak(first.text, lang, tone, speakerOf(session.persona));
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
  }
}
