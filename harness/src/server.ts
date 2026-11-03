/**
 * FAQAT HARNESS. Modulning route plaginini lokal Fastify serverida ishga
 * tushiradi — React sahifalarini sinash uchun.
 *
 *   npm run serve        (http://127.0.0.1:5180)
 *
 * Soxta auth: `HARNESS_AUTH=1` bo'lganda foydalanuvchi header'lardan olinadi
 * (`x-user-id`, `x-business-id`, `x-supervisor`). Bu FAQAT lokal rejim:
 * `module/` bu fayldan hech narsa import qilmaydi va o'zi hech qachon
 * soxta auth yoqa olmaydi.
 *
 * LLM: `ANTHROPIC_API_KEY` bo'lsa haqiqiy model, bo'lmasa demo LLM
 * (`demo-llm.ts`) — UI ni kalitsiz ham sinash mumkin.
 */
// ENG BIRINCHI: harness/.env ni yuklaydi (yo'l harness papkasiga nisbatan).
import { envBool, envInt, envNum, envStr } from './env.js';

import Fastify from 'fastify';

import { registerTrainingRoutes } from '../../module/backend/src/training/routes.js';
import { createTrainingEngine } from '../../module/backend/src/training/engine.js';
import type { GetBusinessProfile, TrainingContext } from '../../module/backend/src/training/ports.js';
import { createScoringService } from '../../module/backend/src/training/scoring/scoring.js';
import { DEMO_BUSINESS_ID, DEMO_USER_ID, ensureDemoRows } from './demo-env.js';
import { BusinessDataError, describeBusinessData, resolveBusinessData } from './business-data.js';
import {
  createTrainerLlm,
  describeLlm,
  latencyWarnings,
  MissingLlmKeyError,
  printDemoBanner,
  printMissingKeyBanner,
  ProviderConfigError,
  resolveProviderConfig,
  startupLine,
} from './llm-factory.js';
import { priceCall } from './llm-anthropic.js';
import { appDatabaseUrl, createPool, createWithTenant } from './withTenant.js';
import {
  createVoiceService,
  describeVoiceCostRates,
  type VoiceService,
} from '../../module/backend/src/training/voice/voice-turn.js';
import {
  createOpenAiStt,
  createOpenAiTts,
  missingVoiceConfig,
  OpenAiVoiceConfigError,
  openAiVoiceConfigFromEnv,
} from './voice/openai.js';

// Bo'sh qiymat = default (avval bo'sh HARNESS_PORT port 0 ga aylanardi).
const PORT = envInt('HARNESS_PORT', 5180, { min: 1, max: 65535 });
/** Bo'sh — `harness/data/business-profile.json`; kalit — o'sha demo profil. */
const DEMO_PROFILE_KEY = envStr('HARNESS_PROFILE');

