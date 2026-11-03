/**
 * Ovozli navbat testlari. HAQIQIY provayder CHAQIRILMAYDI — STT/TTS soxta
 * portlar (`FakeStt` / `FakeTts`), LLM esa `FakeTrainerLlm`.
 *
 *   npm run verify:training:voice
 *
 * DB bo'lmasa DB bloki o'tkazib yuboriladi (sof funksiyalar baribir sinaladi).
 */
import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';

import { getArchetype } from './archetypes.js';
import { createTrainingEngine } from './engine.js';
import { isTrainingError, TrainingError } from './errors.js';
import { classifyHeardUzText } from './language.js';
import { describeApiError } from '../../../frontend/src/lib/api-error.js';
import type { GetBusinessProfile, TrainingContext, WithTenant } from './ports.js';
import { parseBusinessProfile } from './profile-schema.js';
import { errorStage, registerTrainingRoutes } from './routes.js';
import { computeMetrics } from './scoring/metrics.js';
import { createScoringService } from './scoring/scoring.js';
import { initState, type TrainingState } from './state.js';
import {
  assert,
  assertEqual,
  check,
  checkAsync,
  createReport,
  section,
  skip,
} from './testing/assert.js';
import { fakePersona, fakeTurn, FakeTrainerLlm } from './testing/fake-llm.js';
import {
  VOICE_AUDIO,
  VOICE_BUDGET_LINE,
  VOICE_LIMITS,
  VOICE_MAX_REPEATS,
  VOICE_REPEAT_LINE,
  type SttPort,
  type SttRequest,
  type TtsPort,
  type TtsRequest,
} from './voice/ports.js';
import {
  digitsOneByOne,
  normalizeForSpeech,
  numberToUzbekWords,
} from './voice/speech-text.js';
import { clampTone, TONE_LIMITS, toneInstruction, VOICE_TONES } from './voice/tone.js';
import {
  createVoiceService,
  describeVoiceCostRates,
  isAcceptedVoiceMime,
  validateVoiceAudio,
  voiceCost,
} from './voice/voice-turn.js';

const report = createReport();

