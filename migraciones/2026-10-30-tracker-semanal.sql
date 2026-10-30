-- Tracker de progreso semanal (30 oct 2026). Pedido por la Dra. Marrero.
--
-- Es el mismo tracker del PDF que se entrega despues de la visita, pero lleno
-- directo en el portal (pestaña Progress del paciente). Una fila por semana.
-- El paciente escribe y corrige las suyas; no las borra (es parte de su
-- expediente). El equipo medico las lee.
--
-- Tambien deja al equipo medico leer weight_logs, que hasta hoy solo veia el
-- paciente aunque la pantalla le decia "your care team can see it too".
--
-- Solo añade cosas; no cambia nada existente. Para quitarlo:
-- 2026-10-30-tracker-semanal-deshacer.sql

create table if not exists public.weekly_checkins (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  week_of        date not null default current_date,
  weight_lbs     numeric(5,1) check (weight_lbs between 50 and 1000),
  waist_in       numeric(4,1) check (waist_in between 15 and 100),
  dose_mg        numeric(4,2) check (dose_mg between 0 and 50),
  injection_day  text check (injection_day in ('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')),
  nausea         smallint check (nausea between 0 and 3),
  constipation   smallint check (constipation between 0 and 3),
  diarrhea       smallint check (diarrhea between 0 and 3),
  reflux         smallint check (reflux between 0 and 3),
  other_symptom  text check (char_length(other_symptom) <= 200),
  water_glasses  smallint check (water_glasses between 0 and 40),
  protein_meals  smallint check (protein_meals between 0 and 10),
  exercise_min   smallint check (exercise_min between 0 and 3000),
  strength_days  smallint check (strength_days between 0 and 7),
  hunger         smallint check (hunger between 1 and 5),
  energy         smallint check (energy between 1 and 5),
  win            text check (char_length(win) <= 500),
  questions      text check (char_length(questions) <= 1000),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, week_of)
);
alter table public.weekly_checkins enable row level security;
create index if not exists weekly_checkins_user_idx on public.weekly_checkins (user_id, week_of desc);

drop policy if exists "checkin: paciente lee los suyos" on public.weekly_checkins;
create policy "checkin: paciente lee los suyos" on public.weekly_checkins for select to authenticated
  using (auth.uid() = user_id);
drop policy if exists "checkin: paciente anota los suyos" on public.weekly_checkins;
create policy "checkin: paciente anota los suyos" on public.weekly_checkins for insert to authenticated
  with check (auth.uid() = user_id);
drop policy if exists "checkin: paciente corrige los suyos" on public.weekly_checkins;
create policy "checkin: paciente corrige los suyos" on public.weekly_checkins for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "checkin: personal lee" on public.weekly_checkins;
create policy "checkin: personal lee" on public.weekly_checkins for select to authenticated
  using (public.is_staff());

-- updated_at al corregir una semana.
create or replace function public.weekly_checkins_touch() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists weekly_checkins_touch on public.weekly_checkins;
create trigger weekly_checkins_touch before update on public.weekly_checkins
  for each row execute function public.weekly_checkins_touch();

drop policy if exists "Staff can view weight logs" on public.weight_logs;
create policy "Staff can view weight logs" on public.weight_logs for select to authenticated
  using (public.is_staff());
