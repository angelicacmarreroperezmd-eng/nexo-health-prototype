-- 2 nov 2026 (Dra. Marrero): enlace de calendario (iCal) para que cada
-- medico vea sus citas de NuVi en Google Calendar / Notion Calendar.
-- Un token secreto por miembro del staff; la funcion citas-ics lo lee con la
-- service role. El staff solo ve/crea/borra SU fila (para regenerar el enlace).
create table if not exists public.staff_calendar_feeds (
  staff_user_id uuid primary key references auth.users(id) on delete cascade,
  token uuid not null default gen_random_uuid() unique,
  created_at timestamptz not null default now()
);
alter table public.staff_calendar_feeds enable row level security;
drop policy if exists "staff ve su enlace" on public.staff_calendar_feeds;
create policy "staff ve su enlace" on public.staff_calendar_feeds for select
  using (auth.uid() = staff_user_id and public.is_staff());
drop policy if exists "staff crea su enlace" on public.staff_calendar_feeds;
create policy "staff crea su enlace" on public.staff_calendar_feeds for insert
  with check (auth.uid() = staff_user_id and public.is_staff());
drop policy if exists "staff borra su enlace" on public.staff_calendar_feeds;
create policy "staff borra su enlace" on public.staff_calendar_feeds for delete
  using (auth.uid() = staff_user_id and public.is_staff());
