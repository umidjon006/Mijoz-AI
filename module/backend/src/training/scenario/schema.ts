/**
 * Mijoz SSENARIYSI sxemasi (zod — yagona manba). JSON Schema (`json-schema.ts`)
 * muharrir va boshqa tillar uchun; tekshiruv baribir shu zod bilan.
 *
 * Ssenariy — sozlanadigan mijoz: kim (persona), nima yashiradi, qachon rozi
 * bo'ladi / go'shakni qo'yadi, emotsiya qanday o'zgaradi, qanchalik qo'pol
 * gapira oladi va qanday ovozda. G'alaba/mag'lubiyat mexanikasi uchun bitta
 * asosiy arxetipga (`base_archetype`) tayanadi.
 */
import { z } from 'zod';

import { ARCHETYPE_KEYS, getArchetype, type Archetype, type ArchetypeKey } from '../archetypes.js';
import {
  EMOTION_THRESHOLDS,
  MAX_INSULT_LEVEL,
  MAX_TRAITS,
  NAME_HONORIFICS,
  TRAIT_CONFLICTS,
  TRAIT_KEYS,
  TRAITS,
  type TraitKey,
} from './content-rules.js';

const score = z.number().int().min(0).max(100);
const shortText = z.string().trim().min(3).max(300);
const triggerList = z.array(z.string().trim().min(3).max(160)).max(6);

export const SCENARIO_ROLES = [
  'parent',
  'self_learner',
  'grandparent',
  'teenager',
  'child',
  'businessman',
] as const;
export type ScenarioRole = (typeof SCENARIO_ROLES)[number];

export const SCENARIO_RELATIONSHIPS = ['new_lead', 'existing_student_parent', 'debtor', 'other'] as const;
export const VOLATILITY = ['slow', 'medium', 'fast'] as const;
export type Volatility = (typeof VOLATILITY)[number];
/** Part 1 nomlari -> yangi nomlar. */
const LEGACY_VOLATILITY: Record<string, Volatility> = { low: 'slow', med: 'medium', high: 'fast' };

/** Mijozning o'quvchiga munosabati (builder: "otasi, onasi ..."). */
export const RELATIONS = ['father', 'mother', 'grandmother', 'grandfather', 'brother', 'sister', 'self', 'other'] as const;
export type Relation = (typeof RELATIONS)[number];
export const RELATION_LABELS: Record<Relation, string> = {
  father: 'otasi',
  mother: 'onasi',
  grandmother: 'buvisi',
  grandfather: 'bobosi',
  brother: 'akasi',
  sister: 'opasi',
  self: "o'zi o'qimoqchi",
  other: 'boshqa',
};
export const MONEY = ['good', 'medium', 'hard'] as const;
export const BUSY = ['free', 'medium', 'very_busy'] as const;

export const scenarioEmotionSchema = z
  .object({
    baseline: z.object({ anger: score, trust: score, interest: score, patience: score }).strict(),
    volatility: z.enum(VOLATILITY),
    /** Mijoz umuman go'shak qo'ya oladimi (jahl yoki shart bo'yicha). */
    may_hang_up: z.boolean(),
    /** Xarakter xususiyatlari (ko'pi bilan 4 ta, takrorlanmasin). */
    traits: z.array(z.enum(TRAIT_KEYS as [TraitKey, ...TraitKey[]])).max(MAX_TRAITS),
    /** Nima ko'taradi / tushiradi (o'zbekcha, qisqa). */
    triggers: z
      .object({
        anger_up: triggerList,
        anger_down: triggerList,
        trust_up: triggerList,
        trust_down: triggerList,
        interest_up: triggerList,
        interest_down: triggerList,
      })
      .strict(),
    /** Ixtiyoriy: chegaralar (berilmasa `content-rules.ts` dagi default). */
    thresholds: z
      .object({ sen_at: score, siz_at: score, insult_at: score, hangup_at: score })
      .partial()
      .strict()
      .optional(),
  })
  .strict();