async function main(): Promise<void> {
  // Profil va skript startda o'qiladi (fayl o'zgarsa — serverni qayta ishga tushiring).
  const business = resolveBusinessData(DEMO_PROFILE_KEY);
  const profile = business.profile;
  console.log(describeBusinessData(business));
  await ensureDemoRows();

  const pool = createPool(appDatabaseUrl());
  const withTenant = createWithTenant(pool);
  const getBusinessProfile: GetBusinessProfile = async () => profile;

  // Kalit yo'q bo'lsa JIM demo'ga o'tilmaydi: yo DEMO_LLM=1, yo to'xtash.
  const config = resolveProviderConfig();
  console.log(startupLine(config));
  for (const warning of latencyWarnings(config)) console.warn(warning);
  let turnLlm;
  let scoringResolved;
  try {
    turnLlm = createTrainerLlm({ profile, config });
    scoringResolved = createTrainerLlm({ profile, config, scoring: true });
  } catch (err) {
    if (err instanceof MissingLlmKeyError) {
      printMissingKeyBanner('serve', err.config);
      process.exit(1);
    }
    throw err;
  }
  if (turnLlm.isDemo) printDemoBanner('serve');
  const llm = turnLlm.llm;
  const scoringLlm = scoringResolved.llm;

  const app = Fastify({ logger: { level: envStr('LOG_LEVEL') ?? 'warn' } });

  const engine = createTrainingEngine({ withTenant, getBusinessProfile, llm, priceCall });
  const scoring = createScoringService({
    withTenant,
    llm: scoringLlm,
    priceCall,
    // Baholash sotuvchining da'volarini shu faktlar bilan tekshiradi.
    getBusinessProfile,
    getSalesScript: async () => business.script,
    // Bir sessiyada bir vaqtda bitta baholash; shundan eski `pending` — o'lik (jarayon to'xtagan).
    pendingStaleAfterMs: config.scoringTimeoutMs * 4,
    logger: app.log,
  });

  // Oldingi jarayon baholash paytida to'xtagan bo'lsa (Ctrl+C) natija abadiy
  // `pending` qolardi: baholash timeout'idan eski `pending` larni `failed`
  // qilamiz — UI ularni "Qayta baholash" bilan qayta boshlay oladi.
  const recovered = await scoring.failStalePending(DEMO_BUSINESS_ID, {
    olderThanMs: config.scoringTimeoutMs,
  });
  if (recovered > 0) {
    console.log(`Osilib qolgan baholashlar: ${recovered} ta "failed" qilindi (server qayta ishga tushdi).`);
  }

  // --- Ovozli rejim: sozlama to'liq bo'lsa yoqiladi -----------------------
  // Model nomlari env'dan keladi (`npm run diag:voice` tavsiya qiladi).
  // To'liq bo'lmasa ovoz route'lari UMUMAN ro'yxatga olinmaydi va UI buni
  // `_harness` dan bilib, matnli rejimda qolaveradi.
  const voiceConfig = openAiVoiceConfigFromEnv();
  let voice: VoiceService | undefined;
  if (voiceConfig) {
    const rates = {
      sttPerMinuteUsd: envNum('OPENAI_STT_PRICE_PER_MIN'),
      ttsPerMillionCharsUsd: envNum('OPENAI_TTS_PRICE_PER_1M_CHARS'),
    };
    voice = createVoiceService({
      engine,
      withTenant,
      stt: createOpenAiStt(voiceConfig),
      tts: createOpenAiTts(voiceConfig),
      models: {
        stt: voiceConfig.sttModel,
        tts: voiceConfig.ttsModel,
        voice: voiceConfig.ttsVoice,
      },
      getBusinessProfile,
      cost: rates,
      maxMinutesPerSession: envInt('VOICE_MAX_MINUTES_PER_SESSION', 10, { min: 1, max: 600 }),
      logger: app.log,
    });
    console.log(
      `Ovoz: stt=${voiceConfig.sttModel}` +
        ` · stt-til=${voiceConfig.sttLanguageMode ?? 'omit'}` +
        ` · tts=${voiceConfig.ttsModel}${voiceConfig.ttsVoice ? ` (${voiceConfig.ttsVoice})` : ''}` +
        ` · host=${new URL(voiceConfig.baseUrl).host} · kalit ${voiceConfig.keyEnv}=o'rnatilgan`,
    );
    console.log(describeVoiceCostRates(rates));
  } else {
    console.log(
      `Ovoz: O'CHIRILGAN — yetishmayotgan env: ${missingVoiceConfig().join(', ')}` +
        ' (aniqlash: npm run diag:voice)',
    );
  }

  // Default YOQILGAN: bo'sh HARNESS_AUTH avval auth'ni o'chirib, UI 401 olardi.
  // O'chirish faqat aniq HARNESS_AUTH=0 bilan.
  const fakeAuth = envBool('HARNESS_AUTH', true);

  await registerTrainingRoutes(app, {
    engine,
    scoring,
    withTenant,
    getContext: (req): TrainingContext => {
      if (!fakeAuth) {
        throw new Error('HARNESS_AUTH=1 bo\'lishi kerak (lokal soxta auth)');
      }
      const headers = req.headers as Record<string, string | undefined>;
      return {
        businessId: headers['x-business-id'] ?? DEMO_BUSINESS_ID,
        userId: headers['x-user-id'] ?? DEMO_USER_ID,
        seatId: null,
      };
    },
    authorize: (_ctx, permission) => {
      if (permission === 'training:view:all') {
        // Lokal rejimda rahbar huquqi faqat header bilan beriladi.
        return;
      }
    },
    ...(voice ? { voice } : {}),
    config: { allowDebug: true, autoScoreOnEnd: true, rateLimitPerMinute: 240 },
    logger: app.log,
  });

  // Profil va rejim haqida ma'lumot (frontend ko'rsatishi uchun).
  app.get('/api/v1/training/_harness', async () => ({
    profileKey: business.source,
    hasSalesScript: business.script !== null,
    industry: profile.industry,
    callDirection: profile.callDirection,
    llm: turnLlm.provider,
    model: turnLlm.model,
    scoringModel: scoringResolved.model,
    isDemo: turnLlm.isDemo,
    // UI shundan bilib ovoz boshqaruvini ko'rsatadi (yoki ko'rsatmaydi).
    voice: voice
      ? { enabled: true, sttModel: voiceConfig?.sttModel, ttsModel: voiceConfig?.ttsModel }
      : { enabled: false, missing: missingVoiceConfig() },
    debug: true,
  }));

  await app.listen({ port: PORT, host: '127.0.0.1' });
  console.log(`\nHarness backend: http://127.0.0.1:${PORT}`);
  console.log(`Profil: ${business.source} (${profile.industry})`);
  console.log(`LLM:    ${describeLlm(turnLlm)}`);
  console.log(`Baholash: ${describeLlm(scoringResolved)}`);
  console.log(`Soxta auth: ${fakeAuth ? 'yoqilgan (HARNESS_AUTH=1)' : "O'CHIRILGAN"}\n`);

  const shutdown = async (): Promise<void> => {
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  if ((err as { code?: string } | null)?.code === 'ECONNREFUSED') {
    console.error(
      `\n[DB] Postgres'ga ulanib bo'lmadi (${(err as { address?: string }).address ?? '127.0.0.1'}:${
        (err as { port?: number }).port ?? '?'
      }). Ishga tushiring: npm run db:local:start (yoki npm run db:up), keyin qayta: npm run dev\n`,
    );
    process.exit(1);
  }
  if (err instanceof BusinessDataError) {
    console.error(`\n[biznes ma'lumotlari xatosi] ${err.message}\n`);
    process.exit(1);
  }
  if (err instanceof OpenAiVoiceConfigError) {
    console.error(`\n[ovoz sozlamasi xatosi] ${err.message}\n`);
    process.exit(1);
  }
  if (err instanceof ProviderConfigError) {
    console.error(`\n[sozlama xatosi] ${err.message}\n`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
