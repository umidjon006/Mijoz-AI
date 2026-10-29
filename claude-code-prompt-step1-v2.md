# Claude Code prompt — Step 1 (v2): standalone "AI Customer Trainer" module

This replaces `claude-code-prompt-step1.md`. Use this one.

Before running: create an empty folder `sotuv-trener/` on your laptop. Put `archetypes.json` and `demo-profiles.json` inside it. If you have a local clone of the company repo, place it NEXT TO the new folder (`../sales-copilot`) as a **read-only reference**. Run Claude Code from inside `sotuv-trener/`.

---

## Context

We are building an **AI customer simulator for sales training** (sellers practice, by voice later, against an AI customer). It will eventually be merged into an existing multi-tenant SaaS (`sales-copilot`: Fastify + Drizzle + PostgreSQL with RLS + zod + React/Vite). **We must NOT work inside that repo and must NOT push to its GitHub.** We build a **standalone, drop-in module** on this laptop, fully working on its own, then hand the module folder to teammates who copy it into the main repo.

This is **Step 1 of 5: foundation only**. No endpoints, no LLM calls, no STT/TTS, no scoring, no frontend yet.

## Design rules (important)

1. **Drop-in module.** Everything teammates will copy lives in `module/`. Everything that only exists to run it locally lives in `harness/` and is never handed over. Keep the boundary strict: `module/` must not import anything from `harness/`.
2. **Same stack and conventions as the main repo** (TypeScript strict, Fastify 5, Drizzle ORM, PostgreSQL 18, zod, ESM/NodeNext as the main repo does). If `../sales-copilot` exists, **read** its conventions (`backend/package.json`, `backend/src/db/schema/*.ts`, `backend/src/db/rls.sql`, `backend/src/db/index.ts` `withTenant`, a `verify-*.ts` test, `backend/src/ai/llm.ts` `LlmClient` interface, `backend/src/business/profile.ts`). **Never modify it.** If it does not exist, follow the same stack and say so in the report.
3. **Domain-agnostic.** No industry-specific words in code or prompts (the product serves training centers, taxi, food delivery, anything with salespeople). Domain facts come from a tenant's `business.profile` (`profileSchema`).
4. **Deterministic logic lives in code, not in the LLM** (state, win/lose rules) — that is Step 2.
5. **Do not store training sessions in the main `conversation` table.** Separate tables only.
6. **Integration seams** — the module must receive everything from the outside through small interfaces, so teammates can plug in the real implementation in minutes:
   - `TrainingContext = { businessId: string; userId: string; seatId: string | null }` (passed in by the host app's auth, never read from globals).
   - `TrainerLlm` port: same shape as the main repo's `LlmClient` (`completeJson({ stage, system, user, schema })`) so the host can adapt its `getActiveLlm()` 1:1.
   - DB access through a `withTenant`-style function injected by the host (`withTenant(businessId, (tx) => ...)`).
   - Business profile loaded through an injected function `getBusinessProfile(businessId)`.

## Target layout

```
sotuv-trener/
  README.md                      # how to run locally (harness) + what is the module
  module/                        # <- ONLY this folder is handed to teammates
    backend/src/training/
      archetypes.ts              # zod schema + 4 archetypes (typed constants)
      demo-profiles.json         # copied from ../demo-profiles.json (tests/dev only)
      ports.ts                   # TrainingContext, TrainerLlm, injected function types
      profile-schema.ts          # vendored copy of main repo profileSchema (see note)
      verify-training.ts
    backend/src/db/schema/training.ts
    integration/
      INTEGRATION.md             # what to copy, where, what to wire (grow it each step)
      rls-training.sql           # lines teammates add to rls.sql tenant_tables + policies note
      training.sql               # reference SQL for the two tables (teammates will REGENERATE
                                 #   their migration with their own drizzle-kit; do not number it
                                 #   like the main repo's migrations to avoid conflicts)
  harness/                       # local-only scaffolding, NEVER handed over
    docker-compose.yml           # postgres:18 on a non-default port
    db/bootstrap.sql             # restricted app role (NOT superuser, so RLS really applies),
                                 #   stub tables business/app_user/seat with the same names and key
                                 #   columns the module's FKs reference
    package.json, tsconfig.json, drizzle.config.ts, .env.example
```

## Tasks

1. **Archetypes** (`module/backend/src/training/archetypes.ts`): zod `archetypeSchema` matching `archetypes.json` exactly (key, title, description, intent `wants_to_buy|just_info`, difficulty 1–5, initialState {patience,trust,interest} 0–100, objections {count,severityMax}, hiddenNeed boolean, optional needRevealTriggers string[], win {type, minTrust, requireObjectionsResolved, optional acceptedNextSteps}, lose {patienceBelow}, maxTurns, behaviorRules string[]). Export `ARCHETYPES` (embed the 4 archetypes as typed constants; do not read the JSON at runtime), `ArchetypeKey`, `getArchetype(key)`. Archetype text stays Uzbek (Latin).
2. **Ports** (`ports.ts`): the interfaces from design rule 6, with short Uzbek comments explaining each seam.
3. **Profile schema** (`profile-schema.ts`): vendored copy of the main repo's `profileSchema` with a header comment "SYNC WITH backend/src/business/profile.ts — replace this file with an import from the main repo during integration". Add a check in verify that, **if** `../sales-copilot` exists, the two schemas accept/reject the same sample inputs.
4. **Demo profiles**: copy `demo-profiles.json` into the module folder (placeholder data; real data will replace it).
5. **DB schema** (`module/backend/src/db/schema/training.ts`, Drizzle, same style as the main repo's schema files):
   - `training_session`: id uuid pk, business_id (fk business), user_id (fk app_user), seat_id nullable (fk seat), archetype_key text CHECK in the 4 keys, persona_card jsonb nullable (Step 2), state jsonb not null (patience/trust/interest + flags), status text CHECK in (`active`,`ended`,`abandoned`), outcome nullable CHECK in (`won`,`lost`,`timeout`), end_reason nullable, turn_count int default 0, cost_usd numeric default 0, started_at, ended_at nullable. Index (business_id, user_id, started_at desc).
   - `training_turn`: id bigserial pk, session_id fk (on delete cascade), business_id, seq int, speaker text CHECK in (`seller`,`customer`), text not null, state_after jsonb nullable, created_at. Unique (session_id, seq).
   - Write `integration/rls-training.sql` with the table names to add to the main repo's hand-maintained `tenant_tables` array in `rls.sql` (the main repo does **not** protect a tenant table unless it is in that list), plus the policy pattern used there.
6. **Harness**: docker-compose Postgres, bootstrap that creates the restricted app role and stub tables, apply the module's SQL, and a tiny `withTenant` implementation for tests that mirrors the main repo's approach (`set_config('app.business_id', ..., true)` inside a transaction).
7. **Verification** (`verify-training.ts`, plain `tsx`-runnable script in the same style as the main repo's `verify-*.ts`; add an npm script `verify:training` in `harness/package.json`):
   - 4 archetypes pass `archetypeSchema`; keys unique;
   - each demo profile passes the vendored `profileSchema`;
   - **RLS isolation**: rows created under business A are invisible under business B through the restricted role, and are not readable without `withTenant`.
8. **INTEGRATION.md** (Uzbek): list what to copy and where, the four seams from design rule 6 and how to wire each to the main repo's real functions, the `rls.sql` step, "regenerate migration with your drizzle-kit", and a checklist. Mark sections for later steps as "TODO (Step N)".
9. Run typecheck and `verify:training`. Fix problems.

## Constraints

- Do not touch `../sales-copilot` in any way (read-only reference).
- `module/` must have no dependency on `harness/`.
- No LLM/STT/TTS code, no routes, no frontend in this step.
- Run `git init` inside `sotuv-trener/` (local only; no remote) and make a first commit at the end.

## Final report (in Uzbek)

Report **in Uzbek**: (1) the created file tree, (2) how to start the local DB and run the verify script, (3) verify results (passed/failed counts), (4) whether `../sales-copilot` was found and what conventions you copied from it, (5) anything you were unsure about, deviated from, or that conflicted with these instructions.