/** Ssenariy obyekti (refine/normalizatsiyasiz) — JSON Schema va AI chiqishi uchun. */
export const scenarioObjectSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{2,60}$/, 'id: kichik lotin harf, raqam va "_" (3-61 belgi)'),
    title_uz: z.string().trim().min(3).max(120),
    description_uz: z.string().trim().min(10).max(600),
    difficulty: z.number().int().min(1).max(5),
    call_direction: z.enum(['inbound', 'outbound']),
    relationship: z.enum(SCENARIO_RELATIONSHIPS),
    /** G'alaba/mag'lubiyat mexanikasi. Berilmasa — qiyinlikdan (1-2 ready_buyer, 3 negotiator, 4-5 problematic). */
    base_archetype: z.enum(ARCHETYPE_KEYS).optional(),
    /** Navbatlar limiti (berilmasa — arxetipniki). */
    max_turns: z.number().int().min(4).max(40).optional(),
    persona: z
      .object({
        gender: z.enum(['male', 'female']),
        age: z.object({ min: z.number().int().min(6).max(95), max: z.number().int().min(6).max(95) }).strict(),
        role: z.enum(SCENARIO_ROLES),
        /** Ism shu ro'yxatdan tasodifiy tanlanadi (bitta ism — aniq ism). */
        name_pool: z.array(z.string().trim().min(2).max(40)).min(1).max(30),
        backstory: z.string().trim().min(10).max(600),
        /** O'quvchiga kim (otasi, onasi, buvisi ...). Ixtiyoriy. */
        relation: z.enum(RELATIONS).optional(),
        /** Vaziyat: pul, bandlik, avval shu yerda o'qiganmi. Ixtiyoriy. */
        situation: z
          .object({ money: z.enum(MONEY), busy: z.enum(BUSY), studied_before: z.boolean() })
          .strict()
          .optional(),
      })
      .strict(),
    /** Sotuvchi nimani topishi kerak (yashirin). */
    hidden_reason: shortText,
    /** Haqiqiy e'tiroz (aytilgan sababning orqasidagi). */
    real_objection: shortText,
    /** Mijoz qachon rozi bo'ladi / keyingi qadamga keladi. */
    success_condition: shortText,
    /** Mijoz qachon go'shakni qo'yadi. */
    hangup_condition: shortText,
    emotion: scenarioEmotionSchema,
    behavior: z
      .object({
        default_formality: z.literal('siz'),
        allow_sen_when_angry: z.boolean(),
        sarcasm: z.number().int().min(0).max(2),
        insult_level: z.number().int().min(0).max(MAX_INSULT_LEVEL, {
          message: `insult_level ${MAX_INSULT_LEVEL} dan oshmasligi kerak (har qanday ssenariy uchun chegara)`,
        }),
        randomization_notes: z.array(z.string().trim().min(3).max(200)).max(6),
      })
      .strict(),
    voice: z
      .object({
        /** Ovoz profili kaliti (masalan "female_elder") yoki "auto" — jins/yoshdan. */
        profile: z.string().regex(/^(auto|[a-z]+_[a-z]+)$/),
        /** Asosiy gapirish uslubi (TTS uchun, inglizcha yoki o'zbekcha). */
        base_style: z.string().trim().min(3).max(300),
        /** Mos ovoz yo'q (masalan bola) — UI matnli rejimni tavsiya qiladi. */
        text_mode_recommended: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

/** Ismdan murojaat/qarindoshlik so'zlarini olib tashlaydi: "Rustam aka" -> "Rustam". */
export function sanitizeName(name: string): string {
  const honor = new Set(NAME_HONORIFICS.map((h) => h.toLowerCase()));
  return name
    .split(/\s+/)
    .filter((t) => t && !honor.has(t.toLowerCase().replace(/[ʻʼ’‘`´]/g, "'").replace(/[.,]$/, '')))
    .join(' ')
    .trim();
}

/** name_pool ni tozalaydi; o'zgarganlari uchun ogohlantirishlar (o'zbekcha). */
export function sanitizeNamePool(pool: unknown): { pool: unknown; warnings: string[] } {
  if (!Array.isArray(pool)) return { pool, warnings: [] };
  const warnings: string[] = [];
  const out: unknown[] = [];
  for (const n of pool) {
    if (typeof n !== 'string') {
      out.push(n);
      continue;
    }
    const clean = sanitizeName(n);
    if (clean !== n.trim()) {
      warnings.push(
        clean
          ? `Ismdan murojaat so'zi olib tashlandi: "${n.trim()}" -> "${clean}" (murojaatni tizim o'zi tanlaydi).`
          : `"${n.trim()}" ism emas (faqat murojaat so'zi) — olib tashlandi.`,
      );
    }
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return { pool: out, warnings };
}

/** Part 1 shaklini yangi shaklga o'tkazadi (eski fayllar va sessiya nusxalari uchun). */
export function normalizeScenarioInput(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object') return raw;
  const s = structuredClone(raw) as Record<string, unknown>;
  const persona = s.persona as Record<string, unknown> | undefined;
  if (persona && typeof persona === 'object') persona.name_pool = sanitizeNamePool(persona.name_pool).pool;
  const e = s.emotion as Record<string, unknown> | undefined;
  if (e && typeof e === 'object') {
    if (typeof e.volatility === 'string' && LEGACY_VOLATILITY[e.volatility]) e.volatility = LEGACY_VOLATILITY[e.volatility];
    const b = e.baseline as Record<string, unknown> | undefined;
    if (b && typeof b === 'object' && b.patience === undefined && typeof b.anger === 'number') {
      b.patience = Math.max(0, Math.min(100, 100 - b.anger));
    }
    if (e.traits === undefined) e.traits = [];
    if (e.may_hang_up === undefined) e.may_hang_up = true;
  }
  return s;
}

export const scenarioSchema = z.preprocess(
  normalizeScenarioInput,
  scenarioObjectSchema.superRefine((s, ctx) => {
    const { min, max } = s.persona.age;
    if (min > max) ctx.addIssue({ code: 'custom', path: ['persona', 'age'], message: `min (${min}) > max (${max})` });
    const roleAge: Partial<Record<ScenarioRole, [number, number]>> = {
      child: [6, 12],
      teenager: [13, 17],
      grandparent: [50, 95],
    };
    const range = roleAge[s.persona.role];
    if (range && (min < range[0] || max > range[1])) {
      ctx.addIssue({
        code: 'custom',
        path: ['persona', 'age'],
        message: `role "${s.persona.role}" uchun yosh ${range[0]}-${range[1]} oralig'ida bo'lishi kerak`,
      });
    }
    const t = resolveThresholds(s.emotion.thresholds);
    if (!(t.sizAt < t.senAt && t.senAt <= t.insultAt && t.insultAt <= t.hangupAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['emotion', 'thresholds'],
        message: `tartib shart: siz_at (${t.sizAt}) < sen_at (${t.senAt}) <= insult_at (${t.insultAt}) <= hangup_at (${t.hangupAt})`,
      });
    }
    if (s.emotion.baseline.anger >= t.hangupAt) {
      ctx.addIssue({ code: 'custom', path: ['emotion', 'baseline', 'anger'], message: `boshlang'ich jahl hangup_at (${t.hangupAt}) dan past bo'lsin` });
    }
    const traits = s.emotion.traits;
    if (new Set(traits).size !== traits.length) {
      ctx.addIssue({ code: 'custom', path: ['emotion', 'traits'], message: 'xususiyatlar takrorlanmasin' });
    }
    for (const c of TRAIT_CONFLICTS) {
      if (c.level === 'error' && traits.includes(c.a) && traits.includes(c.b)) {
        ctx.addIssue({
          code: 'custom',
          path: ['emotion', 'traits'],
          message: `"${TRAITS[c.a].label}" va "${TRAITS[c.b].label}" bir-biriga zid — bittasini olib tashlang`,
        });
      }
    }
  }),
);

export type Scenario = z.infer<typeof scenarioObjectSchema>;

/** Saqlashga to'sqinlik qilmaydigan ogohlantirishlar (o'zbekcha). */
export function scenarioWarnings(s: Scenario): string[] {
  const out: string[] = [];
  for (const c of TRAIT_CONFLICTS) {
    if (c.level === 'warn' && s.emotion.traits.includes(c.a) && s.emotion.traits.includes(c.b)) {
      out.push(`"${TRAITS[c.a].label}" va "${TRAITS[c.b].label}" birga g'alati ko'rinishi mumkin.`);
    }
  }
  const b = effectiveBehavior(s);
  for (const cap of b.capped) out.push(`Bola/o'smir uchun cheklandi: ${cap}.`);
  if (!s.emotion.may_hang_up) out.push("Mijoz go'shak qo'ymaydi — go'shak sharti e'tiborga olinmaydi.");
  if (s.emotion.traits.includes('jahldor') && s.emotion.baseline.anger < 20) {
    out.push("\"Jahldor\" xususiyati bor, lekin boshlang'ich jahl juda past.");
  }
  return out;
}

export interface Thresholds {
  senAt: number;
  sizAt: number;
  insultAt: number;
  hangupAt: number;
}

export function resolveThresholds(t: Scenario['emotion']['thresholds'] | undefined): Thresholds {
  return {
    senAt: t?.sen_at ?? EMOTION_THRESHOLDS.senAt,
    sizAt: t?.siz_at ?? EMOTION_THRESHOLDS.sizAt,
    insultAt: t?.insult_at ?? EMOTION_THRESHOLDS.insultAt,
    hangupAt: t?.hangup_at ?? EMOTION_THRESHOLDS.hangupAt,
  };
}

/** Bola va o'smir: haqorat 0, kinoya ko'pi bilan 1 — ssenariy nima desa ham. */
export function isMinorRole(role: ScenarioRole): boolean {
  return role === 'child' || role === 'teenager';
}

export interface EffectiveBehavior {
  insultLevel: number;
  sarcasm: number;
  allowSen: boolean;
  /** Cheklov qo'llandimi (masalan bola persona'da insult 2 -> 0). */
  capped: string[];
}

/** Ssenariy aytganini XAVFSIZLIK qoidalari bilan cheklaydi (kod qaror qiladi). */
export function effectiveBehavior(s: Scenario): EffectiveBehavior {
  const capped: string[] = [];
  let insultLevel = Math.min(s.behavior.insult_level, MAX_INSULT_LEVEL);
  let sarcasm = s.behavior.sarcasm;
  let allowSen = s.behavior.allow_sen_when_angry;
  if (isMinorRole(s.persona.role)) {
    if (insultLevel > 0) capped.push(`insult_level ${insultLevel} -> 0 (${s.persona.role})`);
    if (sarcasm > 1) capped.push(`sarcasm ${sarcasm} -> 1 (${s.persona.role})`);
    if (allowSen) capped.push(`allow_sen -> false (${s.persona.role})`);
    insultLevel = 0;
    sarcasm = Math.min(sarcasm, 1);
    allowSen = false;
  }
  return { insultLevel, sarcasm, allowSen, capped };
}

/** UI uchun: boshlashdan oldin ogohlantirish kerakmi (qattiq til). */
export interface ContentFlag {
  harsh: boolean;
  insultLevel: number;
  sarcasm: number;
  allowSen: boolean;
  /** O'zbekcha ogohlantirish matni (harsh bo'lsa). */
  warning: string | null;
  /** Mos ovoz yo'q — matnli rejim tavsiya etiladi. */
  textModeRecommended: boolean;
}

export function contentFlag(s: Scenario): ContentFlag {
  const b = effectiveBehavior(s);
  const harsh = b.insultLevel > 0 || b.allowSen || b.sarcasm >= 2;
  const parts: string[] = [];
  if (b.allowSen) parts.push('jahli chiqsa "sen" deb gapirishi');
  if (b.sarcasm > 0) parts.push('kinoya');
  if (b.insultLevel >= 2) parts.push("yengil haqorat (so'kinishsiz)");
  else if (b.insultLevel === 1) parts.push('kesatiq');
  return {
    harsh,
    insultLevel: b.insultLevel,
    sarcasm: b.sarcasm,
    allowSen: b.allowSen,
    textModeRecommended: s.voice.text_mode_recommended === true,
    warning: harsh
      ? `Bu ssenariyda mijoz qo'pol bo'lishi mumkin: ${parts.join(', ')}. Mashqni istalgan payt "Tugatish" bilan to'xtatishingiz mumkin.`
      : null,
  };
}

/** TTS asosiy uslubi: ssenariy uslubi + xususiyatlarning ovoz ishoralari. */
export function scenarioVoiceStyle(s: Scenario): string {
  const hints = s.emotion.traits.map((k) => TRAITS[k].tts);
  return [s.voice.base_style, hints.length ? `Character in the voice: ${hints.join(', ')}.` : '']
    .filter(Boolean)
    .join(' ')
    .slice(0, 300);
}

/** Ssenariy uchun asosiy arxetip. */
export function baseArchetypeOf(s: Scenario): ArchetypeKey {
  if (s.base_archetype) return s.base_archetype;
  return s.difficulty <= 2 ? 'ready_buyer' : s.difficulty === 3 ? 'negotiator' : 'problematic';
}

/**
 * Ssenariy sessiyasining mexanikasi: asosiy arxetip, lekin g'alaba — rozilik
 * YOKI aniq keyingi qadam (muvaffaqiyat sharti odatda shunday), navbatlar
 * limiti — `max_turns` (berilsa). Yashirin sabab talabi (hiddenNeed) saqlanadi.
 */
export function scenarioArchetype(s: Scenario): Archetype {
  const base = getArchetype(baseArchetypeOf(s));
  return {
    ...base,
    win: { ...base.win, type: 'agree_or_next_step' },
    ...(s.max_turns ? { maxTurns: s.max_turns } : {}),
  };
}

/** Maydon yo'li -> o'zbekcha nom (xato xabarlari uchun). */
export const FIELD_LABELS: Record<string, string> = {
  id: 'ID',
  title_uz: 'Nomi',
  description_uz: 'Vaziyat (tavsif)',
  difficulty: 'Qiyinlik',
  call_direction: "Qo'ng'iroq yo'nalishi",
  relationship: 'Munosabat turi',
  base_archetype: 'Asosiy arxetip',
  max_turns: 'Navbatlar soni',
  'persona.gender': 'Mijoz jinsi',
  'persona.age': 'Mijoz yoshi',
  'persona.age.min': 'Yosh (dan)',
  'persona.age.max': 'Yosh (gacha)',
  'persona.role': 'Mijoz roli',
  'persona.name_pool': 'Ism(lar)',
  'persona.backstory': 'Mijoz tarixi',
  'persona.relation': "O'quvchiga kim",
  'persona.situation': 'Mijoz vaziyati',
  hidden_reason: 'Yashirin sabab',
  real_objection: "Asosiy e'tiroz",
  success_condition: 'Muvaffaqiyat sharti',
  hangup_condition: "Go'shak qo'yish sharti",
  'emotion.baseline.anger': "Jahl (boshlang'ich)",
  'emotion.baseline.trust': "Ishonch (boshlang'ich)",
  'emotion.baseline.interest': "Qiziqish (boshlang'ich)",
  'emotion.baseline.patience': "Sabr (boshlang'ich)",
  'emotion.volatility': "O'zgaruvchanlik",
  'emotion.may_hang_up': "Go'shak qo'ya oladimi",
  'emotion.traits': 'Xususiyatlar',
  'emotion.thresholds': 'Chegaralar',
  'behavior.allow_sen_when_angry': '"Sen"ga o\'tish',
  'behavior.sarcasm': 'Kinoya darajasi',
  'behavior.insult_level': 'Haqorat darajasi',
  'behavior.randomization_notes': 'Xilma-xillik izohlari',
  'voice.profile': 'Ovoz',
  'voice.base_style': 'Ovoz uslubi',
};

function labelOf(path: readonly (string | number)[]): string {
  const key = path.filter((p) => typeof p === 'string').join('.');
  for (let k = key; k; k = k.includes('.') ? k.slice(0, k.lastIndexOf('.')) : '') {
    if (FIELD_LABELS[k]) return FIELD_LABELS[k] as string;
  }
  return key || '(ildiz)';
}

/** zod xatosi -> o'zbekcha matn. */
export function uzbekIssueMessage(issue: z.ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return issue.received === 'undefined'
        ? "to'ldirilishi shart"
        : `noto'g'ri qiymat turi (kutilgan: ${issue.expected === 'number' ? 'son' : issue.expected === 'string' ? 'matn' : issue.expected === 'boolean' ? "ha/yo'q" : issue.expected === 'array' ? "ro'yxat" : issue.expected})`;
    case 'too_small':
      if (issue.type === 'string') return `kamida ${issue.minimum} ta belgi bo'lsin`;
      if (issue.type === 'array') return `kamida ${issue.minimum} ta bo'lsin`;
      return `kamida ${issue.minimum} bo'lsin`;
    case 'too_big':
      if (issue.type === 'string') return `ko'pi bilan ${issue.maximum} ta belgi bo'lsin`;
      if (issue.type === 'array') return `ko'pi bilan ${issue.maximum} ta bo'lsin`;
      return issue.message.includes('dan oshmasligi') ? issue.message : `ko'pi bilan ${issue.maximum} bo'lsin`;
    case 'invalid_enum_value':
      return `ruxsat etilgan qiymatlardan biri bo'lishi kerak: ${issue.options.join(', ')}`;
    case 'invalid_literal':
      return `faqat "${String(issue.expected)}" bo'lishi mumkin`;
    case 'unrecognized_keys':
      return `noma'lum maydon(lar): ${issue.keys.join(', ')}`;
    case 'invalid_string':
      return issue.message && !/^Invalid/.test(issue.message) ? issue.message : "noto'g'ri format";
    default:
      return issue.message;
  }
}

export interface ScenarioIssue {
  /** Maydon yo'li ("emotion.traits"). */
  path: string;
  /** O'zbekcha maydon nomi. */
  field: string;
  /** O'zbekcha xato. */
  message: string;
}

export type ScenarioValidation =
  | { ok: true; scenario: Scenario; warnings: string[] }
  | { ok: false; errors: string[]; issues: ScenarioIssue[] };

/** Tekshiradi; xato bo'lsa — har bir muammo "manba: yo'l (nomi): sabab" ko'rinishida (o'zbekcha). */
export function validateScenario(raw: unknown, source = 'scenario'): ScenarioValidation {
  const nameWarnings =
    raw && typeof raw === 'object' && (raw as { persona?: { name_pool?: unknown } }).persona
      ? sanitizeNamePool((raw as { persona: { name_pool?: unknown } }).persona.name_pool).warnings
      : [];
  const parsed = scenarioSchema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, scenario: parsed.data, warnings: [...nameWarnings, ...scenarioWarnings(parsed.data)] };
  }
  const issues: ScenarioIssue[] = parsed.error.issues.map((i) => ({
    path: i.path.join('.') || '(ildiz)',
    field: labelOf(i.path),
    message: uzbekIssueMessage(i),
  }));
  return {
    ok: false,
    issues,
    errors: issues.map((i) => `${source}: ${i.path} (${i.field}): ${i.message}`),
  };
}

export class ScenarioValidationError extends Error {
  readonly errors: string[];
  readonly issues: ScenarioIssue[];
  constructor(errors: string[], issues: ScenarioIssue[] = []) {
    super(`ssenariy yaroqsiz:\n- ${errors.join('\n- ')}`);
    this.name = 'ScenarioValidationError';
    this.errors = errors;
    this.issues = issues;
  }
}

export function parseScenario(raw: unknown, source = 'scenario'): Scenario {
  const v = validateScenario(raw, source);
  if (!v.ok) throw new ScenarioValidationError(v.errors, v.issues);
  return v.scenario;
}

// ---------------------------------------------------------------------------
// Sotuvchi profili (sessiya boshida MAJBURIY — ovozdan yoki ismdan TAXMIN QILINMAYDI)
// ---------------------------------------------------------------------------
export const sellerProfileSchema = z
  .object({
    name: z.string().trim().min(2).max(60),
    gender: z.enum(['male', 'female']),
    age: z.number().int().min(16).max(80),
  })
  .strict();

export type SellerProfile = z.infer<typeof sellerProfileSchema>;
