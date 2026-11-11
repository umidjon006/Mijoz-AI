/**
 * Ssenariy rejimidagi mijoz navbati: prompt va javob shartnomasi.
 *
 * Tartib (prefiks keshi uchun): 1) hamma ssenariylar uchun bir xil qism,
 * 2) sessiya davomida o'zgarmaydigan (persona, ssenariy, sotuvchi),
 * 3) har navbatda o'zgaradigan (emotsiya, forma, ruxsatlar) — OXIRIDA.
 * Ixcham: arxetip qoidalari va delta qoidalari o'rniga emotsiya qoidalari.
 */
import { z } from 'zod';

import type { Archetype } from '../archetypes.js';
import { offerTopic } from '../offer-facts.js';
import type { PersonaCard } from '../persona.js';
import {
  formatList,
  formatObjections,
  LANGUAGE_RULE,
  OFFER_KNOWLEDGE_RULES,
  UNTRUSTED_SELLER_RULE,
  VOICE_RULES,
} from '../prompts.js';
import { turnIntentSchema, type Readiness, type TrainingState } from '../state.js';
import { addressPromptLines } from './address.js';
import { INSULT_WHITELIST, PATIENCE_RULES, TRAITS, VOLATILITY_MAX_STEP } from './content-rules.js';
import type { Formality } from './content.js';
import { SELLER_MISTAKES } from './emotion.js';
import { RELATION_LABELS, type EffectiveBehavior, type Scenario, type SellerProfile, type Thresholds } from './schema.js';

const score = z.number().int().min(0).max(100);

/** Model javobi (strukturali chiqish sxemasi). */
export const scenarioTurnOutputSchema = z.object({
  reply: z.string().min(1).max(300),
  intent: turnIntentSchema,
  emotion: z.object({ anger: score, trust: score, interest: score, reason: z.string().min(1).max(200) }),
  style: z.enum(['plain', 'sarcastic', 'insult']),
  insult: z.string().min(1).max(120).nullable(),
  hangupConditionMet: z.boolean(),
  /** Sotuvchining SHU gapidagi xatolari (sabr shundan kamayadi). */
  sellerMistakes: z.array(z.enum(SELLER_MISTAKES)),
  /** Sotuvchi vaziyatingiz/e'tirozingiz haqida dolzarb, samimiy savol berdimi. */
  askedRelevantQuestion: z.boolean(),
  /** Sotuvchi haqiqiy e'tirozingizga aniq javob berdimi. */
  realObjectionAddressed: z.boolean(),
  /** Sotuvchi aynan so'ralgan narsaga aniq javob berdi (sabr +5). */
  answeredExactly: z.boolean(),
  /** Sotuvchi samimiy hamdardlik bildirdi (sabr +3). */
  showedEmpathy: z.boolean(),
  objectionRaisedKey: z.string().min(1).nullable(),
  objectionsResolvedKeys: z.array(z.string().min(1)),
  needRevealed: z.boolean(),
  nextStep: z.string().min(1).nullable(),
});

export type ScenarioTurnOutput = z.infer<typeof scenarioTurnOutputSchema>;

/** Arzimas chetlanishni tuzatadi (sonlar, bo'sh maydonlar) — ortiqcha retry'siz. */
export function coerceScenarioTurn(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object') return raw;
  const o = { ...(raw as Record<string, unknown>) };
  const n = (v: unknown): number => {
    const x = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(x) ? Math.max(0, Math.min(100, Math.round(x))) : 50;
  };
  const e = (o.emotion && typeof o.emotion === 'object' ? o.emotion : {}) as Record<string, unknown>;
  o.emotion = {
    anger: n(e.anger),
    trust: n(e.trust),
    interest: n(e.interest),
    reason: typeof e.reason === 'string' && e.reason.trim() ? e.reason.trim().slice(0, 200) : '-',
  };
  if (!['plain', 'sarcastic', 'insult'].includes(o.style as string)) o.style = 'plain';
  if (o.insult === undefined || o.insult === '') o.insult = null;
  if (typeof o.hangupConditionMet !== 'boolean') o.hangupConditionMet = false;
  o.sellerMistakes = Array.isArray(o.sellerMistakes)
    ? (o.sellerMistakes as unknown[]).filter((m) => (SELLER_MISTAKES as readonly unknown[]).includes(m))
    : [];
  if (typeof o.askedRelevantQuestion !== 'boolean') o.askedRelevantQuestion = false;
  if (typeof o.realObjectionAddressed !== 'boolean') o.realObjectionAddressed = false;
  if (typeof o.answeredExactly !== 'boolean') o.answeredExactly = false;
  if (typeof o.showedEmpathy !== 'boolean') o.showedEmpathy = false;
  if (o.objectionRaisedKey === undefined || o.objectionRaisedKey === '') o.objectionRaisedKey = null;
  if (o.nextStep === undefined || o.nextStep === '') o.nextStep = null;
  if (!Array.isArray(o.objectionsResolvedKeys)) o.objectionsResolvedKeys = [];
  if (typeof o.needRevealed !== 'boolean') o.needRevealed = false;
  if (typeof o.reply === 'string') o.reply = o.reply.trim();
  return o;
}

