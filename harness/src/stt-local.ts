/**
 * FAQAT HARNESS. Lokal STT (Doniyor'ning GigaAM s1 modeli) uchun umumiy yo'llar va
 * tekshiruvlar: `stt:setup`, `stt:start` va `dev` shu moduldan foydalanadi.
 *
 * `stt/` papkasi git'ga KIRMAYDI (katta binary fayllar). Faqat `stt/serve.py`
 * commit qilinadi. Model paketi (~3 GB vazn) Doniyor'ning Google Drive
 * papkasidan qo'lda olinadi — README'ga qarang. Hech narsa avtomatik yuklanmaydi.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { envStr } from './env.js';
import { harnessRoot } from './env.js';
import { DEFAULT_LOCAL_STT_URL, LOCAL_STT_PROVIDER } from './voice/local-stt.js';

export const sttRoot = resolve(harnessRoot, '..', 'stt');
export const sttModelDir = join(sttRoot, 'doniyor-model');
export const sttServeScript = join(sttRoot, 'serve.py');
/** venv: default stt/.venv; STT_VENV bilan boshqa joy (masalan sinov uchun). */
export const sttVenvDir = process.env.STT_VENV?.trim() || join(sttRoot, '.venv');

/** venv ichidagi python (Windows: Scripts\python.exe). */
export function venvPython(venv = sttVenvDir): string {
  return process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python');
}

/** Servis ishlashi uchun KERAKLI fayllar (v1/v5 vaznlari kerak emas). */
export const REQUIRED_MODEL_FILES = [
  'gigaam_local.py',
  'base_model/config.json',
  'base_model/modeling_gigaam.py',
  'base_model/pytorch_model.bin',
  'punct_model/config.json',
  'punct_model/model.safetensors',
  'punct_model/tokenizer.json',
  'weights/gigaam_s1.pt',
] as const;

export function missingModelFiles(dir = sttModelDir): string[] {
  return REQUIRED_MODEL_FILES.filter((f) => !existsSync(join(dir, f)));
}

export function localSttSelected(env: NodeJS.ProcessEnv = process.env): boolean {
  return (envStr('STT_PROVIDER', env) ?? LOCAL_STT_PROVIDER).toLowerCase() === LOCAL_STT_PROVIDER;
}

export function localSttUrl(env: NodeJS.ProcessEnv = process.env): string {
  return envStr('STT_LOCAL_URL', env) ?? DEFAULT_LOCAL_STT_URL;
}

/** Servisga beriladigan env: port URL'dan, qurilma STT_DEVICE dan (auto | cpu | cuda). */
export function serviceEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const port = new URL(localSttUrl(env)).port || '5190';
  return { ...env, STT_PORT: port, STT_DEVICE: envStr('STT_DEVICE', env) ?? 'auto' };
}

export const MODEL_PACKAGE_HINT = [
  "Model paketi topilmadi yoki to'liq emas: stt/doniyor-model/",
  "  1) Doniyor'ning Google Drive'dagi \"package\" papkasini yuklab oling (havolani Doniyor'dan so'rang).",
  "  2) Zip'larni BITTA papkaga oching: stt/doniyor-model/ (ichida base_model/, punct_model/, weights/, gigaam_local.py).",
  '  3) Kerakli vazn faqat weights/gigaam_s1.pt (gigaam_v1.pt / gigaam_v5.pt kerak emas).',
  '  Batafsil: README.md — "Lokal STT (Doniyor modeli)" bo\'limi.',
].join('\n');

/** Hammasi tayyormi (venv + model). Tayyor bo'lmasa — nima yetishmasligi. */
export function localSttReadiness(): { ready: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!existsSync(sttServeScript)) problems.push(`stt/serve.py topilmadi (${sttServeScript})`);
  if (!existsSync(venvPython())) problems.push("stt/.venv yo'q — ishga tushiring: cd harness && npm run stt:setup");
  const missing = missingModelFiles();
  if (missing.length > 0) problems.push(`${MODEL_PACKAGE_HINT}\n  Yetishmaydi: ${missing.join(', ')}`);
  return { ready: problems.length === 0, problems };
}
