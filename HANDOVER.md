# Topshirish (HANDOVER) — Sotuv trener

Bu hujjat loyihani qabul qilib olayotgan dasturchi uchun. To'liq texnik tafsilotlar —
[README.md](README.md); bu yerda nima tayyorligi, qanday ishga tushirish va nimalarga
e'tibor berish kerakligi qisqacha.

## 1. Nima tayyor

- **Mashq (AI mijoz bilan suhbat)** — matn va ovoz rejimi. Mijozni Gemini
  (`gemini-3.8-flash`) o'ynaydi, ovozi Gemini TTS (`gemini-3.8-flash-tts`), sotuvchi
  nutqi lokal STT (Doniyor'ning o'zbek GigaAM modeli) orqali matnga aylanadi.
- **Ssenariylar** — 12 ta tayyor ssenariy (`harness/scenarios/*.json`): jahldor mijoz,
  qarzdor ota-ona, nevarasi uchun so'rayotgan buvi, narx solishtiruvchi ona, hazilkash
  qo'ng'iroqchi, band tadbirkor ota, o'smir, qat'iyatli bobo, eri qarshi bo'lgan ona,
  avval aldangan ota, shanba kunigina kela oladigan Toshkentdagi ishchi, nafaqadagi ayol.
  Har birida yashirin sabab, haqiqiy e'tiroz, muvaffaqiyat va go'shak shartlari,
  xususiyatlar, boshlang'ich emotsiya va ovoz profili bor.
- **Qiyinlik darajasi** — sessiya boshida Oson / O'rta / Qiyin. Jadval bitta joyda:
  `module/backend/src/training/scenario/content-rules.ts` (`DIFFICULTY_LEVELS`).
- **Emotsiya boshqaruvi** — jahl, ishonch, qiziqish, sabr; go'shakdan oldin ogohlantirish;
  yashirin sabab faqat yetarli dolzarb savoldan keyin ochiladi (undan oldin promptga ham kirmaydi).
- **Baholash va debrief** — mezonlar, dalil iqtiboslari, maslahat, muhim lahzalar va
  **ssenariy kartasi** (yashirin sabab topildimi va qaysi navbatda, haqiqiy e'tiroz,
  jahlni pasaytirish, bosim ostida xushmuomalalik, to'g'ridan javob, aniq keyingi qadam,
  to'g'ri murojaat + 2-3 iqtibos va bitta maslahat). Natija va Tarix sahifalarida ko'rinadi.
- **Ssenariy yaratish (rahbar uchun)** — forma, "AI bilan to'ldirish", saqlamasdan sinab ko'rish.
- **Tekshiruvlar** — `npm run verify`: 8 ta test to'plami + frontend build (LLM kerak emas).

## 2. Ishga tushirish

Talablar: Node.js 22.9+ (sinalgan: 24), npm 10+, PostgreSQL 16+ (yoki Docker),
Python 3.10+ va `ffmpeg`.

```bash
npm install
cp harness/.env.example harness/.env      # faqat GEMINI_API_KEY ni yozing (3-bo'lim)
npm run db:local:start                    # dockersiz Postgres (yoki: npm run db:up)
npm run db:init
npm run verify                            # ixtiyoriy, lekin tavsiya etiladi
cd harness
npm run stt:setup                         # CPU (GPU uchun pastga qarang)
npm run dev                               # backend + UI + lokal STT
```

Brauzerda: http://127.0.0.1:5181 (backend 5180, STT 5190 — hammasi faqat 127.0.0.1 da).
Server startda 12 ta ssenariyni o'zi bazaga yuklaydi.

**CPU (GPU'siz)** — `npm run stt:setup` (CPU-only torch, venv ~1.2 GB). Ovozli navbat
CPU'da odatda ~4-5 s, eng yomon holatda ~6.7 s.

**GPU (NVIDIA)** — `npm run stt:setup -- --cuda` (venv ~4.9 GB). Qurilma avtomatik
tanlanadi; majburlash uchun `.env` da `STT_DEVICE=cuda` (yoki `cpu`). STT tezlashadi,
lekin umumiy kechikishning katta qismi baribir Gemini (miya + TTS) da.

## 3. Kalit: GEMINI_API_KEY

- Yagona majburiy kalit — `GEMINI_API_KEY`. U **alohida, xavfsiz kanal orqali** beriladi
  va **hech qachon repo'ga, paketga yoki chatga yozilmaydi**.
- Faqat `harness/.env` ga yoziladi (bu fayl `.gitignore` da). Repo'da faqat
  `harness/.env.example` (qiymatsiz nomlar) bor.
- OpenAI kaliti ixtiyoriy (zaxira uchun) va repo'dan tashqaridagi shaxsiy faylda turadi —
  README'dagi "LLM provayderi va kalitlar" bo'limiga qarang.

## 4. STT model paketi (Doniyor'dan)

Model vaznlari (~3 GB) paketga **kirmaydi**. Ularni Doniyor'dan so'rang (Google Drive'dagi
`package` papkasi). Drive bir nechta zip beradi — hammasini **bitta** papkaga oching:

```
stt/doniyor-model/
  base_model/        config.json, modeling_gigaam.py, pytorch_model.bin
  punct_model/       model.safetensors, tokenizer fayllari
  weights/gigaam_s1.pt     — faqat shu vazn kerak (v1/v5 ni o'chirsa bo'ladi)
  gigaam_local.py
```

Keyin `cd harness && npm run stt:setup`. Servis faqat `127.0.0.1` da tinglaydi, audio
kompyuterdan chiqmaydi, vaznlar `weights_only=True` bilan yuklanadi.

## 5. Biznes profili

- Paketda faqat **demo** profil bor (`harness/data/business-profile.demo.json`); u bilan
  UI tepasida "DEMO MA'LUMOT" belgisi turadi.
- Haqiqiy profil (kurslar, narxlar) alohida beriladi: uni
  `harness/data/business-profile.json` ga qo'ying (git'ga kirmaydi). Ixtiyoriy sotuv
  skripti — `harness/data/sales-script.md` (namuna: `sales-script.example.md`).
