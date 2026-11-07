/**
 * Brauzerda 16 kHz / mono / 16-bit PCM WAV yozib oluvchi hook.
 *
 * Nega brauzerda WAV: server tomonda ffmpeg kerak bo'lmasin va STT
 * provayderiga aynan kutilgan format borsin (`VOICE_AUDIO`). `MediaRecorder`
 * webm/opus beradi — u har provayderda ishlamaydi, shuning uchun PCM'ni
 * o'zimiz yig'amiz.
 *
 * Mantiq `harness/web/record.html` (Phase A) dan ko'chirildi va tiplandi.
 * `ScriptProcessorNode` eskirgan API, lekin barcha brauzerlarda bor va
 * AudioWorklet'dan ko'ra sodda; almashtirish kerak bo'lsa faqat shu fayl
 * o'zgaradi.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { ensureAudioRunning, joinChunks, MIN_RECORDING_SECONDS, trimSilence } from './voice-recording.js';

export const WAV_SAMPLE_RATE = 16_000;

export interface UseWavRecorderOptions {
  /** Shu vaqtdan oshsa yozuv O'ZI to'xtaydi (sekund). */
  maxSeconds?: number;
  /** Bundan qisqa yozuv uchun WAV yasalmaydi (sekund). */
  minSeconds?: number;
  /**
   * `maxSeconds` ga yetib yozuv O'ZI to'xtaganda chaqiriladi. Bo'lmasa
   * yozuv shunchaki tashlab yuborilardi — shuning uchun chaqiruvchi uni
   * aynan `stop()` dagidek yuborishi mumkin.
   */
  onAutoStop?: (result: RecordingResult) => void;
}

/** Yozuv natijasi: juda qisqa bo'lsa `wav` = `null` (bu XATO emas). */
export interface RecordingResult {
  wav: Blob | null;
  seconds: number;
}

export type RecorderError =
  | { kind: 'permission'; message: string }
  | { kind: 'unsupported'; message: string };

export interface WavRecorder {
  recording: boolean;
  /** 0..1 — mikrofon darajasi ko'rsatkichi uchun. */
  level: number;
  /** Joriy yozuv davomiyligi (sekund). */
  seconds: number;
  error: RecorderError | null;
  /** Yozishni boshlaydi; mikrofon ochilmasa `false`. */
  start: () => Promise<boolean>;
  /** To'xtatadi; juda qisqa bo'lsa `wav` = `null` (xato EMAS — qayta yozish mumkin). */
  stop: () => Promise<RecordingResult>;
  /** Joriy yozuvni tashlaydi (hech narsa yuborilmaydi). */
  cancel: () => void;
  /** Mikrofonni butunlay bo'shatadi (sahifadan chiqishda). */
  release: () => void;
}

