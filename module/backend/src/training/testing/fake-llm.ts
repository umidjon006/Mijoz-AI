/**
 * Testlar uchun skriptlangan LLM. Haqiqiy model chaqirilmaydi, lekin
 * `TrainerLlm` porti aynan bir xil ishlaydi: javob SXEMA bilan tekshiriladi,
 * shuning uchun validatsiya va retry yo'llari ham sinaladi.
 */
import type { TrainerLlm, TrainerLlmRequest, TokenUsage } from '../ports.js';
import type { TurnIntent, TurnResult } from '../state.js';

export interface FakeCall {
  stage: string;
  system: string;
  user: string;
}

/** Skript elementi: tayyor JSON yoki so'rovga qarab javob beruvchi funksiya. */
export type FakeScriptItem = unknown | ((req: FakeCall) => unknown);

export interface FakeTrainerLlmOptions {
  /** `completeJsonWithUsage` ni ham taqdim etadi (narx testlari uchun). */
  usage?: TokenUsage;
}

export class FakeTrainerLlm implements TrainerLlm {
  readonly calls: FakeCall[] = [];
  private readonly script: FakeScriptItem[];
  private readonly usage?: TokenUsage;

  constructor(script: FakeScriptItem[], options: FakeTrainerLlmOptions = {}) {
    this.script = [...script];
    this.usage = options.usage;
    if (options.usage) {
      // Narx hisobi faqat shu metod bo'lganda ishlaydi.
      this.completeJsonWithUsage = async <T>(
        req: TrainerLlmRequest<T>,
      ): Promise<{ value: T; usage: TokenUsage }> => {
        const value = await this.completeJson(req);
        return { value, usage: options.usage as TokenUsage };
      };
    }
  }

  completeJsonWithUsage?: <T>(
    req: TrainerLlmRequest<T>,
  ) => Promise<{ value: T; usage: TokenUsage }>;

  get callCount(): number {
    return this.calls.length;
  }

  get lastCall(): FakeCall | undefined {
    return this.calls[this.calls.length - 1];
  }

  async completeJson<T>(req: TrainerLlmRequest<T>): Promise<T> {
    const call: FakeCall = { stage: req.stage, system: req.system, user: req.user };
    this.calls.push(call);

    const item = this.script.shift();
    if (item === undefined) {
      throw new Error(`FakeTrainerLlm: skript tugadi (stage=${req.stage})`);
    }
    const raw = typeof item === 'function' ? (item as (c: FakeCall) => unknown)(call) : item;
    if (raw instanceof Error) throw raw;

    // Haqiqiy klient kabi: javobni sxema bilan tekshiramiz.
    return req.schema.parse(raw);
  }
}

/** To'g'ri shakldagi navbat javobi (kerakli maydonlarni ustiga yozish mumkin). */
export function fakeTurn(partial: Partial<TurnResult> & { intent?: TurnIntent } = {}): unknown {
  return {
    reply: 'Tushunarli, lekin bir savolim bor.',
    intent: 'continue',
    deltas: { patience: 0, trust: 0, interest: 0 },
    objectionRaisedKey: null,
    objectionsResolvedKeys: [],
    needRevealed: false,
    nextStep: null,
    ...partial,
  };
}

export interface FakePersonaOptions {
  objectionKeys?: string[];
  severity?: number;
  focusOffer: string;
  hiddenNeed?: string | null;
  direction?: 'inbound' | 'outbound';
  language?: 'uz' | 'ru' | 'mixed';
}

/** To'g'ri shakldagi persona-card JSON'i. */
export function fakePersona({
  objectionKeys = ['price_too_high'],
  severity = 2,
  focusOffer,
  hiddenNeed = null,
  direction = 'inbound',
  language = 'uz',
}: FakePersonaOptions): unknown {
  return {
    name: 'Dilnoza Karimova',
    age: 31,
    role: 'Ofis xodimi',
    speakingStyle: "Tez gapiradi, qisqa javob kutadi",
    language,
    direction,
    situation: "Vaqti kam, kechqurun bo'sh bo'ladi",
    goal: "O'ziga qulay variantni topish",
    focusOffer,
    objections: objectionKeys.map((key, i) => ({
      key,
      text: `${key} haqida shubham bor (${i + 1})`,
      severity,
    })),
    hiddenFacts: ['Oldin boshqa joyda ko\'ngli qolgan'],
    hiddenNeed,
    openingLine: 'Assalomu alaykum, shartlaringizni bilmoqchi edim.',
  };
}
