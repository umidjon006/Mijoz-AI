-- FAQAT LOKAL HARNESS. `module/integration/training.sql` va
-- `module/integration/rls-training.sql` qo'llanganidan KEYIN ishlatiladi:
-- cheklangan ilova roliga trenajyor jadvallarida DML huquqini beradi.
-- (Asosiy repoda bu huquqlar allaqachon o'rnatilgan bo'ladi.)

grant select, insert, update, delete on training_session, training_turn, training_result, training_scenario to trainer_app;
grant usage, select on sequence training_turn_id_seq to trainer_app;
