/**
 * FAQAT HARNESS. Mavjud sessiyani QAYTA BAHOLASH va debrief tilini tekshirish:
 *
 *   npm run rescore -- --latest                 oxirgi tugagan sessiya (haqiqiy LLM)
 *   npm run rescore -- <sessionId>              aniq sessiya
 *   npm run rescore -- --latest --check-only    LLM'siz: oxirgi natija tilini tekshiradi
 *
 * Qayta baholash YANGI versiya qo'shadi (eskilari saqlanadi) — UI'dagi
 * "Qayta baholash" tugmasi bilan bir xil. Keyin saqlangan natijaning har
 * foydalanuvchiga ko'rinadigan maydoni tasniflanadi (lotin / kirill / begona)
 * va lotin bo'lmagan matn qolgan-qolmagani chiqariladi.
 */
// ENG BIRINCHI: harness/.env ni yuklaydi (yo'l harness papkasiga nisbatan).
import { envStr } from './env.js';

import { classifyUzText } from '../../module/backend/src/training/language.js';
import type { TrainingContext } from '../../module/backend/src/training/ports.js';
import * as scoringRepo from '../../module/backend/src/training/scoring/repo.js';
import {
  createScoringService,
  userFacingScoringText,
  type ProcessedScoring,
} from '../../module/backend/src/training/scoring/scoring.js';
import { BusinessDataError, resolveBusinessData } from './business-data.js';
import { DEMO_BUSINESS_ID, DEMO_USER_ID } from './demo-env.js';
import { priceCall } from './llm-anthropic.js';
import {
  createTrainerLlm,
  MissingLlmKeyError,
  printMissingKeyBanner,
  ProviderConfigError,
  resolveProviderConfig,
  startupLine,
} from './llm-factory.js';
import { appDatabaseUrl, createPool, createWithTenant } from './withTenant.js';

/** Saqlangan natijadagi foydalanuvchiga ko'rinadigan matnlar tasnifi. */
function languageAudit(row: scoringRepo.TrainingResultRow): {
  total: number;
  bad: Array<{ field: string; kind: string; text: string }>;
  hidden: number;
} {
  const processed = {
    criteria: row.criteria ?? [],
    coaching: row.coaching ?? { summary: '', strengths: [], improvements: [] },
    keyMoments: row.keyMoments ?? [],
    evidenceFailureRatio: 0,
    failureNotes: [],
    droppedNotes: [],
  } as ProcessedScoring;
  const fields = userFacingScoringText(processed).filter((f) => f.text.length > 0);
  const bad = fields
    .map((f) => ({ ...f, kind: classifyUzText(f.text) }))
    .filter((f) => f.kind !== 'latin');
  return { total: fields.length, bad, hidden: row.coaching?.languageCheck?.hidden.length ?? 0 };
}

function printAudit(label: string, row: scoringRepo.TrainingResultRow): number {
  const audit = languageAudit(row);
  console.log(
    `\n${label}: v${row.version} · ${row.status} · quality=${row.quality} · ball=${row.skillScore ?? '—'} · ${row.promptVersion ?? '-'}`,
  );
  if (row.coaching?.languageCheck) {
    const c = row.coaching.languageCheck;
    console.log(
      `  til himoyasi: ${c.transliterated} o'girildi, ${c.regenerated} qayta yaratildi, ${c.hidden.length} yashirildi` +
        (c.hidden.length > 0 ? ` (${c.hidden.join(', ')})` : ''),
    );
  }
  if (audit.bad.length === 0) {
    console.log(`  TIL: OK — ${audit.total} ta maydonning hammasi lotin o'zbekcha.`);
  } else {
    console.log(`  TIL: MUAMMO — ${audit.bad.length}/${audit.total} maydonda lotin bo'lmagan matn:`);
    for (const f of audit.bad) console.log(`    - ${f.field} [${f.kind}]: ${f.text.slice(0, 100)}`);
  }
  return audit.bad.length;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check-only');
  const latest = args.includes('--latest');
  const explicit = args.find((a) => !a.startsWith('--'));
  if (!latest && !explicit) {
    console.error('Foydalanish: npm run rescore -- <sessionId> | --latest [--check-only]');
    process.exit(1);
  }

  const pool = createPool(appDatabaseUrl());
  const withTenant = createWithTenant(pool);
  try {
    const { sessionId, userId } = await withTenant(DEMO_BUSINESS_ID, async (tx) => {
      if (explicit) {
        const row = await scoringRepo.getSessionForScoring(tx, explicit);
        if (!row) throw new Error(`sessiya topilmadi: ${explicit}`);
        return { sessionId: row.id, userId: row.userId };
      }
      const rows = await scoringRepo.listSessionsWithScore(tx, DEMO_USER_ID);
      const ended = rows
        .filter((r) => r.status !== 'active')
        .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
      const first = ended[0];
      if (!first) throw new Error("tugagan sessiya yo'q");
      return { sessionId: first.id, userId: DEMO_USER_ID };
    });
    const ctx: TrainingContext = { businessId: DEMO_BUSINESS_ID, userId, seatId: null };
    console.log(`Sessiya: ${sessionId}`);

    const before = await withTenant(DEMO_BUSINESS_ID, async (tx) =>
      scoringRepo.getLatestResult(tx, sessionId),
    );
    if (before) printAudit('Hozirgi natija', before);
    else console.log("Hozircha natija yo'q.");
    if (checkOnly) return;

    const business = resolveBusinessData(envStr('HARNESS_PROFILE'));
    const config = resolveProviderConfig();
    console.log(`\n${startupLine(config)}`);
    let scoringLlm;
    try {
      scoringLlm = createTrainerLlm({ profile: business.profile, config, scoring: true }).llm;
    } catch (err) {
      if (err instanceof MissingLlmKeyError) {
        printMissingKeyBanner('rescore', err.config);
        process.exit(1);
      }
      throw err;
    }
    const scoring = createScoringService({
      withTenant,
      llm: scoringLlm,
      priceCall,
      getBusinessProfile: async () => business.profile,
      getSalesScript: async () => business.script,
    // Bir sessiyada bir vaqtda bitta baholash; shundan eski `pending` — o'lik (jarayon to'xtagan).
    pendingStaleAfterMs: config.scoringTimeoutMs * 4,
      logger: {
        info: () => undefined,
        warn: (_obj, msg) => msg && console.warn(`  [ogohlantirish] ${msg}`),
        error: (_obj, msg) => msg && console.error(`  [xato] ${msg}`),
      },
    });

    console.log('Qayta baholanmoqda (yangi versiya)...');
    const result = await scoring.scoreSession(ctx, sessionId);
    if (result.alreadyRunning) {
      console.log(
        `Bu sessiya uchun baholash allaqachon ketmoqda (v${result.version}) — yangisi boshlanmadi. ` +
          'Tugagach qayta ishga tushiring yoki --check-only bilan natijani ko\'ring.',
      );
      return;
    }
    const after = await withTenant(DEMO_BUSINESS_ID, async (tx) =>
      scoringRepo.getLatestResult(tx, sessionId),
    );
    if (!after) throw new Error('natija yozilmadi');
    const bad = printAudit('Yangi natija', after);
    if (result.status === 'failed') {
      console.log(`  Baholash muvaffaqiyatsiz: ${after.error ?? '-'}`);
      process.exitCode = 1;
    } else if (bad > 0) {
      process.exitCode = 1;
    }
  } finally {
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
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
