-- Credenciales sensibles de los médicos (21 oct 2026)
--
-- La tabla staff la puede leer cualquier usuario con sesión (la web le
-- muestra al paciente el nombre y la foto de su médico). Por eso el DEA NO
-- va ahí: va en esta tabla aparte, que solo puede leer y cambiar el propio
-- médico (y los servicios del servidor). Ningún paciente ni otro miembro del
-- personal la ve.
--
-- Solo añade una tabla. No toca ni borra nada existente.
-- Para deshacer: drop table public.staff_credentials;

create table if not exists public.staff_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  dea text,
  updated_at timestamptz not null default now()
);

alter table public.staff_credentials enable row level security;
revoke all on public.staff_credentials from anon;

drop policy if exists "medico lee sus credenciales" on public.staff_credentials;
create policy "medico lee sus credenciales" on public.staff_credentials
  for select to authenticated
  using (user_id = (select auth.uid())
         and exists (select 1 from public.staff s where s.user_id = (select auth.uid())));

drop policy if exists "medico guarda sus credenciales" on public.staff_credentials;
create policy "medico guarda sus credenciales" on public.staff_credentials
  for insert to authenticated
  with check (user_id = (select auth.uid())
              and exists (select 1 from public.staff s where s.user_id = (select auth.uid())));

drop policy if exists "medico actualiza sus credenciales" on public.staff_credentials;
create policy "medico actualiza sus credenciales" on public.staff_credentials
  for update to authenticated
  using (user_id = (select auth.uid())
         and exists (select 1 from public.staff s where s.user_id = (select auth.uid())))
  with check (user_id = (select auth.uid()));
