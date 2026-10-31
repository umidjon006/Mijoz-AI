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
import {
  describeLlmError,
  isCorrectableLlmError,
  PersonaGenerationError,
  trainingErrorFromLlm,
} from './errors.js';
import { findScriptViolations, scriptCorrectionNote } from './language.js';
import { extractPriceFigures, offerPriceFigures } from './offer-facts.js';
import type { TrainerLlm, TrainingLogger } from './ports.js';
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
  const offerPrices = offerPriceFigures(offers);

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

    // Mijoz taklif narxini oldindan BILMAYDI: faqat `hiddenFacts` da (eshitgan
    // gap sifatida) bo'lishi mumkin. Qolgan matnlar mijoz promptiga tushadi.
    const knowsPrice: Array<[Array<string | number>, string]> = [
      [['openingLine'], card.openingLine],
      [['situation'], card.situation],
      [['goal'], card.goal],
      [['role'], card.role],
      [['speakingStyle'], card.speakingStyle],
      ...card.objections.map((o, i): [Array<string | number>, string] => [['objections', i, 'text'], o.text]),
    ];
    for (const [path, text] of knowsPrice) {
      const leaked = extractPriceFigures(text).filter((value) => offerPrices.has(value));
      if (leaked.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `mijoz taklif narxini (${leaked.join(', ')}) oldindan bilmaydi — bu matndan olib tashlang (faqat hiddenFacts da eshitgan gap sifatida bo'lishi mumkin)`,
        });
      }
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
  /** Yozuv tekshiruvi tuzatilmasa — ogohlantirish shu yerga. */
  logger?: TrainingLogger;
}

/** Sotuvchiga ko'rinadigan persona matnlari (ochilish gapi va keyin oshkor qilinadiganlar). */
export function personaUserFacingText(card: PersonaCard): Array<{ field: string; text: string }> {
  return [
    { field: 'name', text: card.name },
    { field: 'role', text: card.role },
    { field: 'openingLine', text: card.openingLine },
    { field: 'situation', text: card.situation },
    { field: 'goal', text: card.goal },
    { field: 'hiddenNeed', text: card.hiddenNeed ?? '' },
    ...card.hiddenFacts.map((text, i) => ({ field: `hiddenFacts.${i}`, text })),
    ...card.objections.map((o) => ({ field: `objections.${o.key}`, text: o.text })),
  ];
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
 *
 * Timeout / HTTP xato — JAVOB SHAKLI muammosi emas: tuzatuvchi qayta so'rov
 * yuborilmaydi (adapter timeout'ni o'zi bir marta takrorlaydi), xato darhol
 * haqiqiy toifasi bilan (`llm_timeout` / `llm_provider_error`) chiqadi.
 */
export async function generatePersonaCard({
  llm,
  profile,
  archetype,
  direction,
  language = 'uz',
  random = Math.random,
  logger,
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

  const request = (correctionText?: string) => {
    const promptInput = { ...constraints, correction: correctionText };
    return llm.completeJson({
      stage: 'training.persona',
      system: buildPersonaSystemPrompt(promptInput),
      user: buildPersonaUserPrompt(promptInput),
      schema,
      outputSchema: personaCardSchema,
    });
  };

  // Til `uz`: lotin bo'lmagan harflar — bitta tuzatish urinishi, keyin log.
  const checkScript = async (card: PersonaCard): Promise<PersonaCard> => {
    if (language !== 'uz') return card;
    const violations = findScriptViolations(personaUserFacingText(card));
    if (violations.length === 0) return card;
    try {
      const retried = await request(scriptCorrectionNote(violations));
      if (findScriptViolations(personaUserFacingText(retried)).length === 0) return retried;
    } catch {
      // Tuzatish muvaffaqiyatsiz — birinchi (yaroqli) persona bilan davom etamiz.
    }
    logger?.warn(
      { violations },
      `persona matnida lotin bo'lmagan harflar qoldi: ${violations
        .map((v) => `${v.field}: ${v.words.join(', ')}`)
        .join('; ')}`.slice(0, 500),
    );
    return card;
  };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let card: PersonaCard;
    try {
      card = await request(correction);
    } catch (err) {
      if (!isCorrectableLlmError(err)) {
        throw trainingErrorFromLlm('persona_generation_failed', 'persona-card yaratilmadi', err);
      }
      lastError = err;
      correction = `Your previous JSON was rejected: ${issuesToText(err)}. Fix exactly these problems and return the full JSON again.`;
      continue;
    }
    return await checkScript(card);
  }

  throw new PersonaGenerationError(
    `persona-card 2 urinishdan keyin ham yaroqsiz: ${describeLlmError(lastError)}`,
    lastError,
  );
}
