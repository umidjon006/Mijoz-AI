/**
 * FAQAT HARNESS. TTS benchmark: har provayder × ovoz × yozuv (lotin/kirill)
 * uchun mijoz gaplarini sintez qiladi, kechikishni o'lchaydi, audio fayllarni
 * saqlaydi va tinglab baholash sahifasini (`out/listen.html`) yasaydi.
 *
 *   npm run bench:tts -- [--providers azure,google] [--voices azure:uz-UZ-MadinaNeural]
 *                        [--scripts latin,cyrillic] [--limit 4] [--yes]
 *
 * MUHIM: ovoz sifatini MEN BAHOLAY OLMAYMAN (audio eshitmayman). Shuning
 * uchun skript faqat o'lchaydi va baholash sahifasini yasaydi — tabiiylik va
 * raqamlarning tushunarliligini ODAM 1–5 ball bilan baholaydi.
 */
// ENG BIRINCHI: harness/.env ni yuklaydi (yo'l harness papkasiga nisbatan).
import './env.js';

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import type { TtsResult } from '../../module/backend/src/training/voice/ports.js';
import { outDir, readCustomerLines, type BenchLine } from './voice/benchmark-data.js';
import { applyScript, type Script } from './voice/locales.js';
import { mean, median, percentile } from './voice/text-metrics.js';
import {
  availableTtsProviders,
  missingKeysHint,
  PRICE_HINTS,
  type ProviderId,
} from './voice/registry.js';

interface Args {
  providers?: ProviderId[];
  voicesByProvider: Partial<Record<ProviderId, string[]>>;
  scripts: Script[];
  limit?: number;
  yes: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const providersRaw = get('providers');
  const voicesRaw = get('voices');
  const scriptsRaw = get('scripts');
  const limitRaw = get('limit');

  const voicesByProvider: Partial<Record<ProviderId, string[]>> = {};
  if (voicesRaw) {
    for (const entry of voicesRaw.split(',')) {
      const [provider, voice] = entry.split(':');
      if (!provider || !voice) continue;
      const id = provider.trim() as ProviderId;
      voicesByProvider[id] = [...(voicesByProvider[id] ?? []), voice.trim()];
    }
  }

  const scripts = (scriptsRaw ? scriptsRaw.split(',') : ['latin'])
    .map((s) => s.trim())
    .filter((s): s is Script => s === 'latin' || s === 'cyrillic');

  return {
    ...(providersRaw
      ? { providers: providersRaw.split(',').map((p) => p.trim()) as ProviderId[] }
      : {}),
    voicesByProvider,
    scripts: scripts.length > 0 ? scripts : ['latin'],
    ...(limitRaw ? { limit: Number(limitRaw) } : {}),
    yes: argv.includes('--yes'),
  };
}

/** `out/voices.json` dan (bench:voices natijasidan) ovoz nomlarini oladi. */
async function voicesFromReport(): Promise<Partial<Record<ProviderId, string[]>>> {
  try {
    const raw = await readFile(resolve(outDir, 'voices.json'), 'utf8');
    const json = JSON.parse(raw) as {
      azure?: { uzbek?: Array<{ ShortName?: string }> };
      google?: { uzbek?: Array<{ name?: string }> };
    };
    const out: Partial<Record<ProviderId, string[]>> = {};
    const azure = (json.azure?.uzbek ?? [])
      .map((v) => v.ShortName)
      .filter((v): v is string => typeof v === 'string');
    const google = (json.google?.uzbek ?? [])
      .map((v) => v.name)
      .filter((v): v is string => typeof v === 'string');
    if (azure.length > 0) out.azure = azure;
    if (google.length > 0) out.google = google;
    return out;
  } catch {
    return {};
  }
}

export interface ClipResult {
  provider: ProviderId;
  voice: string;
  script: Script;
  n: number;
  text: string;
  spokenText: string;
  file?: string;
  mime?: string;
  bytes?: number;
  latencyMs: number;
  firstByteMs?: number;
  error?: string;
}

