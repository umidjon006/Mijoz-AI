/**
 * FAQAT HARNESS. Haqiqiy qo'ng'iroqlar korpusi — BEPUL taxmin:
 *
 *   npm run corpus:estimate
 *
 * ffprobe (davomiylik, bitreyt, kanallar), stereo bo'lsa kanallar
 * so'zlovchilarga ajratilganmi, bo'laklash rejasi, kalitga ochiq modellar
 * (GET /models — bepul), har model uchun qolgan daqiqalar va narx taxmini.
 * Hech qanday transkripsiya qilinmaydi; mazmun chiqmaydi.
 */
// ENG BIRINCHI: harness/.env ni yuklaydi (yo'l harness papkasiga nisbatan).
import './env.js';

import { existsSync } from 'node:fs';

import { listOpenAiModels } from './voice/openai.js';
import { checkFfmpeg } from './corpus/audio.js';
import { CORPUS_MODELS, transcriptPath, shortId } from './corpus/paths.js';
import { intake, listCalls, minutes, openAiTarget, sttPricePerMin } from './corpus/setup.js';

async function main(): Promise<void> {
  const ff = checkFfmpeg();
  if (!ff.ok) {
    console.error(`Topilmadi: ${ff.missing.join(', ')}. O'rnating:  sudo apt install ffmpeg`);
    process.exit(1);
  }
  const calls = await listCalls();
  if (calls.length === 0) {
    console.log("harness/data/real-calls/audio/ bo'sh — fayllarni shu yerga qo'ying.");
    return;
  }

  console.log('id      davomiylik  bitreyt  kanal  ajratilgan  bo\'laklar');
  let totalSec = 0;
  for (const call of calls) {
    const info = intake(call);
    totalSec += info.probe.durationSec;
    const sep = info.channels === null ? '— (mono)' : info.channels.separated ? `ha (${Math.round(info.channels.dominantShare * 100)}%)` : `yo'q (${Math.round(info.channels.dominantShare * 100)}%)`;
    console.log(
      `${shortId(call.callId)}  ${info.probe.durationSec.toFixed(1).padStart(8)} s  ${String(Math.round(info.probe.bitRate / 1000)).padStart(4)}k  ` +
        `${String(info.probe.channels).padStart(5)}  ${sep.padEnd(10)}  ${info.chunks.length}`,
    );
  }
  console.log(`\nJami: ${calls.length} ta fayl, ${minutes(totalSec)} daqiqa audio.`);

  const target = openAiTarget();
  if (!target) {
    console.log("OPENAI_API_KEY bo'sh — modellar ro'yxatini tekshirib bo'lmadi.");
  } else {
    try {
      const available = new Set((await listOpenAiModels({ apiKey: target.apiKey, baseUrl: target.baseUrl })).map((m) => m.id));
      for (const model of CORPUS_MODELS) console.log(`  ${model}: ${available.has(model) ? 'kalitga ochiq' : "KALITGA OCHIQ EMAS"}`);
    } catch (err) {
      console.log(`Modellar ro'yxati olinmadi: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
    }
    console.log(`STT til rejimi: ${target.languageMode}; lug'at ishoralari: ${target.hints.length} ta.`);
  }

  // Davom ettirish: tugagan fayllar qayta pullik chaqirilmaydi.
  const price = sttPricePerMin();
  let pendingTotal = 0;
  console.log('\nModel                         tugagan  qolgan  qolgan daqiqa  narx');
  for (const model of CORPUS_MODELS) {
    const pending = calls.filter((c) => !existsSync(transcriptPath(model, c.callId)));
    let pendingSec = 0;
    for (const call of pending) pendingSec += intake(call).probe.durationSec;
    pendingTotal += pendingSec;
    console.log(
      `${model.padEnd(28)} ${String(calls.length - pending.length).padStart(7)}  ${String(pending.length).padStart(6)}  ` +
        `${minutes(pendingSec).padStart(13)}  ${price === null ? "narx noma'lum" : `≈ $${((pendingSec / 60) * price).toFixed(3)}`}`,
    );
  }
  console.log(
    `\nJami qolgan: ${minutes(pendingTotal)} daqiqa` +
      (price === null
        ? " — narx noma'lum (OPENAI_STT_PRICE_PER_MIN bo'sh). OpenAI narx sahifasidagi har model daqiqa narxiga ko'paytiring."
        : ` ≈ $${((pendingTotal / 60) * price).toFixed(3)} (hamma modelga bir xil narx deb; diarize modeli qimmatroq bo'lishi mumkin).`),
  );
  console.log("Tahlil (corpus:analyze): har qo'ng'iroqqa 2 ta LLM chaqiruvi (rollar + toifalash).");
  console.log('Hech qanday pullik chaqiruv qilinmadi.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
