/**
 * FAQAT HARNESS. Haqiqiy qo'ng'iroqlar korpusining DETERMINISTIK qismlari testi.
 * HAQIQIY CHAQIRUV YO'Q: STT soxta `fetch` bilan, LLM natijalari tayyor
 * yorliqlar bilan; ma'lumotlar — o'ylab topilgan qisqa gaplar.
 *
 *   npm run verify:corpus
 */
// ENG BIRINCHI: harness/.env ni yuklaydi (yo'l harness papkasiga nisbatan).
import './env.js';

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assert,
  assertDeepEqual,
  assertEqual,
  check,
  checkAsync,
  createReport,
  section,
} from '../../module/backend/src/training/testing/assert.js';
import {
  addToTable,
  countOverlaps,
  fillerCounts,
  isShareableExample,
  lengthStats,
  mergeTurns,
  openerCounts,
} from './corpus/analysis.js';
import { anonymize, REDACTED } from './corpus/anonymize.js';
import {
  buildComparePage,
  compareCall,
  listeningWindow,
  parseRatingsCsv,
  seededOrder,
  selectModel,
  windowText,
} from './corpus/compare.js';
import { applyRoles, type ClassifyResult } from './corpus/llm-tasks.js';
import { channelsSeparated, parseSilenceDetect, planChunks } from './corpus/plan.js';
import { buildCorpusReport, buildStyleLibrary, summarizeCorpus } from './corpus/report.js';
import { normalizeSttResponse, transcribeFile } from './corpus/stt.js';
import { displayText, segmentQuality, splitSentences, toLatin, wordSimilarity } from './corpus/text.js';
import { buildModelTranscript } from './corpus/transcript.js';
import type { ModelTranscript, Segment } from './corpus/types.js';

const report = createReport();
const FAKE_KEY = 'sk-fake-CORPUS-0000000000-not-real';

