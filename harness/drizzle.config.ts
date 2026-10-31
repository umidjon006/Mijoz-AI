/**
 * FAQAT LOKAL. Teammate'lar o'z repo'sidagi drizzle.config.ts dan
 * foydalanadi va migratsiyani O'ZI qaytadan generatsiya qiladi.
 *
 * Bu yerda faqat modul sxemasi ko'rsatilgan, shuning uchun
 * `drizzle-kit generate` lokalda ham ishlaydi (lekin natija asosiy repoga
 * KO'CHIRILMAYDI — qarang module/integration/training.sql).
 */
import { defineConfig } from 'drizzle-kit';

const port = process.env.POSTGRES_PORT?.trim() || '55433';

export default defineConfig({
  dialect: 'postgresql',
  schema: '../module/backend/src/db/schema/training.ts',
  out: './drizzle',
  dbCredentials: {
    url:
      process.env.SUPERUSER_DATABASE_URL?.trim() ||
      `postgres://postgres:postgres@127.0.0.1:${port}/sotuv_trener`,
  },
  verbose: true,
  strict: true,
});
