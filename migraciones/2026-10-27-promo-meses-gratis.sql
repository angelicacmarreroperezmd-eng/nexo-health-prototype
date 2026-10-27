-- 2026-10-27: codigos de membresia gratis por VARIOS meses.
-- promo_codes ya existia (primer mes gratis). Se agrega cuantos meses regala
-- cada codigo. Default 1 = los codigos que ya existen siguen igual.
-- nmi-charge extiende membership_paid_until 30 x free_months; despues
-- nmi-renew cobra la mensual a la tarjeta guardada.
alter table public.promo_codes
  add column if not exists free_months integer not null default 1;
alter table public.promo_codes
  drop constraint if exists promo_codes_free_months_check;
alter table public.promo_codes
  add constraint promo_codes_free_months_check check (free_months between 1 and 12);