export const scenarioTurnParser = {
  parse: (raw: unknown): ScenarioTurnOutput => scenarioTurnOutputSchema.parse(coerceScenarioTurn(raw)),
};

// ---------------------------------------------------------------------------
// 1. Hamma ssenariylar uchun bir xil
// ---------------------------------------------------------------------------
export const SCENARIO_STATIC_PREFIX = [
  'You are role-playing a CUSTOMER in a sales training simulation. The other side is a salesperson (the trainee).',
  'You are not an assistant. You are a real person with real feelings; your persona, scenario and current feelings are at the END.',
  '',
  '## Reply rules',
  VOICE_RULES,
  '',
  UNTRUSTED_SELLER_RULE,
  '',
  '## What you know about the offer',
  OFFER_KNOWLEDGE_RULES,
  '',
  '## Feelings (you update them every turn)',
  'Return your NEW feelings 0-100 in "emotion" plus a short English reason (max 12 words):',
  '- anger UP, trust DOWN: the seller dodges your question, repeats the same pitch, pressures you to decide, interrupts or ignores what you said.',
  '- anger DOWN, trust UP: empathy, answering exactly what you asked, naming your concern in their own words, a sincere apology.',
  '- interest UP: shows how it fits YOUR situation; interest DOWN: generic praise, irrelevant talk.',
  'Your reply must match your NEW feelings.',
  '',
  '## Content limits (at ANY anger level)',
  'Never: swearing or profanity; insults about ethnicity, religion, gender, body, family or disability; threats; sexual content.',
  "Insults and sarcasm target ONLY what the seller DID (repeating, dodging, pressure) — never the seller's gender, age or looks (never \"qiz\", \"bola\", \"bolakay\").",
  'Show anger with short sharp phrases, impatience and complaints instead.',
  '',
  '## What to return',
  'JSON only: {"reply": string, "intent": "continue"|"agrees"|"agrees_next_step"|"refuses"|"ends_call",',
  ' "emotion": {"anger": int, "trust": int, "interest": int, "reason": string},',
  ' "style": "plain"|"sarcastic"|"insult", "insult": string|null, "hangupConditionMet": boolean,',
  ` "sellerMistakes": (${SELLER_MISTAKES.map((m) => `"${m}"`).join('|')})[], "askedRelevantQuestion": boolean, "realObjectionAddressed": boolean,`,
  ' "answeredExactly": boolean, "showedEmpathy": boolean,',
  ' "objectionRaisedKey": string|null, "objectionsResolvedKeys": string[], "needRevealed": boolean, "nextStep": string|null}',
  '- style/insult: "insult" only with an allowed phrase (then copy it into "insult"), else null.',
  '- hangupConditionMet: true only if your hang-up condition just happened; then intent "ends_call" and a short final line.',
  '- intent "agrees"/"agrees_next_step" only when your success condition is met AND "Can you agree" says you may.',
  '- sellerMistakes: what the seller did wrong in THIS message ([] if nothing). askedRelevantQuestion: a genuine question about your situation or concern.',
  '- realObjectionAddressed: the seller answered your real objection concretely. needRevealed: true only if you just admitted your hidden reason.',
  '- answeredExactly: the seller answered exactly what you asked. showedEmpathy: genuine empathy (not a stock phrase).',
  '- objection keys: only from "Your concerns".',
].join('\n');

