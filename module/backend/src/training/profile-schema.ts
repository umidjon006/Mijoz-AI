/**
 * SYNC WITH backend/src/business/profile.ts — replace this file with an import
 * from the main repo during integration.
 *
 * Bu — asosiy repodagi `profileSchema`ning vendor (ko'chirma) nusxasi. Modul
 * standalone ishlashi uchun kerak. Integratsiya paytida shu fayl O'CHIRILADI
 * va o'rniga asosiy repodagi sxemadan import qilinadi:
 *
 *   import { profileSchema, type BusinessProfile } from '../business/profile.js';
 *
 * DIQQAT: `../sales-copilot` repo mavjud bo'lmaganida (shu laptopda shunday
 * bo'ldi) sxema `demo-profiles.json` maydonlari bo'yicha tiklandi. Haqiqiy
 * sxema bilan farq bo'lishi mumkin — `verify-training.ts` ichidagi
 * "cross-check" testi repo yonida bo'lsa farqni avtomatik ushlaydi.
 */
import { z } from 'zod';

const nonEmpty = z.string().min(1);
const stringList = z.array(nonEmpty);

export const customerTypeSchema = z.enum(['b2c', 'b2b', 'both']);
export const callDirectionSchema = z.enum(['inbound', 'outbound', 'mixed']);

export const profileSchema = z.object({
  /** Soha nomi — faqat ma'lumot sifatida, modul mantig'i bunga tayanmaydi. */
  industry: nonEmpty,
  businessDescription: nonEmpty,
  /** Taklif/mahsulot ro'yxati (narx, muddat va h.k. erkin matnda). */
  primaryOffers: stringList.min(1),
  typicalCustomers: nonEmpty,
  customerProblem: nonEmpty,
  customerType: customerTypeSchema,
  leadSources: stringList.default([]),
  callDirection: callDirectionSchema,
  commonCustomerQuestions: stringList.default([]),
  commonObjections: stringList.default([]),
  successSignals: stringList.default([]),
  failureSignals: stringList.default([]),
  /** Qizil chiziqlar — AI mijoz ham, baholash ham buzmasligi kerak. */
  redLines: stringList.default([]),
  vocabulary: stringList.default([]),
  additionalNotes: z.string().optional(),
});

export type BusinessProfile = z.infer<typeof profileSchema>;
export type BusinessProfileInput = z.input<typeof profileSchema>;

export function parseBusinessProfile(input: unknown): BusinessProfile {
  return profileSchema.parse(input);
}
