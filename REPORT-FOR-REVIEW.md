# HOLAT HISOBOTI — sotuv-trener (AI mijoz trenajyori)

Sana: 2026-10-30 · Faqat o'qish rejimida tayyorlandi (kod o'zgartirilmadi).
Hisobot faqat shu papkadagi kod, git tarixi va ishga tushirilgan testlarga tayanadi.

---

## 0. Bir qarashda

- **Matnli AI mijoz oqimi to'liq ishlaydi** (kod darajasida): sessiya ochish →
  persona generatsiya → navbatma-navbat suhbat → deterministik win/lose/timeout →
  sessiyani tugatish → baholash (debrief) → React UI'da ko'rsatish. Men buni
  brauzerda **demo LLM** bilan uchidan-uchiga sinab ko'rdim.
- **144 ta test o'tadi, 0 xato, 1 ta skip.** Backend va frontend typecheck toza,
  frontend production build ishlaydi. Hammasi ~6 soniya (LLM chaqirilmaydi).
- **Ovoz (STT/TTS) hali YO'Q.** Step 3 ning faqat **Phase A** (o'lchov asboblari)
  bajarilgan; `takeVoiceTurn`, `/voice-turn` route va brauzer recorder YO'Q.
- **Model bake-off asboblari tayyor, lekin ishga tushirilmagan** (pulli).
- **ENG KATTA TO'SIQ: hech qachon bironta HAQIQIY LLM chaqiruvi qilinmagan.**
  `ANTHROPIC_API_KEY` yo'q. Ya'ni promptlar, o'zbek tilidagi javob sifati,
  kechikish va haqiqiy narx — **tekshirilmagan farazlar**. Butun mahsulotning
  sifati shu noma'lumga bog'liq.
- Ikkinchi to'siq: `../sales-copilot` repo'si yo'q, shuning uchun vendor
  `profileSchema` va `withTenant` tipi asosiy repo bilan solishtirilmagan.
