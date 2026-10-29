/**
 * Mijoz arxetiplari (AI mijoz simulyatori uchun).
 *
 * MUHIM: arxetip matnlari o'zbek (lotin) tilida, lekin hech qanday soha
 * (sanoat) nomi yoki soha atamasi yo'q — domenga bog'liq faktlar
 * tenant'ning `business.profile` ichidan keladi.
 *
 * Arxetiplar runtime'da JSON'dan O'QILMAYDI: ular shu faylda tiplangan
 * konstantalar sifatida saqlanadi (`ARCHETYPES`). `archetypes.json` faqat
 * manba/hujjat sifatida qoladi.
 */
import { z } from 'zod';

const stateValue = z.number().int().min(0).max(100);

/** Mijozning boshlang'ich holati (deterministik mantiq uchun — Step 2). */
export const archetypeInitialStateSchema = z.object({
  patience: stateValue,
  trust: stateValue,
  interest: stateValue,
});

/** E'tirozlar byudjeti: nechta va eng og'iri qanchalik qattiq. */
export const archetypeObjectionsSchema = z.object({
  count: z.number().int().min(0).max(10),
  severityMax: z.number().int().min(1).max(5),
});

/** G'alaba sharti (kodda tekshiriladi, LLM'da emas). */
export const archetypeWinSchema = z.object({
  type: z.enum(['agree', 'agree_or_next_step', 'need_discovered_and_agree']),
  minTrust: stateValue,
  requireObjectionsResolved: z.boolean(),
  acceptedNextSteps: z.array(z.string().min(1)).optional(),
});

/** Yutqazish sharti. */
export const archetypeLoseSchema = z.object({
  patienceBelow: stateValue,
});

export const archetypeSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  intent: z.enum(['wants_to_buy', 'just_info']),
  difficulty: z.number().int().min(1).max(5),
  initialState: archetypeInitialStateSchema,
  objections: archetypeObjectionsSchema,
  hiddenNeed: z.boolean(),
  needRevealTriggers: z.array(z.string().min(1)).optional(),
  win: archetypeWinSchema,
  lose: archetypeLoseSchema,
  maxTurns: z.number().int().min(1).max(100),
  behaviorRules: z.array(z.string().min(1)).min(1),
});

export type Archetype = z.infer<typeof archetypeSchema>;
export type ArchetypeInitialState = z.infer<typeof archetypeInitialStateSchema>;

/** Mavjud arxetip kalitlari — DB'dagi CHECK bilan bir xil bo'lishi shart. */
export const ARCHETYPE_KEYS = ['ready_buyer', 'negotiator', 'problematic', 'info_seeker'] as const;

export type ArchetypeKey = (typeof ARCHETYPE_KEYS)[number];

