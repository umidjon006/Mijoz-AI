/**
 * FAQAT HARNESS. Azure Speech: qisqa audio STT (REST) va neural TTS.
 *
 * Env: AZURE_SPEECH_KEY, AZURE_SPEECH_REGION (masalan `westeurope`).
 * Kalit hech qachon log qilinmaydi.
 *
 * Eslatma: qisqa-audio REST endpointi "phrase list" (hints) ni QO'LLAMAYDI —
 * u faqat SDK'da bor. Shuning uchun `hints` bu yerda e'tiborsiz qoldiriladi
 * (benchmark hisobotida shu cheklov qayd etilgan).
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

export interface AzureConfig {
  key: string;
  region: string;
}

export function azureConfigFromEnv(): AzureConfig | null {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) return null;
  return { key, region };
}

interface AzureSttDetailed {
  RecognitionStatus?: string;
  DisplayText?: string;
  NBest?: Array<{ Confidence?: number; Display?: string; Lexical?: string }>;
}

export function createAzureStt(config: AzureConfig): SttPort {
  return {
    async transcribeShort(req: SttRequest): Promise<SttResult> {
      const locale = LOCALE[req.lang];
      const url =
        `https://${config.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1` +
        `?language=${encodeURIComponent(locale)}&format=detailed&profanity=raw`;

      const startedAt = Date.now();
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': config.key,
          'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
          Accept: 'application/json',
        },
        body: new Uint8Array(req.audio),
      });
      const latencyMs = Date.now() - startedAt;

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Azure STT ${res.status}: ${body.slice(0, 300)}`);
      }

      const json = (await res.json()) as AzureSttDetailed;
      const best = json.NBest?.[0];
      return {
        text: (best?.Display ?? json.DisplayText ?? '').trim(),
        ...(typeof best?.Confidence === 'number' ? { confidence: best.Confidence } : {}),
        latencyMs,
        raw: json,
      };
    },
  };
}

export interface AzureVoice {
  Name: string;
  ShortName: string;
  DisplayName?: string;
  LocalName?: string;
  Gender?: string;
  Locale: string;
  VoiceType?: string;
  Status?: string;
  StyleList?: string[];
}

/** Mavjud ovozlar ro'yxati — o'zbek ovozlari HAQIQATDA bor-yo'qligini shu aniqlaydi. */
export async function listAzureVoices(config: AzureConfig): Promise<AzureVoice[]> {
  const res = await fetch(
    `https://${config.region}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
    { headers: { 'Ocp-Apim-Subscription-Key': config.key } },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Azure voices/list ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as AzureVoice[];
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface AzureTtsOptions {
  /** Brauzerda to'g'ridan-to'g'ri ijro etiladigan format. */
  outputFormat?: string;
}

export function createAzureTts(config: AzureConfig, options: AzureTtsOptions = {}): TtsPort {
  const outputFormat = options.outputFormat ?? 'riff-16khz-16bit-mono-pcm';

  return {
    async synthesize(req: TtsRequest): Promise<TtsResult> {
      const locale = LOCALE[req.lang];
      const voice = req.voice ?? `${locale}-MadinaNeural`;
      const ssml =
        `<speak version="1.0" xml:lang="${locale}">` +
        `<voice name="${voice}">${escapeXml(req.text)}</voice>` +
        `</speak>`;

      const startedAt = Date.now();
      const res = await fetch(
        `https://${config.region}.tts.speech.microsoft.com/cognitiveservices/v1`,
        {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': config.key,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': outputFormat,
            'User-Agent': 'sotuv-trener-harness',
          },
          body: ssml,
        },
      );

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Azure TTS ${res.status}: ${body.slice(0, 300)}`);
      }

      // Birinchi baytni o'lchash uchun oqim bo'ylab o'qiymiz.
      const chunks: Uint8Array[] = [];
      let firstByteMs: number | undefined;
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            if (firstByteMs === undefined) firstByteMs = Date.now() - startedAt;
            chunks.push(value);
          }
        }
      } else {
        chunks.push(new Uint8Array(await res.arrayBuffer()));
      }

      return {
        audio: Buffer.concat(chunks.map((c) => Buffer.from(c))),
        mime: outputFormat.startsWith('riff') ? 'audio/wav' : 'audio/mpeg',
        latencyMs: Date.now() - startedAt,
        ...(firstByteMs !== undefined ? { firstByteMs } : {}),
      };
    },
  };
}