// ---------------------------------------------------------------------------
// Yordamchilar
// ---------------------------------------------------------------------------
/** 16 kHz mono 16-bit PCM WAV yasaydi (jim audio — mazmuni muhim emas). */
function makeWav(seconds: number): Buffer {
  const samples = Math.round(VOICE_AUDIO.sampleRate * seconds);
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(VOICE_AUDIO.sampleRate, 24);
  buffer.writeUInt32LE(VOICE_AUDIO.sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

class FakeStt implements SttPort {
  readonly calls: SttRequest[] = [];
  constructor(private readonly texts: string[]) {}

  async transcribeShort(req: SttRequest): Promise<{ text: string; latencyMs: number }> {
    this.calls.push(req);
    return { text: this.texts.shift() ?? '', latencyMs: 7 };
  }
}

class FakeTts implements TtsPort {
  readonly calls: TtsRequest[] = [];

  async synthesize(req: TtsRequest): Promise<{ audio: Buffer; mime: string; latencyMs: number }> {
    this.calls.push(req);
    // Matn uzunligiga bog'liq "audio" — testda bayt sonini tekshirish uchun.
    return { audio: Buffer.alloc(Math.max(1, req.text.length)), mime: 'audio/mpeg', latencyMs: 11 };
  }
}

/**
 * Sinov profili ATAYLAB sohasiz: `verify-training-core.ts` dagi skaner
 * `module/` ichida soha so'zlarini taqiqlaydi (1-qoida).
 */
const PROFILE = parseBusinessProfile({
  industry: 'Xizmat',
  businessDescription: 'Oylik obuna asosidagi xizmat',
  primaryOffers: ["Asosiy taklif — 700 000 so'm/oy"],
  typicalCustomers: 'Shahar aholisi',
  customerProblem: 'Mos variantni topolmayapti',
  customerType: 'b2c',
  callDirection: 'mixed',
  vocabulary: ['Obuna', 'intensiv'],
});

const NEGOTIATOR = getArchetype('negotiator');

function stateWith(partial: Partial<TrainingState>): TrainingState {
  return { ...initState(NEGOTIATOR), ...partial };
}

// ---------------------------------------------------------------------------
// 1. normalizeForSpeech
// ---------------------------------------------------------------------------
section('1. Matnni ovozga tayyorlash (normalizeForSpeech)');

check(report, 'son -> so\'z: chegaraviy qiymatlar', () => {
  assertEqual(numberToUzbekWords(0), 'nol', '0');
  assertEqual(numberToUzbekWords(1), 'bir', '1');
  assertEqual(numberToUzbekWords(10), "o'n", '10');
  assertEqual(numberToUzbekWords(11), "o'n bir", '11');
  assertEqual(numberToUzbekWords(100), 'yuz', '100 — "bir yuz" emas');
  assertEqual(numberToUzbekWords(101), 'yuz bir', '101');
  assertEqual(numberToUzbekWords(1_000), 'ming', '1000 — "bir ming" emas');
  assertEqual(numberToUzbekWords(1_001), 'ming bir', '1001');
  assertEqual(numberToUzbekWords(999), "to'qqiz yuz to'qson to'qqiz", '999');
  assertEqual(
    numberToUzbekWords(999_999_999),
    "to'qqiz yuz to'qson to'qqiz million to'qqiz yuz to'qson to'qqiz ming to'qqiz yuz to'qson to'qqiz",
    '999 999 999',
  );
});

check(report, '0..999 999 999 oralig\'ida hech qachon raqam qolmaydi', () => {
  // Butun oraliqni sinab bo'lmaydi — har xonalikdan namunalar olamiz.
  const probes = [
    0, 7, 19, 20, 42, 99, 100, 305, 999, 1_000, 1_234, 10_000, 70_500, 100_000, 999_999,
    1_000_000, 3_200_000, 12_345_678, 100_000_000, 999_999_999,
  ];
  for (const n of probes) {
    const words = numberToUzbekWords(n);
    assert(!/\d/.test(words), `${n} -> "${words}" ichida raqam qoldi`);
    assert(words.length > 0, `${n} -> bo'sh`);
  }
});

check(report, 'narx: "700 000 so\'m" -> so\'z', () => {
  const out = normalizeForSpeech("Narxi 700 000 so'm, oyiga 3 200 000.", 'uz');
  assert(out.includes("yetti yuz ming so'm"), `narx o'girilmadi: ${out}`);
  assert(out.includes('uch million ikki yuz ming'), `ikkinchi narx: ${out}`);
  assert(!/\d/.test(out), `raqam qoldi: ${out}`);
});

check(report, 'foiz: "10%" -> "o\'n foiz"', () => {
  assertEqual(normalizeForSpeech('Chegirma 10%.', 'uz'), "Chegirma o'n foiz.", 'foiz');
});

check(report, 'telefon raqam-raqam o\'qiladi', () => {
  const out = normalizeForSpeech('Raqamim 90 123 45 67.', 'uz');
  assert(
    out.includes("to'qqiz nol bir ikki uch to'rt besh olti yetti"),
    `telefon noto'g'ri: ${out}`,
  );
});

check(report, 'katta son telefon deb O\'QILMAYDI (regressiya)', () => {
  // "120 000 000" uch bo'lak — eski mantiqda telefon deb raqamlanardi.
  const out = normalizeForSpeech("Jami 120 000 000 so'm.", 'uz');
  assert(out.includes('yigirma million'), `son sifatida o'qilmadi: ${out}`);
  assert(!out.includes('bir ikki nol'), `telefon deb o'qildi: ${out}`);
});

check(report, 'markdown va emoji olib tashlanadi', () => {
  const out = normalizeForSpeech('**Juda** yaxshi 👍 #zo\'r', 'uz');
  assert(!out.includes('*'), `yulduzcha qoldi: ${out}`);
  assert(!out.includes('#'), `panjara qoldi: ${out}`);
  assert(!out.includes('👍'), `emoji qoldi: ${out}`);
  assert(out.includes('Juda yaxshi'), `matn buzildi: ${out}`);
});

check(report, 'ruscha matnda raqamlar TEGILMAYDI', () => {
  const out = normalizeForSpeech('Цена 700 000 рублей.', 'ru');
  assert(out.includes('700 000'), `ruscha raqam o'zgardi: ${out}`);
});

check(report, 'aralash matn: raqam ham, so\'z ham saqlanadi', () => {
  const out = normalizeForSpeech("Obuna 2 oyda, 1 500 000 so'm.", 'mixed');
  assert(out.includes('Obuna'), `so'z yo'qoldi: ${out}`);
  assert(out.includes('ikki oyda'), `kichik son: ${out}`);
  assert(out.includes('bir million besh yuz ming'), `katta son: ${out}`);
});

check(report, 'raqam-raqam yordamchisi', () => {
  assertEqual(digitsOneByOne('908'), "to'qqiz nol sakkiz", 'digitsOneByOne');
});

// ---------------------------------------------------------------------------
// 2. Ohangni chegaralash
// ---------------------------------------------------------------------------
section('2. Ohang: model taklif qiladi, kod chegaralaydi');

check(report, 'ishonch past bo\'lsa "friendly" RAD etiladi', () => {
  const decision = clampTone('friendly', stateWith({ trust: 20, patience: 80 }), NEGOTIATOR);
  assert(decision.clamped, 'chegaralanishi kerak edi');
  assertEqual(decision.tone, 'calm', 'neytralga tushadi');
});

check(report, 'ishonch yetarli bo\'lsa "friendly" QABUL qilinadi', () => {
  const decision = clampTone(
    'friendly',
    stateWith({ trust: TONE_LIMITS.warmTrust, patience: 80 }),
    NEGOTIATOR,
  );
  assert(!decision.clamped, 'chegaralanmasligi kerak');
  assertEqual(decision.tone, 'friendly', 'ohang saqlanadi');
});

check(report, 'sabr va ishonch baland bo\'lsa "angry" RAD etiladi', () => {
  const decision = clampTone('angry', stateWith({ trust: 90, patience: 95 }), NEGOTIATOR);
  assert(decision.clamped, 'chegaralanishi kerak edi');
  assertEqual(decision.tone, 'calm', 'neytralga tushadi');
  assert(Boolean(decision.reason), 'sabab yoziladi');
});

check(report, 'sabr past bo\'lsa "angry" QABUL qilinadi', () => {
  const low = NEGOTIATOR.lose.patienceBelow + 5;
  const decision = clampTone('angry', stateWith({ trust: 90, patience: low }), NEGOTIATOR);
  assert(!decision.clamped, 'chegaralanmasligi kerak');
  assertEqual(decision.tone, 'angry', 'ohang saqlanadi');
});

check(report, 'ishonch past bo\'lsa "irritated" QABUL qilinadi (sabr baland bo\'lsa ham)', () => {
  const decision = clampTone(
    'irritated',
    stateWith({ trust: TONE_LIMITS.lowTrust - 1, patience: 95 }),
    NEGOTIATOR,
  );
  assert(!decision.clamped, 'ishonch past — ruxsat');
  assertEqual(decision.tone, 'irritated', 'ohang saqlanadi');
});

check(report, '"bored" faqat qiziqish past bo\'lsa', () => {
  const denied = clampTone('bored', stateWith({ interest: 80, patience: 90, trust: 70 }), NEGOTIATOR);
  assert(denied.clamped, 'qiziqish baland — rad etiladi');
  const allowed = clampTone(
    'bored',
    stateWith({ interest: TONE_LIMITS.lowInterest - 1, patience: 90, trust: 70 }),
    NEGOTIATOR,
  );
  assert(!allowed.clamped, 'qiziqish past — ruxsat');
  assertEqual(allowed.tone, 'bored', 'ohang saqlanadi');
});

check(report, '"calm" va "hesitant" har doim mumkin', () => {
  for (const tone of ['calm', 'hesitant'] as const) {
    const decision = clampTone(tone, stateWith({ trust: 5, patience: 5, interest: 5 }), NEGOTIATOR);
    assert(!decision.clamped, `${tone} chegaralanmasligi kerak`);
  }
});

check(report, 'noto\'g\'ri/yo\'q taklif -> holatga mos default', () => {
  const calm = clampTone(undefined, stateWith({ patience: 90 }), NEGOTIATOR);
  assertEqual(calm.tone, 'calm', 'sabr baland -> calm');
  assert(!calm.clamped, 'taklif yo\'q — chegaralash emas');

  const low = NEGOTIATOR.lose.patienceBelow + 5;
  const irritated = clampTone('not-a-tone', stateWith({ patience: low }), NEGOTIATOR);
  assertEqual(irritated.tone, 'irritated', 'sabr past -> irritated');
});

check(report, 'har bir ohang uchun TTS ko\'rsatmasi bor', () => {
  for (const tone of VOICE_TONES) {
    const text = toneInstruction(tone);
    assert(text.length > 10, `${tone}: ko'rsatma juda qisqa`);
  }
});

// ---------------------------------------------------------------------------
// 3. Kirish tekshiruvi va narx
// ---------------------------------------------------------------------------
section('3. Audio tekshiruvi va narx hisobi');

check(report, 'mime: audio/wav (parametrlari bilan ham) qabul qilinadi', () => {
  assert(isAcceptedVoiceMime('audio/wav'), 'audio/wav');
  assert(isAcceptedVoiceMime('audio/wav; codecs=1'), 'parametr bilan');
  assert(isAcceptedVoiceMime('AUDIO/WAV'), 'katta harf');
  assert(!isAcceptedVoiceMime('audio/webm'), 'webm rad etiladi');
  assert(!isAcceptedVoiceMime('application/json'), 'json rad etiladi');
});

check(report, 'noto\'g\'ri mime -> voice_unsupported_media', () => {
  try {
    validateVoiceAudio(makeWav(2), 'audio/webm');
    throw new Error('xato tashlanmadi');
  } catch (err) {
    assert(isTrainingError(err), 'TrainingError');
    assertEqual(err.code, 'voice_unsupported_media', 'kod');
  }
});

check(report, 'juda uzun yozuv -> voice_audio_too_large', () => {
  try {
    validateVoiceAudio(makeWav(45), VOICE_AUDIO.mime);
    throw new Error('xato tashlanmadi');
  } catch (err) {
    assert(isTrainingError(err), 'TrainingError');
    assertEqual(err.code, 'voice_audio_too_large', 'kod');
  }
});

check(report, 'WAV bo\'lmagan bayt -> voice_unsupported_media', () => {
  try {
    validateVoiceAudio(Buffer.alloc(200, 7), VOICE_AUDIO.mime);
    throw new Error('xato tashlanmadi');
  } catch (err) {
    assert(isTrainingError(err), 'TrainingError');
    assertEqual(err.code, 'voice_unsupported_media', 'kod');
  }
});

check(report, 'juda qisqa yozuv — XATO emas, "qaytaring" yo\'li', () => {
  const result = validateVoiceAudio(makeWav(0.1), VOICE_AUDIO.mime);
  assert(result.tooShort, 'tooShort');
  assertEqual(result.durationSec, 0, 'davomiylik hisoblanmaydi');
});

check(report, 'to\'g\'ri yozuv davomiyligi o\'lchanadi', () => {
  const result = validateVoiceAudio(makeWav(3), VOICE_AUDIO.mime);
  assert(!result.tooShort, 'tooShort emas');
  assert(Math.abs(result.durationSec - 3) < 0.01, `davomiylik: ${result.durationSec}`);
});

check(report, 'tarif yo\'q -> narx 0, lekin sarf yoziladi', () => {
  const cost = voiceCost(undefined, { audioSec: 60, chars: 1000 });
  assertEqual(cost.usd, 0, 'narx 0');
  assert(!cost.priced, 'priced=false');
  assert(describeVoiceCostRates(undefined).includes("TARIF YO'Q"), 'ogohlantirish matni');
});

check(report, 'tarif bor -> narx hisoblanadi', () => {
  const cost = voiceCost(
    { sttPerMinuteUsd: 0.006, ttsPerMillionCharsUsd: 15 },
    { audioSec: 60, chars: 1_000_000 },
  );
  assert(cost.priced, 'priced=true');
  assert(Math.abs(cost.usd - 15.006) < 1e-6, `narx: ${cost.usd}`);
});

check(report, 'faqat bitta tarif berilsa ham ishlaydi', () => {
  const cost = voiceCost({ sttPerMinuteUsd: 0.006 }, { audioSec: 120, chars: 500 });
  assert(cost.priced, 'priced=true');
  assert(Math.abs(cost.usd - 0.012) < 1e-9, `faqat STT: ${cost.usd}`);
});

// ---------------------------------------------------------------------------
// 4. "Takrorlaysizmi" hisobi metrikaga tushadi
// ---------------------------------------------------------------------------
section('4. Metrika: voiceRepeatRequests');

check(report, 'meta.needsRepeat bo\'lgan navbatlar sanaladi', () => {
  const persona = fakePersona({ focusOffer: 'Asosiy taklif' }) as { objections: Array<{ key: string }> };
  const state = initState(NEGOTIATOR);
  const metrics = computeMetrics(
    { outcome: null, endReason: null, startedAt: new Date(), endedAt: null } as never,
    [
      { seq: 1, speaker: 'customer', text: 'salom', stateAfter: state, createdAt: new Date() },
      {
        seq: 2,
        speaker: 'customer',
        text: VOICE_REPEAT_LINE,
        stateAfter: { ...state, meta: { needsRepeat: true } },
        createdAt: new Date(),
      },
      {
        seq: 3,
        speaker: 'customer',
        text: VOICE_REPEAT_LINE,
        stateAfter: { ...state, meta: { needsRepeat: true } },
        createdAt: new Date(),
      },
    ] as never,
    NEGOTIATOR,
    persona as never,
  );
  assertEqual(metrics.voiceRepeatRequests, 2, 'ikkita qaytarish');
});

// ---------------------------------------------------------------------------
// 5. DB bilan: to'liq ovozli navbat
// ---------------------------------------------------------------------------
async function dbBlock(): Promise<void> {
  section("5. To'liq ovozli navbat (DB)");

  let mod: typeof import('../../../../harness/src/withTenant.js');
  try {
    mod = await import('../../../../harness/src/withTenant.js');
  } catch (err) {
    skip(report, 'DB bloki', `harness topilmadi: ${err instanceof Error ? err.message : err}`);
    return;
  }

  const pool = mod.createPool(mod.appDatabaseUrl());
  const withTenant = mod.createWithTenant(pool) as WithTenant;

  try {
    await withTenant('11111111-1111-1111-1111-111111111111', async () => undefined);
  } catch (err) {
    skip(report, 'DB bloki', `ulanmadi: ${err instanceof Error ? err.message : err}`);
    await pool.end();
    return;
  }

  const demo = await import('../../../../harness/src/demo-env.js');
  await demo.ensureDemoRows();
  const ctx: TrainingContext = {
    businessId: demo.DEMO_BUSINESS_ID,
    userId: demo.DEMO_USER_ID,
    seatId: null,
  };
  const getBusinessProfile: GetBusinessProfile = async () => PROFILE;

  /**
   * Arxetip AYNAN `objections.count` ta e'tiroz talab qiladi (negotiator — 3),
   * aks holda persona-card sxemadan o'tmaydi.
   */
  const personaScript = (direction: 'inbound' | 'outbound'): unknown =>
    fakePersona({
      objectionKeys: ['price_too_high', 'no_time', 'needs_to_ask_family'],
      severity: NEGOTIATOR.objections.severityMax,
      focusOffer: PROFILE.primaryOffers[0] as string,
      direction,
    });

  function makeEngine(llm: FakeTrainerLlm) {
    return createTrainingEngine({ withTenant, getBusinessProfile, llm, random: () => 0.1 });
  }

  /**
   * Sessiya ochadi. Yo'nalish ANIQ beriladi: persona-card sxemasi kartadagi
   * `direction` so'ralganiga mos kelishini talab qiladi.
   */
  async function startSession(
    llm: FakeTrainerLlm,
    direction: 'inbound' | 'outbound' = 'inbound',
  ): Promise<{ engine: ReturnType<typeof makeEngine>; sessionId: string }> {
    const engine = makeEngine(llm);
    const started = await engine.startSession(ctx, { archetypeKey: 'negotiator', direction });
    return { engine, sessionId: started.sessionId };
  }

  await checkAsync(report, "to'liq navbat: matn saqlanadi, AUDIO saqlanmaydi", async () => {
    const llm = new FakeTrainerLlm([
      personaScript('inbound'),
      fakeTurn({ reply: "Narxi 700 000 so'mmi?", tone: 'hesitant' }),
    ]);
    const { engine, sessionId } = await startSession(llm);
    const stt = new FakeStt(['Assalomu alaykum, taklif haqida gaplashsak']);
    const tts = new FakeTts();
    const voice = createVoiceService({
      engine,
      withTenant,
      stt,
      tts,
      models: { stt: 'fake-stt', tts: 'fake-tts', voice: 'alloy' },
      getBusinessProfile,
    });

    const result = await voice.takeVoiceTurn(ctx, {
      sessionId,
      audio: makeWav(3),
      mime: VOICE_AUDIO.mime,
    });

    assertEqual(result.sellerText, 'Assalomu alaykum, taklif haqida gaplashsak', 'STT matni');
    assertEqual(result.customerText, "Narxi 700 000 so'mmi?", 'mijoz matni');
    assert(!result.needsRepeat, 'qaytarish emas');
    assert(result.audio.length > 0, 'audio qaytdi');
    assertEqual(result.audioMime, 'audio/mpeg', 'audio mime');
    assert(result.timings.totalMs >= 0, 'vaqtlar');

    // TTS ga ASL matn emas, OVOZGA MOSLANGAN matn boradi.
    const spoken = tts.calls[tts.calls.length - 1]?.text ?? '';
    assert(spoken.includes('yetti yuz ming'), `raqam o'girilmadi: ${spoken}`);
    assert(!/\d/.test(spoken), `TTS matnida raqam qoldi: ${spoken}`);

    // DB da — ASL matn (transkript va baholash o'zgarmaydi).
    const session = await engine.getSession(ctx, { sessionId });
    const texts = session.transcript.map((t) => t.text);
    assert(texts.includes("Narxi 700 000 so'mmi?"), 'asl matn saqlandi');
    assert(
      !texts.some((t) => t.includes('yetti yuz ming')),
      'ovozga moslangan matn DB ga YOZILMAYDI',
    );

    // Audio hech qayerda yo'q.
    const raw = JSON.stringify(session);
    assert(!raw.includes('base64'), 'javobda audio izi yo\'q');
  });

  await checkAsync(report, 'meta IKKI navbatga ham yoziladi (model, vaqt, ohang)', async () => {
    const llm = new FakeTrainerLlm([
      personaScript('outbound'),
      fakeTurn({ reply: 'Qiziq emas.', tone: 'calm' }),
    ]);
    const { engine, sessionId } = await startSession(llm, 'outbound');
    const voice = createVoiceService({
      engine,
      withTenant,
      stt: new FakeStt(['Salom, bir daqiqa vaqtingiz bormi']),
      tts: new FakeTts(),
      models: { stt: 'fake-stt', tts: 'fake-tts', voice: 'alloy' },
      getBusinessProfile,
    });
    await voice.takeVoiceTurn(ctx, { sessionId, audio: makeWav(4), mime: VOICE_AUDIO.mime });

    const rows = await withTenant(ctx.businessId, async (tx) => {
      const voiceRepo = await import('./voice/repo.js');
      const maxSeq = await voiceRepo.maxTurnSeq(tx, sessionId);
      return { maxSeq };
    });

    const session = await engine.getSession(ctx, { sessionId });
    assert(rows.maxSeq >= 2, 'ikkita navbat yozildi');
    assert(session.transcript.length >= 2, 'transkriptda ikkala tomon bor');
  });

  await checkAsync(report, 'STT bo\'sh -> "takrorlaysizmi": LLM yo\'q, holat o\'zgarmaydi', async () => {
    const llm = new FakeTrainerLlm([
      personaScript('outbound'),
    ]);
    const { engine, sessionId } = await startSession(llm, 'outbound');
    const before = await engine.getSession(ctx, { sessionId });
    const callsBefore = llm.callCount;

    const voice = createVoiceService({
      engine,
      withTenant,
      stt: new FakeStt(['']),
      tts: new FakeTts(),
      models: { stt: 'fake-stt', tts: 'fake-tts' },
      getBusinessProfile,
    });
    const result = await voice.takeVoiceTurn(ctx, {
      sessionId,
      audio: makeWav(2),
      mime: VOICE_AUDIO.mime,
    });

    assert(result.needsRepeat, 'needsRepeat');
    assertEqual(result.customerText, VOICE_REPEAT_LINE, 'qat\'iy matn');
    assertEqual(result.sellerText, '', 'sotuvchi matni yo\'q');
    assertEqual(llm.callCount, callsBefore, 'LLM CHAQIRILMADI');

    const after = await engine.getSession(ctx, { sessionId });
    assertEqual(after.state.patience, before.state.patience, 'sabr o\'zgarmadi');
    assertEqual(after.state.trust, before.state.trust, 'ishonch o\'zgarmadi');
    assertEqual(after.turnCount, before.turnCount, 'navbat sanalmadi');
  });

  await checkAsync(report, `"takrorlaysizmi" ${VOICE_MAX_REPEATS} martadan oshmaydi`, async () => {
    const llm = new FakeTrainerLlm([
      personaScript('outbound'),
    ]);
    const { engine, sessionId } = await startSession(llm, 'outbound');
    const voice = createVoiceService({
      engine,
      withTenant,
      stt: new FakeStt(['', '', '']),
      tts: new FakeTts(),
      models: { stt: 'fake-stt', tts: 'fake-tts' },
      getBusinessProfile,
    });

    for (let i = 0; i < VOICE_MAX_REPEATS; i += 1) {
      const result = await voice.takeVoiceTurn(ctx, {
        sessionId,
        audio: makeWav(2),
        mime: VOICE_AUDIO.mime,
      });
      assert(result.needsRepeat, `${i + 1}-urinish qaytarish bo'lishi kerak`);
    }

    try {
      await voice.takeVoiceTurn(ctx, { sessionId, audio: makeWav(2), mime: VOICE_AUDIO.mime });
      throw new Error('chegara ishlamadi');
    } catch (err) {
      assert(isTrainingError(err), 'TrainingError');
      assertEqual(err.code, 'voice_not_recognized', 'kod');
    }
  });

  await checkAsync(report, 'byudjet tugasa sessiya XUSHMUOMALA tugaydi', async () => {
    const llm = new FakeTrainerLlm([
      personaScript('outbound'),
    ]);
    const { engine, sessionId } = await startSession(llm, 'outbound');
    const voice = createVoiceService({
      engine,
      withTenant,
      stt: new FakeStt(['salom']),
      tts: new FakeTts(),
      models: { stt: 'fake-stt', tts: 'fake-tts' },
      getBusinessProfile,
      // 0.01 daqiqa = 0.6 s; 2 s yozuv darhol oshib ketadi.
      maxMinutesPerSession: 0.01,
    });

    const result = await voice.takeVoiceTurn(ctx, {
      sessionId,
      audio: makeWav(2),
      mime: VOICE_AUDIO.mime,
    });
    assert(result.ended, 'sessiya tugadi');
    assertEqual(result.customerText, VOICE_BUDGET_LINE, 'xushmuomala matn');
    assertEqual(result.endReason, 'voice_budget_exhausted', 'sabab');
    assertEqual(llm.callCount, 1, 'faqat persona chaqiruvi — navbat LLM si yo\'q');

    const after = await engine.getSession(ctx, { sessionId });
    assert(after.status !== 'active', `sessiya yopildi: ${after.status}`);
  });

  await checkAsync(report, 'boshqa tenant sessiyasi KO\'RINMAYDI (404)', async () => {
    const llm = new FakeTrainerLlm([
      personaScript('outbound'),
    ]);
    const { engine, sessionId } = await startSession(llm, 'outbound');
    const voice = createVoiceService({
      engine,
      withTenant,
      stt: new FakeStt(['salom']),
      tts: new FakeTts(),
      models: { stt: 'fake-stt', tts: 'fake-tts' },
      getBusinessProfile,
    });

    const otherCtx: TrainingContext = {
      businessId: randomUUID(),
      userId: randomUUID(),
      seatId: null,
    };
    try {
      await voice.takeVoiceTurn(otherCtx, {
        sessionId,
        audio: makeWav(2),
        mime: VOICE_AUDIO.mime,
      });
      throw new Error('xato tashlanmadi');
    } catch (err) {
      assert(isTrainingError(err), `TrainingError emas: ${String(err)}`);
      assertEqual(err.code, 'session_not_found', 'RLS tufayli "yo\'q"');
    }
  });

  await checkAsync(report, 'parallel ikkinchi navbat -> voice_turn_in_progress', async () => {
    const llm = new FakeTrainerLlm([
      personaScript('outbound'),
      fakeTurn({ reply: 'Birinchi javob.' }),
      fakeTurn({ reply: 'Ikkinchi javob.' }),
    ]);
    const { engine, sessionId } = await startSession(llm, 'outbound');

    // Birinchi navbat STT da "osilib" turadi — ikkinchisi qulfga uriladi.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowStt: SttPort = {
      async transcribeShort() {
        await gate;
        return { text: 'sekin javob', latencyMs: 1 };
      },
    };

    const slow = createVoiceService({
      engine,
      withTenant,
      stt: slowStt,
      tts: new FakeTts(),
      models: { stt: 'fake-stt', tts: 'fake-tts' },
      getBusinessProfile,
    });
    const fast = createVoiceService({
      engine,
      withTenant,
      stt: new FakeStt(['tez javob']),
      tts: new FakeTts(),
      models: { stt: 'fake-stt', tts: 'fake-tts' },
      getBusinessProfile,
    });

    const first = slow.takeVoiceTurn(ctx, {
      sessionId,
      audio: makeWav(2),
      mime: VOICE_AUDIO.mime,
    });
    // Birinchi navbat qulfni olishiga ulgursin.
    await new Promise((resolve) => setTimeout(resolve, 150));

    let secondCode: string | null = null;
    try {
      await fast.takeVoiceTurn(ctx, { sessionId, audio: makeWav(2), mime: VOICE_AUDIO.mime });
    } catch (err) {
      secondCode = isTrainingError(err) ? err.code : `boshqa: ${String(err)}`;
    }

    release();
    await first;

    assertEqual(secondCode, 'voice_turn_in_progress', 'ikkinchisi 409');
  });

  await checkAsync(report, 'inbound: mijozning birinchi gapi ovozda beriladi', async () => {
    const llm = new FakeTrainerLlm([
      personaScript('inbound'),
    ]);
    const { engine, sessionId } = await startSession(llm);
    const tts = new FakeTts();
    const voice = createVoiceService({
      engine,
      withTenant,
      stt: new FakeStt([]),
      tts,
      models: { stt: 'fake-stt', tts: 'fake-tts' },
      getBusinessProfile,
    });

    const spoken = await voice.speakOpeningLine(ctx, { sessionId });
    assert(spoken !== null, 'inbound uchun ovoz bor');
    assert(spoken.audio.length > 0, 'audio bor');
    assert(spoken.text.length > 0, 'matn bor');
    assertEqual(tts.calls.length, 1, 'bitta TTS chaqiruvi');
  });

  await checkAsync(report, 'outbound: birinchi gap ovozi YO\'Q', async () => {
    const llm = new FakeTrainerLlm([
      personaScript('outbound'),
    ]);
    const { engine, sessionId } = await startSession(llm, 'outbound');
    const tts = new FakeTts();
    const voice = createVoiceService({
      engine,
      withTenant,
      stt: new FakeStt([]),
      tts,
      models: { stt: 'fake-stt', tts: 'fake-tts' },
      getBusinessProfile,
    });

    const spoken = await voice.speakOpeningLine(ctx, { sessionId });
    assertEqual(spoken, null, 'outbound — null');
    assertEqual(tts.calls.length, 0, 'TTS chaqirilmadi');
  });

  await checkAsync(report, 'STT ga lug\'at va taklif nomlari yuboriladi', async () => {
    const llm = new FakeTrainerLlm([
      personaScript('outbound'),
      fakeTurn({ reply: 'Yaxshi.' }),
    ]);
    const { engine, sessionId } = await startSession(llm, 'outbound');
    const stt = new FakeStt(['salom aleykum']);
    const voice = createVoiceService({
      engine,
      withTenant,
      stt,
      tts: new FakeTts(),
      models: { stt: 'fake-stt', tts: 'fake-tts' },
      getBusinessProfile,
    });
    await voice.takeVoiceTurn(ctx, { sessionId, audio: makeWav(2), mime: VOICE_AUDIO.mime });

    const hints = stt.calls[0]?.hints ?? [];
    assert(hints.includes('Obuna'), `lug'at yuborilmadi: ${hints.join(', ')}`);
    assert(hints.length > 0, 'yordamchi so\'zlar bor');
  });

  await checkAsync(report, 'ohang TTS ga ko\'rsatma bilan boradi', async () => {
    const llm = new FakeTrainerLlm([
      personaScript('outbound'),
      // Model "friendly" taklif qiladi, lekin boshlang'ich ishonch past.
      fakeTurn({ reply: 'Hmm.', tone: 'friendly' }),
    ]);
    const { engine, sessionId } = await startSession(llm, 'outbound');
    const tts = new FakeTts();
    const voice = createVoiceService({
      engine,
      withTenant,
      stt: new FakeStt(['salom']),
      tts,
      models: { stt: 'fake-stt', tts: 'fake-tts' },
      getBusinessProfile,
    });

    const result = await voice.takeVoiceTurn(ctx, {
      sessionId,
      audio: makeWav(2),
      mime: VOICE_AUDIO.mime,
    });

    const call = tts.calls[tts.calls.length - 1];
    assert(call !== undefined, 'TTS chaqirildi');
    assertEqual(call.tone, result.tone, 'ohang uzatildi');
    assertEqual(call.instructions, toneInstruction(result.tone), 'ko\'rsatma uzatildi');
    // Boshlang'ich ishonch `warmTrust` dan past — "friendly" o'tmasligi kerak.
    assert(result.tone !== 'friendly', `ohang chegaralanmadi: ${result.tone}`);
  });


  // --- Route darajasi: statuslar ------------------------------------------
  await checkAsync(report, 'route: 415 (JSON yuborilsa), 413 (katta), 404 (boshqa tenant)', async () => {
    const llm = new FakeTrainerLlm([
      personaScript('outbound'),
      fakeTurn({ reply: 'Yaxshi.' }),
      fakeTurn({ reply: 'Yana bir savol.' }),
    ]);
    const engine = makeEngine(llm);
    const started = await engine.startSession(ctx, {
      archetypeKey: 'negotiator',
      direction: 'outbound',
    });
    const sessionId = started.sessionId;

    const voice = createVoiceService({
      engine,
      withTenant,
      stt: new FakeStt(['salom', 'salom']),
      tts: new FakeTts(),
      models: { stt: 'fake-stt', tts: 'fake-tts' },
      getBusinessProfile,
    });

    const app = Fastify({ logger: false });
    let currentCtx = ctx;
    await registerTrainingRoutes(app, {
      engine,
      scoring: createScoringService({ withTenant, llm }),
      withTenant,
      voice,
      getContext: () => currentCtx,
      config: { autoScoreOnEnd: false, allowDebug: true },
    });
    await app.ready();

    const url = `/api/v1/training/sessions/${sessionId}/voice-turn`;

    // 1. To'g'ri yozuv -> 200, javobda base64 audio.
    const ok = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'audio/wav' },
      payload: makeWav(2),
    });
    assertEqual(ok.statusCode, 200, `to'g'ri yozuv: ${ok.body.slice(0, 200)}`);
    const body = ok.json() as { audio: string; customerText: string; tone: string };
    assert(body.audio.length > 0, 'audio base64');
    assert(body.customerText.length > 0, 'mijoz matni');
    assert(VOICE_TONES.includes(body.tone as never), `ohang yaroqli: ${body.tone}`);

    // 2. JSON yuborilsa -> 415.
    const wrongMime = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: { text: 'salom' },
    });
    assertEqual(wrongMime.statusCode, 415, `noto'g'ri mime: ${wrongMime.body.slice(0, 200)}`);

    // 3. Chegaradan katta tana -> 413 (Fastify handler'ga yetkazmaydi).
    const tooLarge = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'audio/wav' },
      payload: Buffer.alloc(VOICE_LIMITS.maxBytes + 1024),
    });
    assertEqual(tooLarge.statusCode, 413, `katta tana: ${tooLarge.body.slice(0, 200)}`);

    // 4. Boshqa tenant -> 404 (403 EMAS).
    currentCtx = { businessId: randomUUID(), userId: randomUUID(), seatId: null };
    const foreign = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'audio/wav' },
      payload: makeWav(2),
    });
    assertEqual(foreign.statusCode, 404, `boshqa tenant: ${foreign.body.slice(0, 200)}`);

    await app.close();
  });

  await checkAsync(report, 'route: "qaytaring" chegarasi tugasa 422', async () => {
    const llm = new FakeTrainerLlm([personaScript('outbound')]);
    const engine = makeEngine(llm);
    const started = await engine.startSession(ctx, {
      archetypeKey: 'negotiator',
      direction: 'outbound',
    });

    const voice = createVoiceService({
      engine,
      withTenant,
      stt: new FakeStt(['', '', '']),
      tts: new FakeTts(),
      models: { stt: 'fake-stt', tts: 'fake-tts' },
      getBusinessProfile,
    });

    const app = Fastify({ logger: false });
    await registerTrainingRoutes(app, {
      engine,
      scoring: createScoringService({ withTenant, llm }),
      withTenant,
      voice,
      getContext: () => ctx,
      config: { autoScoreOnEnd: false },
    });
    await app.ready();

    const url = `/api/v1/training/sessions/${started.sessionId}/voice-turn`;
    const send = () =>
      app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'audio/wav' },
        payload: makeWav(2),
      });

    for (let i = 0; i < VOICE_MAX_REPEATS; i += 1) {
      const res = await send();
      assertEqual(res.statusCode, 200, `${i + 1}-qaytarish 200`);
      assert((res.json() as { needsRepeat: boolean }).needsRepeat, 'needsRepeat');
    }
    const exhausted = await send();
    assertEqual(exhausted.statusCode, 422, `chegara: ${exhausted.body.slice(0, 200)}`);

    await app.close();
  });

  await checkAsync(report, "STT o'zbek kirillida qaytsa -> transkript lotinda", async () => {
    const llm = new FakeTrainerLlm([personaScript('outbound'), fakeTurn({ reply: 'Qancha turadi?' })]);
    const { engine, sessionId } = await startSession(llm, 'outbound');
    const voice = createVoiceService({
      engine,
      withTenant,
      stt: new FakeStt(['Ассалому алайкум, таклиф ҳақида гаплашсак']),
      tts: new FakeTts(),
      models: { stt: 'fake-stt', tts: 'fake-tts' },
      getBusinessProfile,
    });
    const result = await voice.takeVoiceTurn(ctx, { sessionId, audio: makeWav(3), mime: VOICE_AUDIO.mime });
    assertEqual(result.sellerText, "Assalomu alaykum, taklif haqida gaplashsak", 'lotinga o\'girildi');
    const session = await engine.getSession(ctx, { sessionId });
    assert(
      session.transcript.some((t) => t.text === "Assalomu alaykum, taklif haqida gaplashsak"),
      'DB da lotin matn',
    );
  });

  await checkAsync(report, "STT boshqa tilda (qozoq) -> 'eshitolmadim', LLM yo'q", async () => {
    const llm = new FakeTrainerLlm([personaScript('outbound')]);
    const { engine, sessionId } = await startSession(llm, 'outbound');
    const callsBefore = llm.callCount;
    const voice = createVoiceService({
      engine,
      withTenant,
      stt: new FakeStt(['Сәлеметсіз бе, бағасы қанша?']),
      tts: new FakeTts(),
      models: { stt: 'fake-stt', tts: 'fake-tts' },
      getBusinessProfile,
    });
    const result = await voice.takeVoiceTurn(ctx, { sessionId, audio: makeWav(3), mime: VOICE_AUDIO.mime });
    assert(result.needsRepeat, "takrorlaysizmi");
    assertEqual(result.customerText, VOICE_REPEAT_LINE, 'qat\'iy gap');
    assertEqual(llm.callCount, callsBefore, 'LLM chaqirilmadi');
  });

  await checkAsync(report, "STT provayder xatosi -> voice_stt_failed; route 502 + stage='stt' (internal_error EMAS)", async () => {
    const llm = new FakeTrainerLlm([personaScript('outbound')]);
    const { engine, sessionId } = await startSession(llm, 'outbound');
    const failingStt: SttPort = {
      async transcribeShort() {
        throw new Error("OpenAI STT HTTP 400: Language code 'uz' is not recognized.");
      },
    };
    const voice = createVoiceService({
      engine,
      withTenant,
      stt: failingStt,
      tts: new FakeTts(),
      models: { stt: 'fake-stt', tts: 'fake-tts' },
      getBusinessProfile,
    });
    let code: string | null = null;
    try {
      await voice.takeVoiceTurn(ctx, { sessionId, audio: makeWav(3), mime: VOICE_AUDIO.mime });
    } catch (err) {
      code = err instanceof TrainingError ? err.code : 'boshqa';
    }
    assertEqual(code, 'voice_stt_failed', 'kod');

    const app = Fastify({ logger: false });
    await registerTrainingRoutes(app, {
      engine,
      scoring: createScoringService({ withTenant, llm }),
      withTenant,
      voice,
      getContext: () => ctx,
      config: { autoScoreOnEnd: false },
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/training/sessions/${sessionId}/voice-turn`,
      headers: { 'content-type': 'audio/wav' },
      payload: makeWav(3),
    });
    const json = res.json() as { error: string; stage: string; message: string };
    assertEqual(res.statusCode, 502, '502');
    assertEqual(json.error, 'voice_stt_failed', 'kod');
    assertEqual(json.stage, 'stt', 'bosqich');
    assert(json.message.includes('nutq tanilmadi'), "o'zbekcha xabar");
    await app.close();
  });

  await checkAsync(report, 'route: voice berilmasa /voice-turn YO\'Q (404)', async () => {
    const llm = new FakeTrainerLlm([personaScript('outbound')]);
    const engine = makeEngine(llm);
    const started = await engine.startSession(ctx, {
      archetypeKey: 'negotiator',
      direction: 'outbound',
    });

    const app = Fastify({ logger: false });
    await registerTrainingRoutes(app, {
      engine,
      scoring: createScoringService({ withTenant, llm }),
      withTenant,
      // `voice` ATAYLAB berilmadi — matnli rejim o'zgarmasligi kerak.
      getContext: () => ctx,
      config: { autoScoreOnEnd: false },
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/training/sessions/${started.sessionId}/voice-turn`,
      headers: { 'content-type': 'audio/wav' },
      payload: makeWav(2),
    });
    assertEqual(res.statusCode, 404, 'route ro\'yxatga olinmagan');

    await app.close();
  });

  await pool.end();
}

