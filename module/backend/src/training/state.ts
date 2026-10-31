/**
 * Holat va qoidalar — SOF funksiyalar, hech qanday I/O, hech qanday LLM.
 *
 * Asosiy tamoyil (Step 2, 2-qoida): **LLM taklif qiladi, KOD qaror qiladi.**
 * Model faqat strukturalangan natija qaytaradi; uni kod tekshiradi,
 * chegaralaydi va qo'llaydi. G'alaba / yutqazish / timeout faqat shu faylda
 * hisoblanadi.
 *
 * Soha so'zlari yo'q: e'tirozlar matni persona-card'dan (biznes profilidan)
 * keladi, bu fayl faqat kalitlar va sonlar bilan ishlaydi.
 */
import { z } from 'zod';

import type { Archetype } from './archetypes.js';
import type { PersonaCard } from './persona.js';
import { PROMPT_VERSION } from './prompts.js';
import { VOICE_TONES } from './voice/tone.js';

const score = z.number().int().min(0).max(100);

/** Mashq holatining flaglari (jsonb ichida saqlanadi). */
export const trainingFlagsSchema = z.object({
  /** Mijoz aytib bo'lgan e'tiroz kalitlari (persona.objections[].key). */
  objectionsRaised: z.array(z.string().min(1)),
  /** Sotuvchi yechgan e'tiroz kalitlari. */
  objectionsResolved: z.array(z.string().min(1)),
  /** Yashirin ehtiyoj ochildimi (faqat hiddenNeed arxetiplarda true bo'ladi). */
  needRevealed: z.boolean(),
  /** Model qoidani buzib "rozi bo'ldim" degan holatlar soni (rule 8). */
  guardViolations: z.number().int().min(0),
});

export type TrainingFlags = z.infer<typeof trainingFlagsSchema>;

/** `training_session.state` jsonb ustunining aniq shakli. */
export const trainingStateSchema = z.object({
  patience: score,
  trust: score,
  interest: score,
  flags: trainingFlagsSchema,
  /** Qaysi prompt versiyasi bilan o'ynalgani — keyinchalik A/B uchun. */
  promptVersion: z.string().min(1),
});

export type TrainingState = z.infer<typeof trainingStateSchema>;

// ---------------------------------------------------------------------------
// LLM javobining shartnomasi
// ---------------------------------------------------------------------------
export const turnIntentSchema = z.enum([
  'continue', // suhbat davom etadi
  'agrees', // rozi bo'ldi
  'agrees_next_step', // to'liq rozilik emas, lekin aniq keyingi qadamga kelishdi
  'refuses', // rad etdi
  'ends_call', // qo'ng'iroqni tugatdi
]);

export type TurnIntent = z.infer<typeof turnIntentSchema>;

const delta = z.number().int().min(-20).max(20);

/**
 * Model bir navbatda qaytaradigan natija. `reply` ovozga tayyor bo'lishi shart
 * (6-qoida): ko'pi bilan 2 qisqa gap, 300 belgidan oshmasin.
 */
export const turnResultSchema = z.object({
  reply: z.string().min(1).max(300),
  intent: turnIntentSchema,
  deltas: z.object({ patience: delta, trust: delta, interest: delta }),
  /** Shu navbatda ko'tarilgan e'tiroz kaliti (persona'dan) yoki null. */
  objectionRaisedKey: z.string().min(1).nullable(),
  /** Shu navbatda yechilgan e'tiroz kalitlari. */
  objectionsResolvedKeys: z.array(z.string().min(1)),
  needRevealed: z.boolean(),
  /** Kelishilgan keyingi qadam matni (bo'lsa). */
  nextStep: z.string().min(1).nullable(),
  /**
   * Ovoz uchun TAKLIF qilingan ohang. IXTIYORIY: matnli rejimda umuman
   * kerak emas, shuning uchun eski javoblar ham sxemaga tushaveradi.
   * Qiymatni KOD chegaralaydi (`voice/tone.ts` -> `clampTone`).
   */
  tone: z.enum(VOICE_TONES).optional(),
});

export type TurnResult = z.infer<typeof turnResultSchema>;

/**
 * Model javobini sxemaga bermasdan oldin yumshoq tozalash: sonlarni
 * chegaraga keltiradi va kutilgan maydonlarni to'ldiradi. Maqsad — arzimagan
 * chetlanish uchun ortiqcha LLM retry qilmaslik. Matn uzunligi ataylab
 * tozalanmaydi: uzun javob retry'ga sabab bo'lishi kerak (ovoz uchun muhim).
 */
