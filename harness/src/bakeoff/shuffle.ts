/**
 * FAQAT HARNESS. Urug'li (seeded) aralashtirish — ko'r baholash uchun.
 *
 * Bir xil urug' => bir xil tartib va bir xil `Model A/B/C` xaritasi.
 * Shuning uchun baholashni to'xtatib, keyin davom ettirish mumkin va
 * natijani qayta tiklash ham mumkin.
 */

/** xmur3 — satrdan 32-bit urug'. */
export function hashSeed(input: string): number {
  let h = 1779033703 ^ input.length;
  for (let i = 0; i < input.length; i += 1) {
    h = Math.imul(h ^ input.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

/** mulberry32 — kichik deterministik PRNG. */
export function createRandom(seed: string): () => number {
  let a = hashSeed(seed) || 1;
  return function random(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates, deterministik. Kirish massivi o'zgartirilmaydi. */
export function shuffle<T>(items: readonly T[], seed: string): T[] {
  const random = createRandom(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** `haiku` -> `Model C` kabi ko'r yorliqlar (urug' bo'yicha aralashgan). */
export function blindLabels(candidates: readonly string[], seed: string): Map<string, string> {
  const shuffled = shuffle(candidates, `${seed}:labels`);
  const mapping = new Map<string, string>();
  for (const [index, candidate] of shuffled.entries()) {
    mapping.set(candidate, `Model ${ALPHABET[index % ALPHABET.length] ?? String(index + 1)}`);
  }
  return mapping;
}
