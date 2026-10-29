/**
 * Deterministik holat mashinasi.
 *
 * Qoida: LLM hech qachon "yutdim/yutqazdim" demaydi va ballarni o'zgartirmaydi.
 * Bir xil (arxetip + holat + signallar) uchligi HAR DOIM bir xil natija beradi —
 * `verify-training.ts` buni tekshiradi.
 *
 * Soha so'zlari yo'q: e'tirozlar matni persona-card'dan (biznes profilidan)
 * keladi, bu fayl faqat SONLAR va QOIDALAR bilan ishlaydi.
 */
import type { Archetype } from './archetypes.js';
import {
  clampScore,
  parseTurnSignals,
  type TrainingEndReason,
  type TrainingState,
  type TurnSignals,
  type TurnSignalsInput,
} from './state.js';

/**
 * Qoida koeffitsiyentlari bir joyda — sozlash uchun shu obyekt o'zgartiriladi,
 * mantiq emas. (Keyinchalik tenant bo'yicha sozlanishi mumkin.)
 */
export const ENGINE_RULES = {
  /** Har navbatda sabrning tabiiy kamayishi (qiyinchilikka bog'liq). */
  patienceDecayBase: 1,
  /** Javobsiz e'tiroz har navbat qancha sabr yeydi (yoshiga ko'payadi). */
  pendingObjectionPatience: 4,
  pendingObjectionTrust: 3,

  addressedObjection: { trust: 8, patience: 3, interest: 2 },
  gaveSpecifics: { trust: 6, interest: 3 },
  empathy: { trust: 3, patience: 2 },
  discoveryQuestion: { interest: 4, trust: 2 },
  /** Yashirin ehtiyoj ochilganda. */
  needDiscovered: { trust: 10, interest: 15 },

  repeatedSelf: { patience: -8, interest: -3 },
  ignoredCustomer: { patience: -10, trust: -5 },
  pressured: { patience: -6, trust: -3 },
  redLine: { trust: -25, patience: -15 },

  /** Faqat maqtash (dalilsiz) — `just_info` mijozning qiziqishini tushiradi. */
  praiseWithoutSubstance: { interest: -4 },
} as const;

export interface TurnOutcomeEvent {
  code: string;
  detail?: string;
}

export interface ApplyTurnResult {
  state: TrainingState;
  /** Nima bo'lganining ro'yxati — debug, UI va Step 5 (baholash) uchun. */
  events: TurnOutcomeEvent[];
  /** Mijoz shu navbatda yangi e'tiroz ko'tardimi (persona'dagi indeks). */
  raisedObjectionIndex: number | null;
  /** Tozalangan signallar (default'lar qo'yilgan holda). */
  signals: TurnSignals;
}

/** Arxetipdan boshlang'ich holat. */
export function initialState(archetype: Archetype): TrainingState {
  return {
    patience: archetype.initialState.patience,
    trust: archetype.initialState.trust,
    interest: archetype.initialState.interest,
    turn: 0,
    objectionsRaised: 0,
    objectionsResolved: 0,
    pendingObjection: false,
    pendingObjectionAge: 0,
    needDiscovered: false,
    closeRequested: false,
    agreedNextStep: null,
    redLineBroken: false,
    status: 'active',
    outcome: null,
    endReason: null,
  };
}

function patienceDecay(archetype: Archetype): number {
  return ENGINE_RULES.patienceDecayBase + Math.floor(archetype.difficulty / 2);
}

/** Keyingi qadam taklifi arxetip qabul qiladigan ro'yxatga tushadimi. */
function matchNextStep(archetype: Archetype, proposed: string | null): string | null {
  if (!proposed) return null;
  const accepted = archetype.win.acceptedNextSteps;
  if (!accepted || accepted.length === 0) return null;
  const needle = proposed.trim().toLowerCase();
  if (needle.length === 0) return null;
  for (const step of accepted) {
    const hay = step.toLowerCase();
    if (hay === needle || hay.includes(needle) || needle.includes(hay)) return step;
  }
  return null;
}

/** Barcha arxetip e'tirozlari ko'tarilgan va yechilganmi. */
function allObjectionsResolved(archetype: Archetype, state: TrainingState): boolean {
  return (
    state.objectionsRaised >= archetype.objections.count &&
    state.objectionsResolved >= archetype.objections.count &&
    !state.pendingObjection
  );
}

/**
 * Rozilik sharti (win.type dan qat'i nazar umumiy qism).
 * `requireObjectionsResolved` bo'lsa — hamma e'tiroz yechilgan bo'lishi kerak.
 */
function agreeConditionsMet(archetype: Archetype, state: TrainingState): boolean {
  if (state.redLineBroken) return false;
  if (state.trust < archetype.win.minTrust) return false;
  if (archetype.win.requireObjectionsResolved && !allObjectionsResolved(archetype, state)) {
    return false;
  }
  if (archetype.hiddenNeed && !state.needDiscovered) return false;
  if (archetype.win.type === 'need_discovered_and_agree' && !state.needDiscovered) return false;
  return true;
}

/**
 * Bitta sotuvchi navbatini qo'llaydi va yangi holatni qaytaradi.
 * Holat o'zgarmas (immutable): kirish obyekti hech qachon o'zgartirilmaydi.
 */
