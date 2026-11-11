-- ============================================================================
-- training-scenarios.sql — MIGRATSIYA (idempotent): sozlanadigan mijoz
-- ssenariylari (Part 1).
--
--   1. `training_scenario` — tenant ssenariylari (ma'lumot `data` jsonb'da,
--      sxema: backend/src/training/scenario/schema.ts — zod; JSON Schema:
--      scenario/json-schema.ts). Qidirish/cheklov uchun bir nechta ustun
--      `data` dan nusxalanadi.
--   2. `training_session` ga: `scenario_id`, `scenario` (sessiya boshidagi
--      ssenariy NUSXASI — keyin tahrirlansa ham ketayotgan sessiya o'zgarmaydi),
--      `seller_profile` (sotuvchi: ism, jins, yosh — taxmin qilinmaydi).
--
-- Qayta qo'llash xavfsiz (if not exists). Asosiy repoga ko'chirganda — drizzle
-- sxemasi (db/schema/training.ts) bilan qayta generatsiya qiling.
-- Tartib: training.sql -> training-scenarios.sql -> rls-training.sql.
-- ============================================================================

create table if not exists training_scenario (
  business_id   uuid not null references business (id) on delete cascade,
  id            text not null,
  version       integer not null default 1,
  title         text not null,
  difficulty    smallint not null,
  insult_level  smallint not null,
  data          jsonb not null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (business_id, id),
  constraint training_scenario_id_check check (id ~ '^[a-z][a-z0-9_]{2,60}$'),
  constraint training_scenario_difficulty_check check (difficulty between 1 and 5),
  -- Har qanday ssenariy (kelajakdagi menejer yaratganlari ham) — haqorat darajasi <= 2.
  constraint training_scenario_insult_level_check check (insult_level between 0 and 2)
);

alter table training_session add column if not exists scenario_id text;
alter table training_session add column if not exists scenario jsonb;
alter table training_session add column if not exists seller_profile jsonb;

-- RLS (tenant izolyatsiyasi — boshqa jadvallar bilan bir xil).
alter table training_scenario enable row level security;
alter table training_scenario force row level security;

drop policy if exists training_scenario_tenant_isolation on training_scenario;
create policy training_scenario_tenant_isolation on training_scenario
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
