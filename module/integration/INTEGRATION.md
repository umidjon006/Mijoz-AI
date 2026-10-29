# INTEGRATION.md — modulni `sales-copilot` repo'siga ulash

Bu papka (`module/`) — **drop-in modul**. `harness/` papkasi BERILMAYDI va
kerak emas: modul hech qachon undan import qilmaydi.

Hozirgi holat: **Step 1-2** — poydevor (arxetiplar, portlar, profil sxemasi,
DB jadvallari, RLS) + **matnli AI mijoz motori**: persona generatsiya, holat va
qoidalar, prompt'lar, agreement guard, `startSession` / `takeTurn` /
`endSession`. Endpoint (route), STT/TTS, baholash va frontend keyingi
qadamlarda.

---

## 1. Nimani qayerga ko'chirish

| Modul fayli | Asosiy repodagi joyi |
| --- | --- |
| `backend/src/training/archetypes.ts` | `backend/src/training/archetypes.ts` |
| `backend/src/training/state.ts` | `backend/src/training/state.ts` |
| `backend/src/training/prompts.ts` | `backend/src/training/prompts.ts` |
| `backend/src/training/persona.ts` | `backend/src/training/persona.ts` |
| `backend/src/training/engine.ts` | `backend/src/training/engine.ts` |
| `backend/src/training/repo.ts` | `backend/src/training/repo.ts` |
| `backend/src/training/errors.ts` | `backend/src/training/errors.ts` |
| `backend/src/training/ports.ts` | `backend/src/training/ports.ts` |
| `backend/src/training/testing/*.ts` | `backend/src/training/testing/*.ts` (fake LLM + test yordamchilari) |
| `backend/src/training/verify-training.ts` | `backend/src/training/verify-training.ts` |
| `backend/src/training/verify-training-core.ts` | `backend/src/training/verify-training-core.ts` |
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
2. uni import qilgan joylarda (`ports.ts`, `persona.ts`, `prompts.ts`,
   `verify-training*.ts`) importni almashtiring:

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
| **2. TrainerLlm** | `completeJson({ stage, system, user, schema })` | `backend/src/ai/llm.ts` dagi `LlmClient` bilan **ayni bir xil shakl**: `const llm = getActiveLlm();` va to'g'ridan-to'g'ri beriladi, adapter yozish kerak emas. **Ixtiyoriy** `completeJsonWithUsage` ham bor: agar sizning klientingiz token sarfini qaytara olsa, shu metodni qo'shing — `cost_usd` avtomatik to'ldiriladi; qo'shmasangiz hammasi ishlaydi, faqat narx 0 bo'lib qoladi. |
| **3. WithTenant** | `withTenant(businessId, (tx) => ...)` | `backend/src/db/index.ts` dagi `withTenant` — o'zgarishsiz uzatiladi. Modul `tx` dan faqat Drizzle query-builder'ini ishlatadi (`ports.ts` dagi `TrainingTx` — eng umumiy `PgTransaction`). Sizning `withTenant` ning tx tipi bu bilan to'g'ridan-to'g'ri mos kelmasa, ulash joyida bitta `as unknown as TrainingTx` yetarli (harness'da ham shunday). |
| **5. PriceCall** (ixtiyoriy) | `(usage) => number` (USD) | Sizning tariflaringiz. Berilmasa `cost_usd` 0 qoladi. `random` va `now` ham ixtiyoriy — testlar uchun. |
| **4. GetBusinessProfile** | `(businessId) => Promise<BusinessProfile \| null>` | `backend/src/business/profile.ts` dagi profil o'qish funksiyasi. Domen faktlari **faqat shu yerdan** keladi — modul ichida hech qanday soha nomi qattiq yozilmagan. |

Namuna (host tomonda, Step 2 dan boshlab kerak bo'ladi):

```ts
import { getActiveLlm } from './ai/llm.js';
import { withTenant } from './db/index.js';
import { getBusinessProfile } from './business/profile.js';
import type { TrainingDeps } from './training/ports.js';

export const engine = createTrainingEngine({
  withTenant,                 // 3-chok
  getBusinessProfile,         // 4-chok
  llm: getActiveLlm(),        // 2-chok
  priceCall: (usage) => yourPricing(usage), // ixtiyoriy
  logger: app.log,
});

// Route ichida (Step 3):
const ctx: TrainingContext = {               // 1-chok
  businessId: request.user.businessId,
  userId: request.user.id,
  seatId: request.user.seatId ?? null,
};
const result = await engine.takeTurn(ctx, { sessionId, sellerText });
```

Xatolar: `TrainingError.code` -> HTTP:
`profile_missing` 409, `session_not_found` 404, `session_forbidden` 403,
`session_not_active` 409, `persona_generation_failed` / `llm_invalid_output` 502.

## 4b. Motor (Step 2): nima qanday ishlaydi

```
startSession(ctx, {archetypeKey, direction?, language?})
  getBusinessProfile(businessId)        <- chok
  generatePersonaCard({llm, ...})       <- 1 LLM chaqiruvi (+1 tuzatish urinishi)
  initState(archetype)                  <- sof kod
  withTenant -> insert training_session (+ inbound bo'lsa openingLine = seq 1)

takeTurn(ctx, {sessionId, sellerText})  -- hammasi BITTA tranzaksiyada
  session'ni `for update` bilan qulflash (seq bo'shliqsiz bo'lishi uchun)
  insert training_turn (speaker='seller')
  computeReadiness(state, persona, archetype)        <- KOD qaror qiladi
  buildTurnSystemPrompt + buildTurnUserPrompt (oxirgi 12 navbat)
  llm.completeJson({stage:'training.turn', schema: turnResultSchema})
  [guard] intent qoidani buzsa -> BITTA tuzatuvchi retry
          yana buzsa -> matn olinadi, natija O'ZGARMAYDI, guardViolations++
  applyTurnResult(...)  -> clamp, bazaviy decay, flaglar
  evaluateEnd(...)      -> won | lost | timeout (faqat kod)
  insert training_turn (speaker='customer', state_after = holat + {meta:{latencyMs,...}})
  update training_session (state, turn_count, cost_usd += priceCall(usage), status/outcome)
```

Fayllar:

| Fayl | Nima beradi |
| --- | --- |
| `state.ts` | `trainingStateSchema` (= `state` ustuni), `turnResultSchema` (LLM shartnomasi), `initState`, `applyTurnResult`, `computeReadiness`, `evaluateEnd`, `isGuardViolation` |
| `prompts.ts` | `PROMPT_VERSION`, `TRANSCRIPT_WINDOW = 12`, navbat va persona promptlari |
| `persona.ts` | `personaCardSchema`, `makePersonaCardSchema` (arxetip/profil qoidalari), `generatePersonaCard` |
| `engine.ts` | `createTrainingEngine({...})` -> `startSession`, `takeTurn`, `endSession`, `getSession` |
| `repo.ts` | Drizzle so'rovlari (hammasi `tx` oladi) |
| `errors.ts` | `TrainingError` + `code` (route'da HTTP statusga o'giriladi) |

**Qiyinlikni qanday sozlash kerak** (`archetypes.ts`, hech qanday prompt
o'zgartirmasdan):

- `objections.count` — nechta e'tiroz yechilishi kerak. Mijoz hamma e'tirozini
  aytib bo'lmaguncha **hech qachon** rozi bo'lmaydi, shuning uchun bu
  parametr qiyinlikka eng kuchli ta'sir qiladi;
- `objections.severityMax` — e'tirozlar qanchalik qattiq (persona
  generatsiyasida chegara sifatida ishlatiladi);
- `win.minTrust` — rozilik uchun kerakli ishonch;
- `win.requireObjectionsResolved` — e'tirozlar yechilishi shartmi;
- `win.type` — `agree` | `agree_or_next_step` (keyingi qadam ham g'alaba) |
  `need_discovered_and_agree` (avval yashirin ehtiyoj);
- `lose.patienceBelow` — qachon qo'ng'iroq uziladi;
- `difficulty` — har navbatdagi tabiiy sabr kamayishi `ceil(difficulty / 2)`;
- `maxTurns` — timeout;
- `behaviorRules` — prompt'ga aynan tushadi (mijozning xulqi);
- `hiddenNeed` + `needRevealTriggers` — ehtiyojni ochish talabi.

Deltalarning o'zi (`trust +6` kabi) **LLM tomonidan** taklif qilinadi, lekin
kod ularni `[-20, 20]` ga va holatni `[0, 100]` ga chegaralaydi, shuning uchun
model "hammasi yaxshi" deb sessiyani buzib yubora olmaydi.

**Prompt'lar qayerda:** hozircha kodda (`prompts.ts`), `PROMPT_VERSION`
holatga yoziladi (`state.promptVersion`). Xohlasangiz keyinchalik asosiy
repodagi `prompt_template` jadvaliga ko'chirasiz — shart: versiya kaliti
holatga yozilishi davom etsin, aks holda eski sessiyalarni qayta o'qish
mantig'i yo'qoladi.

**Eslatma (ataylab qilingan tanlov):** `takeTurn` LLM chaqiruvini DB
tranzaksiyasi ICHIDA bajaradi (spetsifikatsiya shunday talab qiladi:
"in one transaction"). Bu sessiya qatorini bir necha soniya qulflab turadi.
Yuklama ortsa, tranzaksiyani ikkiga bo'lish kerak bo'ladi (navbatni yozish ->
LLM -> natijani yozish), lekin unda `seq` uchun boshqa qulf kerak.

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
- [ ] `verify-training.ts` va `verify-training-core.ts` to'liq o'tadi (RLS + engine testlari)
- [ ] `module/` ichida provayder SDK'si yo'qligi tekshirildi (Anthropic SDK faqat harness'da edi)
- [ ] `tsc --noEmit` toza

## 8. Keyingi qadamlar

- **BAJARILDI (Step 2)**: persona generatsiya, holat va qoidalar, prompt'lar,
  agreement guard, `startSession`/`takeTurn`/`endSession`/`getSession`,
  `state` va `persona_card` jsonb strukturasi — 4b bo'limga qarang.
- **TODO (Step 3)**: Fastify endpoint'lar (`POST /training/sessions`,
  `POST /training/sessions/:id/turns`, `GET /training/sessions/:id`), zod
  validatsiya, rate-limit, `TrainingError.code` -> HTTP xaritasi, SSE/stream
  (xohlasa).
- **TODO (Step 4)**: STT/TTS (ovozli mashq). `reply` allaqachon ovozga tayyor
  (2 qisqa gap, <= 300 belgi, emoji/markdown yo'q).
- **TODO (Step 5)**: baholash/scoring (transkript + `state` tarixi asosida) va
  frontend (React/Vite) ekranlari.
- **Env (faqat harness)**: `ANTHROPIC_API_KEY`, `TRAINER_MODEL` — asosiy
  repoda bular kerak emas, LLM host tomonidan beriladi.
- **TODO (Step 4)**: STT/TTS (ovozli mashq) chok'lari.
- **TODO (Step 5)**: baholash/scoring va frontend (React/Vite) ekranlari.
