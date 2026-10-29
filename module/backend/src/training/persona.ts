/**
 * Persona-card: arxetip (qanday xarakter) + biznes profili (qanday faktlar)
 * => AI mijoz o'ynaydigan aniq rol.
 *
 * MUHIM:
 *  - LLM YO'Q. Kard butunlay deterministik yig'iladi: urug' (seed, odatda
 *    sessiya id) bir xil bo'lsa — natija ham bir xil. Shu sababli sessiyani
 *    qayta o'ynash (replay) va test qilish mumkin.
 *  - Soha so'zlari KODDA YO'Q: hamma matn `business.profile` dan keladi.
 *    Profil bo'lmasa, kard neytral zahira matnlar bilan to'ldiriladi.
 *  - Step 3 da shu kard LLM uchun system-prompt'ga aylanadi (`personaToPrompt`
 *    kabi funksiya), lekin kardning O'ZI hamon kodda yig'iladi.
 */
import { z } from 'zod';

import { type Archetype } from './archetypes.js';
import type { BusinessProfile } from './profile-schema.js';

export const personaCardSchema = z.object({
  archetypeKey: z.string().min(1),
  archetypeTitle: z.string().min(1),
  intent: z.enum(['wants_to_buy', 'just_info']),
  difficulty: z.number().int().min(1).max(5),

  /** Mijozning maqsadi (profildagi `customerProblem` dan). */
  goal: z.string().min(1),
  /** Mijoz suhbatni qanday boshlaydi. */
  openingLine: z.string().min(1),
  /** Mijoz beradigan savollar (navbati bilan). */
  questionQueue: z.array(z.string().min(1)),
  /**
   * Mijoz ko'taradigan e'tirozlar — soni arxetipning `objections.count` iga
   * teng (profilda yetarli bo'lsa). Engine `objection_raised` da shu
   * ro'yxatdan indeks bilan oladi.
   */
  objectionQueue: z.array(z.string().min(1)),
  /** Yashirin ehtiyoj (faqat `hiddenNeed` arxetiplarda), aks holda null. */
  hiddenNeed: z.string().min(1).nullable(),
  /** Yashirin ehtiyoj ochiladigan shartlar. */
  revealTriggers: z.array(z.string().min(1)),
  /** Sotuvchi buzmasligi kerak bo'lgan chiziqlar (profildan). */
  redLines: z.array(z.string().min(1)),
  /** Mijoz ishlatadigan so'zlar (profildan) — tabiiy nutq uchun. */
  vocabulary: z.array(z.string().min(1)),
  /** Arxetipning xulq qoidalari. */
  behaviorRules: z.array(z.string().min(1)).min(1),
  /** Rozilik o'rniga qabul qiladigan keyingi qadamlar. */
  acceptedNextSteps: z.array(z.string().min(1)),
  /** Mijoz nimaga qiziqishi mumkin (profildagi takliflardan tanlangan). */
  offersInPlay: z.array(z.string().min(1)),

  /** Qayta o'ynash uchun: shu kard qaysi urug'dan yig'ilgani. */
  seed: z.string().min(1),
});

export type PersonaCard = z.infer<typeof personaCardSchema>;

// --- deterministik tasodif ------------------------------------------------
/** Satrdan 32-bit urug' (xmur3). */
function hashSeed(input: string): number {
  let h = 1779033703 ^ input.length;
  for (let i = 0; i < input.length; i += 1) {
    h = Math.imul(h ^ input.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

/** mulberry32 — kichik, tez, deterministik PRNG. */
function createRandom(seed: string): () => number {
  let a = hashSeed(seed) || 1;
  return function random(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ro'yxatni deterministik aralashtiradi (Fisher-Yates). */
function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

// --- neytral zahira matnlar (profil bo'sh bo'lsa) -------------------------
// Diqqat: bu matnlarda ham hech qanday soha so'zi yo'q.
const FALLBACK = {
  goal: "O'ziga mos variantni topmoqchi, lekin qaroridan ishonchi yo'q",
  opening: "Assalomu alaykum, shartlaringiz haqida bilmoqchi edim",
  openingInfoOnly: "Assalomu alaykum, hozircha faqat ma'lumot olyapman",
  objections: [
    'Narxi menga qimmatdek tuyuladi',
    "Hozir vaqtim yo'q, keyinroq",
    "O'ylab ko'raman, keyin aloqaga chiqaman",
    'Boshqa joyda qulayroq shart aytdi',
    'Maslahatlashib olishim kerak',
  ],
  questions: ['Shartlaringiz qanday?', 'Qancha turadi?', 'Qanchaga cho\'ziladi?'],
} as const;

function pickList(primary: readonly string[] | undefined, fallback: readonly string[]): string[] {
  const cleaned = (primary ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
  return cleaned.length > 0 ? cleaned : [...fallback];
}

export interface BuildPersonaOptions {
  archetype: Archetype;
  /** Tenant profili; hali to'ldirilmagan bo'lsa `null` bo'lishi mumkin. */
  profile: BusinessProfile | null;
  /** Odatda sessiya id — bir xil urug' = bir xil kard. */
  seed: string;
}

/**
 * Persona-card'ni yig'adi. Hech qanday I/O, hech qanday LLM, hech qanday
 * `Math.random()` — faqat kirish ma'lumotlari va urug'.
 */
export function buildPersonaCard({ archetype, profile, seed }: BuildPersonaOptions): PersonaCard {
  const random = createRandom(`${seed}:${archetype.key}`);

  const objectionPool = shuffle(
    pickList(profile?.commonObjections, FALLBACK.objections),
    random,
  );
  const questionPool = shuffle(
    pickList(profile?.commonCustomerQuestions, FALLBACK.questions),
    random,
  );
  const offerPool = shuffle(profile?.primaryOffers ?? [], random);

  // E'tirozlar soni arxetipdan; profilda kamroq bo'lsa — borini olamiz.
  const objectionQueue = objectionPool.slice(0, archetype.objections.count);

  const opening =
    archetype.intent === 'just_info'
      ? FALLBACK.openingInfoOnly
      : (questionPool[0] ?? FALLBACK.opening);

  const goal = profile?.customerProblem?.trim() ?? '';

  const card: PersonaCard = {
    archetypeKey: archetype.key,
    archetypeTitle: archetype.title,
    intent: archetype.intent,
    difficulty: archetype.difficulty,

    goal: goal.length > 0 ? goal : FALLBACK.goal,
    openingLine: opening,
    questionQueue: questionPool,
    objectionQueue,
    hiddenNeed: archetype.hiddenNeed ? (goal.length > 0 ? goal : FALLBACK.goal) : null,
    revealTriggers: archetype.hiddenNeed ? [...(archetype.needRevealTriggers ?? [])] : [],
    redLines: [...(profile?.redLines ?? [])],
    vocabulary: [...(profile?.vocabulary ?? [])],
    behaviorRules: [...archetype.behaviorRules],
    acceptedNextSteps: [...(archetype.win.acceptedNextSteps ?? [])],
    offersInPlay: offerPool.slice(0, 2),

    seed,
  };

  // O'zimizni o'zimiz tekshiramiz: kard har doim sxemaga mos chiqishi kerak.
  return personaCardSchema.parse(card);
}

/** Engine `objection_raised` qaytarganda mijoz aytadigan matn. */
export function objectionText(card: PersonaCard, index: number): string | null {
  return card.objectionQueue[index] ?? null;
}
