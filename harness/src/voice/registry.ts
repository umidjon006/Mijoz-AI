/**
 * FAQAT HARNESS. Env'ga qarab mavjud provayderlarni yig'adi va narx
 * taxminlarini bir joyda saqlaydi.
 */
import type { SttPort, TtsPort } from '../../../module/backend/src/training/voice/ports.js';
import { azureConfigFromEnv, createAzureStt, createAzureTts } from './azure.js';
import { createGoogleStt, createGoogleTts, googleConfigFromEnv } from './google.js';

export type ProviderId = 'azure' | 'google';

export interface SttProvider {
  id: ProviderId;
  label: string;
  port: SttPort;
}

export interface TtsProvider {
  id: ProviderId;
  label: string;
  port: TtsPort;
  /** Benchmark uchun sinaladigan ovozlar (bo'sh bo'lsa — aniqlash kerak). */
  voices: string[];
}

/**
 * TAXMINIY narxlar (umumiy ko'rsatkich uchun; har provayderning joriy
 * narx sahifasi bilan tekshirilishi kerak). Benchmark bu raqamlarni faqat
 * "chaqirishdan oldin ogohlantirish" uchun ishlatadi.
 */
export const PRICE_HINTS = {
  /** STT: daqiqa uchun USD. */
  stt: { azure: 0.0167, google: 0.024 } as Record<ProviderId, number>,
  /** TTS: 1 million belgi uchun USD. */
  ttsPerMillionChars: { azure: 16, google: 16 } as Record<ProviderId, number>,
} as const;

export function availableSttProviders(only?: readonly ProviderId[]): SttProvider[] {
  const out: SttProvider[] = [];
  const azure = azureConfigFromEnv();
  const google = googleConfigFromEnv();

  if (azure && (!only || only.includes('azure'))) {
    out.push({ id: 'azure', label: `Azure (${azure.region})`, port: createAzureStt(azure) });
  }
  if (google && (!only || only.includes('google'))) {
    out.push({ id: 'google', label: 'Google (sync recognize)', port: createGoogleStt(google) });
  }
  return out;
}

export interface TtsProviderOptions {
  only?: readonly ProviderId[];
  /** `--voices azure:uz-UZ-MadinaNeural,...` orqali qo'lda berilgan ovozlar. */
  voicesByProvider?: Partial<Record<ProviderId, string[]>>;
}

export function availableTtsProviders(options: TtsProviderOptions = {}): TtsProvider[] {
  const { only, voicesByProvider } = options;
  const out: TtsProvider[] = [];
  const azure = azureConfigFromEnv();
  const google = googleConfigFromEnv();

  if (azure && (!only || only.includes('azure'))) {
    out.push({
      id: 'azure',
      label: `Azure (${azure.region})`,
      port: createAzureTts(azure),
      voices: voicesByProvider?.azure ?? [],
    });
  }
  if (google && (!only || only.includes('google'))) {
    out.push({
      id: 'google',
      label: 'Google',
      port: createGoogleTts(google),
      voices: voicesByProvider?.google ?? [],
    });
  }
  return out;
}

export function missingKeysHint(): string[] {
  const hints: string[] = [];
  if (!process.env.AZURE_SPEECH_KEY || !process.env.AZURE_SPEECH_REGION) {
    hints.push('AZURE_SPEECH_KEY + AZURE_SPEECH_REGION yo\'q — Azure o\'tkazib yuborildi');
  }
  if (!process.env.GOOGLE_API_KEY) {
    hints.push('GOOGLE_API_KEY yo\'q — Google o\'tkazib yuborildi');
  }
  return hints;
}
