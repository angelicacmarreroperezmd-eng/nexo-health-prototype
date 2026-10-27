-- Deshace 2026-10-27-promo-meses-gratis.sql (desactiva antes los codigos de >1 mes).
update public.promo_codes set active = false where free_months > 1;
alter table public.promo_codes drop constraint if exists promo_codes_free_months_check;
alter table public.promo_codes drop column if exists free_months;
