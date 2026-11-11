/**
 * Ssenariy mijozining EMOTSIYA holati: {anger, trust, interest} (0..100).
 *
 * Model har navbatda YANGI qiymatlarni taklif qiladi (sababi bilan) — KOD
 * esa 0..100 ga va volatillik bo'yicha bir navbatlik qadamga chegaralaydi.
 * Forma (siz/sen), haqoratga ruxsat va go'shak qo'yish ham shu yerda.
 */
import type { VoiceTone } from '../voice/tone.js';
import { PATIENCE_RULES, VOLATILITY_MAX_STEP, type TraitKey } from './content-rules.js';
import type { Formality } from './content.js';
import type { EffectiveBehavior, Thresholds, Volatility } from './schema.js';

export interface EmotionValues {
  anger: number;
  trust: number;
  interest: number;
}

const clamp = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 0);

/** Taklif -> qo'llanadigan qiymat: [0,100] va |qadam| <= volatillik. */
export function applyEmotionStep(
  prev: EmotionValues,
  proposed: EmotionValues,
  volatility: Volatility,
): { next: EmotionValues; limited: Array<keyof EmotionValues> } {
  const max = VOLATILITY_MAX_STEP[volatility];
  const limited: Array<keyof EmotionValues> = [];
  const step = (k: keyof EmotionValues): number => {
    const want = clamp(proposed[k]) - prev[k];
    const d = Math.max(-max, Math.min(max, want));
    if (d !== want) limited.push(k);
    return clamp(prev[k] + d);
  };
  return { next: { anger: step('anger'), trust: step('trust'), interest: step('interest') }, limited };
}

/**
 * Forma gisterezis bilan: `sen` ga o'tish anger >= senAt (ruxsat bo'lsa),
 * `siz` ga qaytish anger <= sizAt; oraliqda — avvalgi forma saqlanadi.
 */
export function decideFormality(
  prev: Formality,
  anger: number,
  t: Pick<Thresholds, 'senAt' | 'sizAt'>,
  allowSen: boolean,
): Formality {
  if (!allowSen) return 'siz';
  if (anger >= t.senAt) return 'sen';
  if (anger <= t.sizAt) return 'siz';
  return prev;
}

/** Yumshoq haqorat (oq ro'yxatdan) hozir mumkinmi. */
export function insultAllowed(anger: number, t: Pick<Thresholds, 'insultAt'>, behavior: EffectiveBehavior): boolean {
  return behavior.insultLevel >= 2 && anger >= t.insultAt;
}

/** Go'shak qo'yiladimi (jahl chegarasi). */
export function angerHangup(anger: number, t: Pick<Thresholds, 'hangupAt'>): boolean {
  return anger >= t.hangupAt;
}

/** Sotuvchining xatolari (model har navbatda aytadi) — sabr shundan kamayadi. */
export const SELLER_MISTAKES = ['repeated', 'lectured', 'ignored_question', 'pressured', 'interrupted'] as const;
export type SellerMistake = (typeof SELLER_MISTAKES)[number];

/**
 * Sabr: sotuvchi takrorlasa, ma'ruza o'qisa, savolni e'tiborsiz qoldirsa,
 * bosim qilsa yoki gapni bo'lsa — kamayadi; xatosiz navbatda biroz tiklanadi.
 */
export function applyPatience(prev: number, mistakes: readonly SellerMistake[]): number {
  const unique = [...new Set(mistakes)];
  if (unique.length === 0) return clamp(prev + PATIENCE_RULES.recover);
  const drop = unique.reduce((s, m) => s + PATIENCE_RULES.drop[m], 0);
  return clamp(prev - drop);
}

/** Javob qanday "rang"da — model aytadi, kod tekshiradi. */
export type ReplyStyle = 'plain' | 'sarcastic' | 'insult';

/**
 * Emotsiya -> TTS ohangi (kod qaror qiladi; model ohang taklif qilmaydi).
 * calm | hesitant | irritated | angry | sarcastic | tired | warm.
 */
export function emotionTone(
  e: EmotionValues,
  style: ReplyStyle,
  behavior: EffectiveBehavior,
  traits: readonly TraitKey[] = [],
  patience = 100,
): VoiceTone {
  if (e.anger >= 80) return 'angry';
  if (style === 'sarcastic' && behavior.sarcasm > 0 && e.anger >= 30) return 'sarcastic';
  if (e.anger >= 55 || patience < PATIENCE_RULES.lowAt) return 'irritated';
  if (traits.includes('charchagan') && e.anger < 40) return 'tired';
  if (traits.includes('iliq') && e.trust >= 45 && e.anger < 30) return 'warm';
  if (e.interest < 25 && e.anger < 40) return 'tired';
  if (e.trust >= 65 && e.anger < 30) return 'warm';
  if (e.trust < 45 || e.interest < 45) return 'hesitant';
  return 'calm';
}
