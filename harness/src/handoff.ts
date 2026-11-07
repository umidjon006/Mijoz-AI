/**
 * FAQAT HARNESS. Topshirish (handoff) paketi qoidalari — SOF funksiyalar.
 *
 * Paketga faqat COMMIT qilingan fayllar kiradi (`git archive`), va
 * `harness/data/**` (haqiqiy biznes profili, skript, qo'ng'iroq yozuvlari,
 * namunalar ham) HECH QACHON kirmaydi. `.env` fayllari ham taqiqlangan.
 */

/** `git archive` pathspec'lari: hammasi, `harness/data` dan tashqari. */
export const HANDOFF_PATHSPECS = ['.', ':(exclude)harness/data', ':(exclude)harness/data/**'] as const;

/** Arxivdagi (prefiksiz) yo'llardan taqiqlanganlarini topadi — bo'sh bo'lishi SHART. `.env.example` mumkin. */
export function forbiddenHandoffEntries(entries: readonly string[]): string[] {
  return entries.filter((raw) => {
    const path = raw.replace(/^\.\//, '');
    return (
      /(^|\/)harness\/data(\/|$)/.test(path) ||
      /(^|\/)\.env$/.test(path) ||
      /(^|\/)real-(calls|business)(\/|$)/.test(path)
    );
  });
}
