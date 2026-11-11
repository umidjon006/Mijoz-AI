/**
 * "AI bilan to'ldirish": rahbar faqat erkin matnda vaziyatni yozadi, model
 * qolgan HAMMA maydonni taklif qiladi. Taklif saqlanmaydi — formaga qaytadi.
 * Natija xuddi qo'lda yozilgandek to'liq sxema tekshiruvidan o'tadi
 * (xato bo'lsa — BIR marta tuzatish so'rovi, keyin aniq o'zbekcha xatolar).
 */
import { ARCHETYPE_KEYS } from '../archetypes.js';
import { describeLlmError, isCorrectableLlmError } from '../errors.js';
import { offerTopic } from '../offer-facts.js';
import type { TokenUsage, TrainerLlm } from '../ports.js';
import type { BusinessProfile } from '../profile-schema.js';
import { MAX_TRAITS, TRAIT_CONFLICTS, TRAITS } from './content-rules.js';
import {
  BUSY,
  MONEY,
  RELATIONS,
  scenarioEmotionSchema,
  scenarioObjectSchema,
  SCENARIO_ROLES,
  validateScenario,
  VOLATILITY,
  type Scenario,
  type ScenarioIssue,
} from './schema.js';

/** Modelga beriladigan shakl: chegaralar/arxetip/navbatlar — kod default'i. */
export const scenarioDraftSchema = scenarioObjectSchema
  .omit({ base_archetype: true, max_turns: true })
  .extend({ emotion: scenarioEmotionSchema.omit({ thresholds: true }) });

export const SCENARIO_DRAFT_PROMPT_VERSION = 'scenario-draft-v1';

export function buildDraftSystemPrompt(profile: BusinessProfile | null): string {
  const offers = profile ? profile.primaryOffers.map(offerTopic).slice(0, 8) : [];
  return [
    'You design ONE customer scenario for a sales-training simulator (the trainee is a salesperson on the phone).',
    'The sales manager describes the situation in free text; you fill EVERY field of the JSON.',
    '',
    '## Rules',
    '- All human-facing text (title_uz, description_uz, persona.backstory, hidden_reason, real_objection, success_condition, hangup_condition, triggers, randomization_notes) in natural Uzbek, Latin script.',
    '- id: short snake_case Latin from the title (a-z, 0-9, _), 3-60 chars, starts with a letter.',
    `- persona.role: one of ${SCENARIO_ROLES.join(', ')}; relation: ${RELATIONS.join(', ')}; situation.money: ${MONEY.join('/')}; situation.busy: ${BUSY.join('/')}.`,
    '- persona.age: a realistic range {min, max} (child 6-12, teenager 13-17, grandparent 50+); name_pool: 3-5 Uzbek first names of that gender.',
    `- emotion.volatility: ${VOLATILITY.join('/')}; baseline anger/trust/interest/patience 0-100 (anger below 90).`,
    `- emotion.traits: at most ${MAX_TRAITS} of: ${Object.keys(TRAITS).join(', ')}. Never combine: ${TRAIT_CONFLICTS.filter((c) => c.level === 'error').map((c) => `${c.a}+${c.b}`).join(', ')}.`,
    '- behavior.default_formality is always "siz". insult_level 0-2 (2 only for really hostile adults); sarcasm 0-2. Child/teenager: insult_level 0, sarcasm max 1, allow_sen_when_angry false.',
    '- hidden_reason: what the seller must DISCOVER (the customer hides it). success_condition: a concrete outcome (agreement or next step).',
    '- triggers: 1-3 short Uzbek phrases each. voice.profile: "auto"; voice.base_style: short English description of how the person sounds.',
    '- relationship: new_lead | existing_student_parent | debtor | other. difficulty 1-5 matches how hard the customer is.',
    offers.length ? `- The business offers (names only): ${offers.join('; ')}.` : '',
    `- Possible mechanics (for your understanding only): ${ARCHETYPE_KEYS.join(', ')}.`,
    '',
    'Return JSON only.',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface DraftResult {
  ok: boolean;
  scenario?: Scenario;
  warnings: string[];
  issues: ScenarioIssue[];
  /** Model taklifi (xato bo'lsa ham) — forma uni ko'rsatib, tahrirlatadi. */
  raw: unknown;
  usage?: TokenUsage;
  attempts: number;
}

export async function draftScenarioWithLlm(input: {
  llm: TrainerLlm;
  text: string;
  profile: BusinessProfile | null;
}): Promise<DraftResult> {
  const system = buildDraftSystemPrompt(input.profile);
  const anyJson = { parse: (v: unknown): unknown => v };
  let correction = '';
  let last: DraftResult = { ok: false, warnings: [], issues: [], raw: null, attempts: 0 };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const req = {
      stage: 'training.scenario_draft',
      system,
      user: `## Situation from the manager\n${input.text.trim()}${correction}`,
      schema: anyJson,
      outputSchema: scenarioDraftSchema,
    };
    let raw: unknown;
    let usage: TokenUsage | undefined;
    try {
      if (typeof input.llm.completeJsonWithUsage === 'function') {
        const out = await input.llm.completeJsonWithUsage(req);
        raw = out.value;
        usage = out.usage;
      } else {
        raw = await input.llm.completeJson(req);
      }
    } catch (err) {
      if (attempt === 1 && isCorrectableLlmError(err)) {
        correction = `\n\n## CORRECTION\nYour previous answer was not valid JSON: ${describeLlmError(err)}`;
        continue;
      }
      throw err;
    }
    const v = validateScenario(raw, 'AI taklifi');
    if (v.ok) return { ok: true, scenario: v.scenario, warnings: v.warnings, issues: [], raw, ...(usage ? { usage } : {}), attempts: attempt };
    last = { ok: false, warnings: [], issues: v.issues, raw, ...(usage ? { usage } : {}), attempts: attempt };
    correction = `\n\n## CORRECTION — fix exactly these problems and return the full JSON again\n${v.issues
      .map((i) => `- ${i.path}: ${i.message}`)
      .join('\n')}`;
  }
  return last;
}