// ---------------------------------------------------------------------------
// 6. Loglarda kalit va audio yo'qligi
// ---------------------------------------------------------------------------
section('6. Maxfiylik');

check(report, 'ohang ko\'rsatmalarida kalit yoki URL yo\'q', () => {
  for (const tone of VOICE_TONES) {
    const text = toneInstruction(tone);
    assert(!/sk-|Bearer|https?:/i.test(text), `${tone}: shubhali matn`);
  }
});

check(report, 'narx tavsifida kalit nomi emas, ENV nomi bor', () => {
  const text = describeVoiceCostRates(undefined);
  assert(text.includes('OPENAI_STT_PRICE_PER_MIN'), 'env nomi');
  assert(!/sk-/.test(text), 'kalit izi yo\'q');
});

// ---------------------------------------------------------------------------
// 7. STT matni tili va xato bosqichlari (sof)
// ---------------------------------------------------------------------------
section('7. STT matni tili, xato bosqichi va UI xabari');

check(report, "STT natijasi: o'zbek lotin / o'zbek kirill / aniq boshqa til", () => {
  assertEqual(classifyHeardUzText("Assalomu alaykum, xizmatingiz narxi qancha?"), 'latin', 'uz lotin');
  assertEqual(classifyHeardUzText('Ассалому алайкум, нархи қанча?'), 'uz_cyrillic', 'uz kirill');
  assertEqual(classifyHeardUzText('Сәлеметсіз бе, бағасы қанша?'), 'foreign', 'qozoq (ә, і)');
  assertEqual(classifyHeardUzText('Здравствуйте, сколько это стоит?'), 'foreign', 'rus');
  assertEqual(classifyHeardUzText('Merhaba, fiyatı ne kadar?'), 'foreign', 'turk (ı)');
  assertEqual(classifyHeardUzText('Hello, how much is the price?'), 'foreign', 'ingliz');
  assertEqual(classifyHeardUzText("Ha, o'ylab ko'raman"), 'latin', "qisqa o'zbekcha");
});

