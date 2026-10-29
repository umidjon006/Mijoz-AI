/**
 * FAQAT HARNESS. Google Cloud: Speech-to-Text v1 **sinxron** `speech:recognize`
 * va Text-to-Speech `text:synthesize`.
 *
 * Env: GOOGLE_API_KEY. Kalit hech qachon log qilinmaydi (URL ham log'ga
 * chiqmaydi, chunki kalit query-parametrda bo'ladi).
 *
 * DIQQAT: asosiy repodagi `GoogleStt` `longrunningrecognize` (asinxron) ni
 * ishlatadi — jonli navbat uchun juda sekin, shuning uchun bu yerda
 * ATAYLAB sinxron endpoint olingan.
 */
import type {
  SttPort,
  SttRequest,
  SttResult,
  TtsPort,
  TtsRequest,
  TtsResult,
} from '../../../module/backend/src/training/voice/ports.js';
import { LOCALE } from './locales.js';

export interface GoogleConfig {
  apiKey: string;
}

export function googleConfigFromEnv(): GoogleConfig | null {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  return { apiKey };
}

/** Kalitni xato matniga tushib qolishdan saqlaydi. */
function sanitize(text: string): string {
  return text.replace(/key=[^&"\s]+/g, 'key=***');
}

interface GoogleSttResponse {
  results?: Array<{
    alternatives?: Array<{ transcript?: string; confidence?: number }>;
  }>;
}

export function createGoogleStt(config: GoogleConfig): SttPort {
  return {
    async transcribeShort(req: SttRequest): Promise<SttResult> {
      const body = {
        config: {
          encoding: 'LINEAR16',
          sampleRateHertz: 16_000,
          audioChannelCount: 1,
          languageCode: LOCALE[req.lang],
          enableAutomaticPunctuation: true,
          model: 'default',
          ...(req.hints && req.hints.length > 0
            ? { speechContexts: [{ phrases: req.hints.slice(0, 500), boost: 10 }] }
            : {}),
        },
        audio: { content: req.audio.toString('base64') },
      };

      const startedAt = Date.now();
      const res = await fetch(
        `https://speech.googleapis.com/v1/speech:recognize?key=${encodeURIComponent(config.apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const latencyMs = Date.now() - startedAt;

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Google STT ${res.status}: ${sanitize(text).slice(0, 300)}`);
      }

      const json = (await res.json()) as GoogleSttResponse;
      // Sinxron javobda bir nechta `results` bo'lishi mumkin — ularni ulaymiz.
      const parts = (json.results ?? [])
        .map((r) => r.alternatives?.[0]?.transcript ?? '')
        .filter((t) => t.length > 0);
      const confidences = (json.results ?? [])
        .map((r) => r.alternatives?.[0]?.confidence)
        .filter((c): c is number => typeof c === 'number');

      return {
        text: parts.join(' ').trim(),
        ...(confidences.length > 0
          ? { confidence: confidences.reduce((a, b) => a + b, 0) / confidences.length }
          : {}),
        latencyMs,
        raw: json,
      };
    },
  };
}

export interface GoogleVoice {
  name: string;
  languageCodes: string[];
  ssmlGender?: string;
  naturalSampleRateHertz?: number;
}

/** Google TTS'da o'zbek ovozi BOR-YO'QLIGINI aniqlaydigan yagona ishonchli yo'l. */
export async function listGoogleVoices(
  config: GoogleConfig,
  languageCode?: string,
): Promise<GoogleVoice[]> {
  const url = new URL('https://texttospeech.googleapis.com/v1/voices');
  url.searchParams.set('key', config.apiKey);
  if (languageCode) url.searchParams.set('languageCode', languageCode);

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google voices ${res.status}: ${sanitize(text).slice(0, 300)}`);
  }
  const json = (await res.json()) as { voices?: GoogleVoice[] };
  return json.voices ?? [];
}

export function createGoogleTts(config: GoogleConfig): TtsPort {
  return {
    async synthesize(req: TtsRequest): Promise<TtsResult> {
      const languageCode = LOCALE[req.lang];
      const body = {
        input: { text: req.text },
        voice: { languageCode, ...(req.voice ? { name: req.voice } : {}) },
        audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24_000 },
      };

      const startedAt = Date.now();
      const res = await fetch(
        `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(config.apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Google TTS ${res.status}: ${sanitize(text).slice(0, 300)}`);
      }

      const json = (await res.json()) as { audioContent?: string };
      const latencyMs = Date.now() - startedAt;
      if (!json.audioContent) throw new Error('Google TTS: audioContent yo\'q');

      return {
        audio: Buffer.from(json.audioContent, 'base64'),
        mime: 'audio/wav',
        latencyMs,
        // Google REST JSON qaytaradi — birinchi bayt = to'liq javob.
        firstByteMs: latencyMs,
      };
    },
  };
}