export const ARCHETYPES: Readonly<Record<ArchetypeKey, Archetype>> = {
  ready_buyer: {
    key: 'ready_buyer',
    title: 'Tayyor mijoz',
    description: "Mahsulot/xizmat kerak, rozi bo'lishga tayyor. Asosiy savdo jarayonini o'rgatadi.",
    intent: 'wants_to_buy',
    difficulty: 1,
    initialState: { patience: 80, trust: 50, interest: 75 },
    objections: { count: 1, severityMax: 2 },
    hiddenNeed: false,
    win: { type: 'agree', minTrust: 55, requireObjectionsResolved: true },
    lose: { patienceBelow: 10 },
    maxTurns: 14,
    behaviorRules: [
      'Savollar beradi, lekin sotuvchi aniq javob bersa tez ijobiy javob beradi.',
      "Birinchi e'tiroz yengil (narx yoki vaqt haqida aniqlashtirish).",
    ],
  },
  negotiator: {
    key: 'negotiator',
    title: "Rozi bo'ladigan, lekin qiyinroq mijoz",
    description: "Rozi bo'lishi mumkin, lekin e'tirozlarni yechmaguncha yon bermaydi.",
    intent: 'wants_to_buy',
    difficulty: 3,
    initialState: { patience: 60, trust: 35, interest: 60 },
    objections: { count: 3, severityMax: 3 },
    hiddenNeed: false,
    win: { type: 'agree', minTrust: 55, requireObjectionsResolved: true },
    lose: { patienceBelow: 10 },
    maxTurns: 18,
    behaviorRules: [
      "Har e'tirozni alohida, ketma-ket aytadi (hammasini birdan emas).",
      "Umumiy javobga ('sifatli', 'arzon') qanoat qilmaydi, aniq dalil/raqam so'raydi.",
      "Sotuvchi e'tirozni yechsa, ishonchi o'sadi; e'tiborsiz qoldirsa, kamayadi.",
    ],
  },
  problematic: {
    key: 'problematic',
    title: "Muammolari ko'p mijoz",
    description:
      "Rozi bo'lishi kerak, lekin bir nechta muammo birdaniga. Sotuvchi bir amallab ko'ndirishi kerak.",
    intent: 'wants_to_buy',
    difficulty: 4,
    initialState: { patience: 45, trust: 25, interest: 55 },
    objections: { count: 5, severityMax: 4 },
    hiddenNeed: false,
    win: {
      type: 'agree_or_next_step',
      minTrust: 50,
      requireObjectionsResolved: false,
      acceptedNextSteps: [
        "Aniq vaqtli keyingi qo'ng'iroq",
        'Sinov/probniy variant',
        "Mas'ul shaxs bilan uchrashuv",
      ],
    },
    lose: { patienceBelow: 8 },
    maxTurns: 22,
    behaviorRules: [
      "Muammolar bir-biriga bog'liq (masalan byudjet + oila fikri + vaqt + shubha).",
      "Sabri tez kamayadi: bir xil gap takrorlansa yoki e'tibor berilmasa keskin tushadi.",
      "To'liq rozilik o'rniga aniq keyingi qadamga (sinov, uchrashuv) kelishishi mumkin, agar sotuvchi ishonch uyg'otsa.",
    ],
  },
  info_seeker: {
    key: 'info_seeker',
    title: "Faqat ma'lumot oluvchi mijoz",
    description:
      "Sotib olish niyati yo'q. Sotuvchi ehtiyojni aniqlab, mahsulot kerakligini ko'rsatishi kerak.",
    intent: 'just_info',
    difficulty: 4,
    initialState: { patience: 55, trust: 30, interest: 20 },
    objections: { count: 2, severityMax: 3 },
    hiddenNeed: true,
    needRevealTriggers: [
      "Sotuvchi mijozning maqsadi haqida ochiq savol beradi",
      "Sotuvchi mijozning hozirgi holati/muammosini so'raydi",
    ],
    win: { type: 'need_discovered_and_agree', minTrust: 55, requireObjectionsResolved: true },
    lose: { patienceBelow: 10 },
    maxTurns: 20,
    behaviorRules: [
      "Boshida 'faqat narxini bilmoqchiman / ma'lumot olyapman' deydi.",
      "Yashirin ehtiyojini O'ZI aytmaydi; faqat sotuvchi to'g'ri ochuvchi savol bersa ochiladi.",
      "Ehtiyoj ochilmasdan turib rozi bo'lmaydi. Sotuvchi faqat mahsulotni maqtasa qiziqishi tushadi.",
    ],
  },
};

export function isArchetypeKey(key: string): key is ArchetypeKey {
  return (ARCHETYPE_KEYS as readonly string[]).includes(key);
}

/** Arxetipni kalit bo'yicha oladi; noto'g'ri kalitda xato tashlaydi. */
export function getArchetype(key: string): Archetype {
  if (!isArchetypeKey(key)) {
    throw new Error(`Unknown archetype key: ${key}`);
  }
  return ARCHETYPES[key];
}

export function listArchetypes(): Archetype[] {
  return ARCHETYPE_KEYS.map((key) => ARCHETYPES[key]);
}
