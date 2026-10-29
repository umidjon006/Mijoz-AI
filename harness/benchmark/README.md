# Ovoz benchmarki (Step 3, Phase A)

Maqsad: **o'zbek tili uchun qaysi STT va TTS yaxshi ishlashini raqamlar bilan
aniqlash**, keyin Phase B da faqat tanlangan provayderlarni ulash.

Nega shunday: o'zbekcha ovoz sifati — bu loyihaning eng katta noma'lumi.
Shuning uchun avval o'lchaymiz, keyin quramiz. **Ovoz sifatini (tabiiylik)
faqat ODAM baholadi** — men audio eshitmayman, faqat kechikish va matn
aniqligini o'lchayman.

Kechikish byudjeti (Phase B uchun): sotuvchi gapi tugashidan mijoz ovozi
boshlanishigacha **median ≤ 4 s, p90 ≤ 6 s** (STT + LLM + TTS birgalikda).

---

## 0. Kalitlarni olish

`harness/.env` fayliga yozing (`harness/.env.example` dan nusxa oling).
**`.env` hech qachon commit qilinmaydi.**

| O'zgaruvchi | Qayerdan olinadi | Kerakmi |
| --- | --- | --- |
| `AZURE_SPEECH_KEY` | Azure portal → "Speech service" resursi → Keys and Endpoint | STT va TTS uchun |
| `AZURE_SPEECH_REGION` | O'sha resursning regioni, masalan `westeurope` | Azure bilan birga |
| `GOOGLE_API_KEY` | Google Cloud Console → APIs & Services → Credentials → API key. **Cloud Speech-to-Text API** va **Cloud Text-to-Speech API** yoqilgan bo'lishi kerak | Google uchun |

Azure'da "Free F0" tarifi ham bor (oyiga 5 soat STT, 0,5 mln belgi neural TTS) —
benchmark uchun yetadi. Google'da yangi akkauntda bepul kredit bo'ladi.

Faqat bitta provayder kalitini olsangiz ham benchmark ishlaydi — ikkinchisi
avtomatik o'tkazib yuboriladi (lekin solishtirish uchun ikkisi ham tavsiya
etiladi).

---

## 1. Qaysi ovozlar HAQIQATDA mavjud — tekshirish

```bash
npm run bench:voices
```

Bu provayderlardan ovozlar ro'yxatini **API orqali** so'raydi va
`out/voices.json` ga yozadi. Bepul (sintez qilinmaydi).

Natijada ko'rasiz:
- Azure'da `uz-UZ` ovozlari bor-yo'qligi va ularning aniq nomlari;
- Google TTS'da o'zbek ovozi bor-yo'qligi (agar bo'lmasa — Google faqat STT
  uchun ishlatiladi).

Shu qadamni **birinchi** bajaring: keyingi skript ovoz nomlarini shu fayldan
oladi.

---

## 2. Ovoz namunalarini yozib olish

```bash
npm run bench:record
```

Keyin **Chrome (desktop)** da `http://127.0.0.1:5174` ni ochasiz.

- **QULOQCHIN KIYIB OLING** — dinamikdan chiqqan ovoz mikrofonga qaytsa
  (echo) o'lchov buziladi;
