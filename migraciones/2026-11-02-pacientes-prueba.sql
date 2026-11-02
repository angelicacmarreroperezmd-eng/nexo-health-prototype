-- 2 nov 2026 (Dra. Marrero): marcar cuentas de prueba para que no salgan en
-- las listas del staff, el Inicio ni la agenda. No borra nada.
alter table public.health_history add column if not exists is_test boolean not null default false;
