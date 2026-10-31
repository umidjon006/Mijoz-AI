/**
 * Tiplangan xatolar. Host ilova (Step 3 da route) `code` bo'yicha HTTP
 * statusini tanlaydi — xato matniga qarab emas.
 */
export type TrainingErrorCode =
  | 'profile_missing' // tenant profili to'ldirilmagan
  | 'persona_generation_failed' // LLM persona-card bermadi
  | 'llm_invalid_output' // LLM javobi sxemaga tushmadi (retry'dan keyin ham)
  | 'llm_timeout' // provayder belgilangan vaqtda javob bermadi
  | 'llm_provider_error' // provayder HTTP xato qaytardi (4xx/5xx)
  | 'session_not_found' // sessiya yo'q (yoki boshqa tenant'ga tegishli)
  | 'session_forbidden' // sessiya boshqa foydalanuvchiga tegishli
  | 'session_not_active'; // sessiya allaqachon tugagan

export class TrainingError extends Error {
  readonly code: TrainingErrorCode;
  readonly details?: unknown;
  /** LLM bilan bog'liq bo'lsa — haqiqiy sabab toifasi (log va UI uchun). */
  readonly llmErrorKind?: LlmErrorKind;

  constructor(code: TrainingErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'TrainingError';
    this.code = code;
    this.details = details;
    const kind = details === undefined ? undefined : classifyLlmError(details);
    if (kind && kind !== 'unknown') this.llmErrorKind = kind;
  }
}

/** Persona-card LLM'dan to'g'ri shaklda kelmadi (retry'dan keyin ham). */
export class PersonaGenerationError extends TrainingError {
  constructor(message: string, details?: unknown) {
    super('persona_generation_failed', message, details);
    this.name = 'PersonaGenerationError';
  }
}

// ---------------------------------------------------------------------------
// LLM chaqiruvi xatolarining toifalari
// ---------------------------------------------------------------------------

/**
 * LLM chaqiruvi NIMA sababdan yiqilgani:
 *  - `timeout`      — so'rov belgilangan vaqtda tugamadi (biz uzdik);
 *  - `http`         — provayder 4xx/5xx qaytardi (kvota, kalit, model nomi...);
 *  - `invalid_json` — javob keldi, lekin JSON emas;
 *  - `schema`       — JSON keldi, lekin sxemaga tushmadi;
 *  - `unknown`      — boshqa (tarmoq uzilishi va h.k.).
 *
 * Faqat `invalid_json` va `schema` "tuzatib qayta so'rash" bilan tuzaladi.
 * `timeout` ni adapter ko'pi bilan BIR marta takrorlaydi; `http` takrorlanmaydi.
 */
export type LlmErrorKind = 'timeout' | 'http' | 'invalid_json' | 'schema' | 'unknown';

/**
 * Adapterlar (host / harness) shu xatoni tashlaydi — modul provayder SDK'sini
 * bilmagan holda sababni ajrata oladi. Xabarda kalit bo'lmasligi SHART.
 */
export class LlmCallError extends Error {
  readonly kind: LlmErrorKind;
  /** HTTP status (`http` toifasida). */
  readonly status?: number;
  /** Provayderning qisqa xabari (kalitsiz, kesilgan). */
  readonly providerMessage?: string;

  constructor(
    kind: LlmErrorKind,
    message: string,
    extra: { status?: number; providerMessage?: string; cause?: unknown } = {},
  ) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = 'LlmCallError';
    this.kind = kind;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.providerMessage !== undefined) this.providerMessage = extra.providerMessage;
  }
}

/** Har qanday xatoni toifaga ajratadi (adapter `LlmCallError` bermasa ham). */
export function classifyLlmError(err: unknown): LlmErrorKind {
  if (err instanceof LlmCallError) return err.kind;
  if (err instanceof TrainingError) return err.llmErrorKind ?? 'unknown';
  if (err instanceof Error) {
    if (err.name === 'ZodError') return 'schema';
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'timeout';
    if (err instanceof SyntaxError) return 'invalid_json';
  }
  return 'unknown';
}

/** Tuzatuvchi prompt bilan qayta so'rash ma'nolimi (faqat javob shakli xato bo'lsa). */
export function isCorrectableLlmError(err: unknown): boolean {
  const kind = classifyLlmError(err);
  return kind === 'schema' || kind === 'invalid_json';
}

const KIND_LABEL: Record<LlmErrorKind, string> = {
  timeout: 'timeout — provayder belgilangan vaqtda javob bermadi',
  http: 'provayder HTTP xato qaytardi',
  invalid_json: 'javob JSON emas',
  schema: 'javob sxemaga tushmadi',
  unknown: 'kutilmagan xato',
};

/** Bir qatorli tavsif: `[timeout] ...` — log va UI xabari uchun. */
export function describeLlmError(err: unknown): string {
  const kind = classifyLlmError(err);
  const parts = [`[${kind}] ${KIND_LABEL[kind]}`];
  if (err instanceof LlmCallError) {
    if (err.status !== undefined) parts.push(`HTTP ${err.status}`);
    if (err.providerMessage) parts.push(err.providerMessage);
    else if (err.message && kind !== 'http') parts.push(err.message);
  } else if (err instanceof Error && err.name === 'ZodError' && 'issues' in err) {
    const issues = (err as { issues: Array<{ path: Array<string | number>; message: string }> }).issues;
    parts.push(issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
  } else if (err instanceof Error && err.message) {
    parts.push(err.message);
  }
  return parts.join(': ').slice(0, 500);
}

/** LLM xatosini toifasiga mos `TrainingError` ga aylantiradi. */
export function trainingErrorFromLlm(
  fallback: TrainingErrorCode,
  what: string,
  err: unknown,
): TrainingError {
  const kind = classifyLlmError(err);
  const code: TrainingErrorCode =
    kind === 'timeout' ? 'llm_timeout' : kind === 'http' ? 'llm_provider_error' : fallback;
  return new TrainingError(code, `${what}: ${describeLlmError(err)}`, err);
}

export function isTrainingError(err: unknown): err is TrainingError {
  return err instanceof TrainingError;
}