export function applyTurn(
  archetype: Archetype,
  current: TrainingState,
  signalsInput: TurnSignalsInput,
): ApplyTurnResult {
  const signals = parseTurnSignals(signalsInput);
  const events: TurnOutcomeEvent[] = [];

  if (current.status === 'ended') {
    return { state: current, events: [{ code: 'already_ended' }], raisedObjectionIndex: null, signals };
  }

  const next: TrainingState = { ...current };
  next.turn = current.turn + 1;
  next.closeRequested = signals.askedToClose;

  let patience = current.patience;
  let trust = current.trust;
  let interest = current.interest;

  const add = (code: string, deltas: { patience?: number; trust?: number; interest?: number }) => {
    patience += deltas.patience ?? 0;
    trust += deltas.trust ?? 0;
    interest += deltas.interest ?? 0;
    events.push({ code });
  };

  // 1. Qizil chiziq — eng og'ir jazo, g'alabani butunlay bloklaydi.
  if (signals.brokeRedLine) {
    next.redLineBroken = true;
    add('red_line_broken', ENGINE_RULES.redLine);
  }

  // 2. Javobsiz e'tiroz bilan ishlash.
  if (current.pendingObjection) {
    if (signals.addressedObjection) {
      next.pendingObjection = false;
      next.pendingObjectionAge = 0;
      next.objectionsResolved = current.objectionsResolved + 1;
      add('objection_resolved', ENGINE_RULES.addressedObjection);
    } else {
      // Yoshi oshgani sari ko'proq sabr yeydi.
      const age = current.pendingObjectionAge + 1;
      next.pendingObjectionAge = age;
      add('objection_ignored', {
        patience: -(ENGINE_RULES.pendingObjectionPatience * age),
        trust: -ENGINE_RULES.pendingObjectionTrust,
      });
    }
  } else if (signals.addressedObjection) {
    // Javobsiz e'tiroz yo'q edi — bu "e'tirozni yechish" hisoblanmaydi.
    events.push({ code: 'no_pending_objection' });
  }

  // 3. Ijobiy signallar.
  if (signals.gaveSpecifics) add('gave_specifics', ENGINE_RULES.gaveSpecifics);
  if (signals.empathy) add('empathy', ENGINE_RULES.empathy);
  if (signals.askedDiscoveryQuestion) {
    add('discovery_question', ENGINE_RULES.discoveryQuestion);
    if (archetype.hiddenNeed && !current.needDiscovered) {
      next.needDiscovered = true;
      add('need_discovered', ENGINE_RULES.needDiscovered);
    }
  }

  // 4. Salbiy signallar.
  if (signals.repeatedSelf) add('repeated_self', ENGINE_RULES.repeatedSelf);
  if (signals.ignoredCustomer) add('ignored_customer', ENGINE_RULES.ignoredCustomer);
  if (signals.pressured) add('pressured', ENGINE_RULES.pressured);

  // 5. Dalilsiz maqtash: `just_info` mijoz uchun qiziqish tushadi.
  if (
    archetype.intent === 'just_info' &&
    !signals.gaveSpecifics &&
    !signals.askedDiscoveryQuestion &&
    !signals.addressedObjection
  ) {
    add('praise_without_substance', ENGINE_RULES.praiseWithoutSubstance);
  }

  // 6. Tabiiy sabr kamayishi.
  patience -= patienceDecay(archetype);

  next.patience = clampScore(patience);
  next.trust = clampScore(trust);
  next.interest = clampScore(interest);

  // 7. Keyingi qadam kelishuvi.
  const matched = matchNextStep(archetype, signals.proposedNextStep);
  if (matched) {
    next.agreedNextStep = matched;
    events.push({ code: 'next_step_proposed', detail: matched });
  }

  // 8. Mijoz yangi e'tiroz ko'taradi (bittadan, ketma-ket).
  let raisedObjectionIndex: number | null = null;
  if (!next.pendingObjection && next.objectionsRaised < archetype.objections.count) {
    raisedObjectionIndex = next.objectionsRaised;
    next.objectionsRaised = next.objectionsRaised + 1;
    next.pendingObjection = true;
    next.pendingObjectionAge = 0;
    events.push({ code: 'objection_raised', detail: String(raisedObjectionIndex) });
  }

  // 9. Yakun: avval yutqazish, keyin g'alaba, keyin limit.
  const ended = (outcome: TrainingState['outcome'], reason: TrainingEndReason) => {
    next.status = 'ended';
    next.outcome = outcome;
    next.endReason = reason;
    events.push({ code: 'session_ended', detail: `${outcome}/${reason}` });
  };

  if (next.patience < archetype.lose.patienceBelow) {
    ended('lost', next.redLineBroken ? 'red_line_broken' : 'patience_exhausted');
  } else if (agreeConditionsMet(archetype, next) && (next.closeRequested || next.agreedNextStep)) {
    if (next.closeRequested) {
      ended('won', 'agreed');
    } else {
      ended('won', 'next_step_agreed');
    }
  } else if (
    archetype.win.type === 'agree_or_next_step' &&
    next.agreedNextStep &&
    !next.redLineBroken &&
    next.trust >= archetype.win.minTrust
  ) {
    // Bu arxetip to'liq rozilik o'rniga aniq keyingi qadamga ham kelishadi
    // (e'tirozlar yechilmagan bo'lsa ham).
    ended('won', 'next_step_agreed');
  } else if (next.turn >= archetype.maxTurns) {
    ended('timeout', 'max_turns');
  }

  return { state: next, events, raisedObjectionIndex, signals };
}

/** Qulaylik uchun: signallar ketma-ketligini boshdan oxirigacha o'ynaydi. */
export function simulate(
  archetype: Archetype,
  turns: readonly TurnSignalsInput[],
): { state: TrainingState; results: ApplyTurnResult[] } {
  let state = initialState(archetype);
  const results: ApplyTurnResult[] = [];
  for (const turn of turns) {
    if (state.status === 'ended') break;
    const result = applyTurn(archetype, state, turn);
    results.push(result);
    state = result.state;
  }
  return { state, results };
}
