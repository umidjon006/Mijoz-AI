/**
 * FAQAT HARNESS. Model bake-off: bir xil mashqni har nomzod modeli bilan
 * o'ynab, o'lchanadigan hamma narsani o'lchaydi.
 *
 *   npm run bakeoff -- [--yes] [--n 3] [--profile o_quv_markaz] [--only haiku]
 *
 * MUHIM:
 *  - engine mantig'i O'ZGARMAYDI — faqat `TrainerLlm` almashtiriladi;
 *  - sotuvchi tomoni hamma nomzod uchun BIR XIL model bilan o'ynaladi;
 *  - natijalar `harness/bakeoff/out/runs.jsonl` ga DARHOL yoziladi, shuning
 *    uchun to'xtatilgan ishni qaytadan boshlash shart emas (resume);
 *  - pulli chaqiruvlardan OLDIN taxminiy narx chiqadi va tasdiq so'raladi.
 */
// ENG BIRINCHI: harness/.env ni yuklaydi (yo'l harness papkasiga nisbatan).
import './env.js';

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { ARCHETYPE_KEYS } from '../../module/backend/src/training/archetypes.js';
import { createTrainingEngine } from '../../module/backend/src/training/engine.js';
import type {
  GetBusinessProfile,
  TokenUsage,
  TrainerLlm,
  TrainingContext,
} from '../../module/backend/src/training/ports.js';
import type { BusinessProfile } from '../../module/backend/src/training/profile-schema.js';
import {
  bakeoffOutDir,
  loadBakeoffConfig,
  splitByKeyAvailability,
  type BakeoffConfig,
  type Candidate,
} from './bakeoff/config.js';
import {
  costOf,
  estimateCost,
  isTooLong,
  isWrongLanguage,
  type CostEstimate,
} from './bakeoff/metrics.js';
import {
  runKey,
  SELLER_SCRIPTS,
  sessionRunSchema,
  type LlmCallEvent,
  type SellerScript,
  type SessionRun,
} from './bakeoff/types.js';
import { DEMO_BUSINESS_ID, DEMO_USER_ID, ensureDemoRows, loadDemoProfile } from './demo-env.js';
import { createAnthropicTrainerLlm } from './llm-anthropic.js';
import { createOpenAiCompatibleLlm } from './llm-openai-compatible.js';
import { createSellerBot } from './seller-bot.js';
import { appDatabaseUrl, createPool, createWithTenant } from './withTenant.js';

const runsFile = resolve(bakeoffOutDir, 'runs.jsonl');

interface Args {
  yes: boolean;
  n?: number;
  profile?: string;
  only?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const n = get('n');
  const profile = get('profile');
  const only = get('only');
  return {
    yes: argv.includes('--yes'),
    ...(n ? { n: Number(n) } : {}),
    ...(profile ? { profile } : {}),
    ...(only ? { only } : {}),
  };
}

/** Nomzod uchun `TrainerLlm` yasaydi (kalitni env'dan oladi). */
function createCandidateLlm(candidate: Candidate, onCall: (event: LlmCallEvent) => void): TrainerLlm {
  const apiKey = process.env[candidate.apiKeyEnv];
  if (!apiKey) throw new Error(`${candidate.label}: ${candidate.apiKeyEnv} env yo'q`);

  if (candidate.provider === 'anthropic') {
    return createAnthropicTrainerLlm({
      apiKey,
      model: candidate.model,
      maxTokens: candidate.maxTokens,
      onCall,
    });
  }
  if (!candidate.baseUrl) throw new Error(`${candidate.label}: baseUrl yo'q`);
  return createOpenAiCompatibleLlm({
    apiKey,
    baseUrl: candidate.baseUrl,
    model: candidate.model,
    maxTokens: candidate.maxTokens,
    jsonMode: candidate.jsonMode,
    onCall,
  });
}

