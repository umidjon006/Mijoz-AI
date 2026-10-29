/**
 * Tiplangan xatolar. Host ilova (Step 3 da route) `code` bo'yicha HTTP
 * statusini tanlaydi — xato matniga qarab emas.
 */
export type TrainingErrorCode =
  | 'profile_missing' // tenant profili to'ldirilmagan
  | 'persona_generation_failed' // LLM persona-card bermadi
  | 'llm_invalid_output' // LLM javobi sxemaga tushmadi (retry'dan keyin ham)
  | 'session_not_found' // sessiya yo'q (yoki boshqa tenant'ga tegishli)
  | 'session_forbidden' // sessiya boshqa foydalanuvchiga tegishli
  | 'session_not_active'; // sessiya allaqachon tugagan

export class TrainingError extends Error {
  readonly code: TrainingErrorCode;
  readonly details?: unknown;

  constructor(code: TrainingErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'TrainingError';
    this.code = code;
    this.details = details;
  }
}

/** Persona-card LLM'dan to'g'ri shaklda kelmadi (retry'dan keyin ham). */
export class PersonaGenerationError extends TrainingError {
  constructor(message: string, details?: unknown) {
    super('persona_generation_failed', message, details);
    this.name = 'PersonaGenerationError';
  }
}

export function isTrainingError(err: unknown): err is TrainingError {
  return err instanceof TrainingError;
}
