/**
 * Ssenariylar (Part 1) — LLM'siz va DB'siz tekshiruvlar:
 * sxema/validatsiya, JSON Schema mosligi, murojaat jadvali va post-check,
 * kontent chegaralari, emotsiya mashinasi, xavfsizlik bloki, soxta LLM bilan
 * to'liq ssenariy navbati (qayta so'rash, neytral gap, go'shak).
 *
 *   npm run verify:training:scenarios
 */
import { getArchetype } from './archetypes.js';
import { LlmCallError } from './errors.js';
import { personaCardSchema, type PersonaCard } from './persona.js';
import { buildTurnSystemPrompt } from './prompts.js';
import { computeReadiness, initState, type TrainingState } from './state.js';
import { addressCase, addressRule, findWrongAddress } from './scenario/address.js';
import {
  detectFormality,
  findBlocked,
  findPersonalAttacks,
  findWhitelistedInsults,
  isSafetyBlock,
  isWhitelistedInsult,
} from './scenario/content.js';
import { HANGUP_CLOSING_LINE, HANGUP_WARNING_LINE_SEN, NEUTRAL_FALLBACK_LINES } from './scenario/content-rules.js';
import { applyEmotionStep, applyPatience, decideFormality, emotionTone, insultAllowed } from './scenario/emotion.js';
import { SCENARIO_JSON_SCHEMA } from './scenario/json-schema.js';
import { buildScenarioTurnSystemPrompt } from './scenario/prompt.js';
import { runScenarioTurn } from './scenario/scenario-turn.js';
import {
  contentFlag,
  effectiveBehavior,
  resolveThresholds,
  scenarioArchetype,
  scenarioObjectSchema,
  scenarioSchema,
  scenarioWarnings,
  validateScenario,
  type Scenario,
  type SellerProfile,
} from './scenario/schema.js';
import {
  assert,
  assertDeepEqual,
  assertEqual,
  check,
  checkAsync,
  createReport,
  section,
} from './testing/assert.js';
import { FakeTrainerLlm } from './testing/fake-llm.js';

const report = createReport();

// ---------------------------------------------------------------------------
// Fixture (soha so'zlarisiz)
// ---------------------------------------------------------------------------
function makeScenario(over: Record<string, unknown> = {}): Scenario {
  const base = {
    id: 'test_angry',
    title_uz: "Jahldor mijoz (test)",
    description_uz: "Kecha bir necha marta bezovta qilingan, jahli chiqqan mijoz.",
    difficulty: 4,
    call_direction: 'outbound',
    relationship: 'new_lead',
    base_archetype: 'problematic',
    persona: {
      gender: 'male',
      age: { min: 40, max: 45 },
      role: 'parent',
      name_pool: ['Sherzod'],
      backstory: "Ariza qoldirgan, kecha uch marta qo'ng'iroq qilishgan.",
    },
    hidden_reason: 'Aslida hali ham qiziqadi.',
    real_objection: 'Sizlarda tartib yo\'q.',
    success_condition: 'Uzr va bitta aniq keyingi qadam.',
    hangup_condition: 'Yana bosim qilinsa.',
    emotion: {
      baseline: { anger: 60, trust: 20, interest: 40 },
      volatility: 'high',
      triggers: { anger_up: ['bosim'], anger_down: ['uzr'], trust_up: [], trust_down: [], interest_up: [], interest_down: [] },
    },
    behavior: {
      default_formality: 'siz',
      allow_sen_when_angry: true,
      sarcasm: 2,
      insult_level: 2,
      randomization_notes: [],
    },
    voice: { profile: 'auto', base_style: 'Irritated man.' },
    ...over,
  };
  return scenarioSchema.parse(base);
}

