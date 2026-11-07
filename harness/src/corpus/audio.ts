/**
 * FAQAT HARNESS (korpus). ffprobe / ffmpeg o'ramlari. Asl fayllar
 * O'ZGARTIRILMAYDI — 16 kHz mono WAV nusxalar `work/wav/` ga yoziladi.
 */
import { spawnSync } from 'node:child_process';

import { channelsSeparated, parseSilenceDetect, type Interval } from './plan.js';

export interface ProbeInfo {
  durationSec: number;
  bitRate: number;
  channels: number;
  sampleRate: number;
  codec: string;
}

function run(cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** ffmpeg va ffprobe bormi. Yo'q bo'lsa — o'rnatish buyrug'i bilan to'xtaymiz. */
export function checkFfmpeg(): { ok: boolean; missing: string[] } {
  const missing = ['ffmpeg', 'ffprobe'].filter((bin) => !run(bin, ['-version']).ok);
  return { ok: missing.length === 0, missing };
}

export function probe(file: string): ProbeInfo {
  const r = run('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  if (!r.ok) throw new Error(`ffprobe xato: ${r.stderr.slice(0, 200)}`);
  const json = JSON.parse(r.stdout) as {
    format?: { duration?: string; bit_rate?: string };
    streams?: Array<{ codec_type?: string; channels?: number; sample_rate?: string; codec_name?: string }>;
  };
  const audio = json.streams?.find((s) => s.codec_type === 'audio');
  return {
    durationSec: Number(json.format?.duration ?? 0),
    bitRate: Number(json.format?.bit_rate ?? 0),
    channels: audio?.channels ?? 0,
    sampleRate: Number(audio?.sample_rate ?? 0),
    codec: audio?.codec_name ?? '?',
  };
}

/** Jimliklar (-30 dB, 0.4 s dan uzun). */
export function detectSilences(file: string, noiseDb = -30, minSec = 0.4): Interval[] {
  const r = run('ffmpeg', [
    '-hide_banner', '-nostats', '-i', file, '-af', `silencedetect=noise=${noiseDb}dB:d=${minSec}`, '-f', 'null', '-',
  ]);
  return parseSilenceDetect(r.stderr);
}

/** 16 kHz mono 16-bit WAV (ixtiyoriy oraliq). */
export function toWav(input: string, output: string, range?: Interval): void {
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  if (range) args.push('-ss', range.start.toFixed(3), '-to', range.end.toFixed(3));
  args.push('-i', input, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output);
  const r = run('ffmpeg', args);
  if (!r.ok) throw new Error(`ffmpeg (wav) xato: ${r.stderr.slice(0, 200)}`);
}

/** Tinglash uchun qisqa MP3 parcha (solishtirish sahifasi uchun). */
export function toClip(input: string, output: string, range: Interval): void {
  const r = run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-ss', range.start.toFixed(3), '-to', range.end.toFixed(3),
    '-i', input, '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k', output,
  ]);
  if (!r.ok) throw new Error(`ffmpeg (clip) xato: ${r.stderr.slice(0, 200)}`);
}

/**
 * Stereo bo'lsa: har kanal energiyasi 0.5 s oynalarda — kanallar
 * so'zlovchilarga ajratilganmi. Mono uchun `null`.
 */
export function analyzeChannels(file: string, channels: number): { separated: boolean; dominantShare: number } | null {
  if (channels < 2) return null;
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-i', file, '-ac', '2', '-ar', '8000', '-f', 's16le', '-'],
    { maxBuffer: 512 * 1024 * 1024 },
  );
  if (r.status !== 0 || !r.stdout) return null;
  const pcm = r.stdout as Buffer;
  const frame = 4000; // 0.5 s @ 8 kHz
  const left: number[] = [];
  const right: number[] = [];
  for (let offset = 0; offset + frame * 4 <= pcm.length; offset += frame * 4) {
    let l = 0;
    let rr = 0;
    for (let i = 0; i < frame; i += 1) {
      const a = pcm.readInt16LE(offset + i * 4) / 32768;
      const b = pcm.readInt16LE(offset + i * 4 + 2) / 32768;
      l += a * a;
      rr += b * b;
    }
    left.push(Math.sqrt(l / frame));
    right.push(Math.sqrt(rr / frame));
  }
  return channelsSeparated(left, right);
}
