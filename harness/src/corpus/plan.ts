/**
 * FAQAT HARNESS (korpus). Audio bo'laklash rejasi — SOF funksiyalar.
 *
 * Uzun yozuv STT chegarasidan (`maxChunkSec`) oshsa, uni JIMLIK joylarida
 * bo'lamiz (gap o'rtasida kesilmasin). Jimliklar `ffmpeg -af silencedetect`
 * chiqishidan olinadi.
 */

export interface Interval {
  start: number;
  end: number;
}

/** `silencedetect` stderr chiqishidan jimlik oraliqlarini ajratadi. */
export function parseSilenceDetect(stderr: string): Interval[] {
  const out: Interval[] = [];
  let pendingStart: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (start) {
      pendingStart = Math.max(0, Number(start[1]));
      continue;
    }
    const end = /silence_end:\s*([\d.]+)/.exec(line);
    if (end && pendingStart !== null) {
      out.push({ start: pendingStart, end: Number(end[1]) });
      pendingStart = null;
    }
  }
  return out;
}

/**
 * Bo'laklar: har biri `maxChunkSec` dan oshmaydi. Kesish nuqtasi — chegaradan
 * OLDINGI eng kech jimlik o'rtasi (`minChunkSec` dan keyin); jimlik bo'lmasa —
 * qattiq chegara. Bo'laklar orasida bo'shliq ham, ustma-ustlik ham yo'q.
 */
export function planChunks(
  durationSec: number,
  silences: readonly Interval[],
  maxChunkSec: number,
  minChunkSec = Math.min(30, maxChunkSec / 2),
): Interval[] {
  if (!(durationSec > 0)) return [];
  if (durationSec <= maxChunkSec) return [{ start: 0, end: durationSec }];

  const mids = silences
    .map((s) => (s.start + s.end) / 2)
    .filter((m) => m > 0 && m < durationSec)
    .sort((a, b) => a - b);

  const chunks: Interval[] = [];
  let start = 0;
  while (durationSec - start > maxChunkSec) {
    const limit = start + maxChunkSec;
    const candidates = mids.filter((m) => m >= start + minChunkSec && m <= limit);
    const cut = candidates.length > 0 ? (candidates[candidates.length - 1] as number) : limit;
    chunks.push({ start, end: cut });
    start = cut;
  }
  chunks.push({ start, end: durationSec });
  return chunks;
}

/**
 * Stereo yozuvda kanallar so'zlovchilarga ajratilganmi: har oynada qaysi
 * kanal ustun ekanini sanaymiz. Kanallar deyarli hamma oynada teng bo'lsa —
 * bitta aralash ovoz (ajratilmagan).
 */
export function channelsSeparated(
  leftRms: readonly number[],
  rightRms: readonly number[],
  dominanceRatio = 4,
): { separated: boolean; dominantShare: number } {
  let active = 0;
  let dominant = 0;
  const n = Math.min(leftRms.length, rightRms.length);
  for (let i = 0; i < n; i += 1) {
    const l = leftRms[i] as number;
    const r = rightRms[i] as number;
    if (Math.max(l, r) < 1e-4) continue; // jimlik
    active += 1;
    if (l / Math.max(r, 1e-9) >= dominanceRatio || r / Math.max(l, 1e-9) >= dominanceRatio) dominant += 1;
  }
  const dominantShare = active === 0 ? 0 : dominant / active;
  return { separated: dominantShare >= 0.6, dominantShare };
}