const persona: PersonaCard = personaCardSchema.parse({
  name: 'Sherzod',
  age: 42,
  gender: 'male',
  role: 'Ota',
  speakingStyle: 'Qisqa, keskin',
  language: 'uz',
  direction: 'outbound',
  situation: "Kecha uch marta qo'ng'iroq qilishgan",
  goal: 'Bezovta qilinmaslik',
  focusOffer: 'Test taklif',
  objections: [
    { key: 'no_order', text: "Tartib yo'q", severity: 3 },
    { key: 'busy', text: 'Vaqtim yo\'q', severity: 2 },
    { key: 'trust', text: 'Ishonmayman', severity: 3 },
    { key: 'price', text: 'Qimmat bo\'lsa kerak', severity: 2 },
    { key: 'later', text: 'Keyinroq', severity: 1 },
  ],
  hiddenFacts: ['Aslida hali ham qiziqadi.'],
  hiddenNeed: null,
  openingLine: 'Ha, eshitaman.',
});

const female: SellerProfile = { name: 'Dilnoza', gender: 'female', age: 24 };
const male: SellerProfile = { name: 'Jasur', gender: 'male', age: 25 };

function turnJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reply: "Xo'p, eshityapman.",
    intent: 'continue',
    emotion: { anger: 60, trust: 20, interest: 40, reason: 'nothing changed' },
    style: 'plain',
    insult: null,
    hangupConditionMet: false,
    objectionRaisedKey: null,
    objectionsResolvedKeys: [],
    needRevealed: false,
    nextStep: null,
    ...over,
  };
}

function stateFor(
  s: Scenario,
  anger = s.emotion.baseline.anger,
  formality: 'siz' | 'sen' = 'siz',
  extra: Partial<NonNullable<TrainingState['emotion']>> & { trust?: number; patience?: number } = {},
): TrainingState {
  const base = initState(getArchetype('problematic'));
  const { trust, patience, ...em } = extra;
  return {
    ...base,
    trust: trust ?? s.emotion.baseline.trust,
    interest: s.emotion.baseline.interest,
    patience: patience ?? s.emotion.baseline.patience,
    emotion: { anger, formality, ...em },
  };
}

// ---------------------------------------------------------------------------
section('[1] sxema va validatsiya');

check(report, 'yaroqli ssenariy o\'tadi; kontent ogohlantirishi', () => {
  const s = makeScenario();
  const flag = contentFlag(s);
  assert(flag.harsh && flag.warning !== null && flag.warning.includes('Tugatish'), 'ogohlantirish va tugatish eslatmasi');
});

check(report, 'yaroqsiz: aniq xabar (yo\'l: sabab)', () => {
  const bad = { ...makeScenario(), behavior: { ...makeScenario().behavior, insult_level: 3 }, extra: 1 };
  const v = validateScenario(bad, 'bad.json');
  assert(!v.ok, 'rad etildi');
  if (!v.ok) {
    assert(v.errors.some((e) => e.includes('bad.json: behavior.insult_level') && e.includes('2 dan oshmasligi')), v.errors.join(' | '));
    assert(v.errors.some((e) => /extra|Unrecognized/i.test(e)), `noma\'lum maydon: ${v.errors.join(' | ')}`);
  }
  const role = validateScenario({ ...makeScenario(), persona: { ...makeScenario().persona, role: 'child', age: { min: 30, max: 40 } } });
  assert(!role.ok && role.errors.some((e) => e.includes('persona.age')), 'rol/yosh mosligi');
  const thr = validateScenario({ ...makeScenario(), emotion: { ...makeScenario().emotion, thresholds: { sen_at: 30, siz_at: 50 } } });
  assert(!thr.ok && thr.errors.some((e) => e.includes('siz_at')), 'chegaralar tartibi');
});

