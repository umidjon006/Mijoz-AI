/**
 * FAQAT HARNESS (korpus). Saqlanadigan ma'lumot shakllari.
 * `text` — asl STT matni (O'ZGARTIRILMAYDI); `display` — lotin + yashirilgan raqamlar.
 */
import type { SegmentQuality } from './text.js';

export type Role = 'seller' | 'customer' | 'unknown';

export interface Segment {
  index: number;
  /** Sekund (diarizatsiya bo'lsa). */
  start?: number;
  end?: number;
  /** STT bergan so'zlovchi belgisi ("A", "B", ...). */
  speaker?: string;
  text: string;
  display: string;
  quality: SegmentQuality;
  role?: Role;
}

export interface ModelTranscript {
  callId: string;
  model: string;
  languageMode: string;
  durationSec: number;
  latencyMs: number;
  chunks: number;
  hasSpeakerLabels: boolean;
  hasTimestamps: boolean;
  /** Asl matn (bo'laklar qo'shilgan). */
  text: string;
  segments: Segment[];
  /** Provayder qaytargan til (bo'lsa). */
  language?: string;
  error?: string;
}

/** Ketma-ket bir xil roldagi segmentlar — bitta navbat. */
export interface Turn {
  index: number;
  role: Role;
  display: string;
  quality: SegmentQuality;
  start?: number;
  end?: number;
  segmentIndexes: number[];
}
