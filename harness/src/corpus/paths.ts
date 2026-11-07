/**
 * FAQAT HARNESS (korpus). Fayl joylashuvi. Hammasi `harness/data/real-calls/`
 * ichida va git'da IGNORE qilingan (`.gitignore`).
 */
import { resolve } from 'node:path';

import { harnessRoot } from '../env.js';

export const corpusDir = resolve(harnessRoot, 'data', 'real-calls');
export const audioDir = resolve(corpusDir, 'audio');
export const workDir = resolve(corpusDir, 'work');
export const wavDir = resolve(workDir, 'wav');
export const clipsDir = resolve(corpusDir, 'clips');
export const rawDir = resolve(corpusDir, 'raw');
export const transcriptsDir = resolve(corpusDir, 'transcripts');
export const analysisDir = resolve(corpusDir, 'analysis');

export const rawPath = (model: string, callId: string): string => resolve(rawDir, model, `${callId}.json`);
export const transcriptPath = (model: string, callId: string): string =>
  resolve(transcriptsDir, model, `${callId}.json`);

/** Loglarda ko'rsatiladigan qisqa id (fayl nomining boshi). */
export const shortId = (callId: string): string => callId.slice(0, 6);

/** Solishtiriladigan modellar (topshiriq bo'yicha). */
export const CORPUS_MODELS = ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'gpt-4o-transcribe-diarize'] as const;
export const DIARIZE_MODEL = 'gpt-4o-transcribe-diarize';

/** Bitta so'rovdagi audio chegarasi (sekund) — undan uzun fayl jimlikda bo'linadi. */
export const MAX_CHUNK_SEC = 600;
