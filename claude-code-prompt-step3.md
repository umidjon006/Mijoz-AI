# Claude Code prompt — Step 3: voice (push-to-talk), with a mandatory benchmark gate

Run in the same project folder as Steps 1–2. Save this file there and tell Claude Code: "Read `claude-code-prompt-step3.md` fully and execute **Phase A only**, then stop."

---

## Context

Steps 1–2 are done (module/harness layout, DB tables, RLS, archetypes, persona generation, deterministic engine `createTrainingEngine`, `play` terminal chat, deterministic tests). **Read the actual Step 1–2 code first** (`module/integration/INTEGRATION.md`, `module/backend/src/training/*`, `harness/*`) and adapt to the real interfaces — do not assume names from this prompt. Before anything else run all verify scripts; **if any fail, stop and report** (do not start Step 3 on a broken base).

Goal of Step 3: the seller **talks** to the AI customer in Uzbek using **push-to-talk** (hold/toggle a button, no always-on listening), the customer answers with **synthesized speech**, and every turn is stored as **text** in `training_turn` (the audio itself is NOT stored).

Voice quality for Uzbek is the biggest unknown of this project. Therefore: **Phase A measures first; Phase B builds only after the human has chosen providers.**

## Hard rules

- Keep the module/harness boundary: `module/` contains provider-independent code and **ports** only; provider SDKs/HTTP clients live in `harness/` (teammates will plug in the main repo's own STT or a cloud one). `module/` never imports `harness/`.
- The main repo (`../sales-copilot`, if present) is read-only. Reading its STT code (`backend/src/ai/stt.ts`, `calls/gigaam-xizmat.ts`) for ideas is fine. Note: its `GoogleStt` uses `longrunningrecognize` (async, too slow for a live turn) — do not reuse that mode here.
- Never print, log or commit API keys. Keys live in `harness/.env` (`.env.example` lists the variable names only): `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `GOOGLE_API_KEY` (add others only if needed).
- **Do not assume** which languages/voices/scripts a provider supports. Query the provider (e.g. voices-list endpoints) and record what you find. Uzbek can be written in Latin or Cyrillic script — find out empirically which script each TTS handles best and whether a transliteration step is needed.
- Audio is never persisted and never logged. No temp files left behind.
- All human-facing text (README, reports, INTEGRATION.md additions) in Uzbek; code identifiers in English; code comments in Uzbek where earlier steps do that.

---

## PHASE A — benchmark tooling (then STOP)

Latency budget for later: end of seller speech → start of customer audio **≤ 4 s median, ≤ 6 s p90** for the whole chain (STT + engine LLM + TTS). Measure each stage.

1. **Ports** (`module/backend/src/training/voice/ports.ts`): 
   - `SttPort.transcribeShort({ audio: Buffer, mime: 'audio/wav', lang: 'uz'|'ru'|'mixed', hints?: string[] }) → { text, confidence?: number, latencyMs, raw?: unknown }`
   - `TtsPort.synthesize({ text, lang, voice?: string }) → { audio: Buffer, mime: string, latencyMs, firstByteMs? }`
   Utterances are short (≤ 30 s). Input format is 16 kHz, mono, 16-bit PCM WAV (the browser will produce exactly this, see Phase B, so no ffmpeg dependency).
2. **Candidate providers** in `harness/src/voice/`:
   - STT: Azure Speech short-audio REST (`uz-UZ`), Google Cloud Speech-to-Text **synchronous** `speech:recognize` (`uz-UZ`). Optional third: the main repo's local GigaAM (only if `../sales-copilot` exists and runs on this machine) — measure it too, it is the "free" option.
   - TTS: Azure neural voices for Uzbek (list them via the API and test all that exist). Check whether Google TTS has an Uzbek voice via its voices list; include it only if it does. If neither is usable, report that clearly instead of forcing it.
3. **Benchmark data**: `harness/benchmark/sentences.uz.txt` — 15 realistic sales-call sentences for a *seller* in Uzbek (Latin script), varied length 3–20 words, including: prices ("bir million ikki yuz ming so'm"), digits, phone-style numbers, a few Russian loanwords, product/brand-like names, and a question. Also `harness/benchmark/customer-lines.uz.txt` — 12 typical *customer* replies (short, spoken style, with numbers and objections).
4. **Recording helper**: a tiny page `harness/web/record.html` + harness endpoint that shows one sentence at a time, records the human with the browser (hold button), encodes **16 kHz mono 16-bit PCM WAV client-side** (Web Audio API; no server-side conversion), and saves to `harness/benchmark/samples/NN.wav`. Chrome desktop is the target; the page must say "use headphones" (echo) and show a clear mic-level indicator.
5. **`harness/src/bench-stt.ts`**: for every provider × sample compute latency, WER and CER against the reference sentence (normalize: lowercase, strip punctuation, unify the apostrophes `'`, `ʻ`, `‘`, `’`, `` ` ``). Print a table and write `harness/benchmark/out/stt-results.json`. Estimate and print the cost before calling paid APIs; make the sample count configurable.
6. **`harness/src/bench-tts.ts`**: synthesize each customer line with every voice/provider (and with both Latin and Cyrillic script if the provider might prefer one), measure total latency and first-byte latency, save audio files under `harness/benchmark/out/tts/<provider>/<voice>/NN.<ext>`, and generate `harness/benchmark/out/listen.html` — a page with all clips side by side and 1–5 rating inputs (naturalness, clarity of numbers) that exports a CSV. **You cannot judge audio quality yourself — say so and leave the rating to the human.**
7. **`harness/benchmark/README.md`** (Uzbek): step-by-step for the human: set keys → run the recorder → run `bench-stt` → run `bench-tts` → listen and rate → send the results back.
8. Commit. **STOP.** Final report (Uzbek): what was built, which providers/voices actually exist for Uzbek (facts you verified via API, not assumptions), what keys the human must obtain, exact commands, estimated cost of one full benchmark run. **Do not start Phase B.**

---

## PHASE B — voice pipeline (start ONLY when the user's next message names the chosen STT and TTS providers/voice and may include benchmark numbers)

### B1. Data model

Add `meta jsonb` (nullable) to `training_turn` (STT provider, STT confidence, STT/LLM/TTS timings, audio duration). Update the Drizzle schema, the reference SQL and `INTEGRATION.md` (teammates regenerate their own migration). Never store audio bytes.

### B2. Voice turn in the module

- `module/.../voice/speech-text.ts`: `normalizeForSpeech(text, lang)` — expands digits, prices, percentages and phone-like numbers into **Uzbek words** (e.g. `1 200 000 so'm` → "bir million ikki yuz ming so'm"), applies the script conversion the benchmark showed is needed (if any), and strips anything not speakable. Unit-test thoroughly (numbers 0–999 999 999, mixed text, edge cases).
- `module/.../voice/voice-turn.ts`: `createVoiceTurn({ engine, stt, tts, getBusinessProfile, config })` → `takeVoiceTurn(ctx, { sessionId, audio, mime })`:
  1. validate mime (WAV only) and size/duration limits; STT with `hints` built from `profile.vocabulary` and the offer names;
  2. **low confidence / empty text → "ask to repeat"**: the customer says a fixed, persona-language "sorry, I didn't hear you, could you repeat?" line (TTS, **no LLM call, no state change**), `needsRepeat: true`; allow at most 2 repeat requests per session, then proceed with whatever transcript exists. Threshold configurable (`STT_MIN_CONFIDENCE`);
  3. otherwise `engine.takeTurn(ctx, { sessionId, sellerText })`, then `normalizeForSpeech` → TTS;
  4. return `{ sellerText, customerText, audio (Buffer), audioMime, timings: { sttMs, llmMs, ttsMs, totalMs }, needsRepeat, ended, outcome? }` and persist `meta` on both turns.
  - Also `speakOpeningLine(ctx, { sessionId })` for inbound sessions where the customer speaks first.
  - A second voice/text turn arriving while one is in flight for the same session → reject with a typed conflict error (HTTP 409). Use a DB-level guard (session row lock or equivalent), not only an in-process flag.

### B3. HTTP routes (module, Fastify plugin)

`registerTrainingRoutes(app, deps)` with **injected** `getContext(req) → TrainingContext`, `authorize(ctx, permission)`, `engine`, `voice`. Permissions used (to be added to the main repo's `permissions.ts` by teammates — list them in INTEGRATION.md): `training:use`, `training:view:all`. Routes under `/api/v1/training`:
- `POST /sessions` `{ archetypeKey, direction? }` → session + persona summary (name, role — **not** hidden facts/objections) + opening line (text + audio if inbound);
- `GET /sessions/:id`, `GET /sessions` (own sessions; all only with `training:view:all`);
- `POST /sessions/:id/turn` `{ text }` (text fallback);
- `POST /sessions/:id/voice-turn` (raw `audio/wav` body, max ~2 MB / 30 s) → JSON with the fields above, audio as base64;
- `POST /sessions/:id/end`.
Per-user rate limit, body-size limit, correct 4xx codes (415 wrong mime, 413 too large, 404 for another tenant's session — never 403), zod validation. The persona's hidden facts, objections list and state numbers are **never** sent to the client unless `debug` is allowed by an injected flag (harness only).

### B4. Harness web page

`harness/web/index.html` (vanilla JS, no build step; the real React page is Step 4): choose archetype and profile → start → hold-to-talk button (also spacebar) → shows both sides' text live, timings per stage, and (debug mode only) the state numbers/blockers; plays the customer audio; "text fallback" input; headphones warning. Harness-only fake auth via env `HARNESS_AUTH=1` (header-based dev user) — must be impossible to enable from `module/`.

### B5. Optional latency work — only if measured p50 > 4 s

Measure first. Then evaluate (and report numbers for) in this order: shorter prompts / smaller `max_tokens`; parallelising the STT-independent work; streaming TTS (first-byte playback); sentence-level TTS pipelining. Implement only what the numbers justify.

### B6. Tests (deterministic, no real providers)

Fake `SttPort`/`TtsPort`. Cover: `normalizeForSpeech`; low-confidence → repeat path without state change and the 2-repeat cap; full voice turn persists text + `meta` and **no audio**; session ownership and tenant isolation through the routes (other tenant → 404); wrong mime/oversize rejected; concurrent turn → 409; hidden persona data absent from responses; no API keys in logs. Add `verify:training:voice` to the aggregate verify. Update `INTEGRATION.md` (ports to implement, permissions, env, how to plug the main repo's STT) and `README.md`. Commit.

## Final report (in Uzbek)

(1) files created/changed; (2) verify results (passed/failed/skipped + reasons); (3) real measured latency per stage and total if keys were available (otherwise say so); (4) anything uncertain or any choice the prompt did not cover; (5) known limits (e.g. Uzbek STT accuracy on numbers, echo without headphones).
