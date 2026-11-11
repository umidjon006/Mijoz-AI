/**
 * Ssenariy JSON Schema (draft 2020-12) — muharrir avtoto'ldirishi va boshqa
 * tillar uchun. YAGONA haqiqiy tekshiruv — `schema.ts` (zod); bu fayl u bilan
 * mos turishi testda tekshiriladi (maydon nomlari bir xil).
 * Fayl ko'rinishida: harness/scenarios/scenario.schema.json (`npm run scenarios:check`).
 */
import { MAX_INSULT_LEVEL, MAX_TRAITS, TRAIT_KEYS } from './content-rules.js';
import { BUSY, MONEY, RELATIONS, SCENARIO_RELATIONSHIPS, SCENARIO_ROLES, VOLATILITY } from './schema.js';
import { ARCHETYPE_KEYS } from '../archetypes.js';

const score = { type: 'integer', minimum: 0, maximum: 100 } as const;
const str = (min: number, max: number) => ({ type: 'string', minLength: min, maxLength: max }) as const;
const triggers = { type: 'array', maxItems: 6, items: str(3, 160) } as const;

export const SCENARIO_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://sotuv-trener.local/scenario.schema.json',
  title: 'Training scenario',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'title_uz',
    'description_uz',
    'difficulty',
    'call_direction',
    'relationship',
    'persona',
    'hidden_reason',
    'real_objection',
    'success_condition',
    'hangup_condition',
    'emotion',
    'behavior',
    'voice',
  ],
  properties: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9_]{2,60}$' },
    title_uz: str(3, 120),
    description_uz: str(10, 600),
    difficulty: { type: 'integer', minimum: 1, maximum: 5 },
    call_direction: { enum: ['inbound', 'outbound'] },
    relationship: { enum: [...SCENARIO_RELATIONSHIPS] },
    base_archetype: { enum: [...ARCHETYPE_KEYS] },
    max_turns: { type: 'integer', minimum: 4, maximum: 40 },
    persona: {
      type: 'object',
      additionalProperties: false,
      required: ['gender', 'age', 'role', 'name_pool', 'backstory'],
      properties: {
        gender: { enum: ['male', 'female'] },
        age: {
          type: 'object',
          additionalProperties: false,
          required: ['min', 'max'],
          properties: {
            min: { type: 'integer', minimum: 6, maximum: 95 },
            max: { type: 'integer', minimum: 6, maximum: 95 },
          },
        },
        role: { enum: [...SCENARIO_ROLES] },
        name_pool: { type: 'array', minItems: 1, maxItems: 30, items: str(2, 40) },
        backstory: str(10, 600),
        relation: { enum: [...RELATIONS] },
        situation: {
          type: 'object',
          additionalProperties: false,
          required: ['money', 'busy', 'studied_before'],
          properties: { money: { enum: [...MONEY] }, busy: { enum: [...BUSY] }, studied_before: { type: 'boolean' } },
        },
      },
    },
    hidden_reason: str(3, 300),
    real_objection: str(3, 300),
    success_condition: str(3, 300),
    hangup_condition: str(3, 300),
    emotion: {
      type: 'object',
      additionalProperties: false,
      required: ['baseline', 'volatility', 'may_hang_up', 'traits', 'triggers'],
      properties: {
        baseline: {
          type: 'object',
          additionalProperties: false,
          required: ['anger', 'trust', 'interest', 'patience'],
          properties: { anger: score, trust: score, interest: score, patience: score },
        },
        volatility: { enum: [...VOLATILITY] },
        may_hang_up: { type: 'boolean' },
        traits: { type: 'array', maxItems: MAX_TRAITS, uniqueItems: true, items: { enum: [...TRAIT_KEYS] } },
        triggers: {
          type: 'object',
          additionalProperties: false,
          required: ['anger_up', 'anger_down', 'trust_up', 'trust_down', 'interest_up', 'interest_down'],
          properties: {
            anger_up: triggers,
            anger_down: triggers,
            trust_up: triggers,
            trust_down: triggers,
            interest_up: triggers,
            interest_down: triggers,
          },
        },
        thresholds: {
          type: 'object',
          additionalProperties: false,
          properties: { sen_at: score, siz_at: score, insult_at: score, hangup_at: score },
        },
      },
    },
    behavior: {
      type: 'object',
      additionalProperties: false,
      required: ['default_formality', 'allow_sen_when_angry', 'sarcasm', 'insult_level', 'randomization_notes'],
      properties: {
        default_formality: { const: 'siz' },
        allow_sen_when_angry: { type: 'boolean' },
        sarcasm: { type: 'integer', minimum: 0, maximum: 2 },
        insult_level: { type: 'integer', minimum: 0, maximum: MAX_INSULT_LEVEL },
        randomization_notes: { type: 'array', maxItems: 6, items: str(3, 200) },
      },
    },
    voice: {
      type: 'object',
      additionalProperties: false,
      required: ['profile', 'base_style'],
      properties: {
        profile: { type: 'string', pattern: '^(auto|[a-z]+_[a-z]+)$' },
        base_style: str(3, 300),
      },
    },
  },
} as const;
