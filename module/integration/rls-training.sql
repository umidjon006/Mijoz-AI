-- ============================================================================
-- rls-training.sql — RLS (Row Level Security) uchun integratsiya qadamlari.
--
-- DIQQAT: asosiy repoda `backend/src/db/rls.sql` ichidagi `tenant_tables`
-- ro'yxati QO'LDA yuritiladi. Jadval shu ro'yxatda bo'lmasa, u HIMOYALANMAYDI
-- (hech qanday xato ham bermaydi — shunchaki hamma tenant ko'ra oladi).
-- Shuning uchun quyidagi ikki nomni albatta qo'shing:
--
--     'training_session',
--     'training_turn',
--     'training_result'
--
-- Keyin rls.sql ni qayta qo'llang (repoda qanday bo'lsa: `npm run db:rls`
-- yoki `psql -f backend/src/db/rls.sql`).
--
-- Quyidagi blok — shu ikki jadval uchun siyosat NAMUNASI (rls.sql dagi
-- pattern bilan bir xil). Agar rls.sql ro'yxat bo'yicha avtomatik
-- generatsiya qilsa, pastdagini QO'LDA qo'llash KERAK EMAS — faqat nomlarni
-- ro'yxatga qo'shish kifoya. Lokal harness aynan shu blokni qo'llaydi.
-- ============================================================================

-- training_session ----------------------------------------------------------
alter table training_session enable row level security;
alter table training_session force row level security;

drop policy if exists training_session_tenant_isolation on training_session;
create policy training_session_tenant_isolation on training_session
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- training_turn -------------------------------------------------------------
alter table training_turn enable row level security;
alter table training_turn force row level security;

drop policy if exists training_turn_tenant_isolation on training_turn;
create policy training_turn_tenant_isolation on training_turn
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- training_result (Step 4) -------------------------------------------------
alter table training_result enable row level security;
alter table training_result force row level security;

drop policy if exists training_result_tenant_isolation on training_result;
create policy training_result_tenant_isolation on training_result
  using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- Eslatma: `current_setting(..., true)` sozlanmagan bo'lsa NULL qaytaradi,
-- NULL taqqoslash esa false beradi — ya'ni `withTenant` ishlatilmasa hech
-- qanday qator ko'rinmaydi. Buni `verify-training.ts` tekshiradi.
--
-- NEGA `nullif(..., '')`? `set_config(..., true)` (transaction-local) commit
-- dan keyin GUC'ni o'zining "reset" qiymatiga qaytaradi, va u NULL emas,
-- BO'SH SATR ('') bo'lib qoladi. Bo'sh satrni to'g'ridan-to'g'ri `::uuid`
-- qilsa Postgres xato tashlaydi ("invalid input syntax for type uuid: """).
-- Natijada pool'dan qayta ishlatilgan ulanishda `withTenant`siz so'rov
-- 0 qator emas, XATO beradi. `nullif(..., '')` buni NULL ga aylantiradi —
-- xulosa: xatosiz, lekin hech narsa ko'rinmaydi (fail-closed).
-- Asosiy repoda `rls.sql` ichidagi pattern'da `nullif` bo'lmasa, uni ham
-- shunday to'g'rilashni maslahat beramiz.
--
-- Eslatma 2: siyosatlar CHEKLANGAN (restricted) rol uchun ishlaydi.
-- Superuser va jadval egasi RLS'ni chetlab o'tadi (FORCE ROW LEVEL SECURITY
-- egani ham majburlaydi, lekin superuser'ni emas) — shuning uchun ilova
-- DB'ga alohida, cheklangan rol bilan ulanishi shart.