/** Float32 bo'laklaridan RIFF/WAVE (PCM 16-bit) yasaydi. */
export function encodeWav(chunks: readonly Float32Array[], sampleRate: number): Blob {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;

  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, str: string): void => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + total * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits
  writeStr(36, 'data');
  view.setUint32(40, total * 2, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      const s = Math.max(-1, Math.min(1, chunk[i] as number));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

export function useWavRecorder(options: UseWavRecorderOptions = {}): WavRecorder {
  const maxSeconds = options.maxSeconds ?? 30;
  const minSeconds = options.minSeconds ?? MIN_RECORDING_SECONDS;

  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<RecorderError | null>(null);

  const contextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const samplesRef = useRef(0);
  // Yozuv holati `onaudioprocess` ichida kerak — state emas, ref.
  const recordingRef = useRef(false);
  /** `stop` ni callback ichidan chaqirish uchun (maksimal vaqt tugaganda). */
  const autoStopRef = useRef<(() => void) | null>(null);

  const release = useCallback((): void => {
    recordingRef.current = false;
    processorRef.current?.disconnect();
    processorRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void contextRef.current?.close().catch(() => undefined);
    contextRef.current = null;
    setRecording(false);
    setLevel(0);
  }, []);

  // Sahifadan chiqilganda mikrofon yonib qolmasin.
  useEffect(() => release, [release]);

  const ensureAudio = useCallback(async (): Promise<void> => {
    if (contextRef.current) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      throw { kind: 'unsupported', message: 'Brauzer mikrofonni qo\'llamaydi' } as RecorderError;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    streamRef.current = stream;

    // 16 kHz kontekst: qayta namunalash brauzer zimmasida.
    const context = new AudioContext({ sampleRate: WAV_SAMPLE_RATE });
    contextRef.current = context;

    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;

    processor.onaudioprocess = (event): void => {
      const input = event.inputBuffer.getChannelData(0);

      let peak = 0;
      for (let i = 0; i < input.length; i += 1) {
        const v = Math.abs(input[i] as number);
        if (v > peak) peak = v;
      }
      setLevel(Math.min(1, peak * 1.4));

      if (!recordingRef.current) return;
      chunksRef.current.push(new Float32Array(input));
      samplesRef.current += input.length;
      const elapsed = samplesRef.current / context.sampleRate;
      setSeconds(elapsed);
      if (elapsed >= maxSeconds) autoStopRef.current?.();
    };

    source.connect(processor);
    // Chiqishga ulanmasa ScriptProcessor ishlamaydi; ovoz chiqmasligi uchun 0 gain.
    const silent = context.createGain();
    silent.gain.value = 0;
    processor.connect(silent);
    silent.connect(context.destination);
  }, [maxSeconds]);

  const start = useCallback(async (): Promise<boolean> => {
    if (recordingRef.current) return true;
    setError(null);
    try {
      await ensureAudio();
      // Kontekst `suspended` bo'lsa `onaudioprocess` ishlamaydi va har yozuv
      // 0.00 s bo'lib qoladi — har safar `resume()` qilamiz.
      if (contextRef.current) await ensureAudioRunning(contextRef.current);
    } catch (err) {
      const known = err as RecorderError;
      setError(
        known?.kind
          ? known
          : {
              kind: 'permission',
              message: err instanceof Error ? err.message : String(err),
            },
      );
      return false;
    }
    chunksRef.current = [];
    samplesRef.current = 0;
    setSeconds(0);
    recordingRef.current = true;
    setRecording(true);
    return true;
  }, [ensureAudio]);

  const stop = useCallback(async (): Promise<RecordingResult> => {
    const rate = contextRef.current?.sampleRate ?? WAV_SAMPLE_RATE;
    if (!recordingRef.current) return { wav: null, seconds: 0 };
    recordingRef.current = false;
    setRecording(false);

    const chunks = chunksRef.current;
    chunksRef.current = [];
    samplesRef.current = 0;

    // Boshdagi/oxirdagi jimlik kesiladi: STT tezroq va aniqroq, "juda qisqa"
    // qarori esa HAQIQIY nutq davomiyligiga qaraydi (faqat jimlik — yuborilmaydi).
    const speech = trimSilence(joinChunks(chunks), rate);
    const elapsed = speech.length / rate;
    // Juda qisqa — XATO emas: chaqiruvchi yumshoq xabar ko'rsatadi.
    if (elapsed < minSeconds) return { wav: null, seconds: elapsed };
    return { wav: encodeWav([speech], rate), seconds: elapsed };
  }, [minSeconds]);

  const cancel = useCallback((): void => {
    recordingRef.current = false;
    chunksRef.current = [];
    samplesRef.current = 0;
    setRecording(false);
    setSeconds(0);
  }, []);

  // `onaudioprocess` ichidan chaqirish uchun oxirgi `stop` ni saqlaymiz.
  // Vaqt tugaganda yozuv YO'QOLMAYDI: `onAutoStop` ga beriladi.
  const onAutoStop = options.onAutoStop;
  useEffect(() => {
    autoStopRef.current = () => {
      void stop().then((result) => onAutoStop?.(result));
    };
  }, [stop, onAutoStop]);

  return { recording, level, seconds, error, start, stop, cancel, release };
}
