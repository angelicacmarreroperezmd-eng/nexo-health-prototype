-- APLICADA en nuvi-pruebas y TelemedProject el 27 oct 2026. Los emails se agregan aparte (no van en el repo).
-- 2026-10-27: MEMBRESIA DE CORTESIA POR EMAIL, antes de que el paciente exista.
-- La Dra. agrega el email aqui; cuando esa persona se registra y guarda su
-- historial, su fila de health_history nace con plan 'Comped' y paid = true:
-- no ve boton de pagar y nmi-renew nunca le cobra.
-- El email se toma de auth.users (la cuenta verificada), NUNCA del email que
-- el paciente escribe en el formulario, para que nadie se lo pueda adjudicar.
-- Para empezar a cobrarle: active = false aqui y cambiar su plan a mano.
create table if not exists public.comped_emails (
  email      text primary key check (email = lower(btrim(email)) and email like '%@%'),
  active     boolean not null default true,
  note       text,
  created_at timestamptz not null default now()
);
alter table public.comped_emails enable row level security;   -- sin politicas: solo service role / SQL
revoke all on public.comped_emails from anon, authenticated;

create or replace function public.cortesia_por_email()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_email text;
begin
  select lower(btrim(u.email)) into v_email from auth.users u where u.id = new.user_id;
  if v_email is not null and exists (select 1 from public.comped_emails c where c.email = v_email and c.active) then
    new.plan    := 'Comped';
    new.paid    := true;
    new.paid_at := coalesce(new.paid_at, now());
    new.membership_cancelled := false;
  end if;
  return new;
end $$;
revoke all on function public.cortesia_por_email() from public, anon, authenticated;

-- "zz_" para que corra DESPUES de protect_payment_fields_trg (que en INSERT
-- pone paid/plan en blanco): los BEFORE triggers corren en orden alfabetico.
drop trigger if exists zz_cortesia_por_email on public.health_history;
create trigger zz_cortesia_por_email before insert on public.health_history
  for each row execute function public.cortesia_por_email();
