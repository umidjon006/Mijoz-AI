# INTEGRATION.md — modulni `sales-copilot` repo'siga ulash

Bu papka (`module/`) — **drop-in modul**. `harness/` papkasi BERILMAYDI va
kerak emas: modul hech qachon undan import qilmaydi.

Hozirgi holat: **Step 1-2** — poydevor (arxetiplar, portlar, profil sxemasi,
DB jadvallari, RLS, verify) + **deterministik holat mashinasi va persona-card**.
Endpoint, LLM chaqiruvlari, STT/TTS, baholash va frontend keyingi qadamlarda.

---

## 1. Nimani qayerga ko'chirish

| Modul fayli | Asosiy repodagi joyi |
| --- | --- |
| `backend/src/training/archetypes.ts` | `backend/src/training/archetypes.ts` |
| `backend/src/training/state.ts` | `backend/src/training/state.ts` |
| `backend/src/training/engine.ts` | `backend/src/training/engine.ts` |
| `backend/src/training/persona.ts` | `backend/src/training/persona.ts` |
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
2. uni import qilgan joylarda (`ports.ts`, `persona.ts`, `verify-training.ts`)
   importni almashtiring:

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

## 4b. Holat mashinasi va persona-card (Step 2)

Bu qism **to'liq deterministik va LLM'siz** — shuning uchun integratsiyada
hech narsa ulash kerak emas, shunchaki ko'chiriladi. Lekin Step 3 da
endpoint yozganda shu shartnomaga tayaniladi:

| Fayl | Nima beradi |
| --- | --- |
| `state.ts` | `trainingStateSchema` (= `training_session.state` ustunining shakli), `turnSignalsSchema`, outcome/endReason enum'lari |
| `engine.ts` | `initialState(archetype)`, `applyTurn(archetype, state, signals)`, `simulate(...)`, `ENGINE_RULES` |
| `persona.ts` | `buildPersonaCard({ archetype, profile, seed })` (= `persona_card` ustuni), `objectionText(card, index)` |

Step 3 da bir navbat quyidagicha ishlaydi (tartib muhim):

1. sotuvchi matni keladi -> **LLM/analizator** faqat `TurnSignals` ni ajratib
   beradi (`turnSignalsSchema` bilan validatsiya qilinadi);
2. `applyTurn(...)` **kodda** yangi holatni va hodisalarni hisoblaydi —
   g'alaba/yutqazish qarori LLM'da EMAS;
3. `result.raisedObjectionIndex` bo'lsa, mijoz aytadigan e'tiroz matni
   `objectionText(card, index)` dan olinadi (ya'ni profildan, kodda emas);
4. **LLM** faqat mijozning javob matnini yozadi (persona-card + yangi holat
   asosida);
5. `training_turn` ga seller va customer navbatlari, `training_session.state`
   ga yangi holat yoziladi (hammasi bitta `withTenant` tranzaksiyasida).

Muhim xususiyatlar:

- `applyTurn` kirish holatini **o'zgartirmaydi** (immutable), yangi obyekt
  qaytaradi — optimistik qayta urinish xavfsiz;
- `buildPersonaCard` urug' (seed) bo'yicha deterministik — urug' sifatida
  `training_session.id` ni bering, keyin sessiyani qayta o'ynash mumkin;
- profil `null` bo'lsa kard neytral zahira matnlar bilan to'ladi (ilova
  yiqilmaydi), lekin mashq sifati tushadi — profilni to'ldirishni talab qiling;
- koeffitsiyentlarni sozlash kerak bo'lsa faqat `ENGINE_RULES` ni
  o'zgartiring, mantiqni emas.

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

- [ ] `backend/src/training/*` (archetypes, state, engine, persona, ports, verify) va `backend/src/db/schema/training.ts` ko'chirildi
- [ ] `profile-schema.ts` o'chirildi, import `business/profile.js` ga o'tdi
- [ ] `host-tables.ts` o'chirildi, FK'lar haqiqiy sxemalarga ulandi
- [ ] sxema barrel'iga `export * from './training.js'` qo'shildi
- [ ] migratsiya o'z drizzle-kit bilan generatsiya qilindi va qo'llandi
- [ ] `rls.sql` dagi `tenant_tables` ga 2 jadval qo'shildi va qayta qo'llandi
- [ ] `TrainingDeps` yig'ildi (4 chok: context, llm, withTenant, getBusinessProfile)
- [ ] `verify-training.ts` to'liq o'tadi (RLS testlari ham)
- [ ] `tsc --noEmit` toza

## 8. Keyingi qadamlar

- **BAJARILDI (Step 2)**: deterministik holat mashinasi
  (patience/trust/interest, e'tirozlar, yashirin ehtiyoj, win/lose/timeout),
  persona-card, `state` va `persona_card` jsonb strukturasi — 4b bo'limga
  qarang.
- **TODO (Step 3)**: Fastify endpoint'lar (`POST /training/sessions`,
  `POST /training/sessions/:id/turns`), `TrainerLlm` orqali mijoz matni va
  signal ajratish, zod validatsiya, rate-limit, cost hisobi (`cost_usd`).
- **TODO (Step 4)**: STT/TTS (ovozli mashq) chok'lari.
- **TODO (Step 5)**: baholash/scoring va frontend (React/Vite) ekranlari.
