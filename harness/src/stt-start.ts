/**
 * FAQAT HARNESS. Lokal STT servisini ishga tushiradi (stt/serve.py, faqat 127.0.0.1).
 *
 *   npm run stt:start                    # qurilma: STT_DEVICE (auto | cpu | cuda; default auto)
 *   STT_DEVICE=cpu npm run stt:start
 *
 * Servis allaqachon ishlayotgan bo'lsa — shuni aytadi va chiqadi.
 */
import { envStr } from './env.js';

import { spawn } from 'node:child_process';

import { localSttReadiness, localSttUrl, serviceEnv, sttServeScript, venvPython } from './stt-local.js';
import { checkLocalStt } from './voice/local-stt.js';

async function main(): Promise<void> {
  const url = localSttUrl();
  try {
    const h = await checkLocalStt(url, 1_000);
    console.log(`Lokal STT allaqachon ishlayapti: ${url} (${h.model}, qurilma=${h.device})`);
    return;
  } catch {
    // ishlamayapti — ishga tushiramiz
  }
  const { ready, problems } = localSttReadiness();
  if (!ready) {
    console.error(`\nLokal STT ishga tushmaydi:\n- ${problems.join('\n- ')}\n`);
    process.exit(1);
  }
  const env = serviceEnv();
  console.log(`Lokal STT: ${url} · qurilma=${env.STT_DEVICE}${envStr('STT_DEVICE') ? '' : ' (STT_DEVICE bo\'sh)'}`);
  const child = spawn(venvPython(), [sttServeScript], { stdio: 'inherit', env });
  const stop = (): void => {
    if (!child.killed) child.kill('SIGTERM');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => process.exit(code ?? 0));
}

await main();
