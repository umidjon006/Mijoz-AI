/**
 * Sotuv skripti: bosqichlar va har bosqichda kutilgan harakatlar / iboralar.
 *
 * Skript bo'lsa baholash "Skriptga moslik" bo'limini qo'shadi: har bosqich
 * uchun followed / partly / missed (followed — tekshirilgan sotuvchi
 * iqtibosi bilan).
 *
 * Fayl formati (markdown) — sodda va qo'lda yozishga qulay:
 *
 *   # Skript nomi                  (ixtiyoriy)
 *   ## 1. Salomlashish             <- har `##` yangi bosqich
 *   - O'zini va markazni tanishtiradi   <- `-` / `*`: kutilgan harakat
 *   > Assalomu alaykum, ...        <- `>` yoki `- Ibora: ...`: namuna ibora
 *
 * Boshqa matn (izoh paragraflari) e'tiborsiz qoldiriladi. Modul faylni o'zi
 * O'QIMAYDI — host (yoki harness) matnni beradi.
 */
import { z } from 'zod';

export const salesScriptStageSchema = z.object({
  name: z.string().trim().min(2, "bosqich nomi bo'sh").max(120),
  expectedActions: z
    .array(z.string().trim().min(2).max(300))
    .min(1, "kamida bitta kutilgan harakat (`- ...` qatori) kerak"),
  phrases: z.array(z.string().trim().min(2).max(300)).default([]),
});

export const salesScriptSchema = z.object({
  title: z.string().trim().max(200).nullable().default(null),
  stages: z
    .array(salesScriptStageSchema)
    .min(1, "kamida bitta bosqich (`## ...` sarlavhasi) kerak")
    .max(20, "bosqichlar ko'pi bilan 20 ta")
    .superRefine((stages, ctx) => {
      const seen = new Set<string>();
      for (const [i, stage] of stages.entries()) {
        const key = stage.name.toLowerCase();
        if (seen.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'name'],
            message: `bosqich nomi takrorlangan: "${stage.name}"`,
          });
        }
        seen.add(key);
      }
    }),
});

export type SalesScriptStage = z.infer<typeof salesScriptStageSchema>;
export type SalesScript = z.infer<typeof salesScriptSchema>;

/** Skript fayli noto'g'ri — xabar foydalanuvchiga to'g'ridan-to'g'ri ko'rsatiladi. */
export class SalesScriptFormatError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`sotuv skripti noto'g'ri:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'SalesScriptFormatError';
    this.issues = issues;
  }
}

const PHRASE_PREFIX = /^(ibora|namuna|phrase)\s*:\s*/i;

function unquote(text: string): string {
  return text.replace(/^["“«']+|["”»']+$/g, '').trim();
}

/** Markdown -> xom obyekt (tekshiruvsiz). Qator raqamli xatolar yig'iladi. */
function parseMarkdown(markdown: string): { raw: unknown; issues: string[] } {
  const issues: string[] = [];
  let title: string | null = null;
  const stages: Array<{ name: string; expectedActions: string[]; phrases: string[] }> = [];

  for (const [index, rawLine] of markdown.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    const lineNo = index + 1;
    if (!line) continue;

    const h2 = /^##(?!#)\s*(.*)$/.exec(line);
    if (h2) {
      const name = (h2[1] ?? '').replace(/^\d+\s*[.)]\s*/, '').trim();
      stages.push({ name, expectedActions: [], phrases: [] });
      continue;
    }
    const h1 = /^#(?!#)\s*(.*)$/.exec(line);
    if (h1) {
      if (title === null && stages.length === 0) title = (h1[1] ?? '').trim() || null;
      continue;
    }

    const current = stages[stages.length - 1];
    const quote = /^>\s*(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (!quote && !bullet) continue; // izoh paragrafi

    if (!current) {
      issues.push(`${lineNo}-qator: "${line.slice(0, 40)}" birinchi bosqichdan (## ...) oldin turibdi`);
      continue;
    }
    if (quote) {
      const text = unquote(quote[1] ?? '');
      if (text) current.phrases.push(text);
      continue;
    }
    const item = (bullet?.[1] ?? '').trim();
    if (PHRASE_PREFIX.test(item)) {
      const text = unquote(item.replace(PHRASE_PREFIX, ''));
      if (text) current.phrases.push(text);
    } else if (item) {
      current.expectedActions.push(item);
    }
  }

  return { raw: { title, stages }, issues };
}

/**
 * Markdown skriptni o'qiydi va tekshiradi. Xato bo'lsa `SalesScriptFormatError`
 * — har xato bosqich NOMI yoki qator raqami bilan.
 */
export function parseSalesScriptMarkdown(markdown: string): SalesScript {
  const { raw, issues } = parseMarkdown(markdown);
  const parsed = salesScriptSchema.safeParse(raw);
  if (!parsed.success) {
    const stages = (raw as { stages: Array<{ name: string }> }).stages;
    for (const issue of parsed.error.issues) {
      const [first, index, ...rest] = issue.path;
      if (first === 'stages' && typeof index === 'number') {
        const name = stages[index]?.name || '(nomsiz)';
        const field = rest.length > 0 ? ` (${rest.join('.')})` : '';
        issues.push(`${index + 1}-bosqich "${name}"${field}: ${issue.message}`);
      } else {
        issues.push(`${issue.path.join('.') || 'skript'}: ${issue.message}`);
      }
    }
  }
  if (issues.length > 0 || !parsed.success) throw new SalesScriptFormatError(issues);
  return parsed.data;
}
