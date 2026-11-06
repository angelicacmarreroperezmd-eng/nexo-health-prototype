-- Razon clinica, paciente por paciente, para recetar un GLP-1 compuesto en vez del
-- producto de marca aprobado por la FDA (FDA, abril 2026: el medico tiene que
-- determinar y documentar una diferencia clinica significativa para ESE paciente;
-- el precio no cuenta). Se guarda cada vez que se aprueba o se cambia la dosis:
-- la fila mas reciente por paciente y medicamento es la vigente, y las anteriores
-- quedan como historial de la re-evaluacion en cada cita. No se edita ni se borra.
create table if not exists public.rx_clinical_need (
  id uuid primary key default gen_random_uuid(),
  patient_user_id uuid not null references auth.users(id) on delete cascade,
  medication text not null,
  dose text,
  reason text not null check (reason in ('dose','excipient','other')),
  detail text not null check (char_length(btrim(detail)) >= 40),
  author_user_id uuid not null default auth.uid(),
  author_name text,
  created_at timestamptz not null default now()
);
create index if not exists rx_clinical_need_pac on public.rx_clinical_need (patient_user_id, medication, created_at desc);
alter table public.rx_clinical_need enable row level security;
-- Solo el personal la ve y la escribe. Es parte del expediente; el paciente no la ve en su panel.
create policy rx_clinical_need_leer on public.rx_clinical_need for select to authenticated using (public.is_staff());
create policy rx_clinical_need_crear on public.rx_clinical_need for insert to authenticated
  with check (public.is_staff() and author_user_id = auth.uid());
