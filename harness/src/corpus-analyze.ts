/**
 * FAQAT HARNESS. Mijoz tomoni tahlili (LLM — PULLIK, tasdiq so'raydi):
 *
 *   npm run corpus:analyze -- --ratings ~/Downloads/stt-ratings.csv
 *   npm run corpus:analyze                 (baho yo'q — eng yuqori kelishuvli model)
 *   npm run corpus:analyze -- --yes
 *
 * Har qo'ng'iroq uchun: tanlangan transkript -> LLM rollar (yorliq, matnga
 * tegmaydi) -> navbatlar -> LLM MIJOZ navbatlarini toifalaydi -> kod sanaydi.
 * Natija: `customer-style.json`, `CORPUS-REPORT.md`, `analysis/summary.json`.
 * LLM natijalari keshlanadi (qayta ishga tushirsa qayta chaqirilmaydi).
 * Mazmun faqat sozlangan OpenAI endpoint'iga ketadi — boshqa provayder bo'lsa to'xtaydi.
 */
// ENG BIRINCHI: harness/.env ni yuklaydi (yo'l harness papkasiga nisbatan).
import { envStr } from './env.js';

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { mergeTurns } from './corpus/analysis.js';
import { parseRatingsCsv, selectModel, type ModelCallMetrics } from './corpus/compare.js';
import {
  applyRoles,
  CLASSIFY_SYSTEM,
  classifySchema,
  classifyUserPrompt,
  ROLES_SYSTEM,
  rolesSchema,
  rolesUserPrompt,
  type ClassifyResult,
  type RolesResult,
} from './corpus/llm-tasks.js';
import { analysisDir, CORPUS_MODELS, corpusDir, shortId, transcriptPath } from './corpus/paths.js';
import {
  buildCorpusReport,
  buildStyleLibrary,
  summarizeCorpus,
  type CallAnalysis,
  type ModelQuality,
} from './corpus/report.js';
import { confirm, listCalls, openAiTarget, readJson, writeJson } from './corpus/setup.js';
import type { ModelTranscript } from './corpus/types.js';
import { resolveBusinessData } from './business-data.js';
import { baseUrlHost, createTrainerLlm, resolveProviderConfig } from './llm-factory.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const yes = args.includes('--yes');
  const ratingsPath = args.includes('--ratings') ? args[args.indexOf('--ratings') + 1] : undefined;

  // --- Faqat sozlangan OpenAI endpoint'i ------------------------------------
  const target = openAiTarget();
  const config = resolveProviderConfig();
  if (!target || config.provider !== 'openai-compatible' || !config.baseUrl ||
      baseUrlHost(config.baseUrl) !== new URL(target.baseUrl).host) {
    console.error(
      'To\'xtatildi: tahlil LLM\'i STT bilan bir xil OpenAI endpoint\'ida bo\'lishi shart ' +
        `(LLM: ${config.provider}${config.baseUrl ? ` ${baseUrlHost(config.baseUrl)}` : ''}). Qo'ng'iroq mazmuni boshqa provayderga yuborilmaydi.`,
    );
    process.exit(1);
  }

  const metrics = (await readJson<ModelCallMetrics[]>(resolve(analysisDir, 'stt-compare.json'))) ?? [];
  if (metrics.length === 0) {
    console.error('Avval: npm run corpus:compare');
    process.exit(1);
  }
  const ratings = ratingsPath ? parseRatingsCsv(await readFile(ratingsPath.replace(/^~/, process.env.HOME ?? '~'), 'utf8')) : [];
  console.log(ratingsPath ? `Baholar: ${ratings.length} ta.` : "Baholar berilmadi — har qo'ng'iroqda eng yuqori kelishuvli model olinadi.");

  const calls = await listCalls();
  const plan = calls
    .map((c) => ({ callId: c.callId, pick: selectModel(c.callId, metrics, ratings) }))
    .filter((p): p is { callId: string; pick: NonNullable<typeof p.pick> } => p.pick !== null);

  const cachePath = (callId: string, model: string, kind: string): string =>
    resolve(analysisDir, 'llm', `${callId}.${model}.${kind}.json`);
  const pendingCalls = (
    await Promise.all(
      plan.map(async (p) => ((await readJson(cachePath(p.callId, p.pick.model, 'classify'))) === null ? 1 : 0)),
    )
  ).reduce<number>((a, b) => a + b, 0);
  console.log(
    `Qo'ng'iroqlar: ${plan.length}; LLM kerak: ${pendingCalls} ta qo'ng'iroq × 2 chaqiruv (model: ${config.scoringModel}, ${baseUrlHost(config.baseUrl)}).`,
  );
  if (pendingCalls > 0 && !yes && !(await confirm("Davom etilsinmi? (ha/yo'q) "))) {
    console.log("To'xtatildi — pullik chaqiruv qilinmadi. Tasdiqsiz: npm run corpus:analyze -- --yes");
    return;
  }

  const llm = createTrainerLlm({ profile: resolveBusinessData(envStr('HARNESS_PROFILE')).profile, config, scoring: true }).llm;
  const analyses: CallAnalysis[] = [];
  for (const p of plan) {
    const transcript = await readJson<ModelTranscript>(transcriptPath(p.pick.model, p.callId));
    if (!transcript) continue;
    const useSpeakers = transcript.hasSpeakerLabels;

    let roles = await readJson<RolesResult>(cachePath(p.callId, p.pick.model, 'roles'));
    if (!roles) {
      roles = await llm.completeJson({
        stage: 'corpus.roles',
        system: ROLES_SYSTEM,
        user: rolesUserPrompt(transcript.segments, useSpeakers),
        schema: rolesSchema,
        outputSchema: rolesSchema,
      });
      await writeJson(cachePath(p.callId, p.pick.model, 'roles'), roles);
    }
    const segments = applyRoles(transcript.segments, roles, useSpeakers);
    const turns = mergeTurns(segments);

    let classify = await readJson<ClassifyResult>(cachePath(p.callId, p.pick.model, 'classify'));
    if (!classify) {
      classify = await llm.completeJson({
        stage: 'corpus.classify',
        system: CLASSIFY_SYSTEM,
        user: classifyUserPrompt(turns),
        schema: classifySchema,
        outputSchema: classifySchema,
      });
      await writeJson(cachePath(p.callId, p.pick.model, 'classify'), classify);
    }
    analyses.push({
      callId: p.callId,
      model: p.pick.model,
      selectedBy: p.pick.selectedBy,
      durationSec: transcript.durationSec,
      segments,
      turns,
      classify,
    });
    const customer = turns.filter((t) => t.role === 'customer').length;
    console.log(
      `[analiz] ${shortId(p.callId)} · ${p.pick.model} (${p.pick.selectedBy}) · ${turns.length} navbat, ${customer} mijoz`,
    );
  }

  const summary = summarizeCorpus(analyses);
  const models: ModelQuality[] = CORPUS_MODELS.map((model) => {
    const rows = metrics.filter((m) => m.model === model);
    const ok = rows.filter((m) => m.ok);
    const mean = (vals: number[]): number | null =>
      vals.length === 0 ? null : Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3));
    const rated = ratings.filter((r) => r.model === model).map((r) => r.rating);
    return {
      model,
      files: ok.length,
      failures: rows.length - ok.length,
      meanAgreement: mean(ok.map((m) => m.agreement).filter((v): v is number => v !== null)),
      meanLowQualityShare: mean(ok.map((m) => m.lowQualityShare).filter((v): v is number => v !== null)),
      speakerLabels: ok.some((m) => m.speakerLabels),
      meanRating: rated.length === 0 ? null : Number((rated.reduce((a, b) => a + b, 0) / rated.length).toFixed(2)),
    };
  });

  await writeJson(resolve(analysisDir, 'summary.json'), { summary, models, selection: plan });
  await writeJson(resolve(corpusDir, 'customer-style.json'), buildStyleLibrary(summary));
  await writeFile(resolve(corpusDir, 'CORPUS-REPORT.md'), buildCorpusReport(summary, models), 'utf8');
  console.log(
    `\nTayyor: ${summary.calls} qo'ng'iroq, ${summary.minutes} daqiqa, ${summary.customerTurns} mijoz navbati.` +
      '\nFayllar: harness/data/real-calls/customer-style.json, CORPUS-REPORT.md (faqat shu fayl ulashish uchun).',
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
