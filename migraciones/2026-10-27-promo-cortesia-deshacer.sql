update public.promo_codes set active = false where comped;
alter table public.promo_codes drop column if exists comped;
