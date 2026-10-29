-- ============================================================================
-- training.sql — MA'LUMOT UCHUN (reference) SQL.
--
-- Bu fayl asosiy repo migratsiyasi EMAS va raqamlanmagan (0001_... kabi emas) —
-- shunday qilingani uchun sizning migratsiya ketma-ketligingiz bilan
-- to'qnashmaydi. Asosiy repoga ko'chirganda:
--
--   1. `backend/src/db/schema/training.ts` ni ko'chirib qo'ying;
--   2. migratsiyani O'Z drizzle-kit'ingiz bilan QAYTADAN generatsiya qiling
--      (`npm run db:generate` yoki repoda qanday bo'lsa);
--   3. generatsiya natijasini shu fayl bilan solishtirib tekshiring.
--
-- Lokal harness esa aynan shu faylni qo'llaydi (drizzle-kit'siz).
-- ============================================================================

create table if not exists training_session (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references business (id) on delete cascade,
  user_id         uuid not null references app_user (id) on delete cascade,
  seat_id         uuid references seat (id) on delete set null,
  archetype_key   text not null,
  persona_card    jsonb,
  state           jsonb not null,
  status          text not null default 'active',
  outcome         text,
  end_reason      text,
  turn_count      integer not null default 0,
  cost_usd        numeric(12, 6) not null default 0,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  constraint training_session_archetype_key_check
    check (archetype_key in ('ready_buyer', 'negotiator', 'problematic', 'info_seeker')),
  constraint training_session_status_check
    check (status in ('active', 'ended', 'abandoned')),
  constraint training_session_outcome_check
    check (outcome is null or outcome in ('won', 'lost', 'timeout'))
);

create index if not exists training_session_business_user_started_idx
  on training_session (business_id, user_id, started_at desc);

create table if not exists training_turn (
  id           bigserial primary key,
  session_id   uuid not null references training_session (id) on delete cascade,
  business_id  uuid not null references business (id) on delete cascade,
  seq          integer not null,
  speaker      text not null,
  text         text not null,
  state_after  jsonb,
  created_at   timestamptz not null default now(),
  constraint training_turn_speaker_check check (speaker in ('seller', 'customer'))
);

create unique index if not exists training_turn_session_seq_key
  on training_turn (session_id, seq);
