/**
 * Ssenariy rejimidagi BITTA mijoz navbati (LLM + kod tekshiruvlari).
 *
 * Tartib:
 *  1. kod formani (siz/sen) va haqoratga ruxsatni OLDINGI emotsiyadan hisoblaydi;
 *  2. LLM javobi (emotsiya taklifi bilan);
 *     - provayder xavfsizlik bloki -> BIR marta yumshoqroq ko'rsatma bilan, keyin neytral gap;
 *     - JSON/sxema xatosi yoki bo'sh javob -> BIR marta tuzatish, keyin neytral gap;
 *  3. post-check (murojaat jinsi, forma, haqorat, bloklist, yozuv) — muammo
 *     bo'lsa BIR marta qayta so'rash (hammasi bitta tuzatish eslatmasida);
 *     baribir qolsa: noto'g'ri murojaat olib tashlanadi, taqiqlangan/ruxsatsiz
 *     mazmun — neytral gap bilan almashtiriladi;
 *  4. emotsiya: [0,100] va volatillik qadami; jahl chegarasi yoki go'shak
 *     sharti -> qo'ng'iroq tugaydi (yakuniy gap bilan).
 * Har bir tuzatish `corrections` ga yoziladi va logga chiqadi.
 */
import type { Archetype } from '../archetypes.js';
import { describeLlmError, isCorrectableLlmError } from '../errors.js';
import { nonLatinWords } from '../language.js';
import type { PersonaCard } from '../persona.js';
import type { PriceCall, TokenUsage, TrainerLlm, TrainingLogger } from '../ports.js';
import {
  applyTurnResult,
  type Readiness,
  type TrainingState,
  type TurnResult,
} from '../state.js';
import type { VoiceTone } from '../voice/tone.js';
import { addressRule, findWrongAddress } from './address.js';
import {
  detectFormality,
  findBlocked,
  findPersonalAttacks,
  hasHangupWarning,
  findWhitelistedInsults,
  isSafetyBlock,
  isWhitelistedInsult,
  type Formality,
} from './content.js';
import {
  HANGUP_CLOSING_LINE,
  HANGUP_WARNING_LINE,
  DIFFICULTY_LEVELS,
  HANGUP_WARNING_LINE_SEN,
  NEUTRAL_FALLBACK_LINES,
  REVEAL_RULES,
} from './content-rules.js';
import {
  angerHangup,
  applyEmotionStep,
  applyPatience,
  maxEmotionStep,
  questionsNeeded,
  decideFormality,
  emotionTone,
  insultAllowed,
  type EmotionValues,
  type SellerMistake,
} from './emotion.js';
import {
  buildScenarioTurnSystemPrompt,
  scenarioTurnOutputSchema,
  scenarioTurnParser,
  type ScenarioTurnOutput,
} from './prompt.js';
import { effectiveBehavior, resolveThresholds, type Scenario, type SellerProfile } from './schema.js';

export interface ScenarioTurnMeta {
  emotion: EmotionValues & { reason: string };
  /** Model taklif qilgan (cheklanmagan) qiymatlar. */
  proposed: EmotionValues;
  /** Volatillik tufayli cheklangan ko'rsatkichlar. */
  limited: Array<keyof EmotionValues>;
  /** Kod buyurgan forma va javobda aniqlangani (taxminiy). */
  formality: Formality;
  formalityUsed: Formality | null;
  style: ScenarioTurnOutput['style'];
  insult: { text: string; whitelisted: boolean; allowed: boolean } | null;
  corrections: string[];
  safetyBlocks: number;
  /** Javob neytral gapga almashtirilgan bo'lsa — sabab. */
  fallback: string | null;
  hangup: 'anger' | 'condition' | null;
  llmCalls: number;
  /** Sabr (navbatdan keyin) va sotuvchi xatolari (model aytgan). */
  patience: number;
  mistakes: SellerMistake[];
  /** Dolzarb savollar soni (jami) va yashirin sabab shu navbatda ochildimi. */
  goodQuestions: number;
  revealedNow: boolean;
  /** Model sababni aytdi, lekin shart bajarilmagan edi (erta). */
  revealTooEarly: boolean;
  /** Haqiqiy e'tiroz yechilganmi (jami). */
  objectionAddressed: boolean;
  /** Jahl chegarasiga yetdi — go'shak o'rniga OGOHLANTIRISH berildi. */
  warnedNow: boolean;
  /** Model rozi bo'ldi, lekin ssenariy sharti bajarilmagan — `continue` ga o'zgartirildi. */
  agreeBlocked: boolean;
}