check(report, 'xato kodi -> bosqich (stt, tts, llm, audio, session, server)', () => {
  assertEqual(errorStage('voice_stt_failed'), 'stt', 'stt');
  assertEqual(errorStage('voice_not_recognized'), 'stt', 'tanilmadi');
  assertEqual(errorStage('voice_tts_failed'), 'tts', 'tts');
  assertEqual(errorStage('llm_timeout'), 'llm', 'llm');
  assertEqual(errorStage('voice_audio_too_large'), 'audio', 'audio');
  assertEqual(errorStage('voice_turn_in_progress'), 'session', 'session');
  assertEqual(errorStage('voice_failed'), 'server', 'kutilmagan');
});

check(report, "UI xabari: xom JSON emas, bosqich o'zbekcha", () => {
  const body = {
    error: 'voice_stt_failed',
    stage: 'stt',
    message: "nutq tanilmadi: [http] provayder HTTP xato qaytardi: HTTP 400: Language code 'uz' is not recognized",
  };
  // 1) host tanani xatoga biriktirgan.
  const attached = describeApiError(Object.assign(new Error('502 ...'), { body }));
  assert(attached.startsWith('Nutqni tanish (STT) bosqichida xato'), attached);
  assert(attached.includes("matn bilan yozib ko'ring"), 'maslahat');
  // 2) faqat matnda JSON bor.
  const inText = describeApiError(new Error(`502 ${JSON.stringify(body)}`));
  assert(inText.startsWith('Nutqni tanish (STT)'), inText);
  assert(!inText.includes('{'), "xom JSON yo'q");
  // 3) eski server: stage yo'q, xom JSON -> umumiy xabar.
  const legacy = describeApiError(new Error('500 {"error":"internal_error"}'));
  assert(!legacy.includes('{'), "xom JSON ko'rsatilmaydi");
});

// ---------------------------------------------------------------------------
await dbBlock();

console.log(
  `\nNatija: ${report.passed} o'tdi, ${report.failed} xato, ${report.skipped} tashlab ketildi.`,
);
if (report.failures.length > 0) {
  console.log('\nXatolar:');
  for (const failure of report.failures) console.log(` - ${failure}`);
}
process.exit(report.failed > 0 ? 1 : 0);
