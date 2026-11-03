/**
 * Ovoz yozish tugmasining holat mashinasi — SOF funksiya (React'siz,
 * Node'da testlanadi).
 *
 * Ikki rejim:
 *  - `toggle` (default): bir bosish — yozish, ikkinchi bosish — to'xtatib yuborish;
 *  - `hold`: bosib turib gapirish, qo'yib yuborganda yuboriladi.
 * BO'SHLIQ ham ishlaydi: `toggle` da bosish = bir marta bosish, `hold` da bosib turish.
 *
 * Avvalgi xatolar shu yerda yopilgan:
 *  - "Juda qisqa" endi XATO emas: holat darhol `idle` ga qaytadi, yumshoq
 *    xabar chiqadi va keyingi yozuv darhol mumkin;
 *  - mikrofon hali ochilayotganda (`starting`) qo'yib yuborilsa — yozuv
 *    ochilishi bilan to'xtatiladi (avval abadiy yozilib qolardi);
 *  - 0.4 s dan qisqa yozuv serverga UMUMAN yuborilmaydi.
 */

export type RecordMode = 'toggle' | 'hold';

export type RecordPhase = 'idle' | 'starting' | 'recording' | 'stopping' | 'sending';

/** Bundan qisqa yozuv brauzerning o'zida tashlanadi (serverga bormaydi). */
export const MIN_RECORDING_SECONDS = 0.4;

export interface RecordState {
  phase: RecordPhase;
  /** Mikrofon ochilayotganda to'xtatish so'raldi — ochilishi bilan to'xtatiladi. */
  stopRequested: boolean;
  /** Yumshoq xabar (xato emas): oxirgi yozuv juda qisqa edi. */
  notice: 'too_short' | null;
}

export type RecordEvent =
  | { type: 'press' } // sichqoncha/barmoq/BO'SHLIQ bosildi
  | { type: 'release' } // qo'yib yuborildi
  | { type: 'click' } // to'liq bosish (toggle rejimi)
  | { type: 'cancel' } // "Bekor qilish"
  | { type: 'started' } // mikrofon ochildi, yozuv boshlandi
  | { type: 'startFailed' } // ruxsat yo'q va h.k.
  | { type: 'stopped'; seconds: number } // yozuv to'xtadi
  | { type: 'sent' } // navbat yakunlandi
  | { type: 'failed' }; // yuborish xato bilan tugadi

/** Komponent bajaradigan buyruq. */
export type RecordCommand = 'start' | 'stop' | 'discard' | 'send' | null;

export const INITIAL_RECORD_STATE: RecordState = {
  phase: 'idle',
  stopRequested: false,
  notice: null,
};

export interface RecordStep {
  state: RecordState;
  command: RecordCommand;
}

const startRecording = (): RecordStep => ({
  state: { phase: 'starting', stopRequested: false, notice: null },
  command: 'start',
});

const requestStop = (state: RecordState): RecordStep => {
  if (state.phase === 'starting') return { state: { ...state, stopRequested: true }, command: null };
  if (state.phase === 'recording') return { state: { ...state, phase: 'stopping' }, command: 'stop' };
  return { state, command: null };
};

export function recordingStep(
  state: RecordState,
  event: RecordEvent,
  mode: RecordMode,
  disabled = false,
): RecordStep {
  const same: RecordStep = { state, command: null };

  switch (event.type) {
    case 'press':
      if (mode !== 'hold' || disabled || state.phase !== 'idle') return same;
      return startRecording();

    case 'release':
      if (mode !== 'hold') return same;
      return requestStop(state);

    case 'click':
      if (mode !== 'toggle') return same;
      if (state.phase === 'idle') return disabled ? same : startRecording();
      return requestStop(state);

    case 'cancel':
      if (state.phase === 'starting' || state.phase === 'recording' || state.phase === 'stopping') {
        return { state: { ...INITIAL_RECORD_STATE }, command: 'discard' };
      }
      return same;

    case 'started':
      // Bekor qilingan (idle) bo'lsa — ochilgan yozuv tashlanadi.
      if (state.phase !== 'starting') return { state, command: 'discard' };
      if (state.stopRequested) {
        return { state: { ...state, phase: 'stopping', stopRequested: false }, command: 'stop' };
      }
      return { state: { ...state, phase: 'recording' }, command: null };

    case 'startFailed':
      return { state: { ...INITIAL_RECORD_STATE }, command: null };

    case 'stopped':
      // `recording` — maksimal vaqt tugab yozuv O'ZI to'xtagan holat.
      if (state.phase !== 'stopping' && state.phase !== 'recording') return same; // bekor qilingan
      if (!(event.seconds >= MIN_RECORDING_SECONDS)) {
        // Yumshoq: darhol qayta yozish mumkin, serverga hech narsa bormaydi.
        return { state: { ...INITIAL_RECORD_STATE, notice: 'too_short' }, command: 'discard' };
      }
      return { state: { ...state, phase: 'sending' }, command: 'send' };

    case 'sent':
    case 'failed':
      return { state: { ...INITIAL_RECORD_STATE }, command: null };

    default:
      return same;
  }
}

/** Yozish tugmasi bosiladimi (sessiya tugamagan, yuborish ketmayapti). */
export function canRecord(state: RecordState, disabled: boolean): boolean {
  return !disabled && (state.phase === 'idle' || state.phase === 'recording');
}

/**
 * `AudioContext` brauzer siyosati bo'yicha `suspended` holatda yaratilishi
 * mumkin (ayniqsa `await getUserMedia` dan keyin — foydalanuvchi bosishi
 * "eskiradi"). Unda `onaudioprocess` ishlamaydi va HAR yozuv 0.00 s bo'lib
 * qoladi — avvalgi "tugma ishlamay qoldi" xatosining sababi shu edi.
 */
export async function ensureAudioRunning(context: {
  state: string;
  resume: () => Promise<void>;
}): Promise<boolean> {
  if (context.state === 'running') return true;
  try {
    await context.resume();
  } catch {
    return false;
  }
  return context.state === 'running';
}
