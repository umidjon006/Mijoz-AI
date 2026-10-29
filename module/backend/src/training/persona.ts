/**
 * Persona-card: bitta aniq mijoz. Sessiya boshida BIR MARTA generatsiya
 * qilinadi va `training_session.persona_card` ga yoziladi (7-qoida) — suhbat
 * davomida mijozning ismi, faktlari va e'tirozlari o'zgarmaydi.
 *
 * Domen faktlari faqat `business.profile` dan keladi; shu faylda hech qanday
 * soha so'zi yo'q.
 */
import { z } from 'zod';

import type { Archetype } from './archetypes.js';
import { PersonaGenerationError } from './errors.js';
import type { TrainerLlm } from './ports.js';
import { buildPersonaSystemPrompt, buildPersonaUserPrompt } from './prompts.js';
import type { BusinessProfile } from './profile-schema.js';

export const personaLanguageSchema = z.enum(['uz', 'ru', 'mixed']);
export type PersonaLanguage = z.infer<typeof personaLanguageSchema>;

/** `inbound` — mijoz o'zi qo'ng'iroq qiladi; `outbound` — sotuvchi qo'ng'iroq qiladi. */
export const personaDirectionSchema = z.enum(['inbound', 'outbound']);
export type PersonaDirection = z.infer<typeof personaDirectionSchema>;

export const personaObjectionSchema = z.object({
  /** Barqaror kalit (snake_case) — holat flaglarida shu ishlatiladi. */
  key: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, 'key snake_case bo\'lishi kerak'),
  /** Mijozning o'z ovozi bilan aytilgan e'tiroz matni. */
  text: z.string().min(3).max(300),
  severity: z.number().int().min(1).max(5),
});

export type PersonaObjection = z.infer<typeof personaObjectionSchema>;

/** Bazaviy sxema (DB'dan o'qiganda ham shu ishlatiladi). */
export const personaCardSchema = z.object({
  name: z.string().min(2).max(60),
  age: z.number().int().min(14).max(99),
  role: z.string().min(2).max(120),
  speakingStyle: z.string().min(3).max(300),
  language: personaLanguageSchema,
  direction: personaDirectionSchema,
  situation: z.string().min(3).max(600),
  goal: z.string().min(3).max(300),
  /** `profile.primaryOffers` dan AYNAN bitta satr. */
  focusOffer: z.string().min(1).max(300),
  objections: z.array(personaObjectionSchema).min(1).max(10),
  hiddenFacts: z.array(z.string().min(3).max(300)).min(1).max(3),
  hiddenNeed: z.string().min(3).max(300).nullable(),
  openingLine: z.string().min(2).max(300),
});

export type PersonaCard = z.infer<typeof personaCardSchema>;

export interface PersonaConstraints {
  archetype: Archetype;
  profile: BusinessProfile;
  direction: PersonaDirection;
  language: PersonaLanguage;
}

/**
 * Arxetip va profilga bog'liq QO'SHIMCHA qoidalar bilan kuchaytirilgan sxema:
 *  - e'tirozlar soni aynan `archetype.objections.count`;
 *  - severity `archetype.objections.severityMax` dan oshmaydi;
 *  - `focusOffer` profildagi takliflardan biri (aynan);
 *  - `hiddenNeed` faqat `archetype.hiddenNeed` bo'lsa va faqat o'shanda;
 *  - kalitlar unikal;
 *  - `language` va `direction` so'ralgan qiymatga teng.
 */
export function makePersonaCardSchema({
  archetype,
  profile,
  direction,
  language,
}: PersonaConstraints) {
  const offers = profile.primaryOffers.map((offer) => offer.trim());

  return personaCardSchema.superRefine((card, ctx) => {
    if (card.objections.length !== archetype.objections.count) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['objections'],
        message: `e'tirozlar soni aynan ${archetype.objections.count} bo'lishi kerak, keldi ${card.objections.length}`,
      });
    }

    for (const [i, objection] of card.objections.entries()) {
      if (objection.severity > archetype.objections.severityMax) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['objections', i, 'severity'],
          message: `severity ${archetype.objections.severityMax} dan oshmasligi kerak`,
        });
      }
    }

    const keys = card.objections.map((o) => o.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['objections'],
        message: 'e\'tiroz kalitlari unikal bo\'lishi kerak',
      });
    }

    if (!offers.includes(card.focusOffer.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['focusOffer'],
        message: `focusOffer profildagi primaryOffers dan AYNAN bittasi bo'lishi kerak; ruxsat etilganlar: ${offers
          .map((o) => `"${o}"`)
          .join(' | ')}`,
      });
    }

    if (archetype.hiddenNeed && (card.hiddenNeed === null || card.hiddenNeed.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hiddenNeed'],
        message: 'bu arxetipda hiddenNeed bo\'sh bo\'lmasligi kerak',
      });
    }
    if (!archetype.hiddenNeed && card.hiddenNeed !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hiddenNeed'],
        message: 'bu arxetipda hiddenNeed null bo\'lishi kerak',
      });
    }

    if (card.language !== language) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['language'],
        message: `language "${language}" bo'lishi kerak`,
      });
    }
    if (card.direction !== direction) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['direction'],
        message: `direction "${direction}" bo'lishi kerak`,
      });
    }
  });
}

export interface GeneratePersonaInput {
  llm: TrainerLlm;
  profile: BusinessProfile;
  archetype: Archetype;
  /** Berilmasa `profile.callDirection` dan olinadi (`mixed` -> random). */
  direction?: PersonaDirection;
  language?: PersonaLanguage;
  /** Deterministik testlar uchun; default `Math.random`. */
  random?: () => number;
}

/** `profile.callDirection` -> persona direction. */
export function resolveDirection(
  profile: BusinessProfile,
  random: () => number,
  explicit?: PersonaDirection,
): PersonaDirection {
  if (explicit) return explicit;
  if (profile.callDirection === 'inbound') return 'inbound';
  if (profile.callDirection === 'outbound') return 'outbound';
  return random() < 0.5 ? 'inbound' : 'outbound';
}

function issuesToText(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Bitta LLM chaqiruvi bilan persona-card yasaydi. Validatsiya o'tmasa —
 * xato matni qo'shilgan holda BIR marta qayta uriniladi; yana o'tmasa
 * `PersonaGenerationError`.
 */
export async function generatePersonaCard({
  llm,
  profile,
  archetype,
  direction,
  language = 'uz',
  random = Math.random,
}: GeneratePersonaInput): Promise<PersonaCard> {
  const resolvedDirection = resolveDirection(profile, random, direction);
  const constraints: PersonaConstraints = {
    archetype,
    profile,
    direction: resolvedDirection,
    language,
  };
  const schema = makePersonaCardSchema(constraints);

  let correction: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const promptInput = { ...constraints, correction };
    try {
      return await llm.completeJson({
        stage: 'training.persona',
        system: buildPersonaSystemPrompt(promptInput),
        user: buildPersonaUserPrompt(promptInput),
        schema,
      });
    } catch (err) {
      lastError = err;
      correction = `Your previous JSON was rejected: ${issuesToText(err)}. Fix exactly these problems and return the full JSON again.`;
    }
  }

  throw new PersonaGenerationError(
    `persona-card ${2} urinishdan keyin ham validatsiyadan o'tmadi: ${issuesToText(lastError)}`,
    lastError,
  );
}
