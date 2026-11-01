-- 2026-11-01: "Quitar" en Mensajes por contestar (inicio del medico).
-- No se borra ningun mensaje: solo se marca dismissed_at. Si el paciente
-- vuelve a escribir, el mensaje nuevo sale otra vez.
alter table public.messages add column if not exists dismissed_at timestamptz;
alter table public.messages add column if not exists dismissed_by uuid;

create or replace function public.descartar_mensajes(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'solo personal';
  end if;
  update public.messages
     set dismissed_at = now(), dismissed_by = auth.uid()
   where user_id = p_user and sender = 'patient' and dismissed_at is null;
end;
$$;

revoke all on function public.descartar_mensajes(uuid) from public, anon;
grant execute on function public.descartar_mensajes(uuid) to authenticated;
