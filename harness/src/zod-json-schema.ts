/**
 * FAQAT HARNESS. Modul beradigan zod (v3) sxemasidan `response_format:
 * json_schema` (strict) uchun JSON Schema yasaydi.
 *
 * Ataylab SODDA: faqat tur, enum, majburiy maydonlar va
 * `additionalProperties: false`. Uzunlik/son chegaralari qo'yilmaydi —
 * provayderlar ularni turlicha qo'llaydi (yoki rad etadi); chegaralarni
 * baribir `schema.parse` (zod) tekshiradi.
 *
 * Qo'llanmaydigan tur uchun `null` qaytadi — adapter `json_object` ga tushadi.
 */
type JsonSchema = Record<string, unknown>;

/** `null` bo'lishi mumkin bo'lgan maydon qanday yoziladi. */
export type NullableStyle = 'anyOf' | 'type-array';

interface ZodLike {
  _def: { typeName?: string } & Record<string, unknown>;
}

function isZod(value: unknown): value is ZodLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_def' in value &&
    typeof (value as ZodLike)._def?.typeName === 'string'
  );
}

class Unsupported extends Error {}

function makeNullable(schema: JsonSchema, style: NullableStyle): JsonSchema {
  if (style === 'type-array' && typeof schema.type === 'string') {
    const { enum: values, ...rest } = schema;
    return {
      ...rest,
      type: [schema.type, 'null'],
      ...(Array.isArray(values) ? { enum: [...values, null] } : {}),
    };
  }
  return { anyOf: [schema, { type: 'null' }] };
}

function convert(node: ZodLike, style: NullableStyle): JsonSchema {
  const def = node._def;
  switch (def.typeName) {
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber': {
      const checks = (def.checks as Array<{ kind: string }> | undefined) ?? [];
      return { type: checks.some((c) => c.kind === 'int') ? 'integer' : 'number' };
    }
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum':
      return { type: 'string', enum: [...(def.values as string[])] };
    case 'ZodLiteral': {
      const value = def.value;
      if (typeof value === 'string') return { type: 'string', enum: [value] };
      if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' };
      if (typeof value === 'boolean') return { type: 'boolean' };
      throw new Unsupported('literal');
    }
    case 'ZodNull':
      return { type: 'null' };
    case 'ZodArray':
      return { type: 'array', items: convert(def.type as ZodLike, style) };
    case 'ZodObject': {
      const shape = (def.shape as () => Record<string, ZodLike>)();
      const properties: Record<string, JsonSchema> = {};
      for (const [key, value] of Object.entries(shape)) properties[key] = convert(value, style);
      return {
        type: 'object',
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
      };
    }
    case 'ZodNullable':
      return makeNullable(convert(def.innerType as ZodLike, style), style);
    case 'ZodOptional':
    case 'ZodDefault':
      // Strict rejimda hamma maydon majburiy; default'ni zod baribir qo'yadi.
      return convert(def.innerType as ZodLike, style);
    case 'ZodEffects':
      // superRefine / transform — tekshiruv zod'da qoladi, shakl ichkaridan.
      return convert(def.schema as ZodLike, style);
    case 'ZodUnion': {
      const options = def.options as ZodLike[];
      const nonNull = options.filter((o) => o._def.typeName !== 'ZodNull');
      const hasNull = nonNull.length < options.length;
      const literals = nonNull.filter((o) => o._def.typeName === 'ZodLiteral');
      let base: JsonSchema;
      if (literals.length === nonNull.length && literals.every((o) => typeof o._def.value === 'number')) {
        // 0|1|2|3 kabi: oddiy integer (qiymatni zod tekshiradi).
        base = { type: 'integer' };
      } else if (nonNull.length === 1) {
        base = convert(nonNull[0] as ZodLike, style);
      } else {
        base = { anyOf: nonNull.map((o) => convert(o, style)) };
      }
      return hasNull ? makeNullable(base, style) : base;
    }
    default:
      throw new Unsupported(String(def.typeName));
  }
}

/** zod sxemasidan JSON Schema; mos kelmasa `null`. */
export function zodToJsonSchema(
  schema: unknown,
  // `anyOf` — Gemini (OpenAI-mos) strict rejimida `diag:llm` bilan tasdiqlangan.
  style: NullableStyle = 'anyOf',
): JsonSchema | null {
  if (!isZod(schema)) return null;
  try {
    const out = convert(schema, style);
    return out.type === 'object' ? out : null;
  } catch (err) {
    if (err instanceof Unsupported) return null;
    throw err;
  }
}
