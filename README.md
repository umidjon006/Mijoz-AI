# sotuv-trener — AI mijoz trenajyori (Step 1: poydevor)

Sotuvchilar mashq qiladigan **AI mijoz simulyatori**. Keyinchalik mavjud
multi-tenant SaaS (`sales-copilot`: Fastify + Drizzle + PostgreSQL + RLS + zod
+ React/Vite) ichiga ko'chiriladi. Shu sababli bu repo **standalone drop-in
modul** sifatida yozilgan va asosiy repo hech qachon o'zgartirilmaydi.

```
module/     <- FAQAT shu papka teammate'larga beriladi
harness/    <- lokal ishga tushirish uchun scaffolding, HECH QACHON berilmaydi
```

Qat'iy chegara: `module/` ichidagi hech bir fayl `harness/` dan import
qilmaydi. Teskarisi — mumkin (harness modulni import qiladi).

## Papka tuzilishi

```
sotuv-trener/
  README.md
  package.json                   # npm workspace ildizi (lokal, faqat qulaylik uchun)
  archetypes.json                # manba ma'lumot (runtime'da o'qilmaydi)
  demo-profiles.json             # manba ma'lumot
  module/
    backend/src/training/
      archetypes.ts              # zod sxema + 4 arxetip (tiplangan konstantalar)
      ports.ts                   # TrainingContext, TrainerLlm, WithTenant, GetBusinessProfile
      profile-schema.ts          # vendor profileSchema (integratsiyada o'chiriladi)
      demo-profiles.json         # dev/test ma'lumoti
      verify-training.ts         # tekshiruv skripti
    backend/src/db/schema/
      training.ts                # Drizzle: training_session, training_turn
      host-tables.ts             # host jadvallarining minimal e'loni (integratsiyada o'chiriladi)
    integration/
      INTEGRATION.md             # nimani qayerga ko'chirish va nimani ulash
      rls-training.sql           # rls.sql ga qo'shiladigan qadamlar + siyosat namunasi
      training.sql               # ma'lumot uchun SQL (migratsiya EMAS)
  harness/
    docker-compose.yml           # postgres:18, 55433 portda
    db/bootstrap.sql             # cheklangan rol + business/app_user/seat stub'lari
    db/grants.sql                # ilova roliga DML huquqi
    src/withTenant.ts            # test uchun withTenant (set_config + tranzaksiya)
    src/apply-sql.ts             # SQL fayllarni tartib bilan qo'llaydi
    package.json, tsconfig.json, drizzle.config.ts, .env.example
```

## Lokal ishga tushirish

```bash
npm install
cp harness/.env.example harness/.env
npm run db:up        # docker: postgres:18, 127.0.0.1:55433
npm run db:init      # bootstrap.sql -> training.sql -> rls-training.sql -> grants.sql
npm run verify:training
npm run typecheck
```

DB kerak bo'lmasa (faqat sxema testlari):

```bash
SKIP_DB=1 npm run verify:training
```

To'liq tozalash: `npm run db:reset` (volume bilan birga o'chiradi), keyin
`npm run db:init`.

### Docker bo'lmasa (fallback)

Agar `docker` ishlamasa (masalan foydalanuvchi `docker` guruhida bo'lmasa),
lokal PostgreSQL binary'lari bilan vaqtinchalik klaster ko'tarish mumkin:

```bash
PGBIN=/usr/lib/postgresql/16/bin     # o'z versiyangizni qo'ying
export PGDATA=/tmp/sotuv-trener-pg
$PGBIN/initdb -D "$PGDATA" -U postgres --auth=trust
$PGBIN/pg_ctl -D "$PGDATA" -o "-p 55434 -c listen_addresses=127.0.0.1" -w start
psql -h 127.0.0.1 -p 55434 -U postgres -c "create database sotuv_trener"

export SUPERUSER_DATABASE_URL="postgres://postgres@127.0.0.1:55434/sotuv_trener"
export TRAINING_DATABASE_URL="postgres://trainer_app:trainer_app@127.0.0.1:55434/sotuv_trener"
npm run db:init && npm run verify:training

$PGBIN/pg_ctl -D "$PGDATA" -m fast stop   # tugatgandan keyin
```

## Verify nimani tekshiradi

1. 4 arxetip `archetypeSchema` dan o'tadi, kalitlar unikal, `hiddenNeed`
   bo'lsa `needRevealTriggers` bor;
2. kodagi `ARCHETYPES` ildizdagi `archetypes.json` bilan bir xil (drift yo'q);
3. har bir demo profil vendor `profileSchema` dan o'tadi, noto'g'ri enum rad
   etiladi;
4. `../sales-copilot` mavjud bo'lsa — vendor sxema va asosiy repodagi
   `profileSchema` bir xil namunalarni qabul/rad qiladi (bo'lmasa `skip`);
5. **RLS izolyatsiyasi** cheklangan rol ustida: A biznes qatorlari B biznes
   ostida ko'rinmaydi, `withTenant`siz o'qish ham yozish ham mumkin emas,
   boshqa tenant nomidan yozish rad etiladi, CHECK va unique ishlaydi.

## Keyingi qadamlar

Step 2–5: deterministik holat mashinasi, endpoint'lar, STT/TTS, baholash,
frontend. Batafsil: `module/integration/INTEGRATION.md` (8-bo'lim).
