/**
 * FAQAT LOKAL HARNESS, IXTIYORIY. Qiyinlikni kalibrlash:
 * LLM "beparvo sotuvchi" va "mohir sotuvchi" bo'lib o'ynaydi, har arxetip
 * uchun N sessiya (default 5) va g'alaba foizini chiqaradi.
 *
 *   npm run calibrate -- --profile o_quv_markaz [--sessions 5] [--debug]
 *
 * Kutilgan natija: beparvo sotuvchi kamdan-kam yutadi; mohir sotuvchi
 * ko'pincha yutadi; `problematic` va `info_seeker` `ready_buyer` dan
 * sezilarli qiyin bo'ladi.
 *
 * DIQQAT: pul sarflaydi. Boshlashdan oldin taxminiy narx chiqadi va
 * tasdiqlash so'raladi (`--yes` bilan o'tkazib yuborish mumkin).
 */
// ENG BIRINCHI: harness/.env ni yuklaydi (yo'l harness papkasiga nisbatan).
import './env.js';

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { z } from 'zod';

import { ARCHETYPE_KEYS, getArchetype } from '../../module/backend/src/training/archetypes.js';
import { createTrainingEngine } from '../../module/backend/src/training/engine.js';
import type { GetBusinessProfile } from '../../module/backend/src/training/ports.js';
import type { BusinessProfile } from '../../module/backend/src/training/profile-schema.js';
import { DEMO_CONTEXT, ensureDemoRows, loadDemoProfile, parseArgs } from './demo-env.js';
import { priceCall } from './llm-anthropic.js';
import {
  createTrainerLlm,
  MissingLlmKeyError,
  printDemoBanner,
  printMissingKeyBanner,
  startupLine,
} from './llm-factory.js';
import { appDatabaseUrl, createPool, createWithTenant } from './withTenant.js';

type SellerKind = 'careless' | 'skilled';

const sellerReplySchema = z.object({ message: z.string().min(1).max(400) });

const SELLER_STYLE: Record<SellerKind, string> = {
  careless: [
    'You are a CARELESS, untrained salesperson.',
    'You praise the offer in vague words, you repeat yourself, you push for a quick yes,',
    'you ignore most of what the customer says, you rarely ask questions,',
    'and you never give concrete facts or numbers.',
  ].join(' '),
  skilled: [
    'You are a SKILLED salesperson.',
    'You ask one good open question about the customer\'s situation, you listen,',
    'you answer each concern concretely with the facts available to you,',
    'you never over-promise, and you ask for a decision or a concrete next step only',
    'after the customer\'s concerns have been answered.',
  ].join(' '),
};

function sellerSystemPrompt(kind: SellerKind, profile: BusinessProfile): string {
  return [
    SELLER_STYLE[kind],
    '',
    'You are on a phone call with a customer. Reply with ONE short spoken message (max 2 sentences).',
    'Write in Uzbek (Latin script). No emoji, no markdown.',
    '',
    'What you sell:',
    profile.businessDescription,
    'Offers and terms you may reference (never invent others):',
    ...profile.primaryOffers.map((offer) => `- ${offer}`),
    '',
    'Return JSON only: {"message": string}',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sessionsPerKind = args.sessions ?? 5;
  const profile = loadDemoProfile(args.profile);

  const archetypes = [...ARCHETYPE_KEYS];
  const avgTurns = 8;
  const totalSessions = archetypes.length * 2 * sessionsPerKind;
  // Har navbat: 1 mijoz chaqiruvi + 1 sotuvchi chaqiruvi (~1500 in / 250 out).
  const estCost =
    totalSessions * (1 + avgTurns * 2) * ((1500 / 1_000_000) * 1 + (250 / 1_000_000) * 5);

  console.log(
    `Kalibrlash: ${archetypes.length} arxetip × 2 sotuvchi × ${sessionsPerKind} sessiya = ${totalSessions} sessiya`,
  );
  console.log(`Taxminiy narx: ~$${estCost.toFixed(2)}`);

  if (!process.argv.includes('--yes')) {
    const rl = createInterface({ input, output });
    const answer = (await rl.question('Davom etamizmi? (yes/no) ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'yes' && answer !== 'y') {
      console.log('Bekor qilindi.');
      return;
    }
  }

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
      printMissingKeyBanner('calibrate', err.config);
      process.exit(1);
    }
    throw err;
  }
  if (resolved.isDemo) printDemoBanner('calibrate');
  const llm = resolved.llm;
  const engine = createTrainingEngine({ withTenant, getBusinessProfile, llm, priceCall });

  const results: Record<string, Record<SellerKind, { won: number; total: number }>> = {};
  let totalCost = 0;

  try {
    for (const key of archetypes) {
      const archetype = getArchetype(key);
      results[key] = { careless: { won: 0, total: 0 }, skilled: { won: 0, total: 0 } };

      for (const kind of ['careless', 'skilled'] as SellerKind[]) {
        for (let i = 0; i < sessionsPerKind; i += 1) {
          const started = await engine.startSession(DEMO_CONTEXT, { archetypeKey: key });
          const transcript: string[] = [];
          if (started.openingLine) transcript.push(`CUSTOMER: ${started.openingLine}`);

          let outcome: string | undefined;
          for (let t = 0; t < archetype.maxTurns; t += 1) {
            const seller = await llm.completeJson({
              stage: 'calibrate.seller',
              system: sellerSystemPrompt(kind, profile),
              user: [
                transcript.length > 0 ? transcript.join('\n') : '(call just started)',
                '',
                'Your next message (JSON only):',
              ].join('\n'),
              schema: sellerReplySchema,
            });
            transcript.push(`SELLER: ${seller.message}`);

            const turn = await engine.takeTurn(DEMO_CONTEXT, {
              sessionId: started.sessionId,
              sellerText: seller.message,
            });
            totalCost += turn.meta.costUsd;
            transcript.push(`CUSTOMER: ${turn.customerReply}`);
            if (turn.ended) {
              outcome = turn.outcome;
              break;
            }
          }

          const bucket = results[key]?.[kind];
          if (bucket) {
            bucket.total += 1;
            if (outcome === 'won') bucket.won += 1;
          }

          const session = await engine.getSession(DEMO_CONTEXT, { sessionId: started.sessionId });
          if (session.status === 'active') {
            await engine.endSession(DEMO_CONTEXT, {
              sessionId: started.sessionId,
              reason: 'calibrate_finished',
            });
          }
          console.log(
            `  ${key}/${kind} #${i + 1}: ${outcome ?? 'tugamadi'} (guard=${session.state.flags.guardViolations})`,
          );
          if (args.debug) console.log(transcript.map((l) => `    ${l}`).join('\n'));
        }
      }
    }

    console.log('\n=== G\'alaba foizi ===');
    console.log('arxetip              beparvo    mohir');
    for (const key of archetypes) {
      const row = results[key];
      if (!row) continue;
      const pct = (b: { won: number; total: number }): string =>
        b.total === 0 ? '  n/a' : `${Math.round((b.won / b.total) * 100)}%`.padStart(5, ' ');
      console.log(`${key.padEnd(20, ' ')} ${pct(row.careless)}    ${pct(row.skilled)}`);
    }
    console.log(`\nJami narx: $${totalCost.toFixed(4)}`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