- tinch xonada, mikrofondan 20–30 sm masofada, **tabiiy tezlikda** o'qing;
- har gap uchun tugmani **bosib turib** gapiring (yoki **BO'SHLIQ** tugmasi),
  qo'yib yuborsangiz avtomatik saqlanadi va keyingi gapga o'tadi;
- xato o'qisangiz — o'sha gapga qaytib qayta yozsangiz, fayl ustiga yoziladi;
- mikrofon darajasi ko'rsatkichi harakatlanmasa, mikrofon ishlamayapti.

Yozuvlar: `samples/NN.wav` (16 kHz, mono, 16-bit PCM — brauzerda tayyorlanadi,
serverda konvertatsiya yo'q). 15 gapning hammasini yozsangiz yaxshi, lekin
kamrog'i bilan ham sinab ko'rish mumkin.

`sentences.uz.txt` ichida ataylab: narxlar (so'z bilan), raqamlar, telefon
raqami, ruscha so'zlar (`dostavka`, `konsultatsiya`, `aksiya`, `statistika`),
brend/joy nomlari va savol gap bor — STT aynan shularda qiynaladi.

---

## 3. STT benchmarkini ishga tushirish

```bash
npm run bench:stt                      # hamma mavjud provayder, hamma namuna
npm run bench:stt -- --limit 3         # avval 3 ta bilan sinab ko'rish
npm run bench:stt -- --providers azure
npm run bench:stt -- --digits-to-words # raqamlarni so'zga aylantirib solishtirish
```

Chaqirishdan oldin **taxminiy narx** chiqadi va tasdiq so'raladi (`--yes` bilan
o'tkazib yuborish mumkin). Natija: `out/stt-results.json` + terminalda jadval.

Nimaga qarash kerak:
- **WER** (so'z xatosi) — asosiy ko'rsatkich. 0.10 (10%) dan past bo'lsa juda
  yaxshi, 0.30 dan yuqori bo'lsa mashq uchun qiynaladi;
- **CER** (harf xatosi) — kichik xatolarni ko'rsatadi;
- **lat(med) / lat(p90)** — STT kechikishi. 4 soniyalik umumiy byudjetdan
  STT'ga ~1–1.5 s qoladi;
- **conf** — provayderning o'ziga ishonchi. Phase B da "qaytaring" qarori shu
  qiymatga tayanadi, shuning uchun u haqiqatan mazmunli bo'lishi muhim.

Agar raqamlar so'z bilan o'qilgani uchun WER sun'iy ravishda yuqori chiqsa,
`--digits-to-words` bilan qayta ishga tushirib ikki raqamni solishtiring.

---

## 4. TTS benchmarkini ishga tushirish

```bash
npm run bench:tts                                   # out/voices.json dagi ovozlar, lotin yozuv
npm run bench:tts -- --scripts latin,cyrillic       # ikki yozuvni solishtirish
npm run bench:tts -- --limit 4                      # arzon sinov
npm run bench:tts -- --voices azure:uz-UZ-MadinaNeural,azure:uz-UZ-SardorNeural
```

Natija:
- `out/tts/<provayder>/<ovoz>__<yozuv>/NN.wav` — audio fayllar;
- `out/tts-results.json` — kechikish (umumiy va birinchi bayt);
- **`out/listen.html`** — tinglash va baholash sahifasi.

---

## 5. Tinglash va baholash (eng muhim qadam)

`out/listen.html` ni brauzerda ochib (fayl sifatida ochilsa ham ishlaydi),
har klipni **quloqchin bilan** tinglang va ikki ball qo'ying:

- **tabiiylik**: 1 = robot, 5 = tabiiy odam gapiryapti;
- **raqamlar**: 1 = narx/raqam tushunarsiz, 5 = to'liq tushunarli.

Oxirida "CSV yuklab olish" tugmasini bosing — `tts-ratings.csv` yuklanadi.

---

## 6. Natijalarni qaytarish

Menga quyidagilarni yuboring (yoki shu papkada qoldirib, "tayyor" deb yozing):

1. `out/stt-results.json`
2. `out/tts-results.json`
3. `out/voices.json`
4. `tts-ratings.csv`
5. bir-ikki og'iz fikr: qaysi ovoz eshitishga yoqimli, qaysi biri o'zbekchani
   g'alat talaffuz qiladi, raqam va narxlarni qanday o'qidi.

Shundan keyin Phase B boshlanadi: siz tanlagan STT va TTS (provayder + ovoz
nomi) bilan push-to-talk ovozli mashq quriladi.

---

## Eslatmalar va cheklovlar

- **Audio saqlanmaydi.** Benchmark namunalari (`samples/`) va TTS klipi
  (`out/`) ataylab diskda qoladi — bu lokal o'lchov materiali, git'ga
  kirmaydi (`.gitignore`). Ilovaning o'zi (Phase B) hech qachon audio
  saqlamaydi, faqat matn.
- **Azure qisqa-audio REST endpointi "phrase list" (hints) ni qo'llamaydi** —
  u faqat SDK'da bor. Shuning uchun benchmark'da Azure'ga maxsus so'zlar
  ro'yxati berilmaydi, Google'ga esa beriladi (`speechContexts`). Phase B da
  bu farq hisobga olinadi.
- Narx taxminlari (`PRICE_HINTS`) faqat ogohlantirish uchun — har provayderning
  joriy narx sahifasi bilan tekshirilishi kerak.
- GigaAM (asosiy repodagi lokal STT) o'lchanmadi: `../sales-copilot` repo'si
  bu kompyuterda yo'q. U paydo bo'lsa, "bepul variant" sifatida uni ham shu
  benchmark'ga qo'shish mumkin.
