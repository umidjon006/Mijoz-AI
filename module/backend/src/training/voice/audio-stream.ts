/**
 * Mijoz audiosi OQIMI uchun xotiradagi registr.
 *
 * Nega: TTS butun faylni tayyorlaguncha (1-3 s) kutmaslik uchun ovozli navbat
 * javobi LLM tugashi bilan qaytadi (matn + `audioStreamUrl`), TTS esa shu
 * zahoti boshlanadi. Brauzer URL'ni ochganda kelgan bo'laklar darhol, qolgani
 * kelishi bilan uzatiladi — ijro birinchi bo'lakda boshlanadi.
 *
 * Xavfsizlik va maxfiylik:
 *  - audio FAQAT xotirada (diskka/DB'ga yozilmaydi), bir marta o'qiladi va
 *    o'chiriladi; o'qilmasa `ttlMs` dan keyin tashlanadi;
 *  - id — tasodifiy UUID (taxmin qilib bo'lmaydi), ya'ni URL o'zi ruxsatnoma
 *    (presigned URL kabi): `<audio src>` maxsus sarlavha yubora olmaydi;
 *  - hajm chegarasi (`maxBytes`) — provayder cheksiz oqim bersa ham xotira to'lmaydi.
 */
import { randomUUID } from 'node:crypto';

export interface AudioStreamStats {
  /** TTS boshlangandan birinchi bo'lakkacha (ms). */
  firstByteMs: number | null;
  /** TTS boshlangandan oxirgi bo'lakkacha (ms). */
  totalMs: number;
  bytes: number;
  error?: unknown;
}

export interface AudioStreamHandle {
  id: string;
  mime: string;
}

interface Entry {
  mime: string;
  chunks: Uint8Array[];
  done: boolean;
  error: unknown;
  taken: boolean;
  waiters: Array<() => void>;
  timer: ReturnType<typeof setTimeout>;
}

export interface AudioStreamRegistryOptions {
  ttlMs?: number;
  maxBytes?: number;
}

export class AudioStreamRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxBytes: number;

  constructor(options: AudioStreamRegistryOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  }

  /** Nechta oqim xotirada turibdi (test/monitoring uchun). */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Oqimni ochadi va manbani DARHOL o'qishni boshlaydi (iste'molchini kutmaydi).
   * `onDone` — oqim tugaganda (yoki xato bilan) bir marta chaqiriladi.
   */
  open(input: {
    mime: string;
    source: AsyncIterable<Uint8Array>;
    onDone?: (stats: AudioStreamStats) => void;
  }): AudioStreamHandle {
    const id = randomUUID();
    const entry: Entry = {
      mime: input.mime,
      chunks: [],
      done: false,
      error: undefined,
      taken: false,
      waiters: [],
      timer: setTimeout(() => this.entries.delete(id), this.ttlMs),
    };
    entry.timer.unref?.();
    this.entries.set(id, entry);

    const notify = (): void => {
      const waiters = entry.waiters.splice(0);
      for (const wake of waiters) wake();
    };

    const startedAt = Date.now();
    let firstByteMs: number | null = null;
    let bytes = 0;
    void (async () => {
      try {
        for await (const chunk of input.source) {
          if (firstByteMs === null) firstByteMs = Date.now() - startedAt;
          bytes += chunk.byteLength;
          if (bytes > this.maxBytes) throw new Error('audio oqimi hajm chegarasidan oshdi');
          entry.chunks.push(chunk);
          notify();
        }
      } catch (err) {
        entry.error = err;
      } finally {
        entry.done = true;
        notify();
        input.onDone?.({
          firstByteMs,
          totalMs: Date.now() - startedAt,
          bytes,
          ...(entry.error !== undefined ? { error: entry.error } : {}),
        });
      }
    })();

    return { id, mime: input.mime };
  }

  /**
   * Oqimni BIR MARTA oladi: avval yig'ilgan bo'laklar, keyin kelayotganlari.
   * Topilmasa, muddati o'tgan yoki allaqachon olingan bo'lsa — `null`.
   * Manba xato bersa, iterator o'sha xatoni tashlaydi.
   */
  take(id: string): { mime: string; chunks: AsyncIterable<Uint8Array> } | null {
    const entry = this.entries.get(id);
    if (!entry || entry.taken) return null;
    entry.taken = true;

    const entries = this.entries;
    async function* iterate(): AsyncGenerator<Uint8Array> {
      let index = 0;
      try {
        for (;;) {
          while (index < entry!.chunks.length) {
            const chunk = entry!.chunks[index] as Uint8Array;
            entry!.chunks[index] = new Uint8Array(0); // uzatilgan bo'lak xotiradan bo'shatiladi
            index += 1;
            yield chunk;
          }
          if (entry!.done) {
            if (entry!.error !== undefined) throw entry!.error;
            return;
          }
          await new Promise<void>((resolve) => entry!.waiters.push(resolve));
        }
      } finally {
        clearTimeout(entry!.timer);
        entries.delete(id);
      }
    }
    return { mime: entry.mime, chunks: iterate() };
  }
}

/**
 * Javobni gaplarga bo'ladi (oqimsiz TTS uchun: gaplar PARALLEL sintez
 * qilinadi va tartib bilan qo'shiladi). Juda qisqa bo'laklar qo'shnisiga
 * qo'shiladi — bitta so'zli "gap" uchun alohida so'rov arzimaydi.
 */
export function splitForParallelTts(text: string, maxParts = 2): string[] {
  const parts = text.match(/[^.!?…]+[.!?…]+["»”']?\s*|[^.!?…]+$/g)?.map((p) => p.trim()).filter(Boolean) ?? [];
  if (parts.length <= 1) return [text.trim()].filter(Boolean);
  const merged: string[] = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if (last !== undefined && (part.length < 12 || last.length < 12 || merged.length >= maxParts)) {
      merged[merged.length - 1] = `${last} ${part}`;
    } else {
      merged.push(part);
    }
  }
  return merged;
}