check(report, "xususiyatlar: max 4, ziddiyat (iliq+jahldor) rad, yengil ziddiyat — ogohlantirish; eski shakl o'qiladi", () => {
  const conflict = validateScenario({ ...makeScenario(), emotion: { ...makeScenario().emotion, traits: ['iliq', 'jahldor'] } });
  assert(!conflict.ok && conflict.errors.some((e) => e.includes('zid')), conflict.ok ? '' : conflict.errors.join('|'));
  const five = validateScenario({ ...makeScenario(), emotion: { ...makeScenario().emotion, traits: ['jahldor', 'shoshqaloq', 'injiq', 'charchagan', 'kinoyali'] } });
  assert(!five.ok && five.issues.some((i) => i.field === 'Xususiyatlar'), "ko'pi bilan 4");
  const warn = validateScenario({ ...makeScenario(), emotion: { ...makeScenario().emotion, traits: ['iliq', 'kinoyali'] } });
  assert(warn.ok && warn.warnings.some((w) => w.includes('Kinoyali')), 'ogohlantirish');
  const legacy = makeScenario();
  assertEqual(legacy.emotion.volatility, 'fast', "high -> fast (eski nom)");
  assertEqual(legacy.emotion.baseline.patience, 40, "patience = 100 - anger (eski shakl)");
  assert(scenarioWarnings(legacy).length >= 0, 'warnings');
});

check(report, "o'zbekcha xato xabarlari (maydon nomi bilan)", () => {
  const v = validateScenario({ ...makeScenario(), title_uz: '', difficulty: 9 });
  assert(!v.ok, 'rad');
  if (!v.ok) {
    assert(v.issues.some((i) => i.field === 'Nomi' && i.message.includes('belgi')), JSON.stringify(v.issues));
    assert(v.issues.some((i) => i.field === 'Qiyinlik' && i.message.includes("ko'pi bilan 5")), JSON.stringify(v.issues));
  }
});

check(report, "bola/o'smir: insult 0, sarcasm <= 1, sen yo'q (ssenariy nima desa ham)", () => {
  const kid = makeScenario({ persona: { ...makeScenario().persona, role: 'teenager', age: { min: 14, max: 16 } } });
  const b = effectiveBehavior(kid);
  assertEqual(b.insultLevel, 0, 'insult');
  assertEqual(b.sarcasm, 1, 'sarcasm');
  assertEqual(b.allowSen, false, 'sen');
  assert(b.capped.length === 3, 'cheklovlar qayd etildi');
});

check(report, "ssenariy mexanikasi: g'alaba = rozilik yoki keyingi qadam; max_turns; hiddenNeed saqlanadi", () => {
  const a = scenarioArchetype(makeScenario({ base_archetype: 'info_seeker', max_turns: 10 }));
  assertEqual(a.win.type, 'agree_or_next_step', 'win');
  assertEqual(a.maxTurns, 10, 'max_turns');
  assertEqual(a.hiddenNeed, true, 'hiddenNeed');
  assertEqual(scenarioArchetype(makeScenario({ base_archetype: undefined, difficulty: 2 })).key, 'ready_buyer', 'qiyinlikdan');
});

check(report, 'JSON Schema zod bilan bir xil maydonlar', () => {
  const zodKeys = (o: { shape?: unknown; _def?: { schema?: unknown; innerType?: unknown } }): string[] => {
    let node: unknown = o;
    for (let i = 0; i < 4; i += 1) {
      const n = node as { _def: { typeName: string; schema?: unknown; innerType?: unknown } };
      if (n._def.typeName === 'ZodObject') break;
      node = n._def.schema ?? n._def.innerType;
    }
    return Object.keys((node as { shape: Record<string, unknown> }).shape).sort();
  };
  const js = SCENARIO_JSON_SCHEMA as unknown as { properties: Record<string, { properties?: Record<string, unknown> }> };
  assertDeepEqual(Object.keys(js.properties).sort(), zodKeys(scenarioObjectSchema as never), 'ildiz');
  const shape = (scenarioObjectSchema as unknown as { shape: Record<string, never> }).shape;
  for (const k of ['persona', 'emotion', 'behavior', 'voice'] as const) {
    assertDeepEqual(Object.keys(js.properties[k]?.properties ?? {}).sort(), zodKeys(shape[k] as never), k);
  }
});

// ---------------------------------------------------------------------------
section('[2] murojaat shakllari');

