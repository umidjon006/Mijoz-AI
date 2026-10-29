/** FAQAT HARNESS. Benchmark matnlari va namuna fayllarini o'qish. */
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const benchmarkDir = resolve(here, '../../benchmark');
export const samplesDir = resolve(benchmarkDir, 'samples');
export const outDir = resolve(benchmarkDir, 'out');

export interface BenchLine {
  /** 1 dan boshlanadigan raqam; `samples/NN.wav` bilan mos keladi. */
  n: number;
  text: string;
}

async function readLines(file: string): Promise<BenchLine[]> {
  const raw = await readFile(file, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((text, i) => ({ n: i + 1, text }));
}

/** Sotuvchi gaplari (STT etaloni). */
export function readSentences(): Promise<BenchLine[]> {
  return readLines(resolve(benchmarkDir, 'sentences.uz.txt'));
}

/** Mijoz javoblari (TTS uchun). */
export function readCustomerLines(): Promise<BenchLine[]> {
  return readLines(resolve(benchmarkDir, 'customer-lines.uz.txt'));
}

export function samplePath(n: number): string {
  return resolve(samplesDir, `${String(n).padStart(2, '0')}.wav`);
}

export async function sampleExists(n: number): Promise<boolean> {
  try {
    const info = await stat(samplePath(n));
    return info.isFile() && info.size > 44;
  } catch {
    return false;
  }
}
