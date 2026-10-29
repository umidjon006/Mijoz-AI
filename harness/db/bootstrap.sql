-- ============================================================================
-- bootstrap.sql — FAQAT LOKAL HARNESS UCHUN. Teammate'larga berilmaydi.
--
-- Nima qiladi:
--   1. cheklangan (restricted) ilova roli yaratadi — superuser EMAS va
--      jadval egasi EMAS, shuning uchun RLS unga haqiqatan ham qo'llanadi;
--   2. host ilovaning `business`, `app_user`, `seat` jadvallarining STUB
--      versiyasini yaratadi — nomlari va kalit ustunlari modul FK'lari
--      kutganidek (asosiy repoda bu jadvallar allaqachon bor).
-- ============================================================================

create extension if not exists pgcrypto;

-- 1. Cheklangan ilova roli ------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'trainer_app') then
    create role trainer_app login password 'trainer_app' nosuperuser nocreatedb nocreaterole nobypassrls;
  else
    alter role trainer_app login password 'trainer_app' nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end
$$;

grant usage on schema public to trainer_app;

-- 2. Host ilovaning stub jadvallari ---------------------------------------
create table if not exists business (
  id   uuid primary key default gen_random_uuid(),
  name text
);

create table if not exists app_user (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references business (id) on delete cascade,
  email       text
);

create table if not exists seat (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references business (id) on delete cascade,
  label       text
);

-- Stub jadvallar RLS'siz qoladi: ularni faqat superuser (test setup) yozadi,
-- ilova roli esa faqat o'qiydi.
grant select on business, app_user, seat to trainer_app;