check(report, 'qoidalar jadvali (mijoz yoshi/jinsi vs sotuvchi)', () => {
  assertEqual(addressCase(68, { age: 24 }), 'elder', 'buvi -> yosh sotuvchi');
  assertDeepEqual([...addressRule(68, female).allowed], ['qizim', 'bolam', 'singlim'], 'buvi -> ayol');
  assertDeepEqual([...addressRule(68, male).allowed], ["o'g'lim", 'bolam', 'uka'], 'buvi -> erkak');
  assertEqual(addressCase(42, { age: 25 }), 'older', '42 -> 25');
  assertDeepEqual([...addressRule(42, female).allowed], ['singlim', 'singil'], 'ota -> ayol');
  assertEqual(addressCase(28, { age: 30 }), 'peer', 'tengdosh');
  assertEqual(addressCase(15, { age: 22 }), 'younger', "o'smir");
  assertDeepEqual([...addressRule(15, female).allowed], ['opa', 'opajon'], "o'smir -> ayol");
});

check(report, "post-check: ayolga erkak murojaati (vokativ), uchinchi shaxs emas", () => {
  const r = addressRule(42, female);
  assertDeepEqual(findWrongAddress('Rahmat, uka.', r), ['uka'], 'uka,');
  assertDeepEqual(findWrongAddress("Ukajon, qarang, vaqtim yo'q.", r), ['uka'], 'ukajon boshda');
  assertDeepEqual(findWrongAddress("O'g'lim, tushundingizmi?", r), ["o'g'lim"], "o'g'lim,");
  assertDeepEqual(findWrongAddress('Akam kasal edi, kechirasiz.', r), [], "akam (uchinchi shaxs)");
  assertDeepEqual(findWrongAddress("O'g'lim maktabda o'qiydi.", r), [], "o'g'lim (o'z farzandi)");
  assertDeepEqual(findWrongAddress('Xo\'p, singlim.', r), [], "to'g'ri shakl");
  assertDeepEqual(findWrongAddress('Rahmat, qizim.', addressRule(68, male)), ['qizim'], 'erkakka qizim');
  assertDeepEqual(findWrongAddress("O'g'lim, maktabda yaxshi o'qiydi.", r), [], "o'z farzandi (vergul bilan)");
  assertDeepEqual(findWrongAddress("O'g'lim, uning ustozi yaxshi.", r), [], "o'z farzandi (uchinchi shaxs)");
  assertDeepEqual(findWrongAddress('Bilasizmi, uka, men bandman.', r), ['uka'], "o'rtada vokativ");
});

// ---------------------------------------------------------------------------
section('[3] kontent chegaralari');

check(report, 'bloklist, oq ro\'yxat, forma, xavfsizlik bloki', () => {
  assert(findBlocked('Onangni ...').length > 0, 'oila haqoratidan');
  assertDeepEqual(findBlocked('Assalomu alaykum, rahmat.'), [], 'toza matn');
  assertDeepEqual(findWhitelistedInsults("Tentakmisan? Gapimni tushun."), ['tentakmisan?'], 'oq ro\'yxat');
  assert(isWhitelistedInsult("Qulog'ing og'irmi"), 'tinish belgisisiz ham');
  assert(!isWhitelistedInsult('ahmoq'), "ro'yxatda yo'q");
  assertEqual(detectFormality('Sen nima deyapsan o\'zi?').form, 'sen', 'sen');
  assert(detectFormality('Sen nima deyapsan o\'zi?').strongSen, 'olmosh — kuchli');
  assertEqual(detectFormality('Siz kimsiz, ayting-chi?').form, 'siz', 'siz');
  assert(isSafetyBlock(new LlmCallError('http', 'HTTP 400: safety: Request blocked due to safety violations', { status: 400, providerMessage: 'safety: Request blocked' })), 'safety');
  assert(!isSafetyBlock(new LlmCallError('http', 'HTTP 400: bad field', { status: 400, providerMessage: 'bad field' })), 'oddiy 400');
});

// ---------------------------------------------------------------------------
section('[4] emotsiya mashinasi');

