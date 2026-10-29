/**
 * Mashq sessiyasining holati va bir qadamning "signal"lari.
 *
 * MUHIM (Step 1, 4-qoida): holat va win/lose qoidalari LLM'da emas, KODDA.
 * LLM faqat matn yozadi; qanday signal berilgani esa Step 3 da sotuvchi
 * javobidan ajratib olinadi va shu sxemaga solinadi. Shu sababli bu fayl
 * hech qanday LLM chaqirmaydi va hech qanday soha so'zini bilmaydi.
 */
import { z } from 'zod';

const score = z.number().int().min(0).max(100);

/** Sessiya qanday tugagani. */
export const trainingOutcomeSchema = z.enum(['won', 'lost', 'timeout']);
export type TrainingOutcome = z.infer<typeof trainingOutcomeSchema>;

/** Tugash sababi — UI va analitika uchun barqaror kalitlar. */
export const trainingEndReasonSchema = z.enum([
  'agreed', // mijoz rozi bo'ldi
  'next_step_agreed', // aniq keyingi qadamga kelishildi
  'patience_exhausted', // sabri tugadi
  'red_line_broken', // profildagi qizil chiziq buzildi
  'max_turns', // navbatlar limiti
  'abandoned', // sotuvchi tashlab ketdi (host tomondan)
]);
export type TrainingEndReason = z.infer<typeof trainingEndReasonSchema>;

/**
 * `training_session.state` jsonb ustunining aniq shakli.
 * Faqat shu sxema DB'ga yoziladi — qo'shimcha maydon kerak bo'lsa shu yerga.
 */
export const trainingStateSchema = z.object({
  // Mijozning uch o'lchovi (arxetip initialState dan boshlanadi)
  patience: score,
  trust: score,
  interest: score,

  /** Nechta sotuvchi navbati bo'lgani (0 dan boshlanadi). */
  turn: z.number().int().min(0),

  // E'tirozlar hisobi
  /** Mijoz nechta e'tiroz aytgani. */
  objectionsRaised: z.number().int().min(0),
  /** Shundan nechtasi yechilgani. */
  objectionsResolved: z.number().int().min(0),
  /** Hozir javobsiz turgan e'tiroz bormi. */
  pendingObjection: z.boolean(),
  /** Javobsiz e'tiroz ketma-ket necha navbat turgani (sabrga ta'sir qiladi). */
  pendingObjectionAge: z.number().int().min(0),

  // Yashirin ehtiyoj (hiddenNeed arxetiplari uchun)
  needDiscovered: z.boolean(),

  // Yopish (close) holati
  /** Sotuvchi oxirgi navbatda rozilik so'radimi. */
  closeRequested: z.boolean(),
  /** Kelishilgan keyingi qadam (acceptedNextSteps ichidan). */
  agreedNextStep: z.string().min(1).nullable(),

  /** Qizil chiziq buzilgan bo'lsa — g'alaba imkonsiz. */
  redLineBroken: z.boolean(),

  status: z.enum(['active', 'ended']),
  outcome: trainingOutcomeSchema.nullable(),
  endReason: trainingEndReasonSchema.nullable(),
});

export type TrainingState = z.infer<typeof trainingStateSchema>;

/**
 * Sotuvchining bitta navbati nimalarni qilgani.
 *
 * Step 3 da bu obyekt sotuvchi matnidan (LLM/analizator orqali) to'ldiriladi,
 * lekin HOLAT O'ZGARISHI faqat shu obyektga qarab, kodda hisoblanadi —
 * ya'ni bir xil signallar har doim bir xil natija beradi.
 */
export const turnSignalsSchema = z.object({
  /** Javobsiz turgan e'tirozga aniq javob berdi. */
  addressedObjection: z.boolean().default(false),
  /** Aniq dalil/raqam/shart aytdi ("sifatli" kabi umumiy gap emas). */
  gaveSpecifics: z.boolean().default(false),
  /** Mijozning maqsadi/holati haqida ochuvchi savol berdi. */
  askedDiscoveryQuestion: z.boolean().default(false),
  /** Mijozni tushunganini ko'rsatdi (empatiya). */
  empathy: z.boolean().default(false),
  /** Oldin aytganini takrorladi. */
  repeatedSelf: z.boolean().default(false),
  /** Mijozning savoli/e'tirozini e'tiborsiz qoldirdi. */
  ignoredCustomer: z.boolean().default(false),
  /** Bosim qildi / qistadi. */
  pressured: z.boolean().default(false),
  /** Profildagi `redLines` dan birini buzdi (masalan soxta kafolat). */
  brokeRedLine: z.boolean().default(false),
  /** Rozilik so'radi (yopishga harakat qildi). */
  askedToClose: z.boolean().default(false),
  /** Aniq keyingi qadam taklif qildi — matni `acceptedNextSteps` bilan solishtiriladi. */
  proposedNextStep: z.string().min(1).nullable().default(null),
});

export type TurnSignals = z.infer<typeof turnSignalsSchema>;
export type TurnSignalsInput = z.input<typeof turnSignalsSchema>;

export function parseTurnSignals(input: unknown): TurnSignals {
  return turnSignalsSchema.parse(input ?? {});
}

export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}
