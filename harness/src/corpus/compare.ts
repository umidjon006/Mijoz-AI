/**
 * FAQAT HARNESS (korpus). STT solishtirish — SOF funksiyalar: modellar
 * kelishuvi, tinglash oynasi matni, o'zi yetarli (offline) HTML sahifa va
 * baholar CSV'ini o'qish.
 *
 * "Kelishuv" aniqlik EMAS: qaysi model to'g'riroq ekanini faqat foydalanuvchi
 * tinglab qo'ygan baho aytadi.
 */
import { lowQualityShare } from './transcript.js';
import { wordSimilarity } from './text.js';
import type { ModelTranscript } from './types.js';

export interface ModelCallMetrics {
  callId: string;
  model: string;
  ok: boolean;
  /** Boshqa modellar matni bilan o'rtacha so'z o'xshashligi (0..1). */
  agreement: number | null;
  lowQualityShare: number | null;
  segments: number;
  speakerLabels: boolean;
  latencyMs: number | null;
  error?: string;
}

export function compareCall(
  callId: string,
  transcripts: ReadonlyArray<{ model: string; transcript: ModelTranscript | null; error?: string }>,
): ModelCallMetrics[] {
  const ok = transcripts.filter((t) => t.transcript !== null && t.transcript.text.length > 0);
  return transcripts.map((entry) => {
    const t = entry.transcript;
    if (!t || t.text.length === 0) {
      return {
        callId, model: entry.model, ok: false, agreement: null, lowQualityShare: null,
        segments: 0, speakerLabels: false, latencyMs: null, ...(entry.error ? { error: entry.error } : {}),
      };
    }
    const others = ok.filter((o) => o.model !== entry.model);
    const agreement =
      others.length === 0
        ? null
        : Number((others.reduce((s, o) => s + wordSimilarity(t.text, o.transcript!.text), 0) / others.length).toFixed(3));
    return {
      callId,
      model: entry.model,
      ok: true,
      agreement,
      lowQualityShare: Number(lowQualityShare(t).toFixed(3)),
      segments: t.segments.length,
      speakerLabels: t.hasSpeakerLabels,
      latencyMs: t.latencyMs,
    };
  });
}

/** Tinglash oynasi: ~60 s, qo'ng'iroqning 20% idan (qisqa bo'lsa boshidan). */
export function listeningWindow(durationSec: number, windowSec = 60): { start: number; end: number } {
  if (durationSec <= windowSec) return { start: 0, end: Number(durationSec.toFixed(2)) };
  const start = Math.min(durationSec * 0.2, durationSec - windowSec);
  return { start: Number(start.toFixed(2)), end: Number((start + windowSec).toFixed(2)) };
}

/**
 * Oynaga tushgan matn. Vaqt belgisi bo'lsa — aniq segmentlar; bo'lmasa —
 * matn uzunligiga mutanosib taxminiy kesim (so'z chegarasida), `approx: true`.
 */
export function windowText(t: ModelTranscript, window: { start: number; end: number }): { text: string; approx: boolean } {
  if (t.hasTimestamps) {
    const inside = t.segments.filter(
      (s) => s.start !== undefined && s.end !== undefined && s.end > window.start && s.start < window.end,
    );
    return {
      text: inside.map((s) => (s.speaker ? `[${s.speaker}] ${s.display}` : s.display)).join('\n'),
      approx: false,
    };
  }
  const full = t.segments.map((s) => s.display).join(' ');
  if (t.durationSec <= 0 || full.length === 0) return { text: full, approx: true };
  const from = Math.floor((window.start / t.durationSec) * full.length);
  const to = Math.ceil((window.end / t.durationSec) * full.length);
  const startAt = from === 0 ? 0 : full.indexOf(' ', from) + 1;
  const endSpace = full.indexOf(' ', to);
  const endAt = endSpace === -1 ? full.length : endSpace;
  return { text: full.slice(Math.max(0, startAt), endAt).trim(), approx: true };
}

