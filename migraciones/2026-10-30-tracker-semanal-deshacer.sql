-- Deshace 2026-10-30-tracker-semanal.sql. OJO: borra las semanas que hayan
-- anotado los pacientes. Exportarlas antes si hace falta guardarlas.
drop table if exists public.weekly_checkins;
drop function if exists public.weekly_checkins_touch();
drop policy if exists "Staff can view weight logs" on public.weight_logs;