/** Avval yozilgan natijalar (resume uchun). */
export async function loadExistingRuns(file = runsFile): Promise<Map<string, SessionRun>> {
  const out = new Map<string, SessionRun>();
  if (!existsSync(file)) return out;

  const raw = await readFile(file, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const run = sessionRunSchema.parse(JSON.parse(trimmed));
      out.set(run.key, run); // keyingi yozuv eskisining ustiga yozadi
    } catch {
      // Buzuq qator — jim o'tkazib yuboriladi (fayl qo'lda tahrirlangan bo'lishi mumkin).
    }
  }
  return out;
}

interface PlanItem {
  candidate: Candidate;
  archetype: string;
  script: SellerScript;
  profileKey: string;
  rep: number;
  key: string;
}

/** To'liq matritsa: nomzod × arxetip × skript × takror (+ ikkinchi profil). */
export function buildPlan(config: BakeoffConfig, candidates: readonly Candidate[]): PlanItem[] {
  const plan: PlanItem[] = [];
  for (const candidate of candidates) {
    for (const archetype of ARCHETYPE_KEYS) {
      for (const script of SELLER_SCRIPTS) {
        for (let rep = 1; rep <= config.repetitions; rep += 1) {
          const item = {
            candidate: candidate.label,
            archetype,
            script,
            profile: config.defaultProfile,
            rep,
          };
          plan.push({
            candidate,
            archetype,
            script,
            profileKey: config.defaultProfile,
            rep,
            key: runKey(item),
          });
        }
      }
    }
    // Domen umumiyligi: ikkinchi profil, bitta arxetip.
    if (config.secondProfile) {
      for (const script of SELLER_SCRIPTS) {
        for (let rep = 1; rep <= config.repetitions; rep += 1) {
          const item = {
            candidate: candidate.label,
            archetype: config.secondProfileArchetype,
            script,
            profile: config.secondProfile,
            rep,
          };
          plan.push({
            candidate,
            archetype: config.secondProfileArchetype,
            script,
            profileKey: config.secondProfile,
            rep,
            key: runKey(item),
          });
        }
      }
    }
  }
  return plan;
}