check(report, 'volatillik qadami va [0,100]', () => {
  const r = applyEmotionStep({ anger: 50, trust: 50, interest: 50 }, { anger: 100, trust: 0, interest: 52 }, 'slow');
  assertDeepEqual(r.next, { anger: 58, trust: 42, interest: 52 }, 'low: 8');
  assertDeepEqual(r.limited.sort(), ['anger', 'trust'], 'cheklanganlar');
  assertEqual(applyEmotionStep({ anger: 90, trust: 5, interest: 5 }, { anger: 130, trust: -10, interest: 5 }, 'fast').next.anger, 100, 'yuqori chegara');
  assertEqual(applyEmotionStep({ anger: 50, trust: 50, interest: 50 }, { anger: 100, trust: 50, interest: 50 }, 'fast').next.anger, 70, 'fast: +20');
  assertEqual(applyEmotionStep({ anger: 50, trust: 50, interest: 50 }, { anger: 100, trust: 50, interest: 50 }, 'medium').next.anger, 62, 'medium: +12');
});

check(report, "forma gisterezisi; haqoratga ruxsat; ohang", () => {
  const t = resolveThresholds(undefined);
  assertEqual(decideFormality('siz', 70, t, true), 'sen', '>= 70 -> sen');
  assertEqual(decideFormality('sen', 55, t, true), 'sen', 'oraliqda saqlanadi');
  assertEqual(decideFormality('sen', 40, t, true), 'siz', '<= 40 -> siz');
  assertEqual(decideFormality('siz', 95, t, false), 'siz', "ruxsat yo'q");
  const b = effectiveBehavior(makeScenario());
  assert(insultAllowed(85, t, b) && !insultAllowed(84, t, b), '85 chegarasi');
  assertEqual(emotionTone({ anger: 90, trust: 10, interest: 40 }, 'plain', b), 'angry', 'angry');
  assertEqual(emotionTone({ anger: 40, trust: 10, interest: 40 }, 'sarcastic', b), 'sarcastic', 'sarcastic');
  assertEqual(emotionTone({ anger: 60, trust: 10, interest: 40 }, 'plain', b), 'irritated', 'irritated');
  assertEqual(emotionTone({ anger: 10, trust: 70, interest: 60 }, 'plain', b), 'warm', 'warm');
  assertEqual(emotionTone({ anger: 10, trust: 50, interest: 10 }, 'plain', b), 'tired', 'tired');
  assertEqual(emotionTone({ anger: 10, trust: 30, interest: 60 }, 'plain', b), 'hesitant', 'hesitant');
  assertEqual(emotionTone({ anger: 10, trust: 50, interest: 60 }, 'plain', b), 'calm', 'calm');
});

// ---------------------------------------------------------------------------
section('[5] ssenariy navbati (soxta LLM)');

const archetype = getArchetype('problematic');
const base = (s: Scenario, st: TrainingState, llm: FakeTrainerLlm, seller = female) =>
  runScenarioTurn({
    llm,
    scenario: s,
    seller,
    persona,
    archetype,
    state: st,
    readiness: computeReadiness(st, persona, archetype),
    user: 'SELLER: test',
  });

await checkAsync(report, "ayol sotuvchiga 'uka' -> bir marta qayta so'raladi, tuzatma qayd etiladi", async () => {
  const s = makeScenario();
  const llm = new FakeTrainerLlm([turnJson({ reply: 'Rahmat, uka.' }), turnJson({ reply: 'Rahmat, singlim.' })]);
  const r = await base(s, stateFor(s), llm);
  assertEqual(llm.callCount, 2, 'ikki chaqiruv');
  assertEqual(r.result.reply, 'Rahmat, singlim.', 'tuzatilgan javob');
  assert(r.meta.corrections.includes('address_gender'), r.meta.corrections.join(','));
  assert(llm.calls[1]?.system.includes('wrong gender') ?? false, 'tuzatish eslatmasi');
});

await checkAsync(report, "qayta so'rashdan keyin ham noto'g'ri murojaat -> javob O'ZGARMAYDI (so'z o'chirilmaydi), logga yoziladi", async () => {
  const s = makeScenario();
  const llm = new FakeTrainerLlm([turnJson({ reply: 'Rahmat, uka.' }), turnJson({ reply: 'Xo\'p, uka.' })]);
  const r = await base(s, stateFor(s), llm);
  assertEqual(r.result.reply, "Xo'p, uka.", "so'z o'chirilmadi");
  assert(r.meta.corrections.includes('address_gender:kept'), 'qayd etildi');
});

