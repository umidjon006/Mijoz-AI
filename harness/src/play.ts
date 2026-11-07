/**
 * FAQAT LOKAL HARNESS. Terminalda mashq qilish:
 *
 *   npm run play -- --archetype negotiator --profile o_quv_markaz [--direction inbound] [--debug]
 *
 * Siz sotuvchi bo'lib yozasiz, AI mijoz javob beradi. `--debug` har navbatdan
 * keyin holat, e'tirozlar, readiness, guard va kechikishni ko'rsatadi.
 * Chiqish: `/stop` (sessiya `abandoned` bo'ladi) yoki Ctrl+C.
 */
// ENG BIRINCHI: harness/.env ni yuklaydi (yo'l harness papkasiga nisbatan).
import './env.js';

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { getArchetype } from '../../module/backend/src/training/archetypes.js';
import { createTrainingEngine } from '../../module/backend/src/training/engine.js';
import { isTrainingError } from '../../module/backend/src/training/errors.js';
import type { GetBusinessProfile } from '../../module/backend/src/training/ports.js';
import {
  DEMO_CONTEXT,
  ensureDemoRows,
  parseArgs,
} from './demo-env.js';
import { BusinessDataError, describeBusinessData, resolveBusinessData } from './business-data.js';
import { priceCall } from './llm-anthropic.js';
import {
  createTrainerLlm,
  describeLlm,
  MissingLlmKeyError,
  printDemoBanner,
  printMissingKeyBanner,
  ProviderConfigError,
  startupLine,
} from './llm-factory.js';
import { appDatabaseUrl, createPool, createWithTenant } from './withTenant.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const archetype = getArchetype(args.archetype);
  const business = resolveBusinessData(args.profile);
  const profile = business.profile;

  await ensureDemoRows();

  const pool = createPool(appDatabaseUrl());
  const withTenant = createWithTenant(pool);
  const getBusinessProfile: GetBusinessProfile = async () => profile;
  console.log(startupLine());

  let resolved;
  try {
    resolved = createTrainerLlm({ profile });
  } catch (err) {
    if (err instanceof MissingLlmKeyError) {
      printMissingKeyBanner('play', err.config);
      process.exit(1);
    }
    throw err;
  }
  if (resolved.isDemo) printDemoBanner('play');
  const engine = createTrainingEngine({
    withTenant,
    getBusinessProfile,
    llm: resolved.llm,
    priceCall,
  });

  const rl = createInterface({ input, output });

  console.log(`\nArxetip: ${archetype.key} — ${archetype.title} (qiyinlik ${archetype.difficulty}/5)`);
  console.log(describeBusinessData(business));
  console.log(`LLM:     ${describeLlm(resolved)}`);
  console.log('Persona generatsiya qilinyapti...\n');

  const started = await engine.startSession(DEMO_CONTEXT, {
    archetypeKey: archetype.key,
    ...(args.direction ? { direction: args.direction } : {}),
  });

  const persona = started.persona;
  console.log(
    `Mijoz: ${persona.name}, ${persona.age} yosh, ${persona.role} — ${
      persona.direction === 'inbound' ? "o'zi qo'ng'iroq qildi" : "siz qo'ng'iroq qildingiz"
    }`,
  );
  console.log(`Mavzu: ${persona.focusOffer}`);
  if (args.debug) {
    console.log(`Vaziyat: ${persona.situation}`);
    console.log(`Maqsad: ${persona.goal}`);
    console.log(
      `E'tirozlar: ${persona.objections.map((o) => `${o.key}(${o.severity})`).join(', ')}`,
    );
    if (persona.hiddenNeed) console.log(`Yashirin ehtiyoj: ${persona.hiddenNeed}`);
  }
  console.log(`Maksimal navbat: ${archetype.maxTurns}\n`);

  if (started.openingLine) {
    console.log(`MIJOZ: ${started.openingLine}\n`);
  }

  let totalCost = 0;
  let ended = false;

  try {
    while (!ended) {
      const sellerText = (await rl.question('SIZ:   ')).trim();
      if (sellerText.length === 0) continue;
      if (sellerText === '/stop') {
        await engine.endSession(DEMO_CONTEXT, {
          sessionId: started.sessionId,
          reason: 'user_stopped',
        });
        console.log('\nSessiya tashlab ketildi (abandoned).');
        break;
      }

      try {
        const result = await engine.takeTurn(DEMO_CONTEXT, {
          sessionId: started.sessionId,
          sellerText,
        });
        totalCost += result.meta.costUsd;
        console.log(`\nMIJOZ: ${result.customerReply}\n`);

        if (args.debug) {
          const s = result.state;
          const nextReadiness = result.meta.readiness;
          console.log(
            [
              `  [debug] navbat ${result.turnCount}/${archetype.maxTurns}`,
              `  patience=${s.patience} trust=${s.trust} interest=${s.interest}`,
              `  e'tirozlar: ko'tarilgan=[${s.flags.objectionsRaised.join(', ')}] yechilgan=[${s.flags.objectionsResolved.join(', ')}]`,
              `  needRevealed=${s.flags.needRevealed} guardViolations=${s.flags.guardViolations}`,
              `  (navbat boshida) readyToAgree=${nextReadiness.readyToAgree}${
                nextReadiness.blockers.length > 0
                  ? ` blockers=[${nextReadiness.blockers.join(' | ')}]`
                  : ''
              }`,
              `  intent=${result.meta.intent} guardRetried=${result.meta.guardRetried} guardViolated=${result.meta.guardViolated}`,
              `  latency=${result.meta.latencyMs}ms tokens=${
                result.meta.usage
                  ? `${result.meta.usage.inputTokens}/${result.meta.usage.outputTokens}`
                  : 'n/a'
              } cost=$${result.meta.costUsd.toFixed(6)}`,
            ].join('\n'),
          );
          console.log('');
        }

        if (result.ended) {
          ended = true;
          console.log('----------------------------------------');
          console.log(`NATIJA: ${result.outcome} (${result.endReason ?? '-'})`);
        }
      } catch (err) {
        if (isTrainingError(err)) {
          console.error(`\n[xato: ${err.code}] ${err.message}\n`);
          if (err.code === 'session_not_active') ended = true;
        } else {
          throw err;
        }
      }
    }

    const session = await engine.getSession(DEMO_CONTEXT, { sessionId: started.sessionId });
    console.log('\n=== Transkript ===');
    for (const [i, t] of session.transcript.entries()) {
      console.log(`${String(i + 1).padStart(2, ' ')}. ${t.speaker === 'seller' ? 'SIZ  ' : 'MIJOZ'}: ${t.text}`);
    }
    console.log('\n=== Yakun ===');
    console.log(`status=${session.status} outcome=${session.outcome ?? '-'} reason=${session.endReason ?? '-'}`);
    console.log(
      `navbatlar=${session.turnCount} patience=${session.state.patience} trust=${session.state.trust} interest=${session.state.interest}`,
    );
    console.log(`jami narx=$${Number(session.costUsd || totalCost).toFixed(6)}`);
  } finally {
    rl.close();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  if (err instanceof BusinessDataError) {
    console.error(`\n[biznes ma'lumotlari xatosi] ${err.message}\n`);
    process.exit(1);
  }
  if (err instanceof ProviderConfigError) {
    console.error(`\n[sozlama xatosi] ${err.message}\n`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
