/**
 * FAQAT HARNESS (korpus). LLM vazifalari: rollarni belgilash va MIJOZ
 * navbatlarini toifalash. LLM faqat YORLIQ qaytaradi (indeks bo'yicha) —
 * matnni qayta yozmaydi; misollarni kod transkriptdan aynan oladi.
 */
import { z } from 'zod';

import type { Segment, Turn } from './types.js';

export const OBJECTIONS = [
  'none', 'price', 'time', 'need_to_think', 'family', 'competitor', 'trust', 'not_interested', 'already_have', 'other',
] as const;
export const QUESTIONS = ['none', 'price', 'terms', 'schedule', 'location', 'trust', 'clarify', 'other'] as const;
export const EMOTIONS = ['neutral', 'impatience', 'doubt', 'irritation', 'interest'] as const;
export const SELLER_ISSUES = ['vague', 'pushy', 'rude'] as const;
export const ENDINGS = ['agreed', 'next_step', 'will_think', 'refused', 'hung_up', 'callback', 'unclear'] as const;
const ROLE = z.enum(['seller', 'customer', 'unknown']);

// --- Rollar -----------------------------------------------------------------
export const rolesSchema = z.object({
  speakerRoles: z.array(z.object({ speaker: z.string(), role: ROLE })).default([]),
  segmentRoles: z.array(z.object({ i: z.number().int(), role: ROLE })).default([]),
});
export type RolesResult = z.infer<typeof rolesSchema>;

export const ROLES_SYSTEM = [
  'You label who is speaking in a transcribed SALES PHONE CALL (Uzbek, sometimes Russian words).',
  'The seller represents the business (introduces the company, explains the offer, asks for a decision).',
  'The customer is the other person. Do NOT rewrite, translate or correct any text — only return labels.',
  'If speaker labels are given, return speakerRoles (one per label). Otherwise return segmentRoles (one per segment index).',
  'Use "unknown" when you cannot tell. Return JSON only.',
].join('\n');

export function rolesUserPrompt(segments: readonly Segment[], useSpeakers: boolean): string {
  const lines = segments.map((s) => `${s.index}${useSpeakers ? ` [${s.speaker ?? '?'}]` : ''}: ${s.display}`);
  return [
    useSpeakers
      ? `Speaker labels: ${[...new Set(segments.map((s) => s.speaker ?? '?'))].join(', ')}. Return speakerRoles.`
      : `Segments 0..${segments.length - 1}. Return segmentRoles for EVERY index.`,
    '',
    ...lines,
  ].join('\n');
}

/** LLM yorliqlarini segmentlarga qo'llaydi (matnga TEGMAYDI). */
export function applyRoles(segments: readonly Segment[], result: RolesResult, useSpeakers: boolean): Segment[] {
  if (useSpeakers) {
    const map = new Map(result.speakerRoles.map((r) => [r.speaker, r.role]));
    return segments.map((s) => ({ ...s, role: map.get(s.speaker ?? '?') ?? 'unknown' }));
  }
  const map = new Map(result.segmentRoles.map((r) => [r.i, r.role]));
  return segments.map((s) => ({ ...s, role: map.get(s.index) ?? 'unknown' }));
}

// --- Toifalash ----------------------------------------------------------------
export const classifySchema = z.object({
  customerTurns: z
    .array(
      z.object({
        i: z.number().int(),
        objection: z.enum(OBJECTIONS),
        question: z.enum(QUESTIONS),
        emotion: z.enum(EMOTIONS),
        /** Model ishonchsiz bo'lsa `low`. */
        confidence: z.enum(['high', 'low']),
      }),
    )
    .default([]),
  sellerIssues: z
    .array(z.object({ sellerTurn: z.number().int(), kind: z.enum(SELLER_ISSUES), reactionTurn: z.number().int().nullable() }))
    .default([]),
  ending: z.enum(ENDINGS),
  endingTurn: z.number().int().nullable(),
});
export type ClassifyResult = z.infer<typeof classifySchema>;

export const CLASSIFY_SYSTEM = [
  'You analyse a transcribed SALES PHONE CALL to learn how REAL CUSTOMERS talk.',
  'Classify ONLY the CUSTOMER turns. Never rewrite or quote text — return labels by turn index only.',
  `objection: ${OBJECTIONS.join(' | ')}`,
  `question: ${QUESTIONS.join(' | ')}  (what the customer asks about in this turn)`,
  `emotion: ${EMOTIONS.join(' | ')}  (only when clearly signalled by the words)`,
  'confidence: "low" when the transcript is garbled or the label is a guess.',
  `sellerIssues: seller turns that are ${SELLER_ISSUES.join(' / ')}, with the index of the customer turn that reacts (or null).`,
  `ending: how the call ends — ${ENDINGS.join(' | ')}; endingTurn: the turn index where it is decided (or null).`,
  'Return JSON only.',
].join('\n');

export function classifyUserPrompt(turns: readonly Turn[]): string {
  return [
    'Turns (index, role, text). Classify every CUSTOMER turn.',
    '',
    ...turns.map((t) => `${t.index} ${t.role.toUpperCase()}${t.quality === 'low_quality' ? ' (low quality)' : ''}: ${t.display}`),
  ].join('\n');
}
