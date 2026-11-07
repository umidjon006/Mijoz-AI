/**
 * Ovozli boshqaruv.
 *
 * Yozish usullari (almashtirgich, tanlov brauzerda eslab qolinadi):
 *  - "Bosib-bosib o'chirish" (default): bir bosish — yozish, ikkinchisi — yuborish;
 *  - "Bosib turish": bosib turib gapirish, qo'yib yuborganda yuboriladi.
 * BO'SHLIQ ikkala usulda ham ishlaydi. Yozilayotganda qizil "Yozilyapti…"
 * belgisi, taymer va "Bekor qilish" tugmasi ko'rinadi.
 *
 * Oqim: yozuv -> "Eshityapti…" -> tanilgan matn DARHOL transkriptga chiqadi ->
 * mijoz matni chiqadi va audiosi ijro etiladi. Server oqimli TTS bersa
 * (`audioStreamUrl`), ijro birinchi audio bo'lagi kelishi bilan boshlanadi.
 *
 * Tugma mantig'i `lib/voice-recording.ts` dagi sof holat mashinasida
 * (testlangan): "juda qisqa" — yumshoq xabar, yozish darhol yana mumkin.
 *
 * TEKSHIRISH rejimi ("Matnni yuborishdan oldin tekshirish"): yozuvdan keyin
 * tanilgan matn tahrirlanadigan maydonda chiqadi; mijoz FAQAT "Yuborish"
 * bosilgandan keyin javob beradi. "Qayta yozish" — matn tashlanadi.
 * Asl STT matni serverda navbat meta'sida qoladi (`sttText`, `edited`).
 *
 * Matnli kiritish YO'QOLMAYDI: mikrofon ishlamasa yoki nutq tanilmasa,
 * foydalanuvchi yozib davom etadi.
 */
import { useCallback, useEffect, useRef, useState, type TouchEvent } from 'react';

import { mashq } from '../lugat/mashq.js';
import { apiErrorBody, errorText } from '../lib/api-error.js';
import type { TrainingApi, VoiceTurnResponse } from '../lib/api.js';
import { usePresentation } from '../lib/presentation.js';
import { useWavRecorder, type RecordingResult } from '../lib/useWavRecorder.js';
import {
  INITIAL_RECORD_STATE,
  recordingStep,
  type RecordCommand,
  type RecordEvent,
  type RecordMode,
  type RecordState,
} from '../lib/voice-recording.js';
import { Notice } from './ui.js';

/** Maksimal yozuv — server ham aynan shu chegarani qo'llaydi. */
const MAX_SECONDS = 30;
const MODE_STORAGE_KEY = 'mashq.voiceRecordMode';

export interface VoiceTurnEvents {
  /** STT matni tanilishi bilan — mijoz javobini KUTMASDAN. */
  onSellerText: (text: string) => void;
  /** To'liq navbat: mijoz matni, navbat soni, tugadimi. */
  onCustomerTurn: (result: VoiceTurnResponse) => void;
}

export interface VoiceControlsProps {
  sessionId: string;
  api: TrainingApi;
  /** Sessiya tugagan bo'lsa — yozish mumkin emas. */
  disabled?: boolean;
  /** `inbound` sessiyada mijozning birinchi gapini eshitish tugmasi. */
  hasOpeningLine?: boolean;
  /** Server ovozni yoqqanmi (`_harness` yoki host sozlamasidan). */
  enabled?: boolean;
  /** Bosqichlar vaqtini ko'rsatish (harness; prod'da `false`). */
  debug?: boolean;
  /** Tekshirish rejimi boshlang'ich holati (taqdimot rejimida `true`). */
  reviewDefault?: boolean;
  events?: VoiceTurnEvents;
}

/** Tekshirilayotgan STT natijasi. */
interface ReviewState {
  transcriptId: string;
  text: string;
  recognized: boolean;
}

type Phase = 'idle' | 'stt' | 'playing';

