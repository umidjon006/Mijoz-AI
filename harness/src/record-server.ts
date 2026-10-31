/**
 * FAQAT HARNESS. `harness/web/record.html` ni servis qiladi va brauzerdan
 * kelgan WAV'ni `harness/benchmark/samples/NN.wav` ga yozadi.
 *
 *   npm run bench:record        (keyin http://127.0.0.1:5174 ni Chrome'da ochish)
 *
 * Faqat localhost'da tinglaydi. Audio shu papkadan tashqariga chiqmaydi va
 * hech qanday provayderga yuborilmaydi (uni `bench-stt` keyin o'zi yuboradi).
 */
// ENG BIRINCHI: harness/.env ni yuklaydi (yo'l harness papkasiga nisbatan).
import './env.js';

import { createServer } from 'node:http';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkWav, parseWav } from '../../module/backend/src/training/voice/wav.js';
import { readSentences } from './voice/benchmark-data.js';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, '../web');
const samplesDir = resolve(here, '../benchmark/samples');

const PORT = Number(process.env.BENCH_PORT ?? 5174);

async function savedSampleNumbers(): Promise<number[]> {
  try {
    const files = await readdir(samplesDir);
    return files
      .filter((f) => /^\d+\.wav$/.test(f))
      .map((f) => Number(f.replace('.wav', '')))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/record.html')) {
        const html = await readFile(resolve(webDir, 'record.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/sentences') {
        const sentences = await readSentences();
        const saved = await savedSampleNumbers();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ sentences, saved }));
        return;
      }

      const saveMatch = /^\/api\/samples\/(\d{1,3})$/.exec(url.pathname);
      if (req.method === 'POST' && saveMatch) {
        const n = Number(saveMatch[1]);
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const buf = chunk as Buffer;
          size += buf.length;
          if (size > 8 * 1024 * 1024) {
            res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('juda katta');
            return;
          }
          chunks.push(buf);
        }
        const audio = Buffer.concat(chunks);

        const problem = checkWav(audio);
        if (problem && problem.code === 'bad_format') {
          res.writeHead(415, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(`format mos emas: ${problem.message}`);
          return;
        }

        await mkdir(samplesDir, { recursive: true });
        const file = resolve(samplesDir, `${String(n).padStart(2, '0')}.wav`);
        await writeFile(file, audio);
        const info = parseWav(audio);
        console.log(
          `saqlandi ${String(n).padStart(2, '0')}.wav  ${info.durationSec.toFixed(1)}s  ` +
            `${info.sampleRate}Hz  ${(audio.length / 1024).toFixed(0)}KB`,
        );
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, durationSec: info.durationSec }));
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('topilmadi');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[record-server]', message);
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(message);
    }
  })();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nYozib olish sahifasi: http://127.0.0.1:${PORT}`);
  console.log(`Fayllar: ${samplesDir}`);
  console.log('Chrome (desktop) da oching, QULOQCHIN kiyib oling. Chiqish: Ctrl+C\n');
});
