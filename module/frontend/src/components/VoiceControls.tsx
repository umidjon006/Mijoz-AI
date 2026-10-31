/**
 * Ovozli boshqaruv: bosib turib gapirish (hold-to-talk).
 *
 * Oqim: tugmani bosib turasiz -> 16 kHz mono WAV yoziladi -> qo'yib
 * yuborasiz -> "Eshityapti…" -> tanilgan matn DARHOL transkriptga chiqadi ->
 * mijoz javobi matn bilan chiqadi va audiosi avtomatik ijro etiladi.
 *
 * Matnli kiritish YO'QOLMAYDI: mikrofon ishlamasa yoki nutq tanilmasa,
 * foydalanuvchi yozib davom etadi.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { mashq } from '../lugat/mashq.js';
import type { TrainingApi, VoiceTurnResponse } from '../lib/api.js';
import { useWavRecorder } from '../lib/useWavRecorder.js';
import { Notice } from './ui.js';

/** Maksimal yozuv — server ham aynan shu chegarani qo'llaydi. */
const MAX_SECONDS = 30;

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
  events?: VoiceTurnEvents;
}

type Phase = 'idle' | 'recording' | 'stt' | 'llm' | 'playing';

const PHASE_LABEL: Record<Phase, string> = {
  idle: '',
  recording: mashq.voiceRecording,
  stt: mashq.voiceListening,
  llm: mashq.voiceThinking,
  playing: mashq.voiceSpeaking,
};

/** base64 -> ijro etsa bo'ladigan URL (audio xotirada qoladi, saqlanmaydi). */
function audioUrl(base64: string, mime: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

export function VoiceControls({
  sessionId,
  api,
  disabled = false,
  enabled = false,
  debug = false,
  hasOpeningLine = false,
  events,
}: VoiceControlsProps): JSX.Element | null {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [repeat, setRepeat] = useState(false);
  const [last, setLast] = useState<VoiceTurnResponse | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  /** Yuborish ketayotganda ikkinchi marta yubormaslik uchun. */
  const busyRef = useRef(false);

  const send = useCallback(
    async (wav: Blob | null): Promise<void> => {
      if (!wav || busyRef.current) return;
      busyRef.current = true;
      setError(null);
      setRepeat(false);
      setPhase('stt');

      try {
        const result = await api.takeVoiceTurn(sessionId, wav);

        // Tanilgan matn DARHOL ko'rinadi — kutish seziladi.
        if (result.sellerText) events?.onSellerText(result.sellerText);
        setPhase('llm');
        setLast(result);

        if (result.needsRepeat) setRepeat(true);
        events?.onCustomerTurn(result);

        // Audio: oldingi URL bo'shatiladi (xotira oqmasin).
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        const url = audioUrl(result.audio, result.audioMime);
        urlRef.current = url;

        const player = audioRef.current;
        if (player) {
          player.src = url;
          setPhase('playing');
          try {
            await player.play();
          } catch {
            // Brauzer avtomatik ijroni to'sdi — tugma orqali ijro etiladi.
            setPhase('idle');
          }
        } else {
          setPhase('idle');
        }

      } catch (err) {
        setPhase('idle');
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        busyRef.current = false;
      }
    },
    [api, sessionId, events],
  );

  const recorder = useWavRecorder({ maxSeconds: MAX_SECONDS, onAutoStop: (wav) => void send(wav) });

  /** `inbound`: mijozning birinchi gapi ham ovozda eshitiladi. */
  const playOpening = useCallback(async (): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    try {
      const opening = await api.openingAudio(sessionId);
      const player = audioRef.current;
      if (!opening || !player) return;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = audioUrl(opening.audio, opening.audioMime);
      urlRef.current = url;
      player.src = url;
      setPhase('playing');
      await player.play().catch(() => setPhase('idle'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = false;
    }
  }, [api, sessionId]);

  const begin = useCallback((): void => {
    if (disabled || busyRef.current) return;
    setError(null);
    setPhase('recording');
    void recorder.start();
  }, [disabled, recorder]);

  const finish = useCallback((): void => {
    if (!recorder.recording) return;
    setPhase('stt');
    void recorder.stop().then((wav) => {
      if (!wav) setPhase('idle');
      return send(wav);
    });
  }, [recorder, send]);

  // BO'SHLIQ ham bosib turish tugmasi (matn maydonida emasligini tekshiramiz).
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
      begin();
    };
    const onUp = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || isTyping(event.target)) return;
      event.preventDefault();
      finish();
    };

    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, [enabled, disabled, begin, finish]);

  // Sahifadan chiqishda audio URL'ini bo'shatamiz.
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

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

  const recorderError = recorder.error;
  const recorderMessage =
    recorderError?.kind === 'permission'
      ? mashq.voiceMicDenied
      : recorderError?.kind === 'unsupported'
        ? mashq.voiceUnsupported
        : recorderError?.message;

  return (
    <div className="mq-panel" style={{ marginTop: 12 }}>
      <div className="mq-btn-row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <b>{mashq.voiceSlotTitle}</b>
        <span className="mq-muted mq-small">{mashq.voiceHeadphones}</span>
      </div>

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
      {repeat ? <Notice kind="info">{mashq.voiceRepeatNotice}</Notice> : null}

      <button
        type="button"
        className={`mq-btn mq-btn-primary${recorder.recording ? ' mq-recording' : ''}`}
        style={{ width: '100%', padding: '14px 0', fontSize: 16 }}
        disabled={disabled || busyRef.current}
        onMouseDown={begin}
        onMouseUp={finish}
        onMouseLeave={finish}
        onTouchStart={(event) => {
          event.preventDefault();
          begin();
        }}
        onTouchEnd={(event) => {
          event.preventDefault();
          finish();
        }}
      >
        {recorder.recording ? mashq.voiceRecording : mashq.voiceHoldToTalk}
      </button>

      {/* Mikrofon darajasi + yozuv taymeri */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
        <div
          aria-hidden
          style={{ flex: 1, height: 6, background: '#e6e6e6', borderRadius: 3, overflow: 'hidden' }}
        >
          <div
            style={{
              width: `${Math.round(recorder.level * 100)}%`,
              height: '100%',
              background: recorder.recording ? '#b3261e' : '#9aa0a6',
              transition: 'width 80ms linear',
            }}
          />
        </div>
        <span className="mq-muted mq-small mq-mono" style={{ minWidth: 52, textAlign: 'right' }}>
          {recorder.recording ? `${recorder.seconds.toFixed(1)} s` : `${MAX_SECONDS} s`}
        </span>
      </div>

      {phase !== 'idle' ? (
        <p className="mq-small mq-muted" role="status" style={{ marginTop: 8, marginBottom: 0 }}>
          {PHASE_LABEL[phase]}
        </p>
      ) : null}

      {/* Mijoz ovozi. `controls` — avtomatik ijro to'silsa qo'lda bosish uchun. */}
      <audio
        ref={audioRef}
        controls
        style={{ width: '100%', marginTop: 8 }}
        onEnded={() => setPhase('idle')}
      />

      {debug && last?.debug?.timings ? (
        <p className="mq-small mq-muted mq-mono" style={{ marginBottom: 0 }}>
          {mashq.voiceTimings}: STT {last.debug.timings.sttMs} ms · LLM {last.debug.timings.llmMs} ms
          {' · '}TTS {last.debug.timings.ttsMs} ms · jami {last.debug.timings.totalMs} ms
          {' · '}
          {mashq.voiceTone}: {last.tone}
        </p>
      ) : null}
    </div>
  );
}