- Haqiqiy qo'ng'iroq yozuvlari (`harness/data/real-calls/`) paketga **kirmaydi**.

## 6. Ma'lumotlar holati

Topshirishdan oldin baza tozalandi: barcha sinov sessiyalari, navbatlar, baholashlar va
rahbar yaratgan sinov ssenariylari o'chirildi. Bazada faqat 12 ta tayyor ssenariy va demo
biznes/foydalanuvchi qatorlari bor. Tarix bo'sh.

## 7. Kalibrovka (qisman)

`npm run e2e:calibrate` — sotuvchini ham Gemini o'ynaydi (YAXSHI / O'RTA / YOMON uslub),
O'rta daraja, 12 navbatgacha, faqat matn. **Kalibrovka to'liq emas**: rejalashtirilgan
39 yugurishdan 19 tasi bajarilib, to'xtatildi. Ulardan 3 tasi keyin olib tashlangan bola
ssenariysiga tegishli, demak 16 ta yaroqli natija (6 ta ssenariy bo'yicha):

| Uslub | Yugurish | Yutdi | Yutqazdi | "Ochiq" |
|---|---|---|---|---|
| YAXSHI | 6 | 5 | 0 | 1 |
| O'RTA | 5 | 2 | 0 | 3 |
| YOMON | 5 | 0 | 5 | 0 |

- Maqsadga mos: YAXSHI asosan yutadi, YOMON doim yutqazadi, O'RTA aralash.
- O'RTA (va bitta YAXSHI) dagi **"ochiq" natijalar — sinov sotuvchisining o'zi qo'ng'iroqni
  tugatgani** tufayli (sinov vositasining cheklovi, ssenariy xatosi emas).
- Yashirin sabab 16 tadan faqat 2 tasida ochildi (suhbatlar 3-6 navbatda tugaydi). Qolgan
  6 ta ssenariy hali sinalmagan — kalibrovkani oxirigacha yurgizish tavsiya etiladi
  (~$2, `--budget` bilan cheklanadi).

## 8. Ma'lum cheklovlar

- **TTS limiti:** Gemini TTS Tier 1 da daqiqasiga 10 ta so'rov — bir vaqtda bir nechta
  ovozli mashq bo'lsa 429 xatosi chiqishi mumkin.
- **Bola/o'smir ovozi yo'q:** TTS ovozlari kattalar ovozi. Shu sababli bola ssenariysi olib
  tashlandi; o'smir ssenariysi kattalar ovozida yangraydi (matn rejimi ham mumkin).
- **Kechikish:** ovozli navbat ~4-5 s (STT + miya + TTS birinchi bo'lagi); CPU'da eng yomon
  holat ~6.7 s.
- **Rollar soxta (harness):** foydalanuvchi va rahbar haqiqiy autentifikatsiyasiz,
  `HARNESS_MANAGER_USER_IDS` va header'lar orqali taqlid qilinadi. Asosiy ilovaga ulashda
  haqiqiy auth/ruxsatlar ulanishi kerak.
- **Ssenariyni sotuvchiga biriktirish yo'q:** hozircha har sotuvchi barcha faol
  ssenariylarni ko'radi; rahbar aniq sotuvchiga topshiriq bera olmaydi.
- **Narxlar:** Gemini narxi **2027-yil 1-yanvardan ikki barobar** bo'ladi — narxlar bitta
  joyda: `harness/src/pricing.ts`, shuni yangilang.

## 9. Foydali buyruqlar

| Buyruq | Nima |
|---|---|
| `npm run verify` | hamma test + frontend build |
| `npm run typecheck` | TypeScript tekshiruvi |
| `cd harness && npm run scenarios:check` | ssenariy JSON'larini tekshirish |
| `cd harness && npm run e2e:calibrate` | kalibrovka (pulli, `--budget 3`) |
| `cd harness && npm run e2e:voice -- --runs 5` | ovozli kechikish sinovi |
| `npm run handoff:pack` | topshirish paketi (`dist/handoff-<commit>.tar.gz`) |
