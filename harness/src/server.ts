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
import './env.js';

import Fastify from 'fastify';

import { registerTrainingRoutes } from '../../module/backend/src/training/routes.js';
import { createTrainingEngine } from '../../module/backend/src/training/engine.js';
import type { GetBusinessProfile, TrainingContext } from '../../module/backend/src/training/ports.js';
import { createScoringService } from '../../module/backend/src/training/scoring/scoring.js';
import {
  DEMO_BUSINESS_ID,
  DEMO_USER_ID,
  ensureDemoRows,
  listDemoProfileKeys,
  loadDemoProfile,
} from './demo-env.js';
import {
  createTrainerLlm,
  describeLlm,
  MissingLlmKeyError,
  printDemoBanner,
  printMissingKeyBanner,
  ProviderConfigError,
  resolveProviderConfig,
  startupLine,
} from './llm-factory.js';
import { priceCall } from './llm-anthropic.js';
import { appDatabaseUrl, createPool, createWithTenant } from './withTenant.js';

const PORT = Number(process.env.HARNESS_PORT ?? 5180);
const PROFILE_KEY = process.env.HARNESS_PROFILE ?? listDemoProfileKeys()[0] ?? '';

async function main(): Promise<void> {
  const profile = loadDemoProfile(PROFILE_KEY);
  await ensureDemoRows();

  const pool = createPool(appDatabaseUrl());
  const withTenant = createWithTenant(pool);
  const getBusinessProfile: GetBusinessProfile = async () => profile;

  // Kalit yo'q bo'lsa JIM demo'ga o'tilmaydi: yo DEMO_LLM=1, yo to'xtash.
  const config = resolveProviderConfig();
  console.log(startupLine(config));
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

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });

  const engine = createTrainingEngine({ withTenant, getBusinessProfile, llm, priceCall });
  const scoring = createScoringService({
    withTenant,
    llm: scoringLlm,
    priceCall,
    logger: app.log,
  });

  const fakeAuth = process.env.HARNESS_AUTH === '1';

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
    config: { allowDebug: true, autoScoreOnEnd: true, rateLimitPerMinute: 240 },
    logger: app.log,
  });

  // Profil va rejim haqida ma'lumot (frontend ko'rsatishi uchun).
  app.get('/api/v1/training/_harness', async () => ({
    profileKey: PROFILE_KEY,
    industry: profile.industry,
    callDirection: profile.callDirection,
    llm: turnLlm.provider,
    model: turnLlm.model,
    scoringModel: scoringResolved.model,
    isDemo: turnLlm.isDemo,
    debug: true,
  }));

  await app.listen({ port: PORT, host: '127.0.0.1' });
  console.log(`\nHarness backend: http://127.0.0.1:${PORT}`);
  console.log(`Profil: ${PROFILE_KEY} (${profile.industry})`);
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
  if (err instanceof ProviderConfigError) {
    console.error(`\n[sozlama xatosi] ${err.message}\n`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
