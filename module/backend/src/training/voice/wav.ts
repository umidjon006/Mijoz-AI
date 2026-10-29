/**
 * WAV sarlavhasini o'qish/tekshirish. Provayderga bog'liq emas, shuning uchun
 * `module/` ichida: benchmark (narx hisobi) ham, Phase B (chegaralar) ham
 * shu funksiyadan foydalanadi.
 *
 * Faqat PCM (format 1) qo'llanadi — brauzer aynan shuni beradi.
 */
import { VOICE_AUDIO, VOICE_LIMITS } from './ports.js';

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Audio ma'lumot (data chunk) uzunligi, bayt. */
  dataBytes: number;
  durationSec: number;
}

export class WavFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WavFormatError';
  }
}

/** RIFF/WAVE sarlavhasini o'qiydi (chunk'lar bo'ylab yurib). */
export function parseWav(buffer: Buffer): WavInfo {
  if (buffer.length < 44) throw new WavFormatError('WAV juda qisqa (sarlavha ham sig\'maydi)');
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new WavFormatError('RIFF/WAVE sarlavhasi topilmadi');
  }

  let offset = 12;
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bits: number } | null = null;
  let dataBytes: number | null = null;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ') {
      if (body + 16 > buffer.length) throw new WavFormatError('fmt chunk buzuq');
      fmt = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      // Ba'zi yozuvchilar size'ni 0 yoki noto'g'ri qoldiradi — qolgan hammasini olamiz.
      dataBytes = size > 0 && body + size <= buffer.length ? size : buffer.length - body;
    }

    offset = body + size + (size % 2); // chunk'lar juft baytga tekislanadi
    if (size === 0 && id !== 'data') break;
  }

  if (!fmt) throw new WavFormatError('fmt chunk yo\'q');
  if (dataBytes === null) throw new WavFormatError('data chunk yo\'q');
  if (fmt.audioFormat !== 1) {
    throw new WavFormatError(`faqat PCM qo'llanadi (audioFormat=${fmt.audioFormat})`);
  }

  const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bits / 8);
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bits,
    dataBytes,
    durationSec: bytesPerSecond > 0 ? dataBytes / bytesPerSecond : 0,
  };
}

export interface WavCheckProblem {
  code: 'too_large' | 'too_long' | 'too_short' | 'bad_format';
  message: string;
}

/**
 * Yozuv kutilgan formatga va chegaralarga mos keladimi.
 * `null` — hammasi joyida.
 */
export function checkWav(buffer: Buffer): WavCheckProblem | null {
  if (buffer.length > VOICE_LIMITS.maxBytes) {
    return {
      code: 'too_large',
      message: `yozuv ${buffer.length} bayt, chegara ${VOICE_LIMITS.maxBytes}`,
    };
  }

  let info: WavInfo;
  try {
    info = parseWav(buffer);
  } catch (err) {
    return { code: 'bad_format', message: err instanceof Error ? err.message : String(err) };
  }

  if (
    info.sampleRate !== VOICE_AUDIO.sampleRate ||
    info.channels !== VOICE_AUDIO.channels ||
    info.bitsPerSample !== VOICE_AUDIO.bitsPerSample
  ) {
    return {
      code: 'bad_format',
      message:
        `kutilgan ${VOICE_AUDIO.sampleRate} Hz / ${VOICE_AUDIO.channels} kanal / ` +
        `${VOICE_AUDIO.bitsPerSample} bit, kelgan ${info.sampleRate} Hz / ` +
        `${info.channels} kanal / ${info.bitsPerSample} bit`,
    };
  }

  if (info.durationSec > VOICE_LIMITS.maxDurationSec) {
    return {
      code: 'too_long',
      message: `yozuv ${info.durationSec.toFixed(1)} s, chegara ${VOICE_LIMITS.maxDurationSec} s`,
    };
  }
  if (info.durationSec < VOICE_LIMITS.minDurationSec) {
    return {
      code: 'too_short',
      message: `yozuv ${info.durationSec.toFixed(2)} s — juda qisqa`,
    };
  }

  return null;
}