export function coerceTurnResult(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object') return raw;
  const obj = { ...(raw as Record<string, unknown>) };

  const clampInt = (value: unknown): number => {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(-20, Math.min(20, Math.round(n)));
  };

  const d = obj.deltas;
  const deltas = d && typeof d === 'object' ? (d as Record<string, unknown>) : {};
  obj.deltas = {
    patience: clampInt(deltas.patience),
    trust: clampInt(deltas.trust),
    interest: clampInt(deltas.interest),
  };

  if (obj.objectionRaisedKey === undefined || obj.objectionRaisedKey === '') {
    obj.objectionRaisedKey = null;
  }
  if (obj.nextStep === undefined || obj.nextStep === '') obj.nextStep = null;
  if (!Array.isArray(obj.objectionsResolvedKeys)) obj.objectionsResolvedKeys = [];
  if (typeof obj.needRevealed !== 'boolean') obj.needRevealed = false;
  if (typeof obj.reply === 'string') obj.reply = obj.reply.trim();

  // Ohang ixtiyoriy va baribir kod tomonidan chegaralanadi: noto'g'ri qiymat
  // uchun butun navbatni qayta so'rash ortiqcha — shunchaki olib tashlaymiz.
  if (!(VOICE_TONES as readonly unknown[]).includes(obj.tone)) delete obj.tone;

  return obj;
}

// ---------------------------------------------------------------------------
// Holat
// ---------------------------------------------------------------------------
export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function clampDelta(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-20, Math.min(20, Math.round(value)));
}

export function initState(archetype: Archetype, _persona?: PersonaCard): TrainingState {
  return {
    patience: archetype.initialState.patience,
    trust: archetype.initialState.trust,
    interest: archetype.initialState.interest,
    flags: {
      objectionsRaised: [],
      objectionsResolved: [],
      needRevealed: false,
      guardViolations: 0,
    },
    promptVersion: PROMPT_VERSION,
  };
}

/** Har navbatdagi tabiiy sabr kamayishi — qo'ng'iroq cheksiz davom etmasligi uchun. */
export function basePatienceDecay(archetype: Archetype): number {
  return Math.ceil(archetype.difficulty / 2);
}

