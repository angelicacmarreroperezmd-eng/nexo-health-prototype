-- 2026-10-27: codigo de MEMBRESIA DE CORTESIA (plan 'Comped').
-- Un codigo con comped = true deja al paciente en plan 'Comped': nunca se le
-- cobra (nmi-renew lo salta) y no vence. Para empezar a cobrarle, la clinica
-- cambia su plan a 'Basic' con una fecha en membership_paid_until.
alter table public.promo_codes add column if not exists comped boolean not null default false;
