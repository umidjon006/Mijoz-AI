/**
 * INTEGRATSIYA PAYTIDA BU FAYL O'CHIRILADI.
 *
 * `training.ts` dagi FK'lar host ilovaning `business`, `app_user`, `seat`
 * jadvallariga ishora qiladi. Modul standalone kompilyatsiya bo'lishi uchun
 * shu jadvallarning FAQAT kalit ustunlari (minimal e'lon) shu yerda turadi.
 *
 * Asosiy repoga ko'chirganda:
 *   1. shu faylni o'chiring;
 *   2. `training.ts` ichidagi importni haqiqiy sxemalarga almashtiring:
 *        import { business } from './business.js';
 *        import { appUser } from './app-user.js';
 *        import { seat } from './seat.js';
 *      (fayl nomlari asosiy repoda qanday bo'lsa — shunday);
 *   3. drizzle-kit bilan migratsiyani qaytadan generatsiya qiling.
 *
 * Bu jadvallarni modul HECH QACHON o'zi yaratmaydi/migratsiya qilmaydi —
 * ular host ilovaga tegishli. Lokal harness ularni `harness/db/bootstrap.sql`
 * ichida stub sifatida yaratadi.
 */
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';

export const business = pgTable('business', {
  id: uuid('id').primaryKey(),
});

export const appUser = pgTable('app_user', {
  id: uuid('id').primaryKey(),
  businessId: uuid('business_id').notNull(),
});

export const seat = pgTable('seat', {
  id: uuid('id').primaryKey(),
  businessId: uuid('business_id').notNull(),
  label: text('label'),
});