export interface ScenarioTurnInput {
  llm: TrainerLlm;
  scenario: Scenario;
  seller: SellerProfile;
  persona: PersonaCard;
  archetype: Archetype;
  state: TrainingState;
  readiness: Readiness;
  /** Navbatning user prompti (transkript + sotuvchi gapi). */
  user: string;
  priceCall?: PriceCall | undefined;
  logger?: TrainingLogger | undefined;
  sessionId?: string;
  /** Neytral gap tanlash uchun (deterministik). */
  turnIndex?: number;
}

export interface ScenarioTurnOutcome {
  result: TurnResult;
  state: TrainingState;
  tone: VoiceTone;
  meta: ScenarioTurnMeta;
  usage?: TokenUsage;
  costUsd: number;
}

const SOFTER_NOTE =
  'Your previous reply was blocked by the safety filter. Keep the same feelings, but say it calmly: ' +
  'no insults, no sarcasm, no harsh or crude words. Short and polite-but-firm.';

export async function runScenarioTurn(input: ScenarioTurnInput): Promise<ScenarioTurnOutcome> {
  const { llm, scenario, seller, persona, archetype, state, readiness } = input;
  const behavior = effectiveBehavior(scenario);
  const thresholds = resolveThresholds(scenario.emotion.thresholds);
  const prev: EmotionValues = {
    anger: state.emotion?.anger ?? scenario.emotion.baseline.anger,
    trust: state.trust,
    interest: state.interest,
  };
  const formality = decideFormality(state.emotion?.formality ?? 'siz', prev.anger, thresholds, behavior.allowSen);
  const insultNow = insultAllowed(prev.anger, thresholds, behavior);
  const rule = addressRule(persona.age, seller);
  const em = state.emotion;
  const level = em?.level ?? 'medium';
  const lv = DIFFICULTY_LEVELS[level];
  const goodBefore = em?.goodQuestions ?? 0;
  const needQuestions = questionsNeeded(REVEAL_RULES.questionsByDifficulty[scenario.difficulty] ?? 2, level);
  // Sabab matni promptga FAQAT shart OLDINGI navbatlarda bajarilgan bo'lsa kiradi (sizib chiqmasin).
  const revealAllowed =
    (em?.revealed ?? false) || (goodBefore >= needQuestions && state.trust >= REVEAL_RULES.minTrust);
  const objectionRequired = scenario.difficulty >= lv.objectionRequiredFromDifficulty;
  const scenarioReadiness: Readiness =
    objectionRequired && !(em?.objectionAddressed ?? false)
      ? {
          readyToAgree: false,
          blockers: [...readiness.blockers, 'the seller has not addressed your real objection concretely yet'],
        }
      : readiness;

  const meta: ScenarioTurnMeta = {
    emotion: { ...prev, reason: '' },
    proposed: prev,
    limited: [],
    formality,
    formalityUsed: null,
    style: 'plain',
    insult: null,
    corrections: [],
    safetyBlocks: 0,
    fallback: null,
    hangup: null,
    llmCalls: 0,
    patience: state.patience,
    mistakes: [],
    goodQuestions: goodBefore,
    revealedNow: false,
    revealTooEarly: false,
    objectionAddressed: em?.objectionAddressed ?? false,
    warnedNow: false,
    agreeBlocked: false,
  };
  let usage: TokenUsage | undefined;
  let costUsd = 0;

  const call = async (correction?: string, mild = false): Promise<ScenarioTurnOutput> => {
    meta.llmCalls += 1;
    const system = buildScenarioTurnSystemPrompt({
      scenario,
      behavior: mild ? { ...behavior, sarcasm: 0, insultLevel: 0 } : behavior,
      thresholds,
      seller,
      persona,
      archetype,
      state,
      readiness: scenarioReadiness,
      formality: mild ? 'siz' : formality,
      insultNow: mild ? false : insultNow,
      revealAllowed,
      maxStep: maxEmotionStep(scenario.emotion.volatility, level),
      ...(correction ? { correction } : {}),
    });
    const req = { stage: 'training.turn', system, user: input.user, schema: scenarioTurnParser, outputSchema: scenarioTurnOutputSchema };
    if (typeof llm.completeJsonWithUsage === 'function') {
      const out = await llm.completeJsonWithUsage(req);
      usage = usage
        ? { ...out.usage, inputTokens: usage.inputTokens + out.usage.inputTokens, outputTokens: usage.outputTokens + out.usage.outputTokens }
        : out.usage;
      const c = input.priceCall ? input.priceCall(out.usage) : 0;
      costUsd += Number.isFinite(c) && c > 0 ? c : 0;
      return out.value;
    }
    return await llm.completeJson(req);
  };

  const neutral = (why: string): ScenarioTurnOutput => {
    meta.fallback = why;
    input.logger?.warn({ sessionId: input.sessionId, why }, `ssenariy: javob neytral gap bilan almashtirildi (${why})`);
    const lines = NEUTRAL_FALLBACK_LINES;
    return {
      reply: lines[(input.turnIndex ?? 0) % lines.length] ?? "Xo'p.",
      intent: 'continue',
      emotion: { ...prev, reason: `fallback: ${why}` },
      style: 'plain',
      insult: null,
      hangupConditionMet: false,
      sellerMistakes: [],
      askedRelevantQuestion: false,
      realObjectionAddressed: false,
      answeredExactly: false,
      showedEmpathy: false,
      objectionRaisedKey: null,
      objectionsResolvedKeys: [],
      needRevealed: false,
      nextStep: null,
    };
  };

  /** LLM chaqiruvi + xavfsizlik bloki / shakl xatosi siyosati. */
  const safeCall = async (correction?: string, mild = false): Promise<ScenarioTurnOutput | null> => {
    try {
      return await call(correction, mild);
    } catch (err) {
      if (isSafetyBlock(err)) {
        meta.safetyBlocks += 1;
        meta.corrections.push('safety_block');
        input.logger?.warn({ sessionId: input.sessionId }, `ssenariy: provayder xavfsizlik bloki — yumshoqroq qayta so'raladi`);
        try {
          return await call([correction, SOFTER_NOTE].filter(Boolean).join('\n'), true);
        } catch (err2) {
          if (isSafetyBlock(err2)) meta.safetyBlocks += 1;
          if (isSafetyBlock(err2) || isCorrectableLlmError(err2)) return null;
          throw err2;
        }
      }
      if (isCorrectableLlmError(err)) {
        meta.corrections.push('json_shape');
        try {
          return await call(
            `${correction ? `${correction}\n` : ''}Your previous answer did not match the required JSON shape: ${describeLlmError(err)}. Return valid JSON with all fields.`,
            mild,
          );
        } catch (err2) {
          if (isSafetyBlock(err2)) {
            meta.safetyBlocks += 1;
            return null;
          }
          if (isCorrectableLlmError(err2)) return null;
          throw err2;
        }
      }
      throw err;
    }
  };

  /** Javobdagi qoidabuzarliklar (bo'sh ro'yxat — toza). */
  const problems = (o: ScenarioTurnOutput): { notes: string[]; kinds: string[]; wrong: string[]; blocked: string[] } => {
    const notes: string[] = [];
    const kinds: string[] = [];
    const blocked = findBlocked(o.reply);
    if (blocked.length) {
      kinds.push('blocklist');
      notes.push(`Forbidden words used (${blocked.join(', ')}). Never use them; express displeasure with softer words.`);
    }
    const attacks = findPersonalAttacks(o.reply);
    if (attacks.length) {
      kinds.push('personal_attack');
      blocked.push(...attacks);
      notes.push(
        `You attacked the seller's gender or age ("${attacks.join('", "')}"). Never do that; criticise only what the seller did.`,
      );
    }
    const wrong = findWrongAddress(o.reply, rule);
    if (wrong.length) {
      kinds.push('address_gender');
      notes.push(
        `You addressed the seller as ${wrong.map((w) => `"${w}"`).join(', ')} — wrong gender. The seller is a ${seller.gender === 'female' ? 'WOMAN' : 'MAN'}; use only: ${rule.allowed.join(', ')}.`,
      );
    }
    if (persona.language === 'uz') {
      const bad = nonLatinWords(o.reply);
      if (bad.length) {
        kinds.push('script');
        notes.push(`Write only in Uzbek Latin script (not: ${bad.slice(0, 5).join(', ')}).`);
      }
    }
    const f = detectFormality(o.reply);
    if (formality === 'siz' && f.strongSen) {
      kinds.push('formality');
      notes.push('You used "sen". Address the seller with "siz" only.');
    }
    const found = findWhitelistedInsults(o.reply);
    const claims = o.style === 'insult' || o.insult !== null || found.length > 0;
    if (claims && !insultNow) {
      kinds.push('insult_not_allowed');
      notes.push('No insults now. Remove the insulting phrase.');
    } else if (claims && o.insult !== null && !isWhitelistedInsult(o.insult) && found.length === 0) {
      kinds.push('insult_not_whitelisted');
      notes.push('Use only an allowed mild phrase from the list, or none.');
    }
    return { notes, kinds, wrong, blocked };
  };

  // --- 1-urinish ------------------------------------------------------------
  let out = await safeCall();
  if (!out) out = neutral('safety_or_shape');

  // --- Post-check: muammo bo'lsa BIR marta qayta so'rash ---------------------
  if (!meta.fallback) {
    const p1 = problems(out);
    if (p1.notes.length > 0) {
      meta.corrections.push(...p1.kinds);
      input.logger?.warn({ sessionId: input.sessionId, kinds: p1.kinds }, `ssenariy: javob tuzatish uchun qayta so'raldi: ${p1.kinds.join(', ')}`);
      const again = await safeCall(p1.notes.join('\n'));
      if (!again) {
        out = neutral('safety_or_shape_after_correction');
      } else {
        out = again;
        const p2 = problems(out);
        if (p2.blocked.length || p2.kinds.includes('script') || p2.kinds.includes('insult_not_allowed')) {
          meta.corrections.push(...p2.kinds.map((k) => `${k}:fallback`));
          out = neutral(p2.kinds.join('+'));
        } else if (p2.wrong.length) {
          // So'z HECH QACHON o'chirilmaydi: javob saqlanadi, logga yoziladi.
          meta.corrections.push('address_gender:kept');
          input.logger?.warn(
            { sessionId: input.sessionId, forms: p2.wrong },
            `ssenariy: qayta so'rashdan keyin ham murojaat noto'g'ri (${p2.wrong.join(', ')}) — javob o'zgartirilmadi`,
          );
        }
      }
    }
  }

  // --- Emotsiya va go'shak --------------------------------------------------
  const proposed: EmotionValues = { anger: out.emotion.anger, trust: out.emotion.trust, interest: out.emotion.interest };
  const stepped = meta.fallback
    ? { next: { ...prev }, limited: [] as Array<keyof EmotionValues> }
    : applyEmotionStep(prev, proposed, scenario.emotion.volatility, level);
  const next = { ...stepped.next };
  meta.proposed = proposed;
  meta.limited = stepped.limited;
  meta.style = out.style;
  meta.formalityUsed = detectFormality(out.reply).form;
  const insultFound = findWhitelistedInsults(out.reply);
  const insultText = out.insult ?? insultFound[0] ?? null;
  meta.insult = insultText
    ? { text: insultText, whitelisted: isWhitelistedInsult(insultText) || insultFound.length > 0, allowed: insultNow }
    : null;

  // Sabr, dolzarb savollar, yashirin sabab, haqiqiy e'tiroz — KOD hisoblaydi.
  const mistakes = meta.fallback ? [] : [...new Set(out.sellerMistakes)];
  const patience = meta.fallback
    ? state.patience
    : applyPatience(state.patience, mistakes, { answeredExactly: out.answeredExactly, empathy: out.showedEmpathy }, level);
  const goodQuestions = goodBefore + (out.askedRelevantQuestion && !meta.fallback ? 1 : 0);
  const revealedBefore = em?.revealed ?? false;
  // Sabab faqat promptga kiritilgan navbatda (revealAllowed) ochilgan deb hisoblanadi.
  const revealedNow = !revealedBefore && out.needRevealed && revealAllowed;
  meta.revealTooEarly = !revealedBefore && out.needRevealed && !revealAllowed;
  const objectionAddressed = (em?.objectionAddressed ?? false) || (out.realObjectionAddressed && !meta.fallback);
  Object.assign(meta, { patience, mistakes, goodQuestions, revealedNow, objectionAddressed });
  if (meta.revealTooEarly) {
    input.logger?.warn(
      { sessionId: input.sessionId, goodQuestions, needQuestions },
      'ssenariy: model yashirin sababni erta aytdi (shart bajarilmagan) — ochilgan deb hisoblanmadi',
    );
  }

  let reply = out.reply;
  let intent = out.intent;
  const mayHang = scenario.emotion.may_hang_up;
  const warnedBefore = em?.warned ?? false;
  let warned = warnedBefore;
  if (mayHang && !meta.fallback) {
    const badAgain = mistakes.length > 0 && next.anger >= prev.anger;
    if (angerHangup(next.anger, thresholds) || (warnedBefore && badAgain && next.anger >= thresholds.insultAt)) {
      if (warnedBefore) {
        meta.hangup = 'anger';
      } else {
        // Jahl chegarasiga yetdi, lekin hali ogohlantirilmagan: go'shak o'rniga BITTA ogohlantirish.
        warned = true;
        meta.warnedNow = true;
        next.anger = Math.min(next.anger, thresholds.hangupAt - 1);
        if (intent === 'ends_call' || intent === 'refuses') intent = 'continue';
        if (!hasHangupWarning(reply)) {
          const line = formality === 'sen' ? HANGUP_WARNING_LINE_SEN : HANGUP_WARNING_LINE;
          reply = `${reply} ${line}`.length <= 300 ? `${reply} ${line}` : line;
        }
      }
    } else if (out.hangupConditionMet) {
      meta.hangup = 'condition';
    } else if (!warnedBefore && next.anger >= thresholds.insultAt && hasHangupWarning(reply)) {
      // Model o'zi ogohlantirdi — keyingi yomon navbatda go'shak.
      warned = true;
      meta.warnedNow = true;
    }
  }
  if (warned && next.anger <= thresholds.senAt) warned = false; // tinchlandi — ogohlantirish "kuyadi"
  if (meta.hangup && intent !== 'ends_call') {
    reply = `${reply} ${HANGUP_CLOSING_LINE}`.slice(0, 300);
    intent = 'ends_call';
  }
  // Ssenariy sharti bajarilmagan rozilik -> davom etadi (qo'llanmaydi).
  if ((intent === 'agrees' || intent === 'agrees_next_step') && !scenarioReadiness.readyToAgree && !(objectionAddressed && readiness.readyToAgree)) {
    meta.agreeBlocked = true;
    intent = 'continue';
  }
  meta.emotion = { ...next, reason: out.emotion.reason };

  const result: TurnResult = {
    reply,
    intent,
    deltas: { patience: 0, trust: 0, interest: 0 },
    objectionRaisedKey: out.objectionRaisedKey,
    objectionsResolvedKeys: out.objectionsResolvedKeys,
    needRevealed: revealedBefore || revealedNow,
    nextStep: out.nextStep,
  };
  // Flaglar (e'tirozlar, ehtiyoj) — umumiy qoidalar bilan; sonlar — emotsiyadan.
  const flagged = applyTurnResult(state, result, persona, archetype);
  const nextFormality = decideFormality(formality, next.anger, thresholds, behavior.allowSen);
  const applied: TrainingState = {
    ...flagged,
    patience,
    trust: next.trust,
    interest: next.interest,
    emotion: {
      anger: next.anger,
      formality: nextFormality,
      reason: out.emotion.reason.slice(0, 300),
      warned,
      goodQuestions,
      revealed: revealedBefore || revealedNow,
      objectionAddressed,
      level,
    },
  };

  return {
    result,
    state: applied,
    tone: emotionTone(next, out.style, behavior, scenario.emotion.traits, patience),
    meta,
    ...(usage ? { usage } : {}),
    costUsd,
  };
}