await checkAsync(report, "sotuvchi jinsi/yoshiga haqorat ('sen qizni') -> qayta so'raladi; ikkinchi marta -> neytral gap", async () => {
  const s = makeScenario();
  const llm = new FakeTrainerLlm([
    turnJson({ reply: "Qulog'ing og'irmi sen qizni?", style: 'insult', insult: "qulog'ing og'irmi?", emotion: { anger: 90, trust: 5, interest: 10, reason: 'x' } }),
    turnJson({ reply: "Qulog'ing og'irmi? Kecha aytdim-ku!", style: 'insult', insult: "qulog'ing og'irmi?", emotion: { anger: 90, trust: 5, interest: 10, reason: 'x' } }),
  ]);
  const r = await base(s, stateFor(s, 88, 'sen'), llm, female);
  assert(r.meta.corrections.includes('personal_attack'), r.meta.corrections.join(','));
  assert(llm.calls[1]?.system.includes("gender or age") ?? false, 'tuzatish eslatmasi');
  assertEqual(r.result.reply, "Qulog'ing og'irmi? Kecha aytdim-ku!", 'tuzatilgan javob qabul');
  assertDeepEqual(findPersonalAttacks("Nevaram hali bola-ku, qizim maktabda."), [], "o'z farzandi haqida — haqorat emas");
  assert(findPersonalAttacks('Sen bolani kim ishga oldi?').length > 0, 'sen bolani');
  assert(findPersonalAttacks('Bolakay, gapni tushun!').length > 0, 'bolakay');
});

await checkAsync(report, 'bloklist ikki marta -> neytral gap; emotsiya o\'zgarmaydi', async () => {
  const s = makeScenario();
  const llm = new FakeTrainerLlm([turnJson({ reply: 'Onangni...' }), turnJson({ reply: 'Onangni...' })]);
  const r = await base(s, stateFor(s), llm);
  assert(NEUTRAL_FALLBACK_LINES.includes(r.result.reply), r.result.reply);
  assert(r.meta.fallback !== null && r.meta.corrections.includes('blocklist'), 'qayd etildi');
  assertEqual(r.state.emotion?.anger, 60, "jahl o'zgarmadi");
});

const safetyErr = (): LlmCallError =>
  new LlmCallError('http', 'HTTP 400: safety: Request blocked due to safety violations', { status: 400, providerMessage: 'safety: blocked' });

await checkAsync(report, "xavfsizlik bloki: bir marta yumshoqroq qayta -> muvaffaqiyat", async () => {
  const s = makeScenario();
  const llm = new FakeTrainerLlm([safetyErr(), turnJson({ reply: "Kecha uch marta qo'ng'iroq qilgansiz-ku!" })]);
  const r = await base(s, stateFor(s), llm, male);
  assertEqual(r.meta.safetyBlocks, 1, 'blok soni');
  assert(llm.calls[1]?.system.includes('blocked by the safety filter') ?? false, 'yumshoqroq ko\'rsatma');
  assert(llm.calls[1]?.system.includes('No insults at all') ?? false, 'haqorat o\'chirildi');
  assertEqual(r.meta.fallback, null, 'zaxira gap kerak bo\'lmadi');
});

await checkAsync(report, 'xavfsizlik bloki ikki marta -> neytral gap', async () => {
  const s = makeScenario();
  const llm = new FakeTrainerLlm([safetyErr(), safetyErr()]);
  const r = await base(s, stateFor(s), llm, male);
  assertEqual(r.meta.safetyBlocks, 2, 'blok soni');
  assert(NEUTRAL_FALLBACK_LINES.includes(r.result.reply), 'neytral gap');
});