/** base64 -> ijro etsa bo'ladigan URL (audio xotirada qoladi, saqlanmaydi). */
function audioUrl(base64: string, mime: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

function readMode(): RecordMode {
  try {
    return window.localStorage.getItem(MODE_STORAGE_KEY) === 'hold' ? 'hold' : 'toggle';
  } catch {
    return 'toggle';
  }
}

export function VoiceControls({
  sessionId,
  api,
  disabled = false,
  enabled = false,
  debug = false,
  hasOpeningLine = false,
  reviewDefault = false,
  events,
}: VoiceControlsProps): JSX.Element | null {
  const presentation = usePresentation();
  const [reviewMode, setReviewMode] = useState(reviewDefault);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [replying, setReplying] = useState(false);
  // Server sozlamasi kech kelishi mumkin (`_harness`) — default'ni kuzatamiz.
  useEffect(() => setReviewMode(reviewDefault), [reviewDefault]);
  const [mode, setMode] = useState<RecordMode>(readMode);
  const [rec, setRec] = useState<RecordState>(INITIAL_RECORD_STATE);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [repeat, setRepeat] = useState(false);
  const [last, setLast] = useState<VoiceTurnResponse | null>(null);
  /** Brauzerda o'lchangan: yozuv tugagandan mijoz ovozi boshlanguncha (ms). */
  const [clientMs, setClientMs] = useState<{ response: number; audio: number | null } | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const recRef = useRef<RecordState>(INITIAL_RECORD_STATE);
  const resultRef = useRef<RecordingResult | null>(null);
  const timingRef = useRef<{ stoppedAt: number; responseAt: number | null } | null>(null);
  /** `inbound` ochilish gapi ijro etilayotganda yozuv boshlanmasin. */
  const openingBusyRef = useRef(false);

  const playUrl = useCallback(async (url: string): Promise<void> => {
    const player = audioRef.current;
    if (!player) {
      setPhase('idle');
      return;
    }
    player.src = url;
    setPhase('playing');
    try {
      await player.play();
    } catch {
      // Brauzer avtomatik ijroni to'sdi — `controls` orqali qo'lda ijro etiladi.
      setPhase('idle');
    }
  }, []);

  /** Mijoz navbati natijasi: transkript, holat va audio. */
  const handleTurnResult = useCallback(
    async (result: VoiceTurnResponse): Promise<void> => {
      if (timingRef.current) timingRef.current.responseAt = performance.now();
      // Tanilgan matn DARHOL ko'rinadi — kutish seziladi.
      if (result.sellerText) events?.onSellerText(result.sellerText);
      setLast(result);
      if (result.needsRepeat) setRepeat(true);
      events?.onCustomerTurn(result);

      // Audio: oldingi URL bo'shatiladi (xotira oqmasin).
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
      if (result.audioStreamUrl) {
        // Oqim: brauzer birinchi bo'lak kelishi bilan ijroni boshlaydi.
        await playUrl(result.audioStreamUrl);
      } else {
        const url = audioUrl(result.audio, result.audioMime);
        urlRef.current = url;
        await playUrl(url);
      }
    },
    [events, playUrl],
  );

  const send = useCallback(
    async (wav: Blob): Promise<boolean> => {
      setError(null);
      setRepeat(false);
      setPhase('stt');
      try {
        if (reviewMode) {
          // Faqat STT: matn tekshiruvga chiqadi, mijoz hali javob bermaydi.
          const heard = await api.transcribeVoice(sessionId, wav);
          setReview({ transcriptId: heard.transcriptId, text: heard.sttText, recognized: heard.recognized });
          setPhase('idle');
          return true;
        }
        await handleTurnResult(await api.takeVoiceTurn(sessionId, wav));
        return true;
      } catch (err) {
        setPhase('idle');
        setError(errorText(err, presentation));
        return false;
      }
    },
    [api, sessionId, reviewMode, handleTurnResult, presentation],
  );

  /** "Yuborish": tasdiqlangan (tahrirlangan bo'lishi mumkin) matn bilan javob. */
  const confirmReview = useCallback(async (): Promise<void> => {
    if (!review || replying || review.text.trim().length === 0) return;
    setReplying(true);
    setError(null);
    setPhase('stt');
    timingRef.current = { stoppedAt: performance.now(), responseAt: null };
    try {
      const result = await api.voiceReply(sessionId, { transcriptId: review.transcriptId, text: review.text.trim() });
      setReview(null);
      await handleTurnResult(result);
    } catch (err) {
      setPhase('idle');
      // Yozuv eskirgan bo'lsa — tekshiruv yopiladi, qayta yozish kerak.
      if (apiErrorBody(err)?.error === 'voice_review_expired') setReview(null);
      setError(errorText(err, presentation));
    } finally {
      setReplying(false);
    }
  }, [api, sessionId, review, replying, handleTurnResult, presentation]);

  // --- Holat mashinasi: hodisa -> yangi holat + buyruq ---------------------
  const dispatchRef = useRef<(event: RecordEvent) => void>(() => undefined);
  const recorder = useWavRecorder({
    maxSeconds: MAX_SECONDS,
    onAutoStop: (result) => {
      resultRef.current = result;
      timingRef.current = { stoppedAt: performance.now(), responseAt: null };
      dispatchRef.current({ type: 'stopped', seconds: result.seconds });
    },
  });

  const run = useCallback(
    (command: RecordCommand): void => {
      switch (command) {
        case 'start':
          setError(null);
          setRepeat(false);
          void recorder.start().then((ok) => dispatchRef.current({ type: ok ? 'started' : 'startFailed' }));
          break;
        case 'stop':
          void recorder.stop().then((result) => {
            resultRef.current = result;
            timingRef.current = { stoppedAt: performance.now(), responseAt: null };
            dispatchRef.current({ type: 'stopped', seconds: result.seconds });
          });
          break;
        case 'discard':
          recorder.cancel();
          resultRef.current = null;
          break;
        case 'send': {
          const wav = resultRef.current?.wav;
          resultRef.current = null;
          if (!wav) {
            dispatchRef.current({ type: 'failed' });
            break;
          }
          void send(wav).then((ok) => dispatchRef.current({ type: ok ? 'sent' : 'failed' }));
          break;
        }
        default:
          break;
      }
    },
    [recorder, send],
  );

  // Tekshiruv ochiq yoki javob kutilayotganda yangi yozuv boshlanmaydi.
  const blocked = disabled || openingBusyRef.current || review !== null || replying;
  const dispatch = useCallback(
    (event: RecordEvent): void => {
      const step = recordingStep(recRef.current, event, mode, blocked);
      recRef.current = step.state;
      setRec(step.state);
      run(step.command);
    },
    [mode, blocked, run],
  );
  dispatchRef.current = dispatch;

  /** `inbound`: mijozning birinchi gapi ham ovozda eshitiladi. */
  const playOpening = useCallback(async (): Promise<void> => {
    if (openingBusyRef.current || recRef.current.phase !== 'idle') return;
    openingBusyRef.current = true;
    setError(null);
    try {
      const opening = await api.openingAudio(sessionId);
      if (!opening) return;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = audioUrl(opening.audio, opening.audioMime);
      urlRef.current = url;
      await playUrl(url);
    } catch (err) {
      setError(errorText(err, presentation));
    } finally {
      openingBusyRef.current = false;
    }
  }, [api, sessionId, playUrl, presentation]);

  // BO'SHLIQ: toggle — bir bosish; hold — bosib turish (matn maydonida emas).
  useEffect(() => {
    if (!enabled || disabled) return undefined;

    const isTyping = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      const tag = el?.tagName?.toLowerCase();
      return tag === 'input' || tag === 'textarea' || el?.isContentEditable === true;
    };

    const onDown = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.repeat || isTyping(event.target)) return;
      event.preventDefault();
      dispatch(mode === 'toggle' ? { type: 'click' } : { type: 'press' });
    };
    const onUp = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || isTyping(event.target)) return;
      event.preventDefault();
      if (mode === 'hold') dispatch({ type: 'release' });
    };

    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, [enabled, disabled, dispatch, mode]);

  // Sahifadan chiqishda audio URL'ini bo'shatamiz.
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const changeMode = (next: RecordMode): void => {
    if (rec.phase !== 'idle') return;
    setMode(next);
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch {
      // Saqlab bo'lmasa — faqat shu sahifa uchun.
    }
  };

  if (!enabled) {
    return (
      <details className="mq-panel" style={{ marginTop: 12 }}>
        <summary>{mashq.voiceSlotTitle}</summary>
        <p className="mq-small mq-muted" style={{ marginBottom: 0 }}>
          {mashq.voiceSlotPending}
        </p>
      </details>
    );
  }

  const recorderMessage =
    recorder.error?.kind === 'permission'
      ? mashq.voiceMicDenied
      : recorder.error?.kind === 'unsupported'
        ? mashq.voiceUnsupported
        : null;

  const active = rec.phase === 'starting' || rec.phase === 'recording' || rec.phase === 'stopping';
  const sending = rec.phase === 'sending';
  const reviewOpen = review !== null || replying;
  const buttonDisabled = disabled || sending || rec.phase === 'stopping' || reviewOpen;
  const buttonLabel = active
    ? mode === 'toggle'
      ? mashq.voiceToggleStop
      : mashq.voiceRecording
    : mode === 'toggle'
      ? mashq.voiceToggleStart
      : mashq.voiceHoldToTalk;

  const statusLabel = sending
    ? mashq.voiceListening
    : replying
      ? mashq.voiceThinking
      : phase === 'playing'
      ? mashq.voiceSpeaking
      : '';

  return (
    <div className="mq-panel" style={{ marginTop: 12 }}>
      <div className="mq-btn-row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <b>{mashq.voiceSlotTitle}</b>
        <span className="mq-muted mq-small">{mashq.voiceHeadphones}</span>
      </div>

      {/* Yozish usuli */}
      <div className="mq-btn-row" role="radiogroup" aria-label={mashq.voiceModeLabel} style={{ marginBottom: 8 }}>
        <span className="mq-small mq-muted">{mashq.voiceModeLabel}:</span>
        {(['hold', 'toggle'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            className={`mq-btn mq-small${mode === value ? ' mq-btn-primary' : ''}`}
            disabled={rec.phase !== 'idle'}
            onClick={() => changeMode(value)}
          >
            {value === 'hold' ? mashq.voiceModeHold : mashq.voiceModeToggle}
          </button>
        ))}
      </div>

      {/* Tekshirish rejimi */}
      <label className="mq-small" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={reviewMode}
          disabled={rec.phase !== 'idle' || reviewOpen}
          onChange={(event) => setReviewMode(event.target.checked)}
        />
        {mashq.voiceReviewToggle}
      </label>

      {hasOpeningLine ? (
        <button
          type="button"
          className="mq-btn mq-small"
          style={{ marginBottom: 8 }}
          onClick={() => void playOpening()}
        >
          {mashq.voicePlayOpening}
        </button>
      ) : null}

      {recorderMessage ? <Notice kind="error">{recorderMessage}</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      {rec.notice === 'too_short' ? <Notice kind="info">{mashq.voiceTooShort}</Notice> : null}
      {repeat ? <Notice kind="info">{mashq.voiceRepeatNotice}</Notice> : null}

      <button
        type="button"
        className={`mq-btn mq-btn-primary${active ? ' mq-recording' : ''}`}
        style={{ width: '100%', padding: '14px 0', fontSize: 16 }}
        disabled={buttonDisabled}
        aria-pressed={active}
        {...(mode === 'toggle'
          ? { onClick: () => dispatch({ type: 'click' }) }
          : {
              onMouseDown: () => dispatch({ type: 'press' }),
              onMouseUp: () => dispatch({ type: 'release' }),
              onMouseLeave: () => {
                if (active) dispatch({ type: 'release' });
              },
              onTouchStart: (event: TouchEvent) => {
                event.preventDefault();
                dispatch({ type: 'press' });
              },
              onTouchEnd: (event: TouchEvent) => {
                event.preventDefault();
                dispatch({ type: 'release' });
              },
            })}
      >
        {buttonLabel}
      </button>

      {/* Tekshiruv: tanilgan matn — tuzatib yuborish yoki qayta yozish */}
      {review ? (
        <div className="mq-review" style={{ marginTop: 10 }}>
          <label className="mq-small mq-muted" htmlFor="mq-voice-review">
            {review.recognized ? mashq.voiceReviewLabel : mashq.voiceReviewEmpty}
          </label>
          <textarea
            id="mq-voice-review"
            value={review.text}
            disabled={replying}
            rows={3}
            style={{ width: '100%', marginTop: 4 }}
            onChange={(event) => setReview({ ...review, text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void confirmReview();
              }
            }}
            autoFocus
          />
          <div className="mq-btn-row" style={{ marginTop: 6 }}>
            <button
              type="button"
              className="mq-btn mq-btn-primary"
              disabled={replying || review.text.trim().length === 0}
              onClick={() => void confirmReview()}
            >
              {replying ? mashq.sending : mashq.voiceReviewSend}
            </button>
            <button type="button" className="mq-btn" disabled={replying} onClick={() => setReview(null)}>
              {mashq.voiceReviewRerecord}
            </button>
          </div>
        </div>
      ) : null}

      {/* Yozilyapti: qizil belgi + taymer + bekor qilish */}
      {active ? (
        <div className="mq-btn-row" style={{ alignItems: 'center', gap: 10, marginTop: 8 }}>
          <span className="mq-rec-badge" role="status">
            <span className="mq-rec-dot" aria-hidden />
            {mashq.voiceRecordingBadge} {recorder.seconds.toFixed(1)} s
          </span>
          <button type="button" className="mq-btn mq-small" onClick={() => dispatch({ type: 'cancel' })}>
            {mashq.voiceCancel}
          </button>
        </div>
      ) : null}

      {/* Mikrofon darajasi */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
        <div
          aria-hidden
          style={{ flex: 1, height: 6, background: '#e6e6e6', borderRadius: 3, overflow: 'hidden' }}
        >
          <div
            style={{
              width: `${Math.round(recorder.level * 100)}%`,
              height: '100%',
              background: active ? '#b3261e' : '#9aa0a6',
              transition: 'width 80ms linear',
            }}
          />
        </div>
        <span className="mq-muted mq-small mq-mono" style={{ minWidth: 52, textAlign: 'right' }}>
          {active ? `${recorder.seconds.toFixed(1)} s` : `${MAX_SECONDS} s`}
        </span>
      </div>

      {statusLabel ? (
        <p className="mq-small mq-muted" role="status" style={{ marginTop: 8, marginBottom: 0 }}>
          {statusLabel}
        </p>
      ) : null}

      {/* Mijoz ovozi. `controls` — avtomatik ijro to'silsa qo'lda bosish uchun. */}
      <audio
        ref={audioRef}
        controls
        style={{ width: '100%', marginTop: 8 }}
        onPlaying={() => {
          const t = timingRef.current;
          if (t?.responseAt != null) {
            setClientMs({
              response: Math.round(t.responseAt - t.stoppedAt),
              audio: Math.round(performance.now() - t.stoppedAt),
            });
            timingRef.current = null;
          }
        }}
        onEnded={() => setPhase('idle')}
        onError={() => {
          if (phase === 'playing') setError(mashq.voiceAudioFailed);
          setPhase('idle');
        }}
      />

      {debug && !presentation && last?.debug?.timings ? (
        <p className="mq-small mq-muted mq-mono" style={{ marginBottom: 0 }}>
          {mashq.voiceTimings}: STT {last.debug.timings.sttMs} ms · LLM {last.debug.timings.llmMs} ms
          {' · '}TTS{' '}
          {last.debug.timings.ttsStreamed ? 'oqim' : `${last.debug.timings.ttsMs} ms`}
          {' · '}server {last.debug.timings.totalMs} ms
          {clientMs
            ? ` · javob ${clientMs.response} ms · ${mashq.voiceAudioStarted} ${clientMs.audio ?? '-'} ms`
            : ''}
          {' · '}
          {mashq.voiceTone}: {last.tone}
        </p>
      ) : null}
    </div>
  );
}
