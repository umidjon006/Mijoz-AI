# INTEGRATION.md — modulni `sales-copilot` repo'siga ulash

Bu papka (`module/`) — **drop-in modul**. `harness/` papkasi BERILMAYDI va
kerak emas: modul hech qachon undan import qilmaydi.

Hozirgi holat: **Step 1 — faqat poydevor** (arxetiplar, portlar, profil
sxemasi, DB jadvallari, RLS, verify). Endpoint, LLM, STT/TTS, baholash va
frontend keyingi qadamlarda.

---

## 1. Nimani qayerga ko'chirish

| Modul fayli | Asosiy repodagi joyi |
| --- | --- |
| `backend/src/training/archetypes.ts` | `backend/src/training/archetypes.ts` |
| `backend/src/training/ports.ts` | `backend/src/training/ports.ts` |
| `backend/src/training/verify-training.ts` | `backend/src/training/verify-training.ts` |
| `backend/src/training/demo-profiles.json` | `backend/src/training/demo-profiles.json` (faqat dev/test; haqiqiy ma'lumot kelganda o'chiriladi) |
| `backend/src/db/schema/training.ts` | `backend/src/db/schema/training.ts` |
| `backend/src/training/profile-schema.ts` | **KO'CHIRILMAYDI** — 2-bo'limga qarang |
| `backend/src/db/schema/host-tables.ts` | **KO'CHIRILMAYDI** — 3-bo'limga qarang |
| `integration/training.sql` | faqat ma'lumot uchun (migratsiyani o'zingiz generatsiya qilasiz) |
| `integration/rls-training.sql` | faqat ma'lumot uchun + `rls.sql` ga qo'shiladigan qadamlar |

Sxema barrel fayli bo'lsa (`backend/src/db/schema/index.ts`), unga qo'shing:

```ts
export * from './training.js';
```

## 2. `profile-schema.ts` ni olib tashlash

`module/backend/src/training/profile-schema.ts` — asosiy repodagi
`backend/src/business/profile.ts` dagi `profileSchema` ning vendor nusxasi
(modul standalone ishlashi uchun). Integratsiyada:

1. faylni **o'chirib tashlang**;
2. uni import qilgan joylarda (`ports.ts`, `verify-training.ts`) importni
   almashtiring:

```ts
// oldin
import type { BusinessProfile } from './profile-schema.js';
// keyin
import type { BusinessProfile } from '../business/profile.js';
```

> Bu modul `../sales-copilot` repo'si **bo'lmagan** laptopda yozilgan, shuning
> uchun vendor sxema `demo-profiles.json` maydonlari bo'yicha tiklandi.
> `verify-training.ts` ichida avtomatik taqqoslash testi bor: repo yonida
> bo'lsa (`../sales-copilot`), ikki sxema bir xil namunalarni qabul/rad
> qilishini tekshiradi. **Integratsiyadan oldin shu testni bir marta
> ishga tushiring** — maydon nomlari/optional-lik farqi shu yerda chiqadi.

## 3. `host-tables.ts` ni olib tashlash

`training.ts` dagi FK'lar host ilovaning `business`, `app_user`, `seat`
jadvallariga ishora qiladi. Modul standalone kompilyatsiya bo'lishi uchun
ularning minimal e'loni `backend/src/db/schema/host-tables.ts` da turadi.

1. faylni o'chiring;
2. `training.ts` dagi importni haqiqiy sxemalarga almashtiring:

```ts
// oldin
import { appUser, business, seat } from './host-tables.js';
// keyin (fayl nomlari repoda qanday bo'lsa)
import { business } from './business.js';
import { appUser } from './app-user.js';
import { seat } from './seat.js';
```

Ustun nomlari (`business.id`, `app_user.id`, `seat.id`) o'zgarmasa, boshqa
hech narsa o'zgartirish kerak emas.

## 4. To'rtta chok (seam) — nimani nimaga ulash

Modul tashqi dunyoni faqat `ports.ts` orqali ko'radi. `TrainingDeps` ni host
ishga tushganda bir marta yig'ib beradi:

