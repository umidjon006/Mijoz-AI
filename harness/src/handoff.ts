/**
 * FAQAT HARNESS. Topshirish (handoff) paketi qoidalari — SOF funksiyalar.
 *
 * Paketga faqat COMMIT qilingan fayllar kiradi (`git archive`), va
 * `harness/data/**` (haqiqiy biznes profili, skript, qo'ng'iroq yozuvlari)
 * HECH QACHON kirmaydi — faqat ikkita namuna (HANDOFF_DATA_SAMPLES) bundan mustasno. `.env` fayllari ham taqiqlangan.
 */

/**
 * `harness/data` dan FAQAT shu namunalar paketga kiradi (git'da bor, haqiqiy
 * ma'lumot emas). Ularsiz yangi dasturchida server ishga tushmaydi.
 */
export const HANDOFF_DATA_SAMPLES = [
  'harness/data/business-profile.demo.json',
  'harness/data/sales-script.example.md',
] as const;

/** Ichki ish fayllari: git'da qoladi, lekin topshirish paketiga KIRMAYDI. */
export const HANDOFF_INTERNAL: readonly RegExp[] = [
  /^claude-code-prompt-step[^/]*\.md$/,
  /^REPORT-FOR-REVIEW\.md$/,
  /^llm-compare\//,
  /^tts-test\//,
];

/** Commit'dagi fayllardan paketga kiradiganlari (taqiqlanganlar chiqariladi). */
export function handoffFiles(tracked: readonly string[]): string[] {
  const bad = new Set(forbiddenHandoffEntries(tracked));
  return tracked.filter((f) => !bad.has(f));
}

/** Arxivdagi (prefiksiz) yo'llardan taqiqlanganlarini topadi — bo'sh bo'lishi SHART. `.env.example` mumkin. */
export function forbiddenHandoffEntries(entries: readonly string[]): string[] {
  return entries.filter((raw) => {
    const path = raw.replace(/^\.\//, '');
    // Papka yozuvlari (`stt/`, `harness/data/`) mazmunsiz — faqat fayllar tekshiriladi.
    if (path.endsWith('/')) return false;
    return (
      (/(^|\/)harness\/data(\/|$)/.test(path) && !(HANDOFF_DATA_SAMPLES as readonly string[]).includes(path)) ||
      /(^|\/)\.env$/.test(path) ||
      /(^|\/)real-(calls|business)(\/|$)/.test(path) ||
      // Ichki ish fayllari (git tarixida qoladi, paketga kirmaydi).
      HANDOFF_INTERNAL.some((re) => re.test(path)) ||
      // Lokal STT: model vaznlari/venv hech qachon; faqat stt/serve.py mumkin.
      (/(^|\/)stt\//.test(path) && !/(^|\/)stt\/serve\.py$/.test(path))
    );
  });
}