function uniqueAppend(list: readonly string[], keys: readonly string[]): string[] {
  const out = [...list];
  for (const key of keys) {
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * Model natijasini holatga qo'llaydi. Kirish holati o'zgartirilmaydi.
 *
 * Qoidalar:
 *  - har bir delta [-20, 20] ga, holat [0, 100] ga chegaralanadi;
 *  - har navbat `ceil(difficulty / 2)` sabr tabiiy kamayadi;
 *  - faqat `persona.objections` ichida BOR kalitlar hisobga olinadi
 *    (model o'ylab topgan kalitlar jim e'tiborsiz qoldiriladi);
 *  - `needRevealed` faqat `archetype.hiddenNeed === true` bo'lsa yoqiladi va
 *    bir yoqilgach o'chmaydi.
 */
export function applyTurnResult(
  state: TrainingState,
  result: TurnResult,
  persona: PersonaCard,
  archetype: Archetype,
): TrainingState {
  const known = new Set(persona.objections.map((o) => o.key));

  const raised = result.objectionRaisedKey && known.has(result.objectionRaisedKey)
    ? uniqueAppend(state.flags.objectionsRaised, [result.objectionRaisedKey])
    : [...state.flags.objectionsRaised];

  const resolvedKeys = result.objectionsResolvedKeys.filter((key) => known.has(key));
  const resolved = uniqueAppend(state.flags.objectionsResolved, resolvedKeys);

  const needRevealed = archetype.hiddenNeed
    ? state.flags.needRevealed || result.needRevealed
    : false;

  return {
    patience: clampScore(
      state.patience + clampDelta(result.deltas.patience) - basePatienceDecay(archetype),
    ),
    trust: clampScore(state.trust + clampDelta(result.deltas.trust)),
    interest: clampScore(state.interest + clampDelta(result.deltas.interest)),
    flags: {
      objectionsRaised: raised,
      objectionsResolved: resolved,
      needRevealed,
      guardViolations: state.flags.guardViolations,
    },
    promptVersion: state.promptVersion,
  };
}

/** Guard buzilishini qayd qiladi (rule 8). */
export function recordGuardViolation(state: TrainingState): TrainingState {
  return {
    ...state,
    flags: { ...state.flags, guardViolations: state.flags.guardViolations + 1 },
  };
}

// ---------------------------------------------------------------------------
// Rozilikka tayyorlik (agreement guard)
// ---------------------------------------------------------------------------
export interface Readiness {
  readyToAgree: boolean;
  /** Nega hali rozi bo'lolmaydi — prompt'ga aynan shu matnlar qo'yiladi. */
  blockers: string[];
}

/**
 * Mijoz rozi bo'lishga tayyormi? Faqat kod hisoblaydi, prompt'ga esa
 * "siz hali rozi bo'la OLMAYSIZ, chunki: ..." ko'rinishida kiritiladi.
 *
 * Qoida: mijoz O'ZINING hamma e'tirozini aytmasdan hech qachon rozi
 * bo'lmaydi. `requireObjectionsResolved` bo'lsa — ularning yechilishi ham shart.
 */
export function computeReadiness(
  state: TrainingState,
  persona: PersonaCard,
  archetype: Archetype,
): Readiness {
  const blockers: string[] = [];

  if (state.trust < archetype.win.minTrust) {
    blockers.push(
      `trust is ${state.trust} but you need at least ${archetype.win.minTrust} to agree`,
    );
  }

  const unraised = persona.objections
    .map((o) => o.key)
    .filter((key) => !state.flags.objectionsRaised.includes(key));
  if (unraised.length > 0) {
    blockers.push(
      `you have not raised these concerns yet: ${unraised.join(', ')} — raise the next one now`,
    );
  }

  if (archetype.win.requireObjectionsResolved) {
    const unresolved = persona.objections
      .map((o) => o.key)
      .filter((key) => !state.flags.objectionsResolved.includes(key));
    if (unresolved.length > 0) {
      blockers.push(`these concerns are still not answered to your satisfaction: ${unresolved.join(', ')}`);
    }
  }

  if (archetype.hiddenNeed && !state.flags.needRevealed) {
    blockers.push('the seller has not discovered your real underlying need yet');
  }

  return { readyToAgree: blockers.length === 0, blockers };
}

// ---------------------------------------------------------------------------
// Yakun
// ---------------------------------------------------------------------------
export type TrainingOutcome = 'won' | 'lost' | 'timeout';

export interface EndEvaluation {
  ended: boolean;
  outcome?: TrainingOutcome;
  reason?: string;
}

export interface EvaluateEndInput {
  state: TrainingState;
  result: TurnResult;
  /** Sotuvchining shu sessiyadagi navbatlari soni (shu navbat ham hisobda). */
  turnCount: number;
  archetype: Archetype;
  persona: PersonaCard;
}

/** Mijoz "qo'ng'iroqni tugataman" deyishi haqiqatga o'xshaydimi? */
export function endCallIsPlausible(state: TrainingState, archetype: Archetype): boolean {
  return (
    state.patience <= archetype.lose.patienceBelow + 10 || state.trust < archetype.win.minTrust
  );
}

/**
 * Yakun qoidalari. DIQQAT: `state` va `result` — deltalar QO'LLANGANDAN
 * keyingi holat (shu sababli oxirgi e'tirozni yechgan navbatda rozilik
 * qabul qilinadi).
 */
export function evaluateEnd({
  state,
  result,
  turnCount,
  archetype,
  persona,
}: EvaluateEndInput): EndEvaluation {
  const readiness = computeReadiness(state, persona, archetype);

  // 1. Sabr tugadi.
  if (state.patience < archetype.lose.patienceBelow) {
    return { ended: true, outcome: 'lost', reason: 'patience_exhausted' };
  }

  // 2. Mijoz suhbatni uzdi (faqat ishonarli bo'lsa — aks holda guard ushlaydi).
  if (
    (result.intent === 'refuses' || result.intent === 'ends_call') &&
    endCallIsPlausible(state, archetype)
  ) {
    return {
      ended: true,
      outcome: 'lost',
      reason: result.intent === 'refuses' ? 'customer_refused' : 'customer_ended_call',
    };
  }

  // 3. G'alaba.
  const nextStepAgreed =
    result.intent === 'agrees_next_step' &&
    state.trust >= archetype.win.minTrust &&
    typeof result.nextStep === 'string' &&
    result.nextStep.trim().length > 0;

  switch (archetype.win.type) {
    case 'agree':
      if (result.intent === 'agrees' && readiness.readyToAgree) {
        return { ended: true, outcome: 'won', reason: 'agreed' };
      }
      break;
    case 'agree_or_next_step':
      if (result.intent === 'agrees' && readiness.readyToAgree) {
        return { ended: true, outcome: 'won', reason: 'agreed' };
      }
      if (nextStepAgreed) {
        return { ended: true, outcome: 'won', reason: 'next_step_agreed' };
      }
      break;
    case 'need_discovered_and_agree':
      if (state.flags.needRevealed && result.intent === 'agrees' && readiness.readyToAgree) {
        return { ended: true, outcome: 'won', reason: 'need_discovered_and_agreed' };
      }
      break;
  }

  // 4. Navbatlar limiti.
  if (turnCount >= archetype.maxTurns) {
    return { ended: true, outcome: 'timeout', reason: 'max_turns' };
  }

  return { ended: false };
}

/**
 * Model qoidani buzdimi? (rule 8)
 *  - `agrees` dedi, lekin tayyor emas;
 *  - `agrees_next_step` dedi, lekin bu arxetipda bunday yo'l yo'q / ishonch
 *    yetarli emas / keyingi qadam aytilmagan;
 *  - sabri va ishonchi yuqori bo'lsa ham qo'ng'iroqni tugatdi.
 */
export function isGuardViolation(
  state: TrainingState,
  result: TurnResult,
  archetype: Archetype,
  persona: PersonaCard,
): boolean {
  const readiness = computeReadiness(state, persona, archetype);

  if (result.intent === 'agrees') return !readiness.readyToAgree;

  if (result.intent === 'agrees_next_step') {
    const allowed =
      archetype.win.type === 'agree_or_next_step' &&
      state.trust >= archetype.win.minTrust &&
      typeof result.nextStep === 'string' &&
      result.nextStep.trim().length > 0;
    return !allowed;
  }

  if (result.intent === 'refuses' || result.intent === 'ends_call') {
    return !endCallIsPlausible(state, archetype);
  }

  return false;
}