await checkAsync(report, "jahl 100 ga yetdi, OGOHLANTIRILMAGAN -> go'shak YO'Q, bitta ogohlantirish", async () => {
  const s = makeScenario();
  const llm = new FakeTrainerLlm([turnJson({ reply: 'Bas qiling!', emotion: { anger: 100, trust: 0, interest: 10, reason: 'pressure again' } })]);
  const r = await base(s, stateFor(s, 85, 'sen'), llm, male);
  assertEqual(r.meta.hangup, null, "go'shak yo'q");
  assert(r.meta.warnedNow, 'ogohlantirildi');
  assertEqual(r.result.intent, 'continue', 'intent');
  assert(r.result.reply.includes(HANGUP_WARNING_LINE_SEN), `sen rejimida 'sen' shakli: ${r.result.reply}`);
  assertEqual(r.state.emotion?.anger, 99, 'jahl chegaradan bir pog\'ona past');
  assertEqual(r.state.emotion?.warned, true, 'holatda saqlandi');
});

await checkAsync(report, "ogohlantirilgandan keyin yana yomon navbat -> go'shak (yakuniy gap + ends_call)", async () => {
  const s = makeScenario();
  const llm = new FakeTrainerLlm([
    turnJson({ reply: 'Bas qiling!', sellerMistakes: ['repeated'], emotion: { anger: 100, trust: 0, interest: 10, reason: 'again' } }),
  ]);
  const r = await base(s, stateFor(s, 99, 'sen', { warned: true }), llm, male);
  assertEqual(r.meta.hangup, 'anger', "go'shak");
  assertEqual(r.result.intent, 'ends_call', 'intent');
  assert(r.result.reply.endsWith(HANGUP_CLOSING_LINE), r.result.reply);
});

await checkAsync(report, "may_hang_up=false -> jahl 100 bo'lsa ham go'shak yo'q", async () => {
  const s = makeScenario({ emotion: { ...makeScenario().emotion, may_hang_up: false } });
  const llm = new FakeTrainerLlm([turnJson({ reply: 'Bas!', hangupConditionMet: true, emotion: { anger: 100, trust: 0, interest: 10, reason: 'x' } })]);
  const r = await base(s, stateFor(s, 99, 'sen', { warned: true }), llm, male);
  assertEqual(r.meta.hangup, null, "go'shak yo'q");
});

await checkAsync(report, "sabr: takror/ma'ruza kamaytiradi, xatosiz navbat tiklaydi", async () => {
  assertEqual(applyPatience(50, ['repeated', 'lectured']), 23, '15+12');
  assertEqual(applyPatience(10, ['ignored_question']), 0, '0 dan past emas');
  assertEqual(applyPatience(50, []), 54, '+4');
  const s = makeScenario();
  const llm = new FakeTrainerLlm([turnJson({ sellerMistakes: ['repeated'] })]);
  const r = await base(s, stateFor(s, 60, 'siz', { patience: 30 }), llm, male);
  assertEqual(r.state.patience, 15, 'holatda');
  assertDeepEqual(r.meta.mistakes, ['repeated'], 'xatolar');
});

await checkAsync(report, "yashirin sabab: qiyinlik 4 -> 3 ta dolzarb savol + ishonch >= 50; erta aytilsa hisoblanmaydi", async () => {
  const s = makeScenario(); // qiyinlik 4
  const early = await base(s, stateFor(s, 40, 'siz', { trust: 60, goodQuestions: 0 }), new FakeTrainerLlm([turnJson({ needRevealed: true, askedRelevantQuestion: true })]), male);
  assert(early.meta.revealTooEarly && !early.meta.revealedNow, 'erta');
  assertEqual(early.state.emotion?.goodQuestions, 1, 'savol sanaldi');
  const llm = new FakeTrainerLlm([turnJson({ needRevealed: true, askedRelevantQuestion: true, emotion: { anger: 30, trust: 60, interest: 50, reason: 'x' } })]);
  const ok = await base(s, stateFor(s, 40, 'siz', { trust: 60, goodQuestions: 2 }), llm, male);
  assert(ok.meta.revealedNow && ok.state.emotion?.revealed === true, 'ochildi');
  assert(llm.calls[0]?.system.includes('You MAY admit your hidden reason') ?? false, 'promptda ruxsat');
  const hidden = await base(s, stateFor(s, 40, 'siz', { trust: 60, goodQuestions: 0 }), new FakeTrainerLlm([turnJson()]), male);
  void hidden;
});

