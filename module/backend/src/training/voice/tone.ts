/**
 * Mijoz ovozining OHANGI (tone).
 *
 * Asosiy tamoyil o'zgarmaydi (2-qoida): **LLM taklif qiladi, KOD qaror qiladi.**
 * Model har navbatda ohangni taklif qilishi mumkin, lekin uni `clampTone`
 * holatga moslaydi: ishonchi past mijoz "do'stona" gapirmaydi, sabri
 * baland mijoz esa "jahl bilan" gapirmaydi. Shunday qilib model ohang orqali
 * holat mashinasini chetlab o'tolmaydi.
 *
 * Bu fayl provayderni bilmaydi: ohang -> TTS ko'rsatmasi xaritasi ham matn
 * ko'rinishida qaytariladi, uni ishlatish-ishlatmaslikni adapter hal qiladi
 * (ko'rsatmani qo'llamaydigan TTS uni e'tiborsiz qoldiradi).
 */
import type { Archetype } from '../archetypes.js';
import type { TrainingState } from '../state.js';

export const VOICE_TONES = [
  'calm',
  'friendly',
  'interested',
  'hesitant',
  'irritated',
  'angry',
  'sarcastic',
  'bored',
  // Ssenariy rejimi (emotsiyadan kod tanlaydi): charchagan, iliq.
  'tired',
  'warm',
] as const;

export type VoiceTone = (typeof VOICE_TONES)[number];

/** Hech narsa aniqlanmasa — neytral ohang. */
export const DEFAULT_TONE: VoiceTone = 'calm';

export function isVoiceTone(value: unknown): value is VoiceTone {
  return typeof value === 'string' && (VOICE_TONES as readonly string[]).includes(value);
}

/**
 * Chegaralar. Sonlar shu yerda — testlar ham, prompt ham bir manbaga qaraydi.
 *
 * `patienceMargin`: "sabr past" degani `archetype.lose.patienceBelow + margin`
 * dan past, ya'ni mijoz suhbatni uzishga yaqin.
 */
export const TONE_LIMITS = {
  /** Bundan past ishonch — "ishonmaydi". */
  lowTrust: 40,
  /** `friendly` / `interested` uchun kerakli eng kichik ishonch. */
  warmTrust: 55,
  /** Sabr "past" deb hisoblanadigan qo'shimcha oraliq. */
  patienceMargin: 15,
  /** Bundan past qiziqish — `bored` ga ruxsat. */
  lowInterest: 35,
} as const;

export interface ToneDecision {
  tone: VoiceTone;
  /** Model taklifi holatga to'g'ri kelmagani uchun o'zgartirildimi. */
  clamped: boolean;
  /** Nega o'zgartirildi (debug/telemetriya uchun; foydalanuvchiga ko'rsatilmaydi). */
  reason?: string;
}

function patienceIsLow(state: TrainingState, archetype: Archetype): boolean {
  return state.patience <= archetype.lose.patienceBelow + TONE_LIMITS.patienceMargin;
}

function trustIsLow(state: TrainingState): boolean {
  return state.trust < TONE_LIMITS.lowTrust;
}

/**
 * Model taklif qilgan ohangni holatga moslaydi.
 *
 * Qoidalar:
 *  - `angry`, `irritated`, `sarcastic` — faqat sabr YOKI ishonch past bo'lsa;
 *  - `friendly`, `interested` — faqat ishonch yetarli baland bo'lsa
 *    (`warmTrust`) va sabr tugayotgan bo'lmasa;
 *  - `bored` — faqat qiziqish past bo'lsa;
 *  - `calm`, `hesitant` — har doim mumkin.
 *
 * Ruxsat etilmagan taklif `calm` ga (sabr past bo'lsa `irritated` ga)
 * tushiriladi — ya'ni ohang holatdan "oldinga ketib qolmaydi".
 */
export function clampTone(
  suggested: unknown,
  state: TrainingState,
  archetype: Archetype,
): ToneDecision {
  const lowPatience = patienceIsLow(state, archetype);
  const lowTrust = trustIsLow(state);

  if (!isVoiceTone(suggested)) {
    // Taklif yo'q: holatga qarab eng tabiiy neytral ohang.
    return { tone: lowPatience ? 'irritated' : DEFAULT_TONE, clamped: false };
  }

  const deny = (reason: string): ToneDecision => ({
    tone: lowPatience ? 'irritated' : DEFAULT_TONE,
    clamped: true,
    reason,
  });

  switch (suggested) {
    case 'angry':
    case 'irritated':
    case 'sarcastic':
      if (lowPatience || lowTrust) return { tone: suggested, clamped: false };
      return deny(
        `${suggested}: sabr (${state.patience}) va ishonch (${state.trust}) yetarli baland`,
      );

    case 'friendly':
    case 'interested':
    case 'warm':
      if (state.trust < TONE_LIMITS.warmTrust) {
        return deny(`${suggested}: ishonch ${state.trust} < ${TONE_LIMITS.warmTrust}`);
      }
      if (lowPatience) return deny(`${suggested}: sabr ${state.patience} tugayapti`);
      return { tone: suggested, clamped: false };

    case 'bored':
    case 'tired':
      if (state.interest < TONE_LIMITS.lowInterest) return { tone: suggested, clamped: false };
      return deny(`${suggested}: qiziqish ${state.interest} >= ${TONE_LIMITS.lowInterest}`);

    case 'calm':
    case 'hesitant':
      return { tone: suggested, clamped: false };
  }
}

/**
 * Ohang -> TTS uchun GAPIRISH ko'rsatmasi (tezlik, energiya, balandlik).
 *
 * Ko'rsatmani qo'llaydigan model (masalan `instructions` parametri bor TTS)
 * shuni oladi; qo'llamaydigani e'tiborsiz qoldiradi — ikki holatda ham
 * ovozli navbat ishlayveradi.
 */
const TONE_INSTRUCTION: Record<VoiceTone, string> = {
  calm: 'Neutral, even pace, normal volume. Matter-of-fact, neither warm nor cold.',
  friendly: 'Warm and relaxed, slightly slower, a small smile in the voice.',
  interested:
    'Engaged and a little brighter, slightly faster, leaning forward — curious, asking to know more.',
  hesitant:
    'Uncertain and a little slower, with small pauses, as if weighing the words while speaking.',
  irritated:
    'Clipped and curt, slightly faster and flatter, low patience audible. Not shouting.',
  angry:
    'Raised voice and a faster pace, hard and tense, short sharp phrases, clearly angry. Loud but not screaming.',
  sarcastic: 'Dry and flat with a slight drawl, faint mocking edge, unimpressed.',
  bored: 'Flat, low energy, slower, trailing off — barely engaged.',
  tired: 'Tired and worn out, slow and heavy, sighing between phrases, low energy.',
  warm: 'Warm, soft and friendly, relaxed pace, a gentle smile in the voice, trusting.',
};

export function toneInstruction(tone: VoiceTone): string {
  return TONE_INSTRUCTION[tone];
}

/** Prompt uchun: model tanlashi mumkin bo'lgan ohanglar ro'yxati. */
export function toneListForPrompt(): string {
  return VOICE_TONES.map((tone) => `"${tone}"`).join('|');
}
