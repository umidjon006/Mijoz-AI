/**
 * FAQAT HARNESS (korpus). Skriptlar uchun umumiy qism: fayllar ro'yxati,
 * qabul (ffprobe, kanallar, bo'laklash rejasi), sozlangan OpenAI endpoint,
 * tasdiq so'rash, JSON o'qish/yozish. Loglarda FAQAT id, davomiylik, son va vaqt.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { offerTopic } from '../../../module/backend/src/training/offer-facts.js';
import { resolveBusinessData } from '../business-data.js';
import { envStr } from '../env.js';
import { DEFAULT_OPENAI_BASE_URL, parseSttLanguageMode, type SttLanguageMode } from '../voice/openai.js';
import { analyzeChannels, detectSilences, probe, type ProbeInfo } from './audio.js';
import { audioDir, MAX_CHUNK_SEC } from './paths.js';
import { planChunks, type Interval } from './plan.js';

const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.opus', '.flac', '.aac', '.amr', '.webm']);

export interface CallFile {
  callId: string;
  path: string;
}

export async function listCalls(): Promise<CallFile[]> {
  if (!existsSync(audioDir)) return [];
  return (await readdir(audioDir))
    .filter((name) => AUDIO_EXT.has(extname(name).toLowerCase()))
    .sort()
    .map((name) => ({ callId: name.slice(0, -extname(name).length), path: resolve(audioDir, name) }));
}

export interface IntakeInfo extends CallFile {
  probe: ProbeInfo;
  channels: { separated: boolean; dominantShare: number } | null;
  chunks: Interval[];
}

export function intake(call: CallFile): IntakeInfo {
  const info = probe(call.path);
  const silences = info.durationSec > MAX_CHUNK_SEC ? detectSilences(call.path) : [];
  return {
    ...call,
    probe: info,
    channels: analyzeChannels(call.path, info.channels),
    chunks: planChunks(info.durationSec, silences, MAX_CHUNK_SEC),
  };
}

export interface OpenAiTarget {
  apiKey: string;
  keyEnv: string;
  baseUrl: string;
  languageMode: SttLanguageMode;
  hints: string[];
}

/** Sozlangan OpenAI endpoint (ovoz bilan bir xil). Kalit yo'q bo'lsa `null`. */
export function openAiTarget(): OpenAiTarget | null {
  const keyEnv = envStr('OPENAI_VOICE_KEY_ENV') ?? 'OPENAI_API_KEY';
  const apiKey = envStr(keyEnv);
  if (!apiKey) return null;
  let hints: string[] = [];
  try {
    const profile = resolveBusinessData().profile;
    hints = [...profile.vocabulary, ...profile.primaryOffers.map(offerTopic)].slice(0, 100);
  } catch {
    // profil yo'q — ishorasiz
  }
  return {
    apiKey,
    keyEnv,
    baseUrl: (envStr('OPENAI_BASE_URL') ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, ''),
    languageMode: parseSttLanguageMode(envStr('OPENAI_STT_LANGUAGE_MODE')),
    hints,
  };
}

export async function confirm(question: string): Promise<boolean> {
  if (!input.isTTY) return false;
  const rl = createInterface({ input, output });
  try {
    return ['ha', 'h', 'yes', 'y'].includes((await rl.question(question)).trim().toLowerCase());
  } finally {
    rl.close();
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function readJson<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export const minutes = (sec: number): string => (sec / 60).toFixed(1);

/** Daqiqa narxi env'dan (bo'sh — `null`). */
export function sttPricePerMin(): number | null {
  const v = Number(envStr('OPENAI_STT_PRICE_PER_MIN') ?? NaN);
  return Number.isFinite(v) && v > 0 ? v : null;
}
