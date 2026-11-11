/**
 * FAQAT HARNESS. `SttPort` ning lokal adapteri: Doniyor'ning o'zbek STT modeli
 * (GigaAM s1), `stt/serve.py` servisi orqali (faqat 127.0.0.1).
 *
 * Servis javobi: {text, raw, punctuated, stripped_chars, duration_s, stt_ms, model, device}.
 * `text` — miya uchun ENG XAVFSIZ matn: tinish belgisi faqat hech narsa
 * (raqam, kirill harfi, belgi) yo'qolmaganda qo'llangan, aks holda xom matn.
 *
 * Servis ishlamasa — ZAXIRASIZ, aniq xato: qaysi buyruq bilan ishga tushirish kerak.
 * Audio hech qayerda saqlanmaydi (servis vaqtinchalik faylni darhol o'chiradi).
 */
import type { SttPort, SttRequest, SttResult } from '../../../module/backend/src/training/voice/ports.js';

export const LOCAL_STT_PROVIDER = 'local-doniyor';
export const DEFAULT_LOCAL_STT_PORT = 5190;
export const DEFAULT_LOCAL_STT_URL = `http://127.0.0.1:${DEFAULT_LOCAL_STT_PORT}`;
export const LOCAL_STT_START_COMMAND = 'cd harness && npm run stt:start';
export const LOCAL_STT_SETUP_COMMAND = 'cd harness && npm run stt:setup';

export interface LocalSttResponse {
  text: string;
  raw: string;
  punctuated: boolean;
  stripped_chars?: string[];
  duration_s: number;
  stt_ms: number;
  model: string;
  device: string;
}

export interface LocalSttHealth {
  ok: boolean;
  model: string;
  device: string;
  load_s?: number;
}

/** Lokal servis ishlamayapti yoki javob bermadi — ishlab chiquvchiga NIMA qilish kerakligini aytadi. */
export class LocalSttUnavailableError extends Error {
  constructor(url: string, cause: string) {
    super(
      `Lokal STT servisi ishlamayapti (${url}): ${cause}. ` +
        `Ishga tushiring: ${LOCAL_STT_START_COMMAND}  (birinchi marta: ${LOCAL_STT_SETUP_COMMAND})`,
    );
    this.name = 'LocalSttUnavailableError';
  }
}

export class LocalSttError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalSttError';
  }
}

/** Faqat loopback manzil (servis 127.0.0.1 da tinglaydi; audio tashqariga chiqmasin). */
export function assertLoopbackUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new LocalSttError(`STT_LOCAL_URL noto'g'ri: "${url}"`);
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    throw new LocalSttError(`STT_LOCAL_URL faqat lokal bo'lishi kerak (127.0.0.1), keldi: ${u.host}`);
  }
  return u;
}

function causeOf(err: unknown): string {
  if (err instanceof Error) {
    const inner = err.cause instanceof Error ? err.cause.message : '';
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'javob vaqti tugadi';
    return inner || err.message;
  }
  return String(err);
}

/** `/health` — servis yuklangan va tayyormi. Xato bo'lsa `LocalSttUnavailableError`. */
export async function checkLocalStt(url = DEFAULT_LOCAL_STT_URL, timeoutMs = 2_000): Promise<LocalSttHealth> {
  const base = assertLoopbackUrl(url).origin;
  let res: Response;
  try {
    res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new LocalSttUnavailableError(base, causeOf(err));
  }
  if (!res.ok) throw new LocalSttUnavailableError(base, `HTTP ${res.status}`);
  return (await res.json()) as LocalSttHealth;
}

export interface LocalSttOptions {
  url?: string;
  timeoutMs?: number;
  /** Har chaqiruvga bitta log qatori; `null` — jim. */
  log?: ((line: string) => void) | null;
}

export function createLocalStt(options: LocalSttOptions = {}): SttPort {
  const base = assertLoopbackUrl(options.url ?? DEFAULT_LOCAL_STT_URL).origin;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const log = options.log === undefined ? (line: string) => console.error(line) : options.log;

  return {
    async transcribeShort(req: SttRequest): Promise<SttResult> {
      const startedAt = Date.now();
      let res: Response;
      try {
        res = await fetch(`${base}/transcribe`, {
          method: 'POST',
          headers: { 'content-type': req.mime || 'application/octet-stream' },
          body: new Uint8Array(req.audio),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new LocalSttUnavailableError(base, causeOf(err));
      }
      const body = (await res.json().catch(() => ({}))) as Partial<LocalSttResponse> & { error?: string };
      if (!res.ok) throw new LocalSttError(`lokal STT xato (HTTP ${res.status}): ${body.error ?? 'nomaʼlum'}`);
      const latencyMs = Date.now() - startedAt;
      log?.(
        `[stt] provider=${LOCAL_STT_PROVIDER} model=${body.model} device=${body.device} ` +
          `audio=${body.duration_s}s stt=${body.stt_ms}ms total=${latencyMs}ms ` +
          `punct=${body.punctuated ? 'ha' : `yo'q${body.stripped_chars?.length ? ` (saqlandi: ${body.stripped_chars.join('')})` : ''}`}`,
      );
      return { text: (body.text ?? '').trim(), latencyMs, raw: body };
    },
  };
}
