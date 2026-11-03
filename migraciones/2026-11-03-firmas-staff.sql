-- Firma escaneada de cada medico, para las recetas, ordenes de labs y referidos firmados.
-- No va en el codigo (el repo es publico): se guarda aqui y se carga al abrir un documento firmado.
create table if not exists public.staff_signatures (
  staff_user_id uuid primary key references auth.users(id) on delete cascade,
  image text not null,              -- data:image/png;base64,...
  updated_at timestamptz not null default now()
);
alter table public.staff_signatures enable row level security;
-- Cualquier usuario con sesion la puede leer: el paciente la ve en sus propios documentos firmados.
drop policy if exists firmas_leer on public.staff_signatures;
create policy firmas_leer on public.staff_signatures for select to authenticated using (true);
-- Solo el propio medico (staff) cambia la suya.
drop policy if exists firmas_propia on public.staff_signatures;
create policy firmas_propia on public.staff_signatures for all to authenticated
  using (staff_user_id = auth.uid() and public.is_staff())
  with check (staff_user_id = auth.uid() and public.is_staff());
