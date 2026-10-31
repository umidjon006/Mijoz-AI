/**
 * FAQAT HARNESS. Modulning React sahifalarini lokal ishga tushiradi.
 * Teammate'larga berilmaydi — ular sahifalarni o'z ilovalariga ulaydi.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND = `http://127.0.0.1:${process.env.HARNESS_PORT?.trim() || 5180}`;

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    port: Number(process.env.UI_PORT?.trim() || 5181),
    host: '127.0.0.1',
    // `/api` so'rovlari harness backend'iga uzatiladi (CORS kerak emas).
    proxy: { '/api': { target: BACKEND, changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
