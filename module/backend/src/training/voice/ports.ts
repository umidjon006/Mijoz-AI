/**
 * Ovoz chokchalari (STT / TTS portlari).
 *
 * MUHIM: bu fayl provayderni BILMAYDI. Azure/Google/GigaAM kabi
 * implementatsiyalar `harness/src/voice/` da (lokal o'lchov uchun), asosiy
 * repoda esa teammate'lar o'z STT'sini (yoki bulutli variantni) shu portga
 * ulaydi. `module/` hech qachon `harness/` dan import qilmaydi.
 *
 * Push-to-talk: har navbat — bitta QISQA yozuv (<= 30 s), oqim (streaming)
 * emas. Shuning uchun port ham bitta so'rov/bitta javob.
 */

/** Mijoz/sotuvchi tili. `mixed` — o'zbekcha + ruscha so'zlar aralash. */
export type VoiceLang = 'uz' | 'ru' | 'mixed';

/**
 * Brauzer aynan shu formatni beradi (Phase B dagi `record`/`web` sahifasi
 * mijoz tomonda WAV yasaydi), shuning uchun serverda ffmpeg kerak emas.
 */
export const VOICE_AUDIO = {
  mime: 'audio/wav' as const,
  sampleRate: 16_000,
  channels: 1,
  bitsPerSample: 16,
} as const;

/** Himoya chegaralari (route va voice-turn shu qiymatlarni ishlatadi). */
export const VOICE_LIMITS = {
  /** Eng uzun yozuv — undan oshsa rad etiladi. */
  maxDurationSec: 30,
  /** 16 kHz × 16 bit × mono ≈ 32 KB/s; 30 s ≈ 960 KB. Zaxira bilan ~2 MB. */
  maxBytes: 2 * 1024 * 1024,
  /** Juda qisqa yozuv (tasodifiy bosilish) — "qaytaring" yo'liga tushadi. */
  minDurationSec: 0.3,
} as const;

export interface SttRequest {
  /** 16 kHz, mono, 16-bit PCM WAV. */
  audio: Buffer;
  mime: 'audio/wav';
  lang: VoiceLang;
  /**
   * Tanib olishga yordam beradigan so'zlar (biznes profilidagi `vocabulary`,
   * taklif nomlari). Hamma provayder qo'llamaydi — qo'llamasa jim e'tiborsiz
   * qoldiriladi.
   */
  hints?: string[];
}

export interface SttResult {
  text: string;
  /** 0..1. Provayder bermasa `undefined` — "qaytaring" qarori shunda matn uzunligiga qaraydi. */
  confidence?: number;
  latencyMs: number;
  /** Provayderning xom javobi — faqat benchmark/debug uchun, DB'ga yozilmaydi. */
  raw?: unknown;
}

export interface SttPort {
  /** Qisqa yozuvni (<= 30 s) matnga aylantiradi. */
  transcribeShort(req: SttRequest): Promise<SttResult>;
}

export interface TtsRequest {
  text: string;
  lang: VoiceLang;
  /** Provayderdagi ovoz nomi (masalan Azure'da `uz-UZ-...Neural`). */
  voice?: string;
}

export interface TtsResult {
  audio: Buffer;
  /** Masalan `audio/wav` yoki `audio/mpeg`. */
  mime: string;
  latencyMs: number;
  /** Birinchi bayt kelgan vaqt — oqimli (streaming) ijro uchun muhim. */
  firstByteMs?: number;
}

export interface TtsPort {
  synthesize(req: TtsRequest): Promise<TtsResult>;
}

/** Ovoz zanjiri uchun kechikish byudjeti (Step 3 talabi). */
export const LATENCY_BUDGET = {
  /** Sotuvchi gapini tugatgandan mijoz audiosi boshlanishigacha. */
  medianMs: 4_000,
  p90Ms: 6_000,
} as const;