function seg(index: number, text: string, extra: Partial<Segment> = {}): Segment {
  return { index, text, display: displayText(text), quality: segmentQuality(text), ...extra };
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  section('1. Bo\'laklash rejasi va kanallar');

  check(report, 'silencedetect chiqishi ajratiladi', () => {
    const stderr = [
      '[silencedetect @ 0x1] silence_start: 12.5',
      '[silencedetect @ 0x1] silence_end: 13.4 | silence_duration: 0.9',
      '[silencedetect @ 0x1] silence_start: -0.01',
      '[silencedetect @ 0x1] silence_end: 0.6 | silence_duration: 0.61',
    ].join('\n');
    assertDeepEqual(parseSilenceDetect(stderr), [{ start: 12.5, end: 13.4 }, { start: 0, end: 0.6 }], 'oraliqlar');
  });

  check(report, "qisqa fayl — bitta bo'lak; uzun — jimlikda, chegaradan oshmaydi, uzluksiz", () => {
    assertDeepEqual(planChunks(417, [], 600), [{ start: 0, end: 417 }], 'qisqa');
    const silences = [{ start: 290, end: 292 }, { start: 580, end: 584 }, { start: 1100, end: 1102 }];
    const chunks = planChunks(1500, silences, 600);
    for (const c of chunks) assert(c.end - c.start <= 600, `bo'lak ${c.start}-${c.end} chegaradan oshdi`);
    assertEqual(chunks[0]?.end, 582, "birinchi kesim — chegaragacha eng kech jimlik o'rtasi");
    for (let i = 1; i < chunks.length; i += 1) assertEqual(chunks[i]?.start, chunks[i - 1]?.end, 'uzluksiz');
    assertEqual(chunks[chunks.length - 1]?.end, 1500, 'oxirigacha');
    const hard = planChunks(1300, [], 600);
    assertDeepEqual(hard.map((c) => c.end), [600, 1200, 1300], "jimlik yo'q — qattiq chegara");
  });

  check(report, "stereo: kanallar so'zlovchiga ajratilganmi", () => {
    const left = [0.5, 0.001, 0.4, 0.002, 0.5, 0.001];
    const right = [0.001, 0.4, 0.002, 0.5, 0.001, 0.4];
    assertEqual(channelsSeparated(left, right).separated, true, 'navbatma-navbat — ajratilgan');
    assertEqual(channelsSeparated([0.3, 0.3, 0.3], [0.31, 0.29, 0.3]).separated, false, "teng — aralash");
  });

  // -------------------------------------------------------------------------
  section('2. Anonimlashtirish, yozuv, sifat, o\'xshashlik');

  check(report, 'telefon, e-pochta, pasport, karta, uzun ID -> [RAQAM]', () => {
    for (const text of [
      '+998 90 123 45 67',
      '998901234567',
      '90-123-45-67',
      '(90) 123-45-67',
      'ali.valiyev@mail.uz',
      'AA1234567',
      '8600 1234 5678 9012',
      'shartnoma 1234567890',
    ]) {
      const out = anonymize(`raqam: ${text} rahmat`);
      assert(out.includes(REDACTED), `${text} -> ${out}`);
      assert(!/\d{4,}/.test(out.replace(/\[RAQAM\]/g, '')), `raqam qoldi: ${out}`);
    }
  });

  check(report, 'narxlar SAQLANADI', () => {
    for (const text of ["oyiga 1 200 000 so'm", '700 ming', "1200000 so'm", 'oyiga 900 000', '3 oy']) {
      assertEqual(anonymize(text), text, text);
    }
  });

  check(report, "kirill -> lotin (deterministik), asl matn tegilmaydi", () => {
    const original = 'Нархи қанча бўлади?';
    assertEqual(toLatin(original), "Narxi qancha bo'ladi?", 'lotin');
    const t = buildModelTranscript({
      callId: 'c1', model: 'm', languageMode: 'omit', durationSec: 10,
      chunks: [{ offsetSec: 0, text: original, segments: [], latencyMs: 5 }],
    });
    assertEqual(t.text, original, 'asl matn');
    assertEqual(t.segments[0]?.text, original, 'segment asl matni');
    assertEqual(t.segments[0]?.display, "Narxi qancha bo'ladi?", 'display lotinda');
  });

  check(report, 'low_quality: boshqa til, takrorlanish, harfsiz', () => {
    assertEqual(segmentQuality('Ha, narxi qancha ekan?'), 'ok', "o'zbekcha");
    assertEqual(segmentQuality('Здравствуйте, это очень дорого'), 'low_quality', 'rus');
    assertEqual(segmentQuality('ha ha ha ha ha'), 'low_quality', 'takror');
    assertEqual(segmentQuality('...'), 'low_quality', 'harfsiz');
  });

  check(report, "so'z o'xshashligi: bir xil 1, kirill/lotin bir xil, butunlay boshqa 0", () => {
    assertEqual(wordSimilarity("Narxi qancha bo'ladi?", "narxi qancha bo'ladi"), 1, 'tinish/harf');
    assertEqual(wordSimilarity("Narxi qancha bo'ladi", 'Нархи қанча бўлади'), 1, 'kirill');
    assertEqual(wordSimilarity('salom dunyo', 'xayr olam'), 0, 'boshqa');
    assertEqual(wordSimilarity('bir ikki uch tort', 'bir ikki uch'), 0.75, 'bitta so\'z farq');
  });

  check(report, "gaplarga bo'lish", () => {
    assertDeepEqual(splitSentences('Salom. Narxi qancha? Mayli'), ['Salom.', 'Narxi qancha?', 'Mayli'], 'gaplar');
  });

  // -------------------------------------------------------------------------
  section("3. STT so'rovi (soxta fetch) va javobni o'qish");

  const dir = await mkdtemp(join(tmpdir(), 'corpus-'));
  const wav = join(dir, 'x.wav');
  await writeFile(wav, Buffer.from('RIFFfakeWAVE'));

  await checkAsync(report, 'diarize: diarized_json + chunking_strategy, prompt yo\'q; oddiy: omit -> til yo\'q', async () => {
    const forms: FormData[] = [];
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      forms.push(init?.body as FormData);
      return new Response(
        JSON.stringify({ text: 'Salom', segments: [{ speaker: 'A', start: 0, end: 1.2, text: 'Salom' }] }),
      );
    }) as typeof fetch;
    const cfg = { apiKey: FAKE_KEY, baseUrl: 'https://api.example/v1', languageMode: 'omit' as const, hints: ['sinov darsi'], fetchImpl: fakeFetch };
    const d = await transcribeFile('gpt-4o-transcribe-diarize', wav, cfg);
    assertEqual(forms[0]?.get('response_format'), 'diarized_json', 'diarize format');
    assertEqual(forms[0]?.get('chunking_strategy'), 'auto', 'chunking');
    assertEqual(forms[0]?.get('prompt'), null, "diarize'da prompt yo'q");
    assertEqual(d.segments[0]?.speaker, 'A', "so'zlovchi");
    await transcribeFile('gpt-4o-mini-transcribe', wav, cfg);
    assertEqual(forms[1]?.get('response_format'), 'json', 'oddiy format');
    assertEqual(forms[1]?.get('language'), null, "omit: til yo'q");
  });

  await checkAsync(report, "HTTP xato: kalit xato matnida yo'q", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: { message: `bad key ${FAKE_KEY}` } }), { status: 401 })) as typeof fetch;
    let caught: unknown;
    try {
      await transcribeFile('gpt-4o-transcribe', wav, {
        apiKey: FAKE_KEY, baseUrl: 'https://api.example/v1', languageMode: 'omit', hints: [], fetchImpl: fakeFetch,
      });
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof Error && caught.message.includes('HTTP 401'), 'xato');
    assert(!(caught as Error).message.includes(FAKE_KEY), "kalit yo'q");
  });

  check(report, "javob shakli kutilmagan bo'lsa ham yiqilmaydi", () => {
    assertDeepEqual(normalizeSttResponse({ text: ' a ' }), { text: 'a', segments: [] }, 'faqat matn');
    const n = normalizeSttResponse({ segments: [{ speaker: 1, start: 0, end: 1, text: 'x' }, { text: '' }, 5] });
    assertEqual(n.segments.length, 1, "bo'sh/noto'g'ri segmentlar tashlanadi");
    assertEqual(n.segments[0]?.speaker, '1', 'son belgisi satrga');
    assertEqual(n.text, 'x', 'matn segmentlardan');
  });

  check(report, "ko'p bo'lakli diarizatsiya: vaqt siljiydi, belgiga bo'lak raqami qo'shiladi", () => {
    const t = buildModelTranscript({
      callId: 'c', model: 'd', languageMode: 'omit', durationSec: 700,
      chunks: [
        { offsetSec: 0, text: 'Salom', segments: [{ speaker: 'A', start: 1, end: 2, text: 'Salom' }], latencyMs: 10 },
        { offsetSec: 600, text: 'Xayr', segments: [{ speaker: 'A', start: 3, end: 4, text: 'Xayr' }], latencyMs: 20 },
      ],
    });
    assertEqual(t.segments[1]?.start, 603, 'siljish');
    assertEqual(t.segments[1]?.speaker, '2:A', "bo'lak raqami");
    assertEqual(t.latencyMs, 30, 'kechikish yig\'indisi');
    assert(t.hasSpeakerLabels && t.hasTimestamps, 'belgilar bor');
  });

  // -------------------------------------------------------------------------
  section('4. Solishtirish va sahifa');

  const mk = (model: string, text: string, timed = false): ModelTranscript => ({
    callId: 'call1', model, languageMode: 'omit', durationSec: 120, latencyMs: 100, chunks: 1,
    hasSpeakerLabels: timed, hasTimestamps: timed, text,
    segments: timed
      ? [seg(0, 'Assalomu alaykum', { start: 10, end: 14, speaker: 'A' }), seg(1, 'Narxi qancha', { start: 30, end: 33, speaker: 'B' })]
      : splitSentences(text).map((s, i) => seg(i, s)),
  });

  check(report, "kelishuv: o'xshash modellar yuqori, xato model ok=false", () => {
    const metrics = compareCall('call1', [
      { model: 'a', transcript: mk('a', 'Assalomu alaykum. Narxi qancha.') },
      { model: 'b', transcript: mk('b', 'Assalomu alaykum. Narxi qancha?') },
      { model: 'c', transcript: null, error: 'HTTP 400' },
    ]);
    assertEqual(metrics[0]?.agreement, 1, 'a~b');
    assertEqual(metrics[2]?.ok, false, 'c xato');
    assertEqual(metrics[2]?.error, 'HTTP 400', 'xato matni');
  });

  check(report, 'tinglash oynasi va oyna matni (aniq / taxminiy)', () => {
    assertDeepEqual(listeningWindow(57), { start: 0, end: 57 }, 'qisqa');
    assertDeepEqual(listeningWindow(417), { start: 83.4, end: 143.4 }, '20% dan');
    const timed = windowText(mk('d', 'x', true), { start: 0, end: 20 });
    assertEqual(timed.approx, false, 'aniq');
    assert(timed.text.includes('[A] Assalomu alaykum') && !timed.text.includes('Narxi'), 'faqat oynadagi segment');
    const approx = windowText(mk('a', 'bir ikki uch tort besh olti yetti sakkiz'), { start: 0, end: 60 });
    assertEqual(approx.approx, true, 'taxminiy');
    assert(approx.text.startsWith('bir'), 'boshidan');
  });

  check(report, "sahifa: offline (tashqi URL yo'q), ko'r baholash, CSV", () => {
    assertDeepEqual(seededOrder([1, 2, 3, 4], 'x'), seededOrder([1, 2, 3, 4], 'x'), 'deterministik');
    const html = buildComparePage([
      {
        callId: 'call1', label: "Qo'ng'iroq 1", clipPath: 'clips/call1.mp3', window: { start: 0, end: 60 },
        variants: [{ model: 'a', text: '<b>salom</b>', approx: false }, { model: 'b', text: '', approx: false, error: 'HTTP 400' }],
      },
    ]);
    assert(!/https?:\/\//.test(html), "tashqi manzil yo'q");
    assert(html.includes('src="clips/call1.mp3"'), 'lokal audio');
    assert(html.includes('&lt;b&gt;salom&lt;/b&gt;'), 'HTML escape');
    assert(html.includes('data-model="a"') && html.includes('call_id,model,rating'), 'baholar va CSV');
  });

  check(report, "baholar CSV va model tanlash (baho > kelishuv)", () => {
    const ratings = parseRatingsCsv('call_id,model,rating\ncall1,a,3\ncall1,b,5\ncall1,c,9\nbad\n');
    assertEqual(ratings.length, 2, "noto'g'ri qatorlar tashlandi");
    const metrics = [
      { callId: 'call1', model: 'a', ok: true, agreement: 0.9, lowQualityShare: 0, segments: 3, speakerLabels: false, latencyMs: 1 },
      { callId: 'call1', model: 'b', ok: true, agreement: 0.5, lowQualityShare: 0, segments: 3, speakerLabels: false, latencyMs: 1 },
    ];
    assertDeepEqual(selectModel('call1', metrics, ratings), { model: 'b', selectedBy: 'rating' }, 'baho');
    assertDeepEqual(selectModel('call1', metrics, []), { model: 'a', selectedBy: 'agreement' }, 'kelishuv');
    assertEqual(selectModel('yoq', metrics, []), null, "transkript yo'q");
  });

  // -------------------------------------------------------------------------
  section('5. Statistika, rollar va hisobot');

  check(report, "uzunlik statistikasi, qisqa javoblar, to'ldiruvchilar, boshlanishlar", () => {
    const s = lengthStats(['ha', 'xop mayli', 'narxi qancha boladi', 'bir ikki uch tort besh olti'] );
    assertEqual(s.count, 4, 'soni');
    assertEqual(s.shortShare, 0.75, '1-4 so\'z ulushi');
    assertDeepEqual(s.histogram, { '1-2': 2, '3-4': 1, '5-8': 1, '9-15': 0, '16+': 0 }, 'gistogramma');
    assertEqual(fillerCounts(['Ha, mayli', 'ha endi'])[0]?.word, 'ha', "eng ko'p to'ldiruvchi");
    assertDeepEqual(openerCounts(['Ha mayli', 'ha mayli endi', 'yoq'], 2)[0], { opener: 'ha mayli', count: 2 }, 'boshlanish');
  });

  check(report, "navbatlar va ustma-ust gapirish", () => {
    const segs = [
      seg(0, 'Salom', { role: 'seller', speaker: 'A', start: 0, end: 2 }),
      seg(1, 'Taklif bor', { role: 'seller', speaker: 'A', start: 2, end: 4 }),
      seg(2, 'Qancha', { role: 'customer', speaker: 'B', start: 3.5, end: 5 }),
    ];
    const turns = mergeTurns(segs);
    assertEqual(turns.length, 2, 'ikki navbat');
    assertEqual(turns[0]?.display, 'Salom Taklif bor', 'birlashtirildi');
    assertEqual(countOverlaps(segs), 1, 'ustma-ust');
    assertEqual(countOverlaps([seg(0, 'a')]), null, "vaqtsiz — o'lchanmaydi");
  });

  check(report, "rollar: belgi bo'yicha va segment bo'yicha; matn o'zgarmaydi", () => {
    const segs = [seg(0, 'Salom', { speaker: 'A' }), seg(1, 'Ha', { speaker: 'B' })];
    const bySpeaker = applyRoles(segs, { speakerRoles: [{ speaker: 'A', role: 'seller' }, { speaker: 'B', role: 'customer' }], segmentRoles: [] }, true);
    assertDeepEqual(bySpeaker.map((s) => s.role), ['seller', 'customer'], 'belgi');
    assertDeepEqual(bySpeaker.map((s) => s.text), ['Salom', 'Ha'], 'matn tegilmadi');
    const byIndex = applyRoles(segs, { speakerRoles: [], segmentRoles: [{ i: 1, role: 'customer' }] }, false);
    assertDeepEqual(byIndex.map((s) => s.role), ['unknown', 'customer'], 'indeks; berilmagani unknown');
  });

  check(report, 'misollar: hisobotga faqat raqamsiz, ismsiz, qisqa', () => {
    assert(isShareableExample("O'ylab ko'raman, keyin aytaman"), 'oddiy');
    assert(!isShareableExample('Narxi 700 ming ekan'), 'raqam');
    assert(!isShareableExample(`Raqamim ${REDACTED}`), '[RAQAM]');
    assert(!isShareableExample('Men Dilnoza bilan gaplashgandim'), 'ism (bosh harf)');
    const table = {};
    addToTable(table, 'price', { text: 'qimmat', lowQuality: false, callId: 'c' });
    addToTable(table, 'price', { text: 'qimmat', lowQuality: false, callId: 'c' });
    assertEqual((table as Record<string, { count: number; examples: unknown[] }>).price?.examples.length, 1, 'takror misol yo\'q');
  });

  check(report, "yig'ma: LLM yorlig'i faqat MIJOZ navbatiga; misollar aynan; hisobot <=120 qator, <=20 misol", () => {
    const turnsSegs = [
      seg(0, "Assalomu alaykum, markazdan qo'ng'iroq qilyapman", { role: 'seller' }),
      seg(1, 'Ha, eshitaman', { role: 'customer' }),
      seg(2, 'Kursimiz haqida aytsam', { role: 'seller' }),
      seg(3, 'Qimmat ekan, o\'ylab ko\'raman', { role: 'customer' }),
    ];
    const turns = mergeTurns(turnsSegs);
    const classify: ClassifyResult = {
      customerTurns: [
        { i: 3, objection: 'price', question: 'none', emotion: 'doubt', confidence: 'high' },
        { i: 0, objection: 'time', question: 'none', emotion: 'neutral', confidence: 'high' }, // sotuvchi navbati — e'tiborsiz
      ],
      sellerIssues: [{ sellerTurn: 2, kind: 'vague', reactionTurn: 3 }],
      ending: 'will_think',
      endingTurn: 3,
    };
    const summary = summarizeCorpus([
      { callId: 'c1', model: 'm', selectedBy: 'agreement', durationSec: 90, segments: turnsSegs, turns, classify },
    ]);
    assertEqual(summary.customerTurns, 2, 'mijoz navbatlari');
    assertEqual(summary.objections.price?.examples[0]?.text, "Qimmat ekan, o'ylab ko'raman", 'misol aynan');
    assert(!('time' in summary.objections), "sotuvchi navbatidagi yorliq hisoblanmadi");
    assertEqual(summary.sellerIssueReactions.vague?.count, 1, 'reaksiya');
    const md = buildCorpusReport(summary, [
      { model: 'm', files: 1, failures: 0, meanAgreement: 0.8, meanLowQualityShare: 0.1, speakerLabels: false, meanRating: null },
    ]);
    assert(md.split('\n').length <= 121, `qatorlar: ${md.split('\n').length}`);
    assert((md.match(/«/g) ?? []).length <= 20, "misollar <= 20");
    assert(md.includes('(anekdotal)'), 'kam namunali toifa belgilangan');
    const style = buildStyleLibrary(summary) as { objections: Record<string, unknown> };
    assert('price' in style.objections, 'uslub kutubxonasi');
  });

  console.log(`\nNatija: ${report.passed} o'tdi, ${report.failed} xato, ${report.skipped} tashlab ketildi.`);
  if (report.failed > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
