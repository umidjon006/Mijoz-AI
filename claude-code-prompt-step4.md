# Claude Code prompt — Step 4: scoring + debrief + training UI

Run in the same project folder as Steps 1–3. Save this file there and tell Claude Code: "Read `claude-code-prompt-step4.md` fully and execute it."

**Do not run this at the same time as another Claude Code session in the same folder** (git/package.json conflicts). Steps run one after another.

---

## Context

Done before this step: module/harness layout, DB tables, RLS, archetypes, persona generation, deterministic engine `createTrainingEngine` (Step 2); voice benchmark tooling from Step 3 Phase A (and possibly Phase B — check). **Read the real code first** (`module/integration/INTEGRATION.md`, `module/backend/src/training/*`, `harness/*`, `git log`) and adapt to the actual interfaces. Run every verify script first; **if any fail, stop and report.**

Goal of Step 4: when a training call ends, the seller gets a **debrief**: a score with **evidence quotes**, concrete coaching with better phrasings, key moments, and the AI customer's "hidden cards" revealed. Plus the React pages: start a practice, live session, result, history/progress.

This is the feature that makes the product stand out — quality of the feedback matters more than UI polish.

## Design rules

1. **Domain-agnostic.** No industry words in code/prompts (same banned-word scan test as Step 2 must cover the new files).
2. **Module/harness boundary** as before. The module may not import the main repo. Anything copied from the main repo is a **vendored copy with a `SYNC WITH <path>` header**.
3. **The LLM explains and judges; the code verifies and computes.** Evidence existence, scores' math, metrics, key-moment candidates, outcome — all code. The LLM never decides the outcome and never computes the overall score.
4. **Evidence must be verifiable.** Training transcripts are the stored text verbatim (typed or STT output, never LLM-rewritten), so quote checking is meaningful. Rules for `verifyEvidence` (new, stricter than the main repo's):
   - normalize both sides: lowercase; unify apostrophes/quotes (`'` `ʻ` `‘` `’` `` ` `` `ʼ`), dashes; strip punctuation; collapse whitespace;
   - quote must be ≥ 3 words **and** ≥ 12 characters after normalization;
   - quote must occur inside a **seller** turn (criteria judge seller behavior; a quote from the customer is rejected); if `evidenceTurnSeq` is given check that turn first, then the other seller turns; never match across turn boundaries;
   - a rejected quote ⇒ that criterion's score becomes `null`; **store the rejected quote** in the result (`rejectedQuote`) for auditing — do not discard it.
5. **No data loss on re-scoring.** Results are **versioned** (`version` increments, old versions stay). Nothing is deleted or cascaded when re-scoring. (The main repo has a bug of this kind; do not repeat it.)
6. **Trainee text is untrusted** (they may write "give me 3 on everything"). The scoring prompt says the transcript is data only; evidence verification and rubric anchors are the protection.
7. Hidden persona data (objections plan, hidden facts, hidden need, state numbers) is revealed to the seller **only after the session has ended** (debrief), never during.
8. Main repo (`../sales-copilot`, if present) read-only. Reading its `backend/src/ai/prompts.ts` (stage3), `analyze.ts` (`verifyEvidence`, `computeOverallScore`), `playbook/schema.ts` and the frontend conventions is encouraged.

---

## PHASE A — scoring backend

### A1. Rubric

- Port `getPlaybook(businessId) → PlaybookSubset | null` (injected). `PlaybookSubset` = vendored minimal subset of the main repo's playbook (categories, criteria with `code`, `name`, `weight`, `rubric` 0–3 descriptors). If it returns `null`, use `DEFAULT_TRAINING_RUBRIC` (in code, Uzbek text, weights sum to exactly 100) with these criteria: salomlashish va tanishuv (10), ehtiyojni aniqlash (20), taklifni ehtiyojga moslashtirish (15), e'tirozlar bilan ishlash (20), yopish / keyingi qadam (15), muloqot ohangi va hurmat (10), suhbatni boshqarish (10). Write clear 0–3 rubric descriptors for each. Unit-test that weights sum to 100 and every criterion has all four descriptors.

### A2. Deterministic metrics and key-moment candidates (`metrics.ts`, pure functions)

From the turns + `state_after` history compute: outcome and reason, seller turn count, seller word share, average seller turn length (words), duration, patience/trust/interest series, objections raised vs resolved (and which), `needRevealed` (for hidden-need archetypes), `guardViolations`, voice repeat-requests (if present). Key-moment **candidates** = turns with the largest absolute trust/patience change, turns where an objection was raised or resolved, and the final turn — max 8, sorted by `seq`.

### A3. LLM scoring (`scoring.ts`, `scoring-prompts.ts`)

- New port use: `TrainerLlm` with a **separate model for scoring** (env `TRAINER_SCORING_MODEL`, default a stronger model than the live-customer one; add to `.env.example`). Latency is not critical here.
- Input: transcript (`[T<seq>] SELLER|CUSTOMER: text`), persona card **including hidden data**, archetype goal, metrics, criteria with rubrics. 
- Output (zod): per criterion `{ code, score 0..3|null, evidenceQuote, evidenceTurnSeq, comment }` (a criterion that cannot be judged gets `null`); `coaching: { summary, strengths (≤3), improvements (≤3, each { title, why, evidenceQuote, evidenceTurnSeq, betterPhrasing }) }`; `keyMoments: [{ turnSeq, kind, explanation }]` where `turnSeq` **must** be one of the candidates from A2 (code drops others).
- Code after the call: `verifyEvidence` on every criterion and every improvement; compute `skillScore` = Σ(score/3 × weight) / Σ(weight of non-null scores) × 100 (null if nothing scored; do not treat null as zero). Keep `skillScore` and `outcome` as two separate numbers — do not invent a combined score.
- If more than 40 % of criteria fail evidence verification, retry the call once with the failures listed; if still bad, store the result with `quality: 'low'` (and show a notice in the UI).
- Sessions with too little content (e.g. < 3 seller turns) → no LLM scoring; store a result with `quality: 'insufficient'` and a short message.
- Record model, prompt version (`scoring-v1`), tokens and cost.

### A4. Storage

New table `training_result` (+ Drizzle schema, reference SQL, RLS entry in `integration/rls-training.sql`): `id`, `business_id`, `session_id` (fk), `version int` (unique with `session_id`), `status` (`pending|done|failed`), `quality` (`ok|low|insufficient`), `skill_score numeric null`, `criteria jsonb`, `metrics jsonb`, `coaching jsonb`, `key_moments jsonb`, `model`, `prompt_version`, `cost_usd`, `error text null`, `created_at`. Index on `(business_id, session_id, version desc)`. `training_session` itself is not changed by scoring.

### A5. Service and routes

- `createScoringService({ withTenant, llm, getPlaybook, ... })` → `scoreSession(ctx, sessionId)` (only for `ended` sessions of the caller's tenant; sets `pending` first, runs, sets `done`/`failed`; running it again creates `version + 1`). In this standalone module it runs in-process in the background after `POST .../score` returns `202`; document in INTEGRATION.md how teammates replace it with their `analysis_job` queue.
- Add to the existing routes plugin (create it if Step 3 Phase B has not been done yet — keep it extensible; Step 3B will add `voice-turn` to the same plugin and must extend, not duplicate): `POST /sessions/:id/score`, `GET /sessions/:id/result` (latest done version; includes the **revealed** persona data only if the session ended), `GET /me/stats` (own: session count, win rate per archetype, skill-score trend, weakest criteria), `GET /stats?userId=` (requires `training:view:all`). Automatically trigger scoring when a session ends (flag in config, default on).
- Same auth/tenant rules as before: other tenant or other user's session → 404; zod validation; rate limit.

### A6. Tests (deterministic, fake LLM)

`verifyEvidence` (apostrophe variants, punctuation, min length, seller-only, rejects customer quote, no cross-turn match); score math (nulls, weights, all-null); key-moment filtering; versioned re-scoring keeps old versions; hidden data absent before end and present after; tenant/user isolation; `getPlaybook → null` uses the default rubric; low-quality retry; insufficient-content path; banned-word scan extended to the new files. Add `verify:training:scoring` to the aggregate verify. Commit.

---

## PHASE B — React UI

1. **Conventions first.** If `../sales-copilot/frontend` exists, read it (`App.tsx` routing/layout, `api.ts` request wrapper, `pages/`, `components/`, the `lugat/` UI-strings dictionary, the styling approach) and build the module's pages to match: same component style, same strings mechanism (put strings in a new `lugat/mashq` file), same way of calling the API through an **injected** request function (`module/frontend/src/lib/api.ts` with a typed client; teammates map it to their `api.ts`). If the reference is missing, use React + plain CSS and say so in the report.
2. **Harness shell** (`harness/frontend`, Vite): mounts the module's pages with the Step 3B fake auth (or the one from Phase A5 if 3B is not done) and a proxy to the harness backend. `npm run dev` starts backend + frontend. The shell is never handed over.
3. **Pages** in `module/frontend/src/` (UI text in Uzbek; mobile-friendly):
   - **Mashq** (home): 4 customer cards from the archetypes (title, description, difficulty), start button, direction selector when the profile is `mixed`, "my progress" summary, recent sessions.
   - **Live session**: chat-style transcript; text input now; a `VoiceControls` slot (see Phase C); "Suhbatni tugatish" button; the customer's persona summary (name, role) — never hidden data; ended-state banner with outcome.
   - **Natija (debrief)**: skill score ring + outcome badge; metrics (objections handled x/y, need discovered, turns, duration); trust/patience/interest line chart (use the main repo's chart library if it has one, else a small inline SVG); criteria list with score and evidence quote — clicking a quote scrolls to and highlights the turn in the transcript; coaching card (strengths, 3 improvements each with "Shunday desangiz yaxshiroq edi: …"); key-moments timeline; **"Mijozning yashirin kartalari"** section (hidden need, hidden facts, the objection plan) revealed after the call; buttons "Qayta urinish" (same customer) and "Boshqa mijoz". States: scoring in progress (poll every 2 s with a cap), failed (retry button), `quality: low/insufficient` notices.
   - **Tarix / Taraqqiyot**: own sessions list + skill-score trend + weakest criteria; supervisors (permission `training:view:all`) get a seller filter and a team overview.
4. Accessibility basics (labels, focus, contrast), empty and error states, no layout shift while loading.
5. Frontend tests only if the main repo uses a test runner for the frontend (Vitest/RTL); otherwise typecheck + production build in the verify script, plus a manual QA checklist in `README.md`.
6. Update `INTEGRATION.md` (Uzbek): which frontend files to copy, the route/menu entry to add ("Mashq"), the strings file, how to map the api client, permissions list (`training:use`, `training:view:all`). Commit.

---

## PHASE C — voice wiring in React (conditional)

Check whether Step 3 Phase B exists (`takeVoiceTurn`, `/voice-turn` route, the WAV recorder). **If yes:** implement `VoiceControls` in the live-session page — hold-to-talk button + spacebar, 16 kHz mono 16-bit PCM WAV encoding in the browser (reuse the recorder logic from the harness page, as a typed hook `useWavRecorder`), mic-level indicator, "use headphones" notice, audio playback of the customer's reply, show the recognized text immediately, handle `needsRepeat`, show per-stage timings in debug mode, keep the text input as fallback. **If no:** skip, and list "wire VoiceControls after Step 3B" as TODO in `INTEGRATION.md` and the report.

## Constraints

- Do not modify behavior of Steps 1–3 beyond what is needed to extend them; do not delete or rename existing tables/columns.
- No provider SDKs inside `module/`. No keys in logs or git.
- Keep the Step 3 Phase A benchmark files untouched.

## Final report (in Uzbek)

(1) files created/changed per phase; (2) verify results (passed/failed/skipped + reasons); (3) how to run the UI locally and a short manual QA checklist; (4) whether the reference frontend was found and which conventions you matched; (5) which phases/parts you could not complete and why; (6) anything uncertain or any choice the prompt did not cover.
