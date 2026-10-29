/**
 * FAQAT HARNESS. Provayderlarda O'ZBEK TILI uchun nima bor-yo'qligini
 * ANIQLAYDI (taxmin qilmaydi): ovozlar ro'yxatini API'dan so'raydi va
 * `harness/benchmark/out/voices.json` ga yozadi.
 *
 *   npm run bench:voices
 *
 * Kalit kerak: AZURE_SPEECH_KEY + AZURE_SPEECH_REGION, GOOGLE_API_KEY.
 * Bu chaqiruvlar bepul (ovoz sintez qilinmaydi).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { azureConfigFromEnv, listAzureVoices, type AzureVoice } from './voice/azure.js';
import { googleConfigFromEnv, listGoogleVoices, type GoogleVoice } from './voice/google.js';
import { missingKeysHint } from './voice/registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../benchmark/out');

interface VoicesReport {
  generatedAt: string;
  azure?: {
    region: string;
    totalVoices: number;
    uzbek: AzureVoice[];
    russian: AzureVoice[];
    error?: string;
  };
  google?: {
    uzbek: GoogleVoice[];
    russian: GoogleVoice[];
    totalVoices: number;
    error?: string;
  };
}

function isUzbek(locale: string): boolean {
  return locale.toLowerCase().startsWith('uz');
}

async function main(): Promise<void> {
  for (const hint of missingKeysHint()) console.log(`[eslatma] ${hint}`);

  const report: VoicesReport = { generatedAt: new Date().toISOString() };
  const azure = azureConfigFromEnv();
  const google = googleConfigFromEnv();

  if (azure) {
    console.log(`\n=== Azure (${azure.region}) ===`);
    try {
      const voices = await listAzureVoices(azure);
      const uzbek = voices.filter((v) => isUzbek(v.Locale));
      const russian = voices.filter((v) => v.Locale.toLowerCase().startsWith('ru'));
      report.azure = { region: azure.region, totalVoices: voices.length, uzbek, russian };

      console.log(`Jami ovozlar: ${voices.length}`);
      if (uzbek.length === 0) {
        console.log("O'zbek ovozi TOPILMADI (shu regionda).");
      } else {
        for (const v of uzbek) {
          console.log(
            `  ${v.ShortName}  [${v.Locale}]  ${v.Gender ?? '-'}  ${v.VoiceType ?? '-'}` +
              `${v.Status ? `  status=${v.Status}` : ''}`,
          );
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.azure = { region: azure.region, totalVoices: 0, uzbek: [], russian: [], error: message };
      console.log(`XATO: ${message}`);
    }
  }

  if (google) {
    console.log('\n=== Google Cloud TTS ===');
    try {
      const all = await listGoogleVoices(google);
      const uzbek = all.filter((v) => v.languageCodes.some(isUzbek));
      const russian = all.filter((v) => v.languageCodes.some((l) => l.toLowerCase().startsWith('ru')));
      report.google = { totalVoices: all.length, uzbek, russian };

      console.log(`Jami ovozlar: ${all.length}`);
      if (uzbek.length === 0) {
        console.log(
          "O'zbek ovozi TOPILMADI — demak Google TTS o'zbekcha uchun yaramaydi (faqat STT uchun ishlatiladi).",
        );
      } else {
        for (const v of uzbek) {
          console.log(`  ${v.name}  [${v.languageCodes.join(', ')}]  ${v.ssmlGender ?? '-'}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.google = { totalVoices: 0, uzbek: [], russian: [], error: message };
      console.log(`XATO: ${message}`);
    }
  }

  if (!azure && !google) {
    console.log('\nHech qanday kalit yo\'q — tekshirish o\'tkazilmadi.');
    console.log('harness/.env ni to\'ldiring (harness/.env.example ga qarang).');
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });
  const outFile = resolve(outDir, 'voices.json');
  await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nNatija: ${outFile}`);
  console.log('Shu faylni bench-tts uchun ovoz nomlarini olishda ishlatamiz.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