- Docker ishlamaydi (socket ruxsati yo'q) — DB lokal PostgreSQL 16 klasteri
  bilan ko'tarildi; `npm run db:up` hozircha bu mashinada ishlamaydi.

---

## 1. Muhit

| Narsa | Qiymat |
| --- | --- |
| OS | Linux 7.0.0-42-generic, x86_64 |
| Node | v24.21.0 |
| npm | 11.19.0 |
| Paket tartibi | npm workspaces: root `package.json` → `workspaces: ["harness"]`. `module/` da `package.json` **yo'q** (dep'lar root'dan hoist qilinadi) |
| Postgres (testlarda) | **16.15** (lokal `/usr/lib/postgresql/16/bin`, vaqtinchalik klaster) |
| Postgres (rejada) | `harness/docker-compose.yml` → **postgres:18**, port 55433 |
| Docker | **ishlamaydi** — `docker ps` → "permission denied ... /var/run/docker.sock" |
| `../sales-copilot` | **YO'Q** (`/home/umidjon/sales-copilot` mavjud emas) |
| `psql` klient | 16.15 |

**Eslatma:** bu muhitda `tsx` CLI unix-pipe yarata olmaydi (sandbox), shuning
uchun skriptlar `node --import tsx/esm <fayl>` bilan ishga tushirildi. Oddiy
mashinada `npm run ...` (ya'ni `tsx`) ishlashi kerak — buni tasdiqlab
bo'lmadi, **aniq emas**.

---

## 2. Git

7 ta commit, ishchi daraxt **toza** (`git status --short` → 0 qator).

```
5c87c93  Step 2b: model bake-off (ko'r taqqoslash asboblari)
f765d18  Step 4 Phase B: React sahifalar (mashq, suhbat, debrief, tarix)
adeaabb  Step 4 Phase A: baholash (scoring) backend
66bb778  Step 3 Phase A: ovoz benchmark asboblari (o'lchov, qurilish emas)
1de25e6  Step 2: matnli AI mijoz motori (deterministik yadro + LLM)
05ecf4e  Step 2: deterministik holat mashinasi va persona-card   <-- almashtirilgan
78f2b8f  Step 1: AI mijoz trenajyori poydevori (standalone drop-in modul)
```

- `05ecf4e` — Step 2 prompt fayli kelishidan oldin yozilgan improvizatsiya;
  `1de25e6` uni butunlay almashtirgan (state/engine/persona qayta yozilgan).
- Remote **yo'q** (lokal repo).
- `.env` git'da **ignore qilingan**: `.gitignore:3:.env` → `harness/.env`
  (`git check-ignore -v` bilan tasdiqlandi). `harness/bakeoff/out/`,
  `harness/benchmark/out/`, `*.wav`, `node_modules/`, `dist/` ham ignore'da.

---

## 3. Qadamlar bo'yicha holat

Papkadagi spetsifikatsiya fayllari: `claude-code-prompt-step1-v2.md`,
`-step2.md`, `-step2b-model-bakeoff.md`, `-step3.md`, `-step4.md`.
**Step 5 uchun prompt fayli YO'Q.**

### Step 1 — poydevor (commit `78f2b8f`)

| Vazifa | Holat | Dalil | Izoh |
| --- | --- | --- | --- |
| Arxetiplar (zod + 4 konstanta) | bajarildi | `module/backend/src/training/archetypes.ts`: `archetypeSchema`, `ARCHETYPES`, `getArchetype()` | test: "archetype ... archetypeSchema dan o'tadi" |
| `ARCHETYPES` = `archetypes.json` | bajarildi | test: "ARCHETYPES === archetypes.json (drift yo'q)" | drift avtomatik ushlanadi |
| Ports (4 chok) | bajarildi | `training/ports.ts`: `TrainingContext`, `TrainerLlm`, `WithTenant`, `GetBusinessProfile` | Step 4 da `PriceCall`, `TrainingTx` qo'shildi |
| Vendor `profileSchema` | qisman | `training/profile-schema.ts` (`SYNC WITH ...` sarlavhasi bor) | asosiy repo yo'qligi uchun **solishtirilmagan** (test skip) |
| `demo-profiles.json` ko'chirish | bajarildi | `training/demo-profiles.json` (3 profil) | |
| DB sxema (2 jadval) | bajarildi | `db/schema/training.ts`, `integration/training.sql` | Step 4 da 3-jadval qo'shildi |
| `rls-training.sql` | bajarildi | `integration/rls-training.sql` | 5.3-bo'limga qarang |
| Harness (docker, bootstrap, withTenant) | bajarildi | `harness/docker-compose.yml`, `db/bootstrap.sql`, `src/withTenant.ts` | docker bu mashinada ishlamaydi |
| `verify-training.ts` + RLS testi | bajarildi | 22 ok / 1 skip | |
| `INTEGRATION.md` | bajarildi | `module/integration/INTEGRATION.md` (~400 qator) | 9-bo'limdagi eskirgan TODO'larga qarang |
| `git init` + commit | bajarildi | `78f2b8f` | |

### Step 2 — matnli AI mijoz motori (commit `1de25e6`)

| Vazifa | Holat | Dalil | Izoh |
| --- | --- | --- | --- |
| A. `personaCardSchema` | bajarildi | `persona.ts`: `personaCardSchema`, `makePersonaCardSchema` | `focusOffer` profildan, e'tiroz soni/severity, `hiddenNeed` iff — hammasi zod'da |
| A. `generatePersonaCard` + 1 retry | bajarildi | `persona.ts:generatePersonaCard`, `PersonaGenerationError` | test: "focusOffer profilda bo'lmasa: retry, keyin PersonaGenerationError" |
| A. `direction` `mixed` → random | bajarildi | `persona.ts:resolveDirection` | |
| B. `TrainingState` + `initState` | bajarildi | `state.ts:trainingStateSchema`, `initState` | |
| B. `applyTurnResult` (clamp, decay, flags) | bajarildi | `state.ts:applyTurnResult` | test guruhi [1] (7 test) |
| B. `computeReadiness` | bajarildi | `state.ts:computeReadiness` | |
| B. `evaluateEnd` | bajarildi | `state.ts:evaluateEnd` | imzosi chetlangan — 8-bo'lim |
| C. `prompts.ts` + `PROMPT_VERSION` | bajarildi | `prompts.ts:PROMPT_VERSION = 'training-v1'`, `TRANSCRIPT_WINDOW = 12` | |
| C. turn-result zod sxemasi | bajarildi | `state.ts:turnResultSchema` | |
| C. `createTrainingEngine` (4 metod) | bajarildi | `engine.ts:createTrainingEngine` | `startSession`/`takeTurn`/`endSession`/`getSession` |
| C. Agreement guard + 1 retry | bajarildi | `state.ts:isGuardViolation`, `engine.ts` guard bloki | test: "guard: qoidasiz 'agrees' -> bitta retry -> g'alaba YO'Q" |
| C. Bo'shliqsiz `seq` + qulf | bajarildi | `repo.ts:getSessionForUpdate` (`for update`), `nextSeq` | test: "seq bo'shliqsiz, state_after yoziladi" |
| D. `llm-anthropic.ts` | bajarildi | `harness/src/llm-anthropic.ts`, `TRAINER_MODEL`, default `claude-haiku-5-5` | **haqiqiy model bilan sinalmagan** |
| D. `play.ts` (terminal chat) | bajarildi (sinalmagan) | `harness/src/play.ts`, `npm run play` | kalit yo'qligi uchun ishga tushirilmagan |
| D. `smoke-llm.ts` | bajarildi (sinalmagan) | `harness/src/smoke-llm.ts` | injection satri bor |
| D. `calibrate.ts` (ixtiyoriy) | bajarildi (sinalmagan) | `harness/src/calibrate.ts` | faqat typecheck |
| E. Testlar (8 guruh) | bajarildi | `verify-training-core.ts` — **50 ok** | FakeTrainerLlm |
| E. Soha so'zlari skaneri | bajarildi | test: "module/ ichidagi kodda soha so'zi yo'q" | `.ts` va `.tsx` |
| F. Hujjatlar | bajarildi | `INTEGRATION.md` 4b bo'lim, `README.md` | |

### Step 2b — model bake-off (commit `5c87c93`)

| Vazifa | Holat | Dalil | Izoh |
| --- | --- | --- | --- |
| `bakeoff.config.json` (kodda emas) | bajarildi | `harness/bakeoff.config.json` | haiku + sonnet yoqilgan; Gemini/Groq/GLM namunalari `enabled:false` |
| `openai-compatible` adapter | bajarildi (sinalmagan) | `harness/src/llm-openai-compatible.ts` | JSON rejimi yoki prompt+1 retry; haqiqiy endpoint bilan sinalmagan |
| Sotuvchi: careless/skilled/injection | bajarildi | `harness/src/seller-bot.ts`, `INJECTION_SCRIPT` | injection — LLM'siz skript (8-bo'lim) |
| Matritsa + narx tasdiqi | bajarildi | `harness/src/bakeoff.ts:buildPlan`, `estimateCost` | `--yes`, `--n`, `--profile`, `--only` |
| Resume (`runs.jsonl`) | bajarildi | `bakeoff.ts:loadExistingRuns` | test guruhi [3] |
| O'lchovlar | bajarildi | `bakeoff/metrics.ts:summarizeCandidate` | JSON, guard, g'alaba, p50/p90, token, narx/100 sessiya, uzunlik, til |
| `report.html` + ko'r baholash | bajarildi | `bakeoff/report-html.ts:buildReportHtml` | soxta ma'lumot bilan sinab ko'rildi |
| `bakeoff-score.ts` + tavsiya | bajarildi | `bakeoff/score.ts:rankCandidates`, `recommend` | injection g'alabasi → diskvalifikatsiya |
| Testlar | bajarildi | `harness/src/verify-bakeoff.ts` — **33 ok** | |
| `bakeoff/README.md` | bajarildi | `harness/bakeoff/README.md` | |
| **Pulli bake-off ishga tushirish** | **boshlanmagan** | `harness/bakeoff/out/` papkasi yo'q | prompt talab qilgan (odam boshlaydi) |

### Step 3 — ovoz

**Phase A (o'lchov asboblari) — commit `66bb778`:**

| Vazifa | Holat | Dalil | Izoh |
| --- | --- | --- | --- |
| STT/TTS portlari | bajarildi | `training/voice/ports.ts`: `SttPort`, `TtsPort`, `VOICE_AUDIO`, `VOICE_LIMITS` | |
| WAV tekshiruvi | bajarildi | `training/voice/wav.ts`: `parseWav`, `checkWav` | qo'lda sinaldi; **rasmiy test YO'Q** |
| Azure STT + TTS | bajarildi (sinalmagan) | `harness/src/voice/azure.ts` | kalit yo'q |
| Google STT (sinxron) + TTS | bajarildi (sinalmagan) | `harness/src/voice/google.ts` | `longrunningrecognize` ataylab ishlatilmagan |
| GigaAM (ixtiyoriy 3-chi) | boshlanmagan | — | `../sales-copilot` yo'q |
| Benchmark matnlari | bajarildi | `benchmark/sentences.uz.txt` (15), `customer-lines.uz.txt` (12) | |
| Recorder sahifa + server | bajarildi | `harness/web/record.html`, `src/record-server.ts` | HTTP darajasida sinaldi (415/200/404) |
| `bench-stt.ts` (WER/CER) | bajarildi (sinalmagan) | `harness/src/bench-stt.ts`, `voice/text-metrics.ts` | WER/CER qo'lda sinaldi |
| `bench-tts.ts` + `listen.html` | bajarildi (sinalmagan) | `harness/src/bench-tts.ts:buildListenHtml` | |
| `benchmark/README.md` | bajarildi | `harness/benchmark/README.md` | |
| **Benchmark ishga tushirish** | **boshlanmagan** | `benchmark/out/` va `samples/` **bo'sh** | kalit yo'q |
| O'zbek ovozlari mavjudligini API bilan tasdiqlash | **boshlanmagan** | `bench-voices.ts` yozilgan, lekin ishga tushirilmagan | Google TTS'da o'zbek ovozi bor-yo'qligi **aniq emas** |

**Phase B (ovozli mashq) — butunlay boshlanmagan:**

| Vazifa | Holat | Dalil |
| --- | --- | --- |
| B1. `training_turn.meta jsonb` | boshlanmagan | `integration/training.sql` da ustun yo'q |
| B2. `voice/speech-text.ts` (`normalizeForSpeech`) | boshlanmagan | fayl yo'q (raqam→so'z mantig'i hozircha `harness/src/voice/numbers.ts` da) |
| B2. `voice/voice-turn.ts` (`takeVoiceTurn`) | boshlanmagan | fayl yo'q |
| B3. `POST /voice-turn` route | boshlanmagan | `routes.ts:430` da TODO chok |
| B4. Harness web sahifa (push-to-talk) | boshlanmagan | `harness/web/` da faqat `record.html` (benchmark uchun) |
| B5. Kechikish ishi | boshlanmagan | o'lchanmagan |
| B6. `verify:training:voice` | boshlanmagan | skript yo'q |

### Step 4 — baholash + UI

**Phase A (commit `adeaabb`):**

| Vazifa | Holat | Dalil |
| --- | --- | --- |
| A1. `getPlaybook` porti + `PlaybookSubset` | bajarildi | `scoring/rubric.ts:playbookSubsetSchema`, `scoring.ts:GetPlaybook` |
| A1. `DEFAULT_TRAINING_RUBRIC` (7 mezon, 100 vazn) | bajarildi | test: "vaznlar yig'indisi aynan 100", "har mezonda 0-3 uchun to'rtta tavsif" |
| A2. `metrics.ts` (deterministik) | bajarildi | `scoring/metrics.ts:computeMetrics` |
| A2. Muhim lahza nomzodlari (max 8) | bajarildi | `scoring/metrics.ts:keyMomentCandidates`, `MAX_KEY_MOMENTS = 8` |
| A3. `scoring-prompts.ts` (`scoring-v1`) | bajarildi | `scoring/scoring-prompts.ts` |
| A3. `verifyEvidence` (qattiqroq qoidalar) | bajarildi | `scoring/evidence.ts` — test guruhi [2] (9 test) |
| A3. `skillScore` formulasi | bajarildi | `scoring/scoring.ts:computeSkillScore` — test: "null baho NOLGA aylanmaydi" |
| A3. 40%+ yiqilsa retry → `quality:'low'` | bajarildi | test: "dalillar yiqilsa: bitta retry, keyin quality=low" |
| A3. `< 3 navbat` → `insufficient` | bajarildi | test: "kam mazmun -> insufficient, LLM chaqirilmaydi" |
| A4. `training_result` jadvali + RLS | bajarildi | `integration/training.sql`, `rls-training.sql` |
| A5. `createScoringService` + versiyalash | bajarildi | test: "qayta baholash yangi versiya qo'shadi, eskisi qoladi" |
| A5. Route'lar (8 ta) | bajarildi | `training/routes.ts` — 5.4-bo'lim |
| A5. Sessiya tugaganda avtomatik baholash | bajarildi | `routes.ts:scoreInBackground`, `config.autoScoreOnEnd` (default `true`) |
| A6. Testlar | bajarildi | `verify-training-scoring.ts` — **39 ok** |

**Phase B (commit `f765d18`):**

| Vazifa | Holat | Dalil |
| --- | --- | --- |
| B1. Asosiy repo konventsiyalari | **imkonsiz** | `../sales-copilot/frontend` yo'q → React + oddiy CSS |
| B2. Harness Vite qobiq + `npm run dev` | bajarildi | `harness/frontend/`, `harness/src/dev.ts` |
| B3. Mashq (bosh) sahifa | bajarildi | `module/frontend/src/pages/MashqPage.tsx` |
| B3. Jonli sessiya sahifasi | bajarildi | `pages/SessionPage.tsx` (+ `VoiceControls` sloti) |
| B3. Natija (debrief) | bajarildi | `pages/NatijaPage.tsx` — ball, metrikalar, grafik, mezon+dalil, maslahat, yashirin kartalar |
| B3. Tarix / Taraqqiyot | bajarildi | `pages/TarixPage.tsx` |
| B4. A11y, bo'sh/xato holatlar | qisman | `aria-*`, `mq-sr-only`, skeleton bor; **rasmiy a11y audit yo'q** |
| B5. Frontend testlar | bajarildi (shartli) | runner yo'q → `verify:frontend` = typecheck + build; QA ro'yxati `README.md` da |
| B6. Hujjatlar | bajarildi | `INTEGRATION.md` 4e bo'lim |

**Phase C (ovozni React'ga ulash): o'tkazib yuborildi** — Step 3 Phase B
yo'qligi sababli. Dalil: `module/frontend/src/components/VoiceControls.tsx:8`
(TODO ro'yxati), `INTEGRATION.md` TODO bandi.

### Step 5

Prompt fayli papkada **yo'q**, hech narsa boshlanmagan.

---

## 4. Testlar va build

Hammasi lokal PostgreSQL 16 klasteri bilan, **haqiqiy LLM chaqirilmasdan**.

| Skript | O'tdi | Xato | Skip | Izoh |
| --- | --- | --- | --- | --- |
| `verify:training` | 22 | 0 | 1 | skip sababi: `/home/umidjon/sales-copilot/backend/src/business/profile.ts` topilmadi |
| `verify:training:core` | 50 | 0 | 0 | |
| `verify:training:scoring` | 39 | 0 | 0 | |
| `verify:training:bakeoff` | 33 | 0 | 0 | |
| **Jami** | **144** | **0** | **1** | ~6 soniya (DB tayyorlashsiz) |

- `tsc --noEmit` (backend, `harness/tsconfig.json` + `../module/backend/**`): **exit 0**
- `tsc -p frontend/tsconfig.json` (`../../module/frontend/**`): **exit 0**
- `vite build`: **muvaffaqiyatli** — `index.html` 0.41 kB, CSS 6.78 kB,
  JS 176.99 kB (gzip 55.55 kB), 436 ms

`SKIP_DB=1` bilan DB'siz ham ishlaydi (u holda RLS/engine/route testlari skip bo'ladi).

**Qamrovdagi bo'shliq:** `module/backend/src/training/voice/*` (ports, wav)
uchun **rasmiy test yo'q** — faqat typecheck va qo'lda tekshiruv.

---

## 5. Arxitektura (hozirgi kod bo'yicha)

### 5.1 Fayl daraxti

```
module/                                  # FAQAT shu papka teammate'larga beriladi
  backend/src/db/schema/
    training.ts            trainingSession, trainingTurn, trainingResult (Drizzle)
    host-tables.ts         business/app_user/seat minimal e'loni (integratsiyada O'CHIRILADI)
  backend/src/training/
    archetypes.ts  state.ts  prompts.ts  persona.ts  engine.ts  repo.ts
    ports.ts  errors.ts  profile-schema.ts  routes.ts  demo-profiles.json
    scoring/   rubric.ts metrics.ts evidence.ts scoring-prompts.ts
               scoring.ts scoring-types.ts repo.ts
    voice/     ports.ts wav.ts                      # Step 3B uchun tayyorgarlik
    testing/   assert.ts fake-llm.ts
    verify-training.ts  verify-training-core.ts  verify-training-scoring.ts
  frontend/src/
    TrainingApp.tsx  index.ts  styles.css
    pages/      MashqPage NatijaPage SessionPage TarixPage
    components/ Coaching CriteriaList HiddenCards StateChart Transcript ui VoiceControls
    lib/api.ts  lugat/mashq.ts
  integration/ INTEGRATION.md  training.sql  rls-training.sql

harness/                                 # hech qachon berilmaydi
  src/  apply-sql withTenant server dev demo-env demo-llm play smoke-llm calibrate
        llm-anthropic llm-openai-compatible seller-bot record-server
        bench-stt bench-tts bench-voices bakeoff bakeoff-report bakeoff-score
        verify-bakeoff
        voice/ azure google locales numbers registry text-metrics benchmark-data
        bakeoff/ config types metrics shuffle excerpts report-html score
  frontend/ index.html src/main.tsx vite.config.ts tsconfig.json
  web/record.html   db/{bootstrap,grants}.sql   docker-compose.yml
  benchmark/{README.md,sentences.uz.txt,customer-lines.uz.txt,out/,samples/}
  bakeoff/README.md   bakeoff.config.json
```

Hajmi: `module/` ~9 392 qator TS/TSX, `harness/` ~5 756 qator.

### 5.2 Portlar va sxemalar (verbatim)

```ts
// module/backend/src/training/ports.ts
export interface TrainingContext { businessId: string; userId: string; seatId: string | null; }

export interface TokenUsage { inputTokens: number; outputTokens: number; model?: string; }

export interface TrainerLlmRequest<T> {
  stage: string; system: string; user: string;
  schema: { parse: (input: unknown) => T };
}
export interface TrainerLlm {
  completeJson<T>(req: TrainerLlmRequest<T>): Promise<T>;
  completeJsonWithUsage?<T>(req: TrainerLlmRequest<T>): Promise<{ value: T; usage: TokenUsage }>;
}

export type TrainingTx = PgTransaction<
  PgQueryResultHKT, Record<string, never>, ExtractTablesWithRelations<Record<string, never>>>;

export type WithTenant<TTx = TrainingTx> =
  <R>(businessId: string, fn: (tx: TTx) => Promise<R>) => Promise<R>;

export type GetBusinessProfile = (businessId: string) => Promise<BusinessProfile | null>;
export type PriceCall = (usage: TokenUsage) => number;

// module/backend/src/training/scoring/scoring.ts
export type GetPlaybook = (businessId: string) => Promise<PlaybookSubset | null>;

// module/backend/src/training/voice/ports.ts
export type VoiceLang = 'uz' | 'ru' | 'mixed';
export const VOICE_AUDIO = { mime: 'audio/wav', sampleRate: 16_000, channels: 1, bitsPerSample: 16 };
export const VOICE_LIMITS = { maxDurationSec: 30, maxBytes: 2 * 1024 * 1024, minDurationSec: 0.3 };
export const LATENCY_BUDGET = { medianMs: 4_000, p90Ms: 6_000 };
export interface SttPort { transcribeShort(req: SttRequest): Promise<SttResult>; }
export interface TtsPort { synthesize(req: TtsRequest): Promise<TtsResult>; }
```

```ts
// archetypes.ts
export const ARCHETYPE_KEYS = ['ready_buyer', 'negotiator', 'problematic', 'info_seeker'] as const;
export const archetypeSchema = z.object({
  key, title, description: z.string().min(1),
  intent: z.enum(['wants_to_buy', 'just_info']),
  difficulty: z.number().int().min(1).max(5),
  initialState: { patience, trust, interest: 0..100 },
  objections: { count: 0..10, severityMax: 1..5 },
  hiddenNeed: z.boolean(),
  needRevealTriggers: z.array(z.string()).optional(),
  win: { type: 'agree'|'agree_or_next_step'|'need_discovered_and_agree',
         minTrust: 0..100, requireObjectionsResolved: boolean,
         acceptedNextSteps?: string[] },
  lose: { patienceBelow: 0..100 },
  maxTurns: 1..100,
  behaviorRules: z.array(z.string()).min(1),
});

// state.ts
export const trainingStateSchema = z.object({
  patience, trust, interest,                       // 0..100 int
  flags: { objectionsRaised: string[], objectionsResolved: string[],
           needRevealed: boolean, guardViolations: int },
  promptVersion: z.string().min(1),
});
export const turnResultSchema = z.object({
  reply: z.string().min(1).max(300),
  intent: z.enum(['continue','agrees','agrees_next_step','refuses','ends_call']),
  deltas: { patience, trust, interest },           // int -20..20
  objectionRaisedKey: z.string().nullable(),
  objectionsResolvedKeys: z.array(z.string()),
  needRevealed: z.boolean(),
  nextStep: z.string().nullable(),
});

// persona.ts
export const personaCardSchema = z.object({
  name, age (14..99), role, speakingStyle,
  language: 'uz'|'ru'|'mixed', direction: 'inbound'|'outbound',
  situation, goal, focusOffer,                      // focusOffer: profile.primaryOffers dan AYNAN bitta
  objections: [{ key: snake_case, text, severity: 1..5 }],   // 1..10 ta
  hiddenFacts: string[1..3], hiddenNeed: string|null, openingLine: <=300,
});
```

```ts
// Xizmatlarning ommaviy imzolari
export interface TrainingEngine {
  startSession(ctx, input: { archetypeKey; direction?; language? }): Promise<StartSessionResult>;
  takeTurn(ctx, input: { sessionId; sellerText }): Promise<TakeTurnResult>;
  endSession(ctx, input: { sessionId; reason }): Promise<void>;
  getSession(ctx, input: { sessionId }): Promise<GetSessionResult>;
}
export interface ScoringService {
  scoreSession(ctx, sessionId): Promise<ScoreSessionResult>;
  getLatestResult(ctx, sessionId): Promise<TrainingResultRow | null>;
  getLatestAnyResult(ctx, sessionId): Promise<TrainingResultRow | null>;
}
// Sof funksiyalar: initState, applyTurnResult, computeReadiness, evaluateEnd,
// isGuardViolation, recordGuardViolation (state.ts);
// computeMetrics, keyMomentCandidates (scoring/metrics.ts);
// verifyEvidence, normalizeForEvidence (scoring/evidence.ts);
// computeSkillScore, processLlmScoring (scoring/scoring.ts);
// parseWav, checkWav (voice/wav.ts)
```

### 5.3 DB

Manba: `module/integration/training.sql` (ma'lumot uchun; teammate'lar
migratsiyani o'z drizzle-kit'i bilan qayta generatsiya qiladi).

**`training_session`** — RLS: **bor**

| Ustun | Tip | Null | Izoh |
| --- | --- | --- | --- |
| id | uuid pk | yo'q | `gen_random_uuid()` |
| business_id | uuid | yo'q | FK `business(id)` cascade |
| user_id | uuid | yo'q | FK `app_user(id)` cascade |
| seat_id | uuid | **ha** | FK `seat(id)` set null |
| archetype_key | text | yo'q | CHECK: 4 kalit |
| persona_card | jsonb | **ha** | `PersonaCard` |
| state | jsonb | yo'q | `TrainingState` |
| status | text | yo'q | CHECK `active|ended|abandoned`, default `active` |
| outcome | text | **ha** | CHECK `won|lost|timeout` |
| end_reason | text | **ha** | |
| turn_count | integer | yo'q | default 0 (sotuvchi navbatlari) |
| cost_usd | numeric(12,6) | yo'q | default 0 |
| started_at / ended_at | timestamptz | yo'q / **ha** | |

Indeks: `training_session_business_user_started_idx (business_id, user_id, started_at desc)`

**`training_turn`** — RLS: **bor**

| Ustun | Tip | Null | Izoh |
| --- | --- | --- | --- |
| id | bigserial pk | yo'q | |
| session_id | uuid | yo'q | FK cascade |
| business_id | uuid | yo'q | FK cascade |
| seq | integer | yo'q | unique bilan `(session_id, seq)` |
| speaker | text | yo'q | CHECK `seller|customer` |
| text | text | yo'q | **aynan saqlanadi** (dalil tekshiruvi shunga tayanadi) |
| state_after | jsonb | **ha** | holat + `meta` (latencyMs, intent, usage) |
| created_at | timestamptz | yo'q | |

**`training_result`** (Step 4) — RLS: **bor**

| Ustun | Tip | Null | Izoh |
| --- | --- | --- | --- |
| id | uuid pk | yo'q | |
| business_id / session_id | uuid | yo'q | FK cascade |
| version | integer | yo'q | unique `(session_id, version)` — **versiyalash** |
| status | text | yo'q | CHECK `pending|done|failed` |
| quality | text | yo'q | CHECK `ok|low|insufficient` |
| skill_score | numeric(5,1) | **ha** | `null` = baholanmadi (nol EMAS) |
| criteria / metrics / coaching / key_moments | jsonb | **ha** | |
| model / prompt_version / error | text | **ha** | |
| cost_usd | numeric(12,6) | yo'q | default 0 |
| created_at | timestamptz | yo'q | |

Indeks: `training_result_business_session_idx (business_id, session_id, version desc)`

**RLS:** uchala jadval uchun ham `enable` + `force row level security` va
`<table>_tenant_isolation` siyosati
(`business_id = nullif(current_setting('app.business_id', true), '')::uuid`).
`nullif` ataylab: `set_config(..., true)` commit'dan keyin GUC'ni bo'sh satrga
qaytaradi va `''::uuid` xato beradi (izoh `rls-training.sql:43-51`).

**Ustun YO'Q:** `training_turn.meta jsonb` (Step 3 Phase B talab qiladi).

### 5.4 HTTP route'lar

Prefiks: `/api/v1/training` (sozlanadi). Hammasi `registerTrainingRoutes()` da.

| Metod | Yo'l | Ruxsat | So'rov → javob |
| --- | --- | --- | --- |
| GET | `/archetypes` | `training:use` | — → `{archetypes:[{key,title,description,difficulty,intent,maxTurns}]}` |
| POST | `/sessions` | `training:use` | `{archetypeKey, direction?, language?}` → `{sessionId, archetype, persona(QISQA), openingLine}` |
| GET | `/sessions` | `training:use` | — → `{sessions:[{id,archetypeKey,status,outcome,turnCount,startedAt,skillScore,...}]}` |
| GET | `/sessions/:id` | `training:use` | — → `{transcript, persona, revealed(faqat tugagach), debug?}` |
| POST | `/sessions/:id/turn` | `training:use` | `{text}` → `{customerReply, ended, outcome, endReason, turnCount, debug?}` |
| POST | `/sessions/:id/end` | `training:use` | `{reason?}` → `{ok:true}` (+ avto baholash) |
| POST | `/sessions/:id/score` | `training:use` | `{}` → **202** `{status:'pending'}` |
| GET | `/sessions/:id/result` | `training:use` | — → `{result:{version,status,quality,skillScore,criteria,metrics,coaching,keyMoments}, transcript, revealed}` |
| GET | `/me/stats` | `training:use` | — → `{totalSessions, winRateByArchetype, skillScoreTrend, avgSkillScore, weakestCriteria}` |
| GET | `/stats?userId=` | `training:view:all` | — → yuqoridagidek |

Xato xaritasi (`routes.ts:STATUS_BY_CODE`): `session_not_found` **404**,
`session_forbidden` **404** (ataylab 403 emas), `session_not_active` 409,
`profile_missing` 409, `persona_generation_failed` / `llm_invalid_output` 502,
zod xatosi 400, auth xatosi 401, rate-limit 429.

### 5.5 Frontend

Router kutubxonasi yo'q — `TrainingApp` ichida ko'rinish almashinadi
(`home | session | result | history`), host router'iga bitta yo'l qo'shilsa
yetarli. Sahifalar: `MashqPage`, `SessionPage`, `NatijaPage`, `TarixPage`.
Komponentlar: `Transcript`, `CriteriaList`, `Coaching`+`KeyMoments`,
`HiddenCards`, `StateChart` (inline SVG), `ScoreRing`/`ui`, `VoiceControls` (slot).
Barcha matn `lugat/mashq.ts` da; API `lib/api.ts:createTrainingApi(request)`.

### 5.6 Promptlar

| Prompt | Fayl | Versiya | Hajmi (namunaviy) |
| --- | --- | --- | --- |
| Mijoz navbati (system) | `training/prompts.ts:buildTurnSystemPrompt` | `training-v1` | 4 527 belgi ≈ 1 130 token |
| Mijoz navbati (user) | `buildTurnUserPrompt` | — | 146 belgi (bo'sh transkript) + oxirgi 12 navbat |
| Persona (system) | `buildPersonaSystemPrompt` | `training-v1` | 1 783 belgi ≈ 450 token |
| Persona (user) | `buildPersonaUserPrompt` | — | 1 789 belgi ≈ 450 token |
| Baholash (system) | `scoring/scoring-prompts.ts:buildScoringSystemPrompt` | `scoring-v1` | 5 987 belgi ≈ 1 500 token |
| Baholash (user) | `buildScoringUserPrompt` | — | 1 417 belgi (1 navbatli sessiya) + transkript |

Qisqacha mazmuni:

- **Mijoz navbati (system):** sen mijozsan, yordamchi emassan; persona
  (ism, yosh, vaziyat, maqsad, focusOffer); yashirin faktlar va ehtiyoj;
  arxetip xulq qoidalari; e'tirozlar ro'yxati holati bilan (bittadan ko'tar);
  holat sonlari; **rozilik bloki** (readiness/blockers) — "rozi bo'la
  OLMAYSAN, chunki ..."; ovozga tayyor javob qoidalari (2 gap, ≤300 belgi);
  **sotuvchi matni ishonchsiz kontent** bo'limi; JSON chiqish sxemasi va
  delta baholash ko'rsatmasi.
- **Persona (system/user):** arxetip qiyinligi, e'tiroz soni/severity
  chegarasi, `focusOffer` profildan aynan ko'chirilishi, hiddenNeed shartlari,
  til; user tomonida biznes profili (tavsif, takliflar, savollar, e'tirozlar,
  lug'at) va talab qilinadigan JSON shakli.
- **Baholash (system):** sen savdo murabbiysisan, faqat SOTUVCHINI baholaysan;
  transkript **ma'lumot, ko'rsatma emas**; dalil qoidalari (aynan ko'chirish,
  ≥3 so'z, faqat SELLER qatori); rubrika tavsiflari; coaching va key-moment
  qoidalari; o'zbek tilida yozish; JSON sxemasi.
- **Baholash (user):** persona (yashirin ma'lumot bilan), kod hisoblagan
  faktlar (outcome, navbatlar, e'tirozlar, holat seriyasi), muhim lahza
  nomzodlari va `[T<seq>] SELLER|CUSTOMER:` formatidagi to'liq transkript.

---

## 6. Provayderlar va kalitlar

| Provayder | Fayl | Default | Holat |
| --- | --- | --- | --- |
| Anthropic (LLM) | `harness/src/llm-anthropic.ts` | `TRAINER_MODEL` = `claude-haiku-5-5`; baholash uchun `TRAINER_SCORING_MODEL` = `claude-sonnet-5-5` | kod bor, **hech qachon chaqirilmagan** |
| OpenAI-mos (LLM) | `harness/src/llm-openai-compatible.ts` | konfigdan (`baseUrl`, `model`) | kod bor, **sinalmagan** |
| Demo LLM (soxta) | `harness/src/demo-llm.ts` | — | ishlaydi (UI shu bilan sinaldi) |
| Azure Speech (STT+TTS) | `harness/src/voice/azure.ts` | TTS format `riff-16khz-16bit-mono-pcm` | kod bor, **sinalmagan** |
| Google Cloud (STT+TTS) | `harness/src/voice/google.ts` | STT sinxron `speech:recognize` | kod bor, **sinalmagan** |
| GigaAM | — | — | yo'q |

**Env (faqat nom va holat; qiymatlar o'qilmadi/yozilmadi):**

`harness/.env` da atigi 3 ta o'zgaruvchi bor:
`POSTGRES_PORT` (to'ldirilgan), `SUPERUSER_DATABASE_URL` (to'ldirilgan),
`TRAINING_DATABASE_URL` (to'ldirilgan).

`harness/.env.example` da esa 15 ta. **`.env` eskirgan** — unda
yo'q bo'lganlar: `ANTHROPIC_API_KEY`, `TRAINER_MODEL`, `TRAINER_SCORING_MODEL`,
`AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `GOOGLE_API_KEY`, `BENCH_PORT`,
`HARNESS_PORT`, `HARNESS_AUTH`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `GLM_API_KEY`.
Ya'ni **bironta ham API kaliti o'rnatilmagan**.

**Benchmark / bake-off natijalari:** `harness/benchmark/out/` — **bo'sh**,
`harness/benchmark/samples/` — **bo'sh**, `harness/bakeoff/out/` — **mavjud emas**.
Ya'ni hech qanday o'lchov natijasi yo'q.

---

## 7. Nimani hozir sinab ko'rsa bo'ladi

| Maqsad | Buyruq | Holat |
| --- | --- | --- |
| DB (docker) | `npm run db:up` | **to'silgan** — docker socket ruxsati yo'q. Yechim: `sudo usermod -aG docker $USER` + qayta kirish; yoki `README.md` dagi lokal klaster yo'li |
| DB sxemasi | `npm run db:init` | **ishlaydi** (DB ko'tarilgan bo'lsa) |
| Hamma testlar | `npm run verify` | **ishlaydi** — 144 ok / 1 skip + frontend build |
| Typecheck | `npm run typecheck` | **ishlaydi** |
| Matnli chat (terminal) | `npm run play -- --archetype negotiator --profile o_quv_markaz --debug` | **to'silgan** — `ANTHROPIC_API_KEY` yo'q (`play` demo LLM'ga tushmaydi, xato beradi) |
| Web UI (to'liq oqim) | `npm run dev` → <http://127.0.0.1:5181> | **ishlaydi** — kalitsiz **demo LLM** bilan; brauzerda sinab ko'rilgan |
| Backend alohida | `npm run serve` | **ishlaydi** (demo LLM bilan) |
| Haqiqiy model bilan smoke | `npm run smoke:llm` | **to'silgan** — kalit yo'q |
| Kalibrlash | `npm run calibrate -- --sessions 5` | **to'silgan** — kalit yo'q |
| Ovoz: ovozlar ro'yxati | `npm run bench:voices` | **to'silgan** — Azure/Google kaliti yo'q |
| Ovoz: yozib olish | `npm run bench:record` → <http://127.0.0.1:5174> | **ishlaydi** (kalit kerak emas) |
| Ovoz: STT/TTS benchmark | `npm run bench:stt` / `bench:tts` | **to'silgan** — kalit yo'q (+ avval namuna yozish kerak) |
| Ovozli mashq (push-to-talk) | — | **yo'q** — Step 3 Phase B bajarilmagan |
| Model bake-off | `npm run bakeoff` | **to'silgan** — kalit yo'q |
| Bake-off hisoboti | `npm run bakeoff:report` | natija fayli yo'q → xato beradi |

---

## 8. Spetsifikatsiyadan chetlanishlar

| # | Chetlanish | Sabab / dalil |
| --- | --- | --- |
| 1 | Ildizda `package.json` (npm workspaces) qo'shilgan — Step 1 layout'ida yo'q edi | `module/` `harness/` yonida turgani uchun `node_modules` ildizda bo'lmasa modul `zod`/`pg` ni topa olmaydi |
| 2 | `module/backend/src/db/schema/host-tables.ts` qo'shilgan | Drizzle FK'lari uchun `business/app_user/seat` obyektlari kerak; integratsiyada o'chiriladi (fayl sarlavhasida yozilgan) |
| 3 | `TrainerLlm` ga ixtiyoriy `completeJsonWithUsage` qo'shilgan | `cost_usd` uchun token kerak; majburiy metod o'zgarmagani uchun asosiy repo `LlmClient` i hamon mos (`ports.ts` izohi) |
| 4 | Anthropic klientida retry YO'Q (Step 2 D "zod + bitta retry" degan) | Engine'da allaqachon bitta tuzatuvchi retry bor; ikkalasi birga "navbatiga 1 (+1) chaqiruv" qoidasini buzardi (`llm-anthropic.ts` sarlavha izohi) |
| 5 | `evaluateEnd` imzosi obyekt qabul qiladi va `persona` ham oladi | readiness persona e'tirozlarini bilishi shart (`state.ts:EvaluateEndInput`) |
| 6 | `takeTurn` LLM chaqiruvini DB tranzaksiyasi ICHIDA bajaradi | Step 3 spetsifikatsiyasi "in one transaction" talab qilgan; xavfi 9-bo'limda |
| 7 | Baholash LLM chaqiruvi tranzaksiyadan TASHQARIDA | uzoq tahlil chaqiruvi qulfni ushlab turmasligi uchun (`scoring.ts` izohi) |
| 8 | `verify:training:bakeoff` `harness/src/` da (module'da emas) | bake-off butunlay harness asbobi; `module/` toza qoldi |
| 9 | Bake-off `injection` skripti LLM'siz, qat'iy matn | hamma nomzod aynan bir xil hujumni olsin va arzon bo'lsin (`seller-bot.ts` izohi) |
| 10 | `harness/src/demo-llm.ts` — spetsifikatsiyada yo'q | kalitsiz UI/QA qilish uchun; faqat harness, provayderga ulanmaydi |
| 11 | Step 4 Phase C bajarilmagan | Step 3 Phase B yo'q (shartli bo'lim, prompt ruxsat bergan) |
| 12 | Step 3 Phase A da GigaAM o'lchanmagan | `../sales-copilot` yo'q |
| 13 | Taqiqlangan soha so'zlari ro'yxatiga `guruh`, `sertifikat` qo'shilgan | demo profil lug'atidan kelib chiqib kuchaytirildi |
| 14 | Testlar PostgreSQL **16** da (compose'da 18) | docker ishlamadi; SQL'da 18-ga xos narsa yo'q, lekin **18 da sinalmagan** |
| 15 | Ushbu muhitda skriptlar `node --import tsx/esm` bilan ishga tushirildi | sandbox `tsx` CLI'ning unix-pipe'ini bloklaydi; `package.json` dagi buyruqlar o'zgarmagan |

---

## 9. Muammolar va xavflar

| Daraja | Muammo | Dalil | Ta'siri |
| --- | --- | --- | --- |
| **yuqori** | **Hech qachon haqiqiy LLM chaqirilmagan.** Promptlar, o'zbek javob sifati, kechikish (4s/6s byudjeti), haqiqiy narx — tekshirilmagan | `.env` da kalit yo'q; `benchmark/out`, `bakeoff/out` bo'sh | Mahsulot sifati butunlay noma'lum; `maxTokens`, prompt uzunligi, guard'ning amaldagi ishlashi sinalmagan |
| **yuqori** | Vendor `profileSchema` asosiy repo bilan solishtirilmagan | `verify-training` skip | Integratsiyada maydon nomi/optional farqi chiqishi mumkin |
| **yuqori** | O'zbek uchun STT/TTS mavjudligi API bilan tasdiqlanmagan (ayniqsa Google TTS) | `bench-voices.ts` ishga tushirilmagan | Step 3B ni rejalashtirish mumkin emas |
| **o'rta** | `takeTurn` LLM chaqiruvi davomida sessiya qatori `for update` bilan qulflanadi | `repo.ts:getSessionForUpdate`, `engine.ts` | Sekin model → uzoq qulf; parallel yuklamada 409/timeout. Spetsifikatsiya talabi, lekin yuklama ortsa bo'linishi kerak |
| **o'rta** | `harness/.env` eskirgan (12 ta o'zgaruvchi yetishmaydi) | 6-bo'lim | `npm run serve` jimgina **demo LLM**ga tushadi — foydalanuvchi haqiqiy model ishlayapti deb o'ylashi mumkin (banner bor, lekin terminalda) |
| **o'rta** | `allowDebug` yoqilsa holat sonlari va blockers javobga tushadi; harness'da `true` | `routes.ts`, `server.ts:config` | Prod'da yoqilsa mashqning "javoblari" ochiladi. INTEGRATION.md da ogohlantirish bor |
| **o'rta** | Rate-limit xotirada, bitta process uchun | `routes.ts:createRateLimiter` | Ko'p instansiyali prod'da ishlamaydi; almashtirish kerak (hujjatda bor) |
| **o'rta** | `module/` da `package.json` yo'q, bog'liqliklar yashirin (`zod`, `drizzle-orm`, `pg`, `fastify` tiplari, `react`) | `ls module/package.json` → yo'q | Teammate'lar ko'chirganda qaysi versiyalar kerakligi noaniq |
| **o'rta** | `host-tables.ts` o'chirilmasa, drizzle-kit host jadvallari uchun ham migratsiya generatsiya qiladi | `db/schema/host-tables.ts` | INTEGRATION.md 3-bo'limda yozilgan, lekin avtomatik tekshiruv yo'q |
| **past** | `module/backend/src/training/voice/*` uchun rasmiy test yo'q | `verify*` skriptlarida yo'q | Step 3B da `verify:training:voice` qo'shilishi kerak |
| **past** | `INTEGRATION.md` oxirida **eskirgan TODO'lar**: "TODO (Step 4): STT/TTS", "TODO (Step 5): baholash/scoring va frontend" — ikkalasi ham allaqachon bajarilgan yoki boshqa qadamga tegishli | `module/integration/INTEGRATION.md:396-397` | O'quvchini chalg'itadi |
| **past** | `rls-training.sql` izohi "quyidagi **ikki** nomni qo'shing" deydi, lekin uchta nom sanalgan; pastda ham "shu **ikki** jadval" | `rls-training.sql:7` va `:16` | `training_result` RLS'siz qolib ketishi mumkin |
| **past** | `verify-training-scoring.ts` `fastify` ni runtime import qiladi (modul qolgan joyda faqat tip sifatida ishlatadi) | fayl boshidagi `import Fastify from 'fastify'` | Test fayli uchun normal, lekin modul "SDK'siz" qoidasiga chegara |
| **past** | Transkript `GET /sessions/:id` da to'liq qaytadi (limitsiz) | `routes.ts` → `getRecentTurns(tx, id, 1000)` | Juda uzun sessiyada katta javob |

**Tenant izolyatsiyasi va yashirin ma'lumot — tekshirilgan joylar:**
RLS uchala jadvalda; boshqa tenant → **404**; boshqa foydalanuvchi → **404**;
`revealed` (yashirin ehtiyoj, faktlar, e'tiroz rejasi) faqat
`status !== 'active'` bo'lganda yuboriladi (`routes.ts`, test: "yashirin
kartalar faqat tugagandan keyin"). `POST /sessions` javobida persona faqat
`{name, age, role, direction, openingLine}`.
**Qolgan xavf:** `allowDebug` va kelajakdagi yangi route'lar — har yangi
endpoint uchun shu tekshiruv qayta qilinishi kerak.

---

## 10. Ochiq savollar

1. **API kalitlari kim beradi va qachon?** Ularsiz Step 2/2b/3 ning hech bir
   o'lchov qismi bajarilmaydi va mahsulot sifati noma'lumligicha qoladi.
2. **Model bake-off'ni kim va qanday budjet bilan o'tkazadi?** (taxminan $3–4,
   `--n 1` bilan ~$1). Natijasiz "qaysi model" savoli ochiq.
3. **Ovoz benchmarki (Step 3A) o'tkaziladimi?** O'zbek tili uchun qaysi
   STT/TTS ishlashi hozircha hujjatga ham, API'ga ham tayanmagan taxmin.
4. **`../sales-copilot` repo'si qachon shu mashinaga qo'yiladi?** Bu bo'lmasa
   `profileSchema` sinxronligi, `withTenant` tipi va `rls.sql` pattern'i
   tekshirilmaydi.
5. **Asosiy repodagi `rls.sql` `nullif(...)` pattern'ini ishlatadimi?** Agar
   yo'q bo'lsa, u yerda ham xuddi shu xato bor (hujjatda ogohlantirilgan).
6. **Baholash `analysis_job` navbatiga ko'chiriladimi** yoki fon rejimida
   qolaveradimi? Bu route'ning shartnomasiga ta'sir qilmaydi, lekin prod'da
   muhim.
7. **Docker masalasi hal qilinadimi** (`usermod -aG docker`), yoki harness
   lokal klaster yo'liga o'tkaziladimi?
8. **Step 5 bormi va u nima?** Prompt fayli yo'q.
9. **Qo'shib yuborish (handoff) qachon?** Qaysi branch, kim ko'chiradi,
   `host-tables.ts` va `profile-schema.ts` ni kim o'chiradi?