| Chok | Tip | Asosiy repoda nimaga ulanadi |
| --- | --- | --- |
| **1. TrainingContext** | `{ businessId, userId, seatId }` | Fastify auth/preHandler dagi `request.user` / JWT claim'lari. Modul **hech qachon** global'dan yoki `request` dan o'zi o'qimaydi — kontekst argument sifatida uzatiladi. |
| **2. TrainerLlm** | `completeJson({ stage, system, user, schema })` | `backend/src/ai/llm.ts` dagi `LlmClient` bilan **ayni bir xil shakl**: `const llm = getActiveLlm();` va to'g'ridan-to'g'ri beriladi, adapter yozish kerak emas. |
| **3. WithTenant** | `withTenant(businessId, (tx) => ...)` | `backend/src/db/index.ts` dagi `withTenant` — o'zgarishsiz uzatiladi. Tip generik (`WithTenant<TTx>`), shuning uchun Drizzle tranzaksiya tipini bersangiz bo'ladi: `WithTenant<typeof db extends ... >` yoki oddiygina `WithTenant<DbTx>`. |
| **4. GetBusinessProfile** | `(businessId) => Promise<BusinessProfile \| null>` | `backend/src/business/profile.ts` dagi profil o'qish funksiyasi. Domen faktlari **faqat shu yerdan** keladi — modul ichida hech qanday soha nomi qattiq yozilmagan. |

Namuna (host tomonda, Step 2 dan boshlab kerak bo'ladi):

```ts
import { getActiveLlm } from './ai/llm.js';
import { withTenant } from './db/index.js';
import { getBusinessProfile } from './business/profile.js';
import type { TrainingDeps } from './training/ports.js';

export const trainingDeps: TrainingDeps = {
  withTenant,
  getBusinessProfile,
  llm: getActiveLlm(),
  logger: app.log,
};
```

## 5. DB migratsiyasi

1. `backend/src/db/schema/training.ts` ni joyiga qo'ying (2 va 3-bo'limdan
   keyin);
2. migratsiyani **o'z drizzle-kit'ingiz bilan QAYTADAN generatsiya qiling**
   (`npm run db:generate` yoki repoda qanday bo'lsa). `integration/training.sql`
   — faqat ma'lumot uchun, raqamlanmagan va **migratsiya papkasiga
   ko'chirilmaydi** (aks holda migratsiya raqamlari to'qnashadi);
3. generatsiya natijasini `integration/training.sql` bilan solishtiring:
   ikkita jadval, CHECK'lar, `(business_id, user_id, started_at desc)` indeks,
   `(session_id, seq)` unique.

Eslatma: mashq sessiyalari **asosiy `conversation` jadvaliga yozilmaydi** —
faqat `training_session` va `training_turn`.

## 6. RLS (eng muhim qadam — oson esdan chiqadi)

`backend/src/db/rls.sql` ichidagi `tenant_tables` ro'yxati **qo'lda**
yuritiladi. Jadval ro'yxatda bo'lmasa — u **himoyalanmaydi** va hech qanday
xato ham chiqmaydi.

1. ro'yxatga qo'shing:

```
'training_session',
'training_turn'
```

2. `rls.sql` ni qayta qo'llang;
3. `integration/rls-training.sql` ni o'qing — siyosat namunasi va
   `nullif(current_setting('app.business_id', true), '')::uuid` haqidagi
   muhim izoh shu yerda (bo'sh satr `::uuid` da xato beradi);
4. tekshiring: `verify-training.ts` dagi RLS testlari.

## 7. Checklist

- [ ] `backend/src/training/*` va `backend/src/db/schema/training.ts` ko'chirildi
- [ ] `profile-schema.ts` o'chirildi, import `business/profile.js` ga o'tdi
- [ ] `host-tables.ts` o'chirildi, FK'lar haqiqiy sxemalarga ulandi
- [ ] sxema barrel'iga `export * from './training.js'` qo'shildi
- [ ] migratsiya o'z drizzle-kit bilan generatsiya qilindi va qo'llandi
- [ ] `rls.sql` dagi `tenant_tables` ga 2 jadval qo'shildi va qayta qo'llandi
- [ ] `TrainingDeps` yig'ildi (4 chok: context, llm, withTenant, getBusinessProfile)
- [ ] `verify-training.ts` to'liq o'tadi (RLS testlari ham)
- [ ] `tsc --noEmit` toza

## 8. Keyingi qadamlar

- **TODO (Step 2)**: deterministik holat mashinasi (patience/trust/interest,
  e'tirozlar, yashirin ehtiyoj, win/lose qoidalari), persona-card generatsiya,
  `persona_card` va `state` jsonb strukturasi.
- **TODO (Step 3)**: Fastify endpoint'lar (`POST /training/sessions`,
  `POST /training/sessions/:id/turns`), zod validatsiya, rate-limit, cost
  hisobi (`cost_usd`).
- **TODO (Step 4)**: STT/TTS (ovozli mashq) chok'lari.
- **TODO (Step 5)**: baholash/scoring va frontend (React/Vite) ekranlari.
