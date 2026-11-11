/**
 * FAQAT HARNESS. Lokal STT muhitini tayyorlaydi: `stt/.venv` + minimal paketlar.
 *
 *   npm run stt:setup              # CPU-only torch (default, ~1 GB kamroq)
 *   npm run stt:setup -- --cuda    # NVIDIA GPU uchun (PyPI torch, CUDA 13)
 *   npm run stt:setup -- --python python3.12
 *
 * Faqat pip paketlari yuklanadi. pyannote (diarizatsiya) O'RNATILMAYDI.
 * Model paketi (vaznlar) avtomatik yuklanMAYDI — README'ga qarang.
 * Versiyalar stt/ da sinalganlari bilan bir xil (torch 2.11.0, transformers 5.18.0).
 */
import './env.js';

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import {
  localSttReadiness,
  MODEL_PACKAGE_HINT,
  missingModelFiles,
  sttRoot,
  sttServeScript,
  sttVenvDir,
  venvPython,
} from './stt-local.js';

/** Sinalgan versiyalar (stt/bench_doniyor.py bilan o'lchangan). */
export const TORCH_PACKAGES = ['torch==2.11.0', 'torchaudio==2.11.0'] as const;
export const OTHER_PACKAGES = [
  'transformers==5.18.0',
  'hydra-core==1.3.8',
  'sentencepiece==0.2.3',
  'soundfile==0.14.0',
  'numpy==2.5.4',
] as const;
export const CPU_TORCH_INDEX = 'https://download.pytorch.org/whl/cpu';

function sh(cmd: string, args: string[], label: string): void {
  console.log(`\n$ ${[cmd, ...args].join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    console.error(`\n[stt:setup] ${label} muvaffaqiyatsiz (${r.error?.message ?? `kod ${r.status}`}).`);
    process.exit(1);
  }
}

function pythonVersion(py: string): [number, number] | null {
  const r = spawnSync(py, ['-c', 'import sys; print(sys.version_info[0], sys.version_info[1])'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const [maj, min] = r.stdout.trim().split(' ').map(Number);
  return maj && min !== undefined ? [maj, min] : null;
}

function main(): void {
  const argv = process.argv.slice(2);
  const cuda = argv.includes('--cuda');
  const pyArg = argv.includes('--python') ? argv[argv.indexOf('--python') + 1] : undefined;
  const python = pyArg ?? (process.platform === 'win32' ? 'python' : 'python3');

  console.log(`Lokal STT muhiti: ${sttRoot}  (torch: ${cuda ? 'CUDA' : 'CPU-only'})`);
  if (!existsSync(sttServeScript)) {
    console.error(`stt/serve.py topilmadi: ${sttServeScript}`);
    process.exit(1);
  }
  const ff = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (ff.error || ff.status !== 0) {
    console.warn("[ogohlantirish] ffmpeg topilmadi — servis audioni o'gira olmaydi (sudo apt install ffmpeg).");
  }

  if (!existsSync(venvPython())) {
    const v = pythonVersion(python);
    if (!v) {
      console.error(`Python topilmadi ("${python}"). Python 3.10+ o'rnating yoki --python <yo'l> bering.`);
      process.exit(1);
    }
    if (v[0] < 3 || (v[0] === 3 && v[1] < 10)) {
      console.error(`Python ${v.join('.')} — kamida 3.10 kerak (--python bilan boshqasini bering).`);
      process.exit(1);
    }
    sh(python, ['-m', 'venv', sttVenvDir], 'venv yaratish');
  } else {
    console.log(`venv bor: ${sttVenvDir}`);
  }

  const py = venvPython();
  sh(py, ['-m', 'pip', 'install', '--upgrade', 'pip'], 'pip yangilash');
  sh(
    py,
    ['-m', 'pip', 'install', ...TORCH_PACKAGES, ...(cuda ? [] : ['--index-url', CPU_TORCH_INDEX])],
    'torch o\'rnatish',
  );
  sh(py, ['-m', 'pip', 'install', ...OTHER_PACKAGES], 'paketlar o\'rnatish');
  sh(
    py,
    ['-c', "import torch, transformers; print('torch', torch.__version__, '| CUDA:', torch.cuda.is_available(), '| transformers', transformers.__version__)"],
    'tekshiruv',
  );
  sh(py, [sttServeScript, '--self-test'], 'serve.py self-test');

  const missing = missingModelFiles();
  if (missing.length > 0) {
    console.warn(`\n${MODEL_PACKAGE_HINT}\n  Yetishmaydi: ${missing.join(', ')}`);
  }
  const { ready } = localSttReadiness();
  console.log(ready ? '\nTayyor. Ishga tushirish: npm run stt:start' : '\nvenv tayyor; model paketini qo\'shgach: npm run stt:start');
}

main();