/** Deterministik aralashtirish (har qo'ng'iroq uchun bir xil — sahifa qayta yasalsa ham). */
export function seededOrder<T>(items: readonly T[], seed: string): T[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface ComparePageCall {
  callId: string;
  label: string;
  /** Sahifaga nisbatan LOKAL yo'l (masalan `clips/<id>.mp3`). */
  clipPath: string;
  window: { start: number; end: number };
  variants: Array<{ model: string; text: string; approx: boolean; error?: string }>;
}

/** O'zi yetarli (tashqi resurssiz) HTML: tinglash, ko'r baholash, CSV eksport. */
export function buildComparePage(calls: readonly ComparePageCall[]): string {
  const sections = calls
    .map((call) => {
      const variants = seededOrder(call.variants, call.callId)
        .map(
          (v, i) => `
      <div class="variant">
        <div class="vhead"><b>Variant ${i + 1}</b>
          <details><summary>model</summary><code>${esc(v.model)}</code></details></div>
        ${v.error ? `<p class="err">Xato: ${esc(v.error)}</p>` : `<pre>${esc(v.text) || '<i>(bo\'sh)</i>'}</pre>`}
        ${v.approx && !v.error ? '<p class="note">Vaqt belgisi yo\'q — oyna matni taxminiy.</p>' : ''}
        <label>Matn qanchalik to'g'ri:
          <select data-call="${esc(call.callId)}" data-model="${esc(v.model)}">
            <option value="">—</option>${[1, 2, 3, 4, 5].map((n) => `<option>${n}</option>`).join('')}
          </select></label>
      </div>`,
        )
        .join('');
      return `
  <section>
    <h2>${esc(call.label)} <span class="muted">(${call.window.start.toFixed(0)}–${call.window.end.toFixed(0)} s)</span></h2>
    <audio controls preload="none" src="${esc(call.clipPath)}"></audio>
    <div class="grid">${variants}</div>
  </section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="uz"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>STT solishtirish</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--muted:#6b6b6b;--line:#ddd;--card:#f7f7f8}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--muted:#9a9a9a;--line:#333;--card:#1e1e1e}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1200px;padding:16px}
section{border-top:1px solid var(--line);padding:12px 0}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));margin-top:8px}
.variant{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px}
.vhead{display:flex;justify-content:space-between;align-items:center}
pre{white-space:pre-wrap;font:inherit;margin:8px 0}
.muted,.note{color:var(--muted);font-size:13px}.err{color:#c0392b}
audio{width:100%}button{padding:8px 14px;font:inherit}
</style></head><body>
<h1>STT solishtirish — tinglang va baholang</h1>
<p class="muted">Har qo'ng'iroqdan ~60 soniya. Variantlar tartibi aralashtirilgan, model nomi yashirin (ko'r baholash).
Har variant uchun 1–5 baho qo'ying va CSV'ni yuklab oling. Sahifa faqat shu kompyuterda — hech qayerga yuborilmaydi.</p>
<p><button id="export">Baholarni CSV qilib yuklash</button> <span id="count" class="muted"></span></p>
${sections}
<script>
(function(){
  var sel=document.querySelectorAll('select[data-call]');
  function key(s){return 'stt-rating:'+s.dataset.call+':'+s.dataset.model;}
  function update(){var n=0;sel.forEach(function(s){if(s.value)n++;});document.getElementById('count').textContent=n+' / '+sel.length+' baholandi';}
  sel.forEach(function(s){try{var v=localStorage.getItem(key(s));if(v)s.value=v;}catch(e){}
    s.addEventListener('change',function(){try{localStorage.setItem(key(s),s.value);}catch(e){}update();});});
  update();
  document.getElementById('export').addEventListener('click',function(){
    var rows=['call_id,model,rating'];
    sel.forEach(function(s){if(s.value)rows.push(s.dataset.call+','+s.dataset.model+','+s.value);});
    var a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([rows.join('\\n')+'\\n'],{type:'text/csv'}));
    a.download='stt-ratings.csv';a.click();
  });
})();
</script>
</body></html>
`;
}

/** `call_id,model,rating` CSV -> baholar (noto'g'ri qatorlar tashlanadi). */
export function parseRatingsCsv(csv: string): Array<{ callId: string; model: string; rating: number }> {
  return csv
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(',').map((c) => c.trim()))
    .filter((cols) => cols.length >= 3)
    .map(([callId, model, rating]) => ({ callId: callId as string, model: model as string, rating: Number(rating) }))
    .filter((r) => r.callId && r.model && Number.isInteger(r.rating) && r.rating >= 1 && r.rating <= 5);
}

/**
 * Qo'ng'iroq uchun tahlilga olinadigan model: baho bo'lsa — eng yuqori
 * baholangan; bo'lmasa — eng yuqori kelishuvli (muvaffaqiyatli) model.
 */
export function selectModel(
  callId: string,
  metrics: readonly ModelCallMetrics[],
  ratings: ReadonlyArray<{ callId: string; model: string; rating: number }>,
): { model: string; selectedBy: 'rating' | 'agreement' } | null {
  const ok = metrics.filter((m) => m.callId === callId && m.ok);
  if (ok.length === 0) return null;
  const rated = ratings.filter((r) => r.callId === callId && ok.some((m) => m.model === r.model));
  if (rated.length > 0) {
    const best = [...rated].sort((a, b) => b.rating - a.rating || a.model.localeCompare(b.model))[0]!;
    return { model: best.model, selectedBy: 'rating' };
  }
  const best = [...ok].sort((a, b) => (b.agreement ?? 0) - (a.agreement ?? 0) || a.model.localeCompare(b.model))[0]!;
  return { model: best.model, selectedBy: 'agreement' };
}
