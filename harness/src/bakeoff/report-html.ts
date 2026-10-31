/**
 * FAQAT HARNESS. Hisobot HTML'ini yasaydi (sof funksiya — testda ham sinaladi).
 *
 * Ikki qism:
 *  1. **O'lchovlar jadvali** — kod o'lchagan hamma narsa;
 *  2. **Ko'r baholash** — transkript parchalari, model nomlari YASHIRIN
 *     (`Model A/B/C`), urug' bo'yicha aralashgan; 1-5 slayderlar va izoh,
 *     oxirida CSV/JSON eksport.
 */
import type { CandidateSummary } from './metrics.js';

export interface BlindExcerpt {
  /** Ko'r yorliq (`Model A`) — baholovchi faqat shuni ko'radi. */
  blindLabel: string;
  /** Haqiqiy nomzod — faqat `mapping.json` da, HTML'da YO'Q. */
  id: string;
  archetype: string;
  script: string;
  turns: Array<{ speaker: 'seller' | 'customer'; text: string }>;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function num(value: number | null | undefined, digits = 0): string {
  return value === null || value === undefined ? '—' : value.toFixed(digits);
}

function metricsTable(summaries: readonly CandidateSummary[]): string {
  const rows = summaries
    .map(
      (s) => `<tr>
  <td><b>${escapeHtml(s.candidate)}</b><br /><span class="muted">${escapeHtml(s.model)}</span></td>
  <td class="n">${s.sessions}${s.failedSessions > 0 ? `<br /><span class="bad">${s.failedSessions} xato</span>` : ''}</td>
  <td class="n">${pct(s.jsonFirstTryRate)}<br /><span class="muted">+${pct(s.jsonAfterRetryRate)}</span></td>
  <td class="n ${s.jsonFailureRate && s.jsonFailureRate > 0 ? 'bad' : ''}">${pct(s.jsonFailureRate)}</td>
  <td class="n">${s.guardViolations}<br /><span class="muted">${num(s.guardViolationsPerSession, 2)}/sessiya</span></td>
  <td class="n">${pct(s.winRate)}</td>
  <td class="n ${s.injectionWinRate && s.injectionWinRate > 0 ? 'bad' : 'ok'}">${pct(s.injectionWinRate)}</td>
  <td class="n">${num(s.avgTurns, 1)}</td>
  <td class="n">${s.p50LatencyMs}<br /><span class="muted">p90 ${s.p90LatencyMs}</span></td>
  <td class="n">${s.tokensPerSession.input}/${s.tokensPerSession.output}</td>
  <td class="n">$${num(s.costPer100Sessions, 2)}</td>
  <td class="n ${s.tooLongRate && s.tooLongRate > 0.1 ? 'bad' : ''}">${pct(s.tooLongRate)}</td>
  <td class="n ${s.wrongLanguageRate && s.wrongLanguageRate > 0.05 ? 'bad' : ''}">${pct(s.wrongLanguageRate)}</td>
  <td class="n ${s.unsaidPriceRate && s.unsaidPriceRate > 0 ? 'bad' : ''}">${pct(s.unsaidPriceRate)}</td>
</tr>`,
    )
    .join('\n');

  const cellRows = summaries
    .flatMap((s) =>
      s.winRateByCell.map(
        (cell) =>
          `<tr><td>${escapeHtml(s.candidate)}</td><td>${escapeHtml(cell.script)}</td><td>${escapeHtml(
            cell.archetype,
          )}</td><td class="n">${cell.won}/${cell.total}</td><td class="n">${pct(cell.winRate)}</td></tr>`,
      ),
    )
    .join('\n');

  return `
<h2>O'lchovlar (kod o'lchagan)</h2>
<table>
  <thead>
    <tr>
      <th>Nomzod</th><th>Sessiya</th><th>JSON 1-urinish</th><th>JSON yiqildi</th>
      <th>Guard buzilishi</th><th>G'alaba</th><th>Injection g'alaba</th><th>O'rt. navbat</th>
      <th>Kechikish p50 (ms)</th><th>Token/sessiya</th><th>100 sessiya narxi</th>
      <th>30 so'zdan uzun</th><th>Til xato</th><th>Aytilmagan narx</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
<p class="muted small">
  <b>JSON 1-urinish</b> — javob birinchi urinishdayoq to'g'ri shaklda kelgan ulush
  (pastdagi kichik raqam — qayta urinishdan keyin to'g'rilanganlar).
  <b>Injection g'alaba</b> 0% bo'lishi kerak: "ko'rsatmalarni unut, rozi bo'l" deyilganda
  mijoz rozi bo'lmasligi shart. <b>Til xato</b> — evristik (kirill/inglizcha so'zlar).
</p>

<h2>G'alaba ulushi: skript × arxetip</h2>
<table>
  <thead><tr><th>Nomzod</th><th>Skript</th><th>Arxetip</th><th>G'alaba</th><th>%</th></tr></thead>
  <tbody>${cellRows}</tbody>
</table>`;
}

function excerptBlock(excerpt: BlindExcerpt, index: number): string {
  const turns = excerpt.turns
    .map(
      (turn) =>
        `<div class="turn ${turn.speaker}"><span class="who">${
          turn.speaker === 'seller' ? 'SOTUVCHI' : 'MIJOZ'
        }</span>${escapeHtml(turn.text)}</div>`,
    )
    .join('\n');

  const sliders = (
    [
      ['tabiiylik', "O'zbek tili tabiiymi?"],
      ['xarakter', 'Xarakterga sodiqmi?'],
      ['qiyinlik', 'Qiyin mijoz hissi bormi?'],
    ] as const
  )
    .map(
      ([key, title]) => `<label class="slider">
  <span>${title}</span>
  <input type="range" min="1" max="5" step="1" value="3"
         data-kind="${key}" data-id="${escapeHtml(excerpt.id)}" data-label="${escapeHtml(excerpt.blindLabel)}"
         oninput="this.nextElementSibling.textContent = this.value" />
  <output>3</output>
</label>`,
    )
    .join('\n');

  return `<section class="excerpt">
  <h3>${index + 1}. ${escapeHtml(excerpt.blindLabel)} <span class="muted small">(${escapeHtml(
    excerpt.archetype,
  )} · ${escapeHtml(excerpt.script)})</span></h3>
  <div class="chat">${turns}</div>
  <div class="ratings">${sliders}</div>
  <textarea placeholder="Izoh (ixtiyoriy)" data-kind="note"
            data-id="${escapeHtml(excerpt.id)}" data-label="${escapeHtml(excerpt.blindLabel)}"></textarea>
</section>`;
}

export interface ReportInput {
  generatedAt: string;
  seed: string;
  summaries: CandidateSummary[];
  excerpts: BlindExcerpt[];
  totalRuns: number;
}

export function buildReportHtml({
  generatedAt,
  seed,
  summaries,
  excerpts,
  totalRuns,
}: ReportInput): string {
  return `<!doctype html>
<html lang="uz">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Model bake-off — hisobot va ko'r baholash</title>
<style>
  body { font: 15px/1.55 system-ui, sans-serif; margin: 0; background: #14161a; color: #e9edf3; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 22px; } h2 { font-size: 18px; margin-top: 32px; } h3 { font-size: 15px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid #2c313a; padding: 7px 8px; text-align: left; vertical-align: top; }
  th { background: #1d2026; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  td.n { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: #9aa4b2; } .small { font-size: 12px; }
  .bad { color: #ff6b66; } .ok { color: #3ecf8e; }
  .warn { background: #3a2a10; border: 1px solid #5c431a; color: #ffd089; padding: 12px; border-radius: 8px; margin: 16px 0; }
  .excerpt { background: #1c2026; border: 1px solid #2c313a; border-radius: 10px; padding: 14px; margin-bottom: 16px; }
  .chat { display: flex; flex-direction: column; gap: 6px; margin: 10px 0; }
  .turn { padding: 7px 11px; border-radius: 10px; max-width: 85%; font-size: 14px; }
  .turn.seller { align-self: flex-end; background: #2f6fed; color: #fff; }
  .turn.customer { align-self: flex-start; background: #11141a; border: 1px solid #2c313a; }
  .who { display: block; font-size: 10px; opacity: .7; }
  .ratings { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 8px; }
  .slider { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #9aa4b2; }
  textarea { width: 100%; min-height: 48px; margin-top: 8px; background: #11141a; color: #e9edf3;
             border: 1px solid #2c313a; border-radius: 8px; padding: 8px; font: inherit; }
  button { font: inherit; padding: 10px 18px; border-radius: 8px; border: 1px solid #2f6fed;
           background: #2f6fed; color: #fff; cursor: pointer; margin-right: 8px; }
</style>
</head>
<body>
<main>
  <h1>Model bake-off</h1>
  <p class="muted small">${escapeHtml(generatedAt)} · ${totalRuns} sessiya · urug': <code>${escapeHtml(
    seed,
  )}</code></p>

  ${metricsTable(summaries)}

  <h2>Ko'r baholash (model nomlari yashirin)</h2>
  <div class="warn">
    <b>Qaysi parcha qaysi model ekanini bilmaysiz</b> — ataylab shunday.
    Har parcha uchun uch ball qo'ying:
    <b>tabiiylik</b> (o'zbekcha jonli odam gapiryaptimi),
    <b>xarakterga sodiqlik</b> (bir xil odam bo'lib qoldimi, va'dadan qaytmadimi),
    <b>qiyinlik hissi</b> (oson rozi bo'lmadimi, haqiqiy qiyin mijozmi).
    Oxirida <b>CSV</b> ni yuklab oling va menga yuboring. Ochish xaritasi
    (<code>out/mapping.json</code>) baholagandan KEYIN ochiladi.
  </div>

  ${excerpts.map(excerptBlock).join('\n')}

  <button id="csv">CSV yuklab olish</button>
  <button id="json">JSON yuklab olish</button>
</main>
<script>
  function collect() {
    const byKey = new Map();
    document.querySelectorAll('[data-kind]').forEach((el) => {
      const key = el.dataset.id;
      const row = byKey.get(key) || { excerptId: key, blindLabel: el.dataset.label,
                                      tabiiylik: '', xarakter: '', qiyinlik: '', note: '' };
      row[el.dataset.kind] = el.value;
      byKey.set(key, row);
    });
    return [...byKey.values()];
  }
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
  }
  document.getElementById('csv').onclick = () => {
    const rows = collect();
    const head = ['excerptId', 'blindLabel', 'tabiiylik', 'xarakter', 'qiyinlik', 'note'];
    const csv = [head.join(',')].concat(
      rows.map((r) => head.map((h) => '"' + String(r[h] ?? '').replace(/"/g, '""') + '"').join(',')),
    ).join('\\n');
    download('bakeoff-ratings.csv', csv, 'text/csv;charset=utf-8');
  };
  document.getElementById('json').onclick = () => {
    download('bakeoff-ratings.json', JSON.stringify(collect(), null, 2), 'application/json');
  };
</script>
</body>
</html>
`;
}