await checkAsync(report, "rozilik: qiyinlik >= 3 da haqiqiy e'tiroz yechilmagan bo'lsa -> 'continue'", async () => {
  const s = makeScenario();
  const r = await base(s, stateFor(s, 20, 'siz', { trust: 80 }), new FakeTrainerLlm([turnJson({ intent: 'agrees_next_step', nextStep: 'shanba' })]), male);
  assert(r.meta.agreeBlocked && r.result.intent === 'continue', 'bloklandi');
});

await checkAsync(report, "ruxsatsiz haqorat (jahl < 85) -> qayta so'raladi", async () => {
  const s = makeScenario();
  const llm = new FakeTrainerLlm([
    turnJson({ reply: 'Tentakmisan?', style: 'insult', insult: 'tentakmisan?' }),
    turnJson({ reply: 'Yana qo\'ng\'iroq qilyapsizmi?' }),
  ]);
  const r = await base(s, stateFor(s, 60), llm, male);
  assert(r.meta.corrections.includes('insult_not_allowed'), r.meta.corrections.join(','));
  assertEqual(r.meta.insult, null, "haqorat qolmadi");
});

await checkAsync(report, "ruxsatli haqorat (jahl >= 85, insult 2): oq ro'yxatdan — qabul qilinadi", async () => {
  const s = makeScenario();
  const llm = new FakeTrainerLlm([
    turnJson({ reply: 'Tentakmisan? Kecha uch marta aytdim!', style: 'insult', insult: 'tentakmisan?', emotion: { anger: 90, trust: 5, interest: 20, reason: 'repeated pitch' } }),
  ]);
  const r = await base(s, stateFor(s, 88, 'sen'), llm, male);
  assertEqual(llm.callCount, 1, "qayta so'ralmadi");
  assertDeepEqual(r.meta.insult, { text: 'tentakmisan?', whitelisted: true, allowed: true }, 'haqorat qaydi');
});

await checkAsync(report, "'siz' paytida 'sen' olmoshi -> qayta so'raladi", async () => {
  const s = makeScenario();
  const llm = new FakeTrainerLlm([turnJson({ reply: 'Sen kimsan o\'zi?' }), turnJson({ reply: 'Siz kimsiz o\'zi?' })]);
  const r = await base(s, stateFor(s, 50), llm, male);
  assert(r.meta.corrections.includes('formality'), r.meta.corrections.join(','));
  assertEqual(r.meta.formalityUsed, 'siz', 'aniqlangan forma');
});

// ---------------------------------------------------------------------------
section('[6] prompt hajmi');

check(report, "ssenariy prompti arxetip promptidan ko'pi bilan ~800 token uzun (taxmin: belgi/4)", () => {
  const s = makeScenario();
  const st = stateFor(s);
  const readiness = computeReadiness(st, persona, archetype);
  const scenarioPrompt = buildScenarioTurnSystemPrompt({
    scenario: s,
    behavior: effectiveBehavior(s),
    thresholds: resolveThresholds(undefined),
    seller: female,
    persona,
    archetype,
    state: st,
    readiness,
    formality: 'siz',
    insultNow: false,
  });
  const archetypePrompt = buildTurnSystemPrompt({ persona, archetype, state: st, readiness });
  const extraTokens = Math.round((scenarioPrompt.length - archetypePrompt.length) / 4);
  console.log(`       arxetip ~${Math.round(archetypePrompt.length / 4)} tok, ssenariy ~${Math.round(scenarioPrompt.length / 4)} tok, farq ~${extraTokens} tok`);
  assert(extraTokens < 800, `farq ${extraTokens} token`);
});

console.log(`\nNatija: ${report.passed} o'tdi, ${report.failed} xato, ${report.skipped} tashlab ketildi.`);
if (report.failed > 0) process.exit(1);
