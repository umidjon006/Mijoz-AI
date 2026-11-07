/**
 * FAQAT HARNESS (korpus). STT javob(lar)idan saqlanadigan transkript yasash —
 * SOF funksiya. Asl matn `text` maydonida o'zgarishsiz qoladi.
 */
import type { RawSegment } from './stt.js';
import { displayText, segmentQuality, splitSentences } from './text.js';
import type { ModelTranscript, Segment } from './types.js';

export interface ChunkResult {
  /** Bo'lakning asl fayldagi boshlanishi (sekund). */
  offsetSec: number;
  text: string;
  segments: RawSegment[];
  latencyMs: number;
  language?: string;
}

export function buildModelTranscript(input: {
  callId: string;
  model: string;
  languageMode: string;
  durationSec: number;
  chunks: readonly ChunkResult[];
}): ModelTranscript {
  const segments: Segment[] = [];
  let hasSpeakerLabels = false;
  let hasTimestamps = false;

  for (const [chunkIndex, chunk] of input.chunks.entries()) {
    if (chunk.segments.length > 0) {
      for (const raw of chunk.segments) {
        if (raw.speaker !== undefined) hasSpeakerLabels = true;
        if (raw.start !== undefined) hasTimestamps = true;
        segments.push({
          index: segments.length,
          ...(raw.start !== undefined ? { start: Number((raw.start + chunk.offsetSec).toFixed(2)) } : {}),
          ...(raw.end !== undefined ? { end: Number((raw.end + chunk.offsetSec).toFixed(2)) } : {}),
          // Bo'laklar orasida diarizatsiya belgilari mos kelmasligi mumkin — bo'lak raqami qo'shiladi.
          ...(raw.speaker !== undefined
            ? { speaker: input.chunks.length > 1 ? `${chunkIndex + 1}:${raw.speaker}` : raw.speaker }
            : {}),
          text: raw.text,
          display: displayText(raw.text),
          quality: segmentQuality(raw.text),
        });
      }
    } else {
      for (const sentence of splitSentences(chunk.text)) {
        segments.push({
          index: segments.length,
          text: sentence,
          display: displayText(sentence),
          quality: segmentQuality(sentence),
        });
      }
    }
  }

  const languages = [...new Set(input.chunks.map((c) => c.language).filter((l): l is string => !!l))];
  return {
    callId: input.callId,
    model: input.model,
    languageMode: input.languageMode,
    durationSec: input.durationSec,
    latencyMs: input.chunks.reduce((sum, c) => sum + c.latencyMs, 0),
    chunks: input.chunks.length,
    hasSpeakerLabels,
    hasTimestamps,
    text: input.chunks.map((c) => c.text).join(' ').trim(),
    segments,
    ...(languages.length > 0 ? { language: languages.join(',') } : {}),
  };
}

export function lowQualityShare(t: ModelTranscript): number {
  return t.segments.length === 0 ? 1 : t.segments.filter((s) => s.quality === 'low_quality').length / t.segments.length;
}
