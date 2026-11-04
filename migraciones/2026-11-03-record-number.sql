-- Numero de record (MRN) de 6 digitos por paciente, para identificarlos sin usar el nombre.
-- Empieza en 100001; los pacientes existentes se numeran por orden de registro.
-- Aplicada en staging y produccion el 3 nov 2026.
create sequence if not exists public.patient_record_seq start 100001 minvalue 100001;
alter table public.health_history add column if not exists record_number integer;
with orden as (
  select id, row_number() over (order by created_at, id) n from public.health_history where record_number is null
)
update public.health_history h set record_number = 100000 + orden.n from orden where h.id = orden.id;
select setval('public.patient_record_seq', (select coalesce(max(record_number), 100000) from public.health_history) + 1, false);
alter table public.health_history alter column record_number set default nextval('public.patient_record_seq');
alter table public.health_history alter column record_number set not null;
create unique index if not exists health_history_record_number_key on public.health_history(record_number);
-- Lo asigna la base al crear el paciente y nadie lo puede cambiar.
create or replace function public.record_number_fijo() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.record_number := nextval('public.patient_record_seq');
  elsif new.record_number is distinct from old.record_number then
    new.record_number := old.record_number;
  end if;
  return new;
end $$;
create trigger record_number_fijo before insert or update on public.health_history for each row execute function public.record_number_fijo();