function extFor(mime: string): string {
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('ogg')) return 'ogg';
  return 'bin';
}

export function buildListenHtml(clips: ClipResult[], lines: BenchLine[]): string {
  const ok = clips.filter((c) => !c.error && c.file);
  const groups = new Map<string, ClipResult[]>();
  for (const clip of ok) {
    const key = `${clip.provider}|${clip.voice}|${clip.script}`;
    groups.set(key, [...(groups.get(key) ?? []), clip]);
  }
  const columns = [...groups.keys()];

  const rows = lines
    .filter((line) => ok.some((c) => c.n === line.n))
    .map((line) => {
      const cells = columns
        .map((key) => {
          const clip = (groups.get(key) ?? []).find((c) => c.n === line.n);
          if (!clip?.file) return '<td class="muted">—</td>';
          const id = `${key.replace(/\|/g, '_')}_${line.n}`;
          return `<td>
            <audio controls preload="none" src="${clip.file}"></audio>
            <div class="meta">${clip.latencyMs} ms${
              clip.firstByteMs !== undefined ? ` · 1-bayt ${clip.firstByteMs} ms` : ''
            }</div>
            <label>tabiiylik
              <select data-kind="natural" data-col="${key}" data-n="${line.n}" id="nat_${id}">
                <option value=""></option>${[1, 2, 3, 4, 5]
                  .map((v) => `<option value="${v}">${v}</option>`)
                  .join('')}
              </select>
            </label>
            <label>raqamlar
              <select data-kind="numbers" data-col="${key}" data-n="${line.n}" id="num_${id}">
                <option value=""></option>${[1, 2, 3, 4, 5]
                  .map((v) => `<option value="${v}">${v}</option>`)
                  .join('')}
              </select>
            </label>
          </td>`;
        })
        .join('');
      return `<tr><td class="line"><b>${String(line.n).padStart(2, '0')}</b><br />${line.text}</td>${cells}</tr>`;
    })
    .join('\n');

  const head = columns
    .map((key) => {
      const [provider, voice, script] = key.split('|');
      return `<th>${provider}<br /><span class="muted">${voice}</span><br /><span class="muted">${script}</span></th>`;
    })
    .join('');

  return `<!doctype html>
<html lang="uz">
<head>
<meta charset="utf-8" />
<title>TTS tinglash va baholash</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 24px; background:#14161a; color:#e9edf3; }
  h1 { font-size: 20px; }
  .warn { background:#3a2a10; border:1px solid #5c431a; color:#ffd089; padding:10px 12px; border-radius:8px; margin:12px 0; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #2c313a; padding: 8px; vertical-align: top; font-size: 13px; }
  th { background: #1d2026; position: sticky; top: 0; }
  td.line { max-width: 280px; }
  .muted { color: #9aa4b2; font-weight: normal; }
  .meta { color: #9aa4b2; font-size: 12px; margin: 4px 0; }
  audio { width: 220px; }
  label { display: block; font-size: 12px; color:#9aa4b2; margin-top: 4px; }
  select { font: inherit; background:#262b33; color:#e9edf3; border:1px solid #2c313a; border-radius:6px; }
  button { font: inherit; padding: 10px 16px; border-radius: 8px; border: 1px solid #4f8cff; background:#4f8cff; color:#fff; cursor:pointer; margin: 16px 0; }
</style>
</head>
<body>
<h1>TTS tinglash va baholash</h1>
<div class="warn">
  <b>Quloqchin kiyib tinglang.</b> Har klip uchun ikki ball qo'ying:
  <b>tabiiylik</b> (1 = robot, 5 = tabiiy odam) va <b>raqamlar</b>
  (1 = raqam/narx tushunarsiz, 5 = to'liq tushunarli).
  Baholaganingizdan keyin "CSV yuklab olish" ni bosing va faylni menga yuboring.
</div>
<button id="export">CSV yuklab olish</button>
<table>
<thead><tr><th>Gap</th>${head}</tr></thead>
<tbody>
${rows}
</tbody>
</table>
<button id="export2">CSV yuklab olish</button>
<script>
  function exportCsv() {
    const rows = [['provider','voice','script','line','kind','score']];
    document.querySelectorAll('select[data-kind]').forEach((sel) => {
      if (!sel.value) return;
      const [provider, voice, script] = sel.dataset.col.split('|');
      rows.push([provider, voice, script, sel.dataset.n, sel.dataset.kind, sel.value]);
    });
    const csv = rows.map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tts-ratings.csv';
    a.click();
  }
  document.getElementById('export').onclick = exportCsv;
  document.getElementById('export2').onclick = exportCsv;
</script>
</body>
</html>
`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  for (const hint of missingKeysHint()) console.log(`[eslatma] ${hint}`);

  const fromReport = await voicesFromReport();
  const voicesByProvider: Partial<Record<ProviderId, string[]>> = {
    ...fromReport,
    ...args.voicesByProvider,
  };

  const providers = availableTtsProviders({
    ...(args.providers ? { only: args.providers } : {}),
    voicesByProvider,
  });
  if (providers.length === 0) {
    console.error('\nHech qanday TTS provayderi mavjud emas (kalitlar yo\'q).');
    process.exit(1);
  }

  const withoutVoices = providers.filter((p) => p.voices.length === 0);
  if (withoutVoices.length > 0) {
    console.log(
      `\n[eslatma] ${withoutVoices
        .map((p) => p.id)
        .join(', ')} uchun ovoz nomi berilmagan. Avval \`npm run bench:voices\` ni ` +
        'ishga tushiring yoki --voices bilan qo\'lda ko\'rsating.',
    );
  }

  const allLines = await readCustomerLines();
  const lines = args.limit ? allLines.slice(0, args.limit) : allLines;

  const tasks: Array<{ provider: (typeof providers)[number]; voice: string; script: Script }> = [];
  for (const provider of providers) {
    for (const voice of provider.voices) {
      for (const script of args.scripts) {
        tasks.push({ provider, voice, script });
      }
    }
  }

  if (tasks.length === 0) {
    console.error('\nSinaladigan ovoz yo\'q — to\'xtatildi.');
    process.exit(1);
  }

  const totalChars = lines.reduce((sum, line) => sum + line.text.length, 0) * tasks.length;
  console.log(
    `\nGaplar: ${lines.length}, ovoz/yozuv kombinatsiyalari: ${tasks.length}, ` +
      `jami ${lines.length * tasks.length} klip, ~${totalChars} belgi`,
  );
  let estCost = 0;
  for (const provider of providers) {
    const providerTasks = tasks.filter((t) => t.provider.id === provider.id).length;
    const chars = lines.reduce((s, l) => s + l.text.length, 0) * providerTasks;
    const cost = (chars / 1_000_000) * (PRICE_HINTS.ttsPerMillionChars[provider.id] ?? 0);
    estCost += cost;
    console.log(`  ${provider.id}: ${chars} belgi ~$${cost.toFixed(4)} (taxminiy)`);
  }
  console.log(`Taxminiy jami: ~$${estCost.toFixed(4)}`);

  if (!args.yes) {
    const rl = createInterface({ input, output });
    const answer = (await rl.question('Davom etamizmi? (yes/no) ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'yes' && answer !== 'y') {
      console.log('Bekor qilindi.');
      return;
    }
  }

  const clips: ClipResult[] = [];

  for (const task of tasks) {
    console.log(`\n=== ${task.provider.id} / ${task.voice} / ${task.script} ===`);
    const dir = resolve(outDir, 'tts', task.provider.id, `${task.voice}__${task.script}`);
    await mkdir(dir, { recursive: true });

    for (const line of lines) {
      const spokenText = applyScript(line.text, task.script);
      try {
        const result: TtsResult = await task.provider.port.synthesize({
          text: spokenText,
          lang: 'uz',
          voice: task.voice,
        });
        const ext = extFor(result.mime);
        const name = `${String(line.n).padStart(2, '0')}.${ext}`;
        await writeFile(resolve(dir, name), result.audio);
        const rel = `tts/${task.provider.id}/${task.voice}__${task.script}/${name}`;

        clips.push({
          provider: task.provider.id,
          voice: task.voice,
          script: task.script,
          n: line.n,
          text: line.text,
          spokenText,
          file: rel,
          mime: result.mime,
          bytes: result.audio.length,
          latencyMs: result.latencyMs,
          ...(result.firstByteMs !== undefined ? { firstByteMs: result.firstByteMs } : {}),
        });
        console.log(
          `  ${String(line.n).padStart(2, '0')}  ${String(result.latencyMs).padStart(5)}ms` +
            `${result.firstByteMs !== undefined ? `  1-bayt ${String(result.firstByteMs).padStart(5)}ms` : ''}` +
            `  ${(result.audio.length / 1024).toFixed(0)}KB`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        clips.push({
          provider: task.provider.id,
          voice: task.voice,
          script: task.script,
          n: line.n,
          text: line.text,
          spokenText,
          latencyMs: 0,
          error: message,
        });
        console.log(`  ${String(line.n).padStart(2, '0')}  XATO: ${message}`);
      }
    }
  }

  console.log('\n================ KECHIKISH ================');
  console.log('provayder/ovoz/yozuv                     n   lat(med)  lat(p90)  1-bayt(med)');
  for (const task of tasks) {
    const own = clips.filter(
      (c) =>
        c.provider === task.provider.id &&
        c.voice === task.voice &&
        c.script === task.script &&
        !c.error,
    );
    if (own.length === 0) continue;
    const firstBytes = own.map((c) => c.firstByteMs).filter((v): v is number => v !== undefined);
    const key = `${task.provider.id}/${task.voice}/${task.script}`;
    console.log(
      `${key.padEnd(40).slice(0, 40)} ${String(own.length).padStart(2)}   ` +
        `${String(Math.round(median(own.map((c) => c.latencyMs)))).padStart(6)}ms  ` +
        `${String(Math.round(percentile(own.map((c) => c.latencyMs), 90))).padStart(6)}ms  ` +
        `${firstBytes.length > 0 ? `${String(Math.round(median(firstBytes))).padStart(8)}ms` : '       -'}`,
    );
  }

  const okClips = clips.filter((c) => !c.error);
  await writeFile(
    resolve(outDir, 'tts-results.json'),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        clips,
        latencyOverall: {
          medianMs: Math.round(median(okClips.map((c) => c.latencyMs))),
          meanMs: Math.round(mean(okClips.map((c) => c.latencyMs))),
          p90Ms: Math.round(percentile(okClips.map((c) => c.latencyMs), 90)),
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const listen = resolve(outDir, 'listen.html');
  await writeFile(listen, buildListenHtml(clips, lines), 'utf8');

  console.log(`\nNatija: ${resolve(outDir, 'tts-results.json')}`);
  console.log(`Tinglash sahifasi: ${listen}`);
  console.log(
    '\nOVOZ SIFATINI MEN BAHOLAY OLMAYMAN (audio eshitmayman). ' +
      'listen.html ni brauzerda ochib, har klipga tabiiylik va raqamlar bo\'yicha ' +
      '1-5 ball qo\'ying, CSV ni yuklab olib menga yuboring.',
  );
}

// Faqat to'g'ridan-to'g'ri ishga tushirilganda bajariladi — shunda
// `buildListenHtml` ni testdan import qilish mumkin bo'ladi.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