function printEstimate(estimate: CostEstimate, config: BakeoffConfig): void {
  console.log(
    `\nMatritsa: ${estimate.sessionsPerCandidate} sessiya/nomzod × ` +
      `${estimate.perCandidate.length} nomzod = ${estimate.totalSessions} sessiya`,
  );
  console.log(
    `Chaqiruvlar: ~${estimate.customerCalls} mijoz + ~${estimate.sellerCalls} sotuvchi ` +
      `(sessiyada ${config.maxTurnsPerSession} navbatgacha)`,
  );
  console.log(
    `Tokenlar (taxminiy): ${estimate.tokens.input.toLocaleString()} kirish / ` +
      `${estimate.tokens.output.toLocaleString()} chiqish`,
  );
  for (const row of estimate.perCandidate) {
    console.log(`  ${row.label.padEnd(16)} ${row.sessions} sessiya  ~$${row.costUsd.toFixed(3)}`);
  }
  console.log(`  ${'(sotuvchi modeli)'.padEnd(16)} ~$${estimate.sellerCostUsd.toFixed(3)}`);
  console.log(`TAXMINIY JAMI: ~$${estimate.totalCostUsd.toFixed(2)}`);
  console.log('(taxmin; haqiqiy narx promptlar uzunligiga qarab farq qiladi)');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadBakeoffConfig();
  if (args.n) config.repetitions = args.n;
  if (args.profile) config.defaultProfile = args.profile;

  const selected = args.only
    ? config.candidates.filter((c) => c.label === args.only)
    : config.candidates;
  if (selected.length === 0) {
    console.error(`"${args.only ?? ''}" nomli nomzod topilmadi.`);
    process.exit(1);
  }

  const { ready, missingKey } = splitByKeyAvailability(selected);
  for (const candidate of missingKey) {
    console.log(
      `[o'tkazib yuborildi] ${candidate.label}: ${candidate.apiKeyEnv} env yo'q (harness/.env)`,
    );
  }
  if (ready.length === 0) {
    console.error('\nIshga tushirish uchun kamida bitta nomzod kerak (kalit bilan).');
    process.exit(1);
  }

  const sellerKey = process.env[config.sellerApiKeyEnv];
  if (!sellerKey) {
    console.error(`\nSotuvchi modeli uchun ${config.sellerApiKeyEnv} env kerak.`);
    process.exit(1);
  }

  await mkdir(bakeoffOutDir, { recursive: true });
  const existing = await loadExistingRuns();
  const plan = buildPlan(config, ready);
  const todo = plan.filter((item) => !existing.has(item.key));

  console.log(`Nomzodlar: ${ready.map((c) => `${c.label} (${c.model})`).join(', ')}`);
  console.log(`Sotuvchi modeli: ${config.sellerModel} (hamma nomzod uchun bir xil)`);
  if (existing.size > 0) {
    console.log(`Avval bajarilgan: ${existing.size} sessiya — ular qayta ishlanmaydi (resume).`);
  }
  console.log(`Bajariladi: ${todo.length} sessiya`);

  if (todo.length === 0) {
    console.log('\nHammasi allaqachon bajarilgan. Hisobot: npm run bakeoff:report');
    return;
  }

  const sellerPrice = ready.find((c) => c.model === config.sellerModel)?.pricePerMTok ?? {
    input: 3,
    output: 15,
  };
  const estimate = estimateCost({
    candidates: ready,
    archetypes: ARCHETYPE_KEYS.length,
    scripts: SELLER_SCRIPTS.length,
    repetitions: config.repetitions,
    extraSessionsPerCandidate: config.secondProfile
      ? SELLER_SCRIPTS.length * config.repetitions
      : 0,
    maxTurnsPerSession: config.maxTurnsPerSession,
    sellerPrice,
  });
  printEstimate(estimate, config);
  if (existing.size > 0) {
    console.log(`(resume: ${existing.size} sessiya allaqachon bor, ular uchun to'lanmaydi)`);
  }

  if (!args.yes) {
    const rl = createInterface({ input, output });
    const answer = (await rl.question('\nDavom etamizmi? (yes/no) ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'yes' && answer !== 'y') {
      console.log('Bekor qilindi.');
      return;
    }
  }

  await ensureDemoRows();
  const pool = createPool(appDatabaseUrl());
  const withTenant = createWithTenant(pool);
  const ctx: TrainingContext = {
    businessId: DEMO_BUSINESS_ID,
    userId: DEMO_USER_ID,
    seatId: null,
  };

  const sellerLlm = createAnthropicTrainerLlm({
    apiKey: sellerKey,
    model: config.sellerModel,
    maxTokens: 512,
  });

  const profileCache = new Map<string, BusinessProfile>();
  const profileOf = (key: string): BusinessProfile => {
    const cached = profileCache.get(key);
    if (cached) return cached;
    const profile = loadDemoProfile(key);
    profileCache.set(key, profile);
    return profile;
  };

  let done = 0;
  try {
    for (const item of todo) {
      done += 1;
      const label = `${item.candidate.label}/${item.archetype}/${item.script}/${item.profileKey}#${item.rep}`;
      process.stdout.write(`[${done}/${todo.length}] ${label} … `);

      const run = await runOneSession({
        item,
        config,
        ctx,
        withTenant,
        sellerLlm,
        profile: profileOf(item.profileKey),
      });

      await appendFile(runsFile, `${JSON.stringify(run)}\n`, 'utf8');
      console.log(
        run.error
          ? `XATO: ${run.error.slice(0, 80)}`
          : `${run.outcome ?? 'tugamadi'} · ${run.turns} navbat · ${Math.round(
              run.latenciesMs.reduce((a, b) => a + b, 0) / Math.max(1, run.latenciesMs.length),
            )}ms · $${run.costUsd.toFixed(4)}`,
      );
    }
  } finally {
    await pool.end();
  }

  const all = await loadExistingRuns();
  const totalCost = [...all.values()].reduce((sum, r) => sum + r.costUsd, 0);
  console.log(`\nTayyor. Jami ${all.size} sessiya, haqiqiy narx ~$${totalCost.toFixed(3)}`);
  console.log(`Natijalar: ${runsFile}`);
  console.log('Keyingi qadam: npm run bakeoff:report');
}

interface RunOneInput {
  item: PlanItem;
  config: BakeoffConfig;
  ctx: TrainingContext;
  withTenant: ReturnType<typeof createWithTenant>;
  sellerLlm: TrainerLlm;
  profile: BusinessProfile;
}

async function runOneSession({
  item,
  config,
  ctx,
  withTenant,
  sellerLlm,
  profile,
}: RunOneInput): Promise<SessionRun> {
  const startedAt = new Date();
  const started = Date.now();

  const calls = { total: 0, firstTryOk: 0, afterRetryOk: 0, failed: 0 };
  const latenciesMs: number[] = [];
  const tokens = { input: 0, output: 0 };

  const onCall = (event: LlmCallEvent): void => {
    if (!event.stage.startsWith('training.')) return;
    calls.total += 1;
    if (!event.ok) calls.failed += 1;
    else if (event.attempts === 1) calls.firstTryOk += 1;
    else calls.afterRetryOk += 1;
    if (event.usage) {
      tokens.input += event.usage.inputTokens;
      tokens.output += event.usage.outputTokens;
    }
  };

  const customerLlm = createCandidateLlm(item.candidate, onCall);
  const getBusinessProfile: GetBusinessProfile = async () => profile;
  const engine = createTrainingEngine({ withTenant, getBusinessProfile, llm: customerLlm });
  const seller = createSellerBot(item.script, { llm: sellerLlm, profile });

  const transcript: Array<{ speaker: 'seller' | 'customer'; text: string }> = [];
  const lines: string[] = [];
  let turns = 0;
  let outcome: string | null = null;
  let endReason: string | null = null;
  let guardViolations = 0;
  let tooLongReplies = 0;
  let wrongLanguageReplies = 0;
  let customerReplies = 0;
  let personaName: string | null = null;
  let error: string | null = null;

  try {
    const session = await engine.startSession(ctx, { archetypeKey: item.archetype });
    personaName = session.persona.name;
    const language = session.persona.language;

    if (session.openingLine) {
      transcript.push({ speaker: 'customer', text: session.openingLine });
      lines.push(`CUSTOMER: ${session.openingLine}`);
      customerReplies += 1;
      if (isTooLong(session.openingLine)) tooLongReplies += 1;
      if (isWrongLanguage(session.openingLine, language)) wrongLanguageReplies += 1;
    }

    for (let i = 0; i < config.maxTurnsPerSession; i += 1) {
      const sellerText = await seller.next(lines, i);
      if (sellerText === null) break;

      transcript.push({ speaker: 'seller', text: sellerText });
      lines.push(`SELLER: ${sellerText}`);

      const result = await engine.takeTurn(ctx, {
        sessionId: session.sessionId,
        sellerText,
      });
      turns = result.turnCount;
      latenciesMs.push(result.meta.latencyMs);
      customerReplies += 1;
      if (isTooLong(result.customerReply)) tooLongReplies += 1;
      if (isWrongLanguage(result.customerReply, language)) wrongLanguageReplies += 1;

      transcript.push({ speaker: 'customer', text: result.customerReply });
      lines.push(`CUSTOMER: ${result.customerReply}`);
      guardViolations = result.state.flags.guardViolations;

      if (result.ended) {
        outcome = result.outcome ?? null;
        endReason = result.endReason ?? null;
        break;
      }
    }

    if (outcome === null) {
      await engine
        .endSession(ctx, { sessionId: session.sessionId, reason: 'bakeoff_script_finished' })
        .catch(() => undefined);
      endReason = 'script_finished';
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const usage: TokenUsage = { inputTokens: tokens.input, outputTokens: tokens.output };
  return sessionRunSchema.parse({
    key: item.key,
    candidate: item.candidate.label,
    model: item.candidate.model,
    archetype: item.archetype,
    script: item.script,
    profile: item.profileKey,
    rep: item.rep,
    outcome,
    endReason,
    turns,
    guardViolations,
    customerCalls: calls,
    latenciesMs,
    tokens: { input: usage.inputTokens, output: usage.outputTokens },
    costUsd: Number(costOf(tokens, item.candidate.pricePerMTok).toFixed(6)),
    tooLongReplies,
    wrongLanguageReplies,
    customerReplies,
    transcript,
    personaName,
    error,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - started,
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { runsFile };