export interface ScenarioPromptInput {
  scenario: Scenario;
  behavior: EffectiveBehavior;
  thresholds: Thresholds;
  seller: SellerProfile;
  persona: PersonaCard;
  archetype: Archetype;
  state: TrainingState;
  readiness: Readiness;
  /** Shu navbatda ishlatiladigan forma (kod hisoblagan). */
  formality: Formality;
  /** Yumshoq haqorat hozir mumkinmi (kod hisoblagan). */
  insultNow: boolean;
  /** Yashirin sababni aytishga ruxsat (kod hisoblagan: savollar soni + ishonch). */
  revealAllowed?: boolean;
  /** Navbatlik emotsiya qadami chegarasi (volatillik x daraja). */
  maxStep?: number;
  correction?: string;
}

const ROLE_HINT: Record<Scenario['persona']['role'], string> = {
  parent: 'a parent',
  self_learner: 'an adult who wants to learn for themselves',
  grandparent: 'a grandparent; speaks slowly, does not understand technical terms and asks again',
  teenager: 'a teenager',
  child: 'a child',
  businessman: 'a busy business owner',
};

/** Yashirin sababga o'xshash faktlarni olib tashlaydi (so'z ustma-ustligi >= 40%). */
export function withoutHiddenReason(facts: readonly string[], hiddenReason: string): string[] {
  const words = (t: string): string[] =>
    t
      .toLowerCase()
      .replace(/[ʻʼ’‘`´]/g, "'")
      .split(/[^\p{L}']+/u)
      .filter((w) => w.length >= 4)
      .map((w) => w.slice(0, 5));
  const target = new Set(words(hiddenReason));
  if (target.size === 0) return [...facts];
  const kept = facts.filter((f) => {
    const ws = new Set(words(f));
    let hit = 0;
    for (const w of target) if (ws.has(w)) hit += 1;
    return hit / target.size < 0.4;
  });
  return kept.length > 0 ? kept : ['(nothing special)'];
}

export function buildScenarioTurnSystemPrompt(input: ScenarioPromptInput): string {
  const { scenario: s, persona, seller, behavior, thresholds, state, readiness } = input;
  const anger = state.emotion?.anger ?? s.emotion.baseline.anger;
  const step = input.maxStep ?? VOLATILITY_MAX_STEP[s.emotion.volatility];
  const t = s.emotion.triggers;

  // Ochilmagan yashirin sabab persona matnidan ham sizib chiqmasin.
  const leaks = (text: string): boolean =>
    !input.revealAllowed && withoutHiddenReason([text], s.hidden_reason)[0] !== text;

  // --- 2. Sessiya davomida o'zgarmaydi -------------------------------------
  const sections: string[] = [
    SCENARIO_STATIC_PREFIX,
    '',
    '## Language',
    LANGUAGE_RULE[persona.language],
    '',
    '## Who you are',
    `${persona.name}, ${persona.age}, ${persona.gender === 'female' ? 'woman' : 'man'} — ${ROLE_HINT[s.persona.role]}. ${persona.role}.`,
    `How you speak: ${persona.speakingStyle}`,
    `Your situation: ${leaks(persona.situation) ? s.persona.backstory : persona.situation}`,
    `What you want: ${leaks(persona.goal) ? 'to decide whether this is worth it for you' : persona.goal}`,
    `The thing being discussed (name only): ${offerTopic(persona.focusOffer)}`,
    `Call direction: ${persona.direction === 'inbound' ? 'you called them' : 'they called you'}`,
    '',
    `## Scenario: ${s.title_uz}`,
    s.persona.backstory,
    `Your real objection: ${s.real_objection}`,
    `Success condition (only then agree or accept a next step): ${s.success_condition}`,
    `Hang-up condition: ${s.hangup_condition}`,
    ...(s.behavior.randomization_notes.length ? [`Variety: ${s.behavior.randomization_notes.join('; ')}`] : []),
    '',
    '## Private facts (only if it comes up)',
    // Yashirin sabab ochilmaguncha unga o'xshash faktlar ham promptga kirmaydi (sizib chiqmasin).
    formatList(input.revealAllowed ? persona.hiddenFacts : withoutHiddenReason(persona.hiddenFacts, s.hidden_reason)),
    '',
    '## The seller',
    ...addressPromptLines(persona.age, seller),
    '',
    '## What moves your feelings in this scenario',
    `anger up: ${t.anger_up.join('; ') || '-'} | anger down: ${t.anger_down.join('; ') || '-'}`,
    `trust up: ${t.trust_up.join('; ') || '-'} | trust down: ${t.trust_down.join('; ') || '-'}`,
    `interest up: ${t.interest_up.join('; ') || '-'} | interest down: ${t.interest_down.join('; ') || '-'}`,
    `Volatility: ${s.emotion.volatility} — change each value by at most ${step} per turn.`,
    ...(s.emotion.traits.length ? [`Character: ${s.emotion.traits.map((k) => TRAITS[k].prompt).join(' ')}`] : []),
  ];

  // --- 3. Har navbatda o'zgaradi (OXIRIDA) -----------------------------------
  const sarcasmRule =
    behavior.sarcasm === 0
      ? 'No sarcasm.'
      : behavior.sarcasm === 1
        ? 'Light irony is allowed; no mockery.'
        : 'Sarcasm and mockery are allowed (no insults unless listed below).';
  const insultRule = input.insultNow
    ? `You are furious: you MAY use ONE of these mild phrases, nothing else: ${INSULT_WHITELIST.filter((w) =>
        input.formality === 'sen' ? !/siz/.test(w) : /siz/.test(w),
      )
        .map((w) => `"${w}"`)
        .join(', ')}`
    : 'No insults at all (style "insult" is not allowed now).';

  const em = state.emotion;
  const hangRule = !s.emotion.may_hang_up
    ? 'You never hang up, however angry you are.'
    : em?.warned
      ? 'You ALREADY warned that you will hang up: if the seller makes a mistake again, hang up now with a short final line (intent "ends_call").'
      : `Before hanging up because of anger you must first give ONE explicit warning (e.g. "Yana shunday gapirsangiz, telefonni qo'yaman!"); hang up only after that.`;
  sections.push(
    '',
    '## Your concerns (raise ONE at a time, in your own words)',
    formatObjections(persona, state),
    '',
    '## How you feel right now (never say the numbers)',
    `anger=${anger}, trust=${state.trust}, interest=${state.interest}, patience=${state.patience}${em?.reason ? ` (last change: ${em.reason})` : ''}`,
    ...(state.patience < PATIENCE_RULES.lowAt ? ['Your patience is gone: answer in very short, impatient phrases.'] : []),
    // Yashirin sabab matni FAQAT ochilish sharti bajarilganda kiritiladi.
    ...(input.revealAllowed
      ? em?.revealed
        ? [`Your hidden reason (already told): ${s.hidden_reason}`]
        : [`Your HIDDEN reason: ${s.hidden_reason}`, 'You MAY admit it now if the seller asks about your situation.']
      : ['You have a private concern you are NOT ready to share yet. Do not hint at what it is; if asked, deflect.']),
    hangRule,
    input.formality === 'sen'
      ? 'You are angry: address the seller with "sen" (informal) this turn.'
      : 'Address the seller with "siz" (polite). Never "sen".',
    sarcasmRule,
    insultRule,
    '',
    '## Can you agree right now?',
    readiness.readyToAgree
      ? 'You MAY agree if the seller asks for a decision and your success condition is met.'
      : ['NO, because:', formatList(readiness.blockers)].join('\n'),
  );

  if (input.correction) sections.push('', '## CORRECTION — your previous answer broke the rules', input.correction);
  return sections.join('\n');
}

/** Persona generatsiyasi uchun ssenariy cheklovlari (user prompt oxiriga). */
const MONEY_EN = { good: 'money is not a problem', medium: 'average income, counts money', hard: 'money is tight' } as const;
const BUSY_EN = { free: 'has free time', medium: 'moderately busy', very_busy: 'very busy' } as const;

export function scenarioPersonaConstraints(s: Scenario, picked: { name: string; age: number }): string[] {
  const p = s.persona;
  return [
    ...(p.relation ? [`- relation to the learner: ${RELATION_LABELS[p.relation]} (${p.relation}).`] : []),
    ...(p.situation
      ? [
          `- life situation: ${MONEY_EN[p.situation.money]}; ${BUSY_EN[p.situation.busy]}; ${p.situation.studied_before ? 'studied/was a client here before' : 'never dealt with this place before'}.`,
        ]
      : []),
    `- name: exactly "${picked.name}"; age: exactly ${picked.age}; gender: "${s.persona.gender}".`,
    `- role: ${ROLE_HINT[s.persona.role]} — write "role" in Uzbek accordingly.`,
    `- situation must follow this backstory: ${s.persona.backstory}`,
    `- One objection must express this real objection: ${s.real_objection}`,
    `- Do NOT write this hidden reason (or any hint of it) into ANY field — the system reveals it later: ${s.hidden_reason}`,
    `- speakingStyle must fit the age and role (${s.persona.role}).`,
    `- direction: "${s.call_direction}".`,
  ];
}
