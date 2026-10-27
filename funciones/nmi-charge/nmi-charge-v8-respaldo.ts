// ============================================================
// nmi-charge — Supabase Edge Function
// Cobra con tarjeta (Visa/Mastercard/etc.) a traves del gateway NMI de
// Merchant Service Depot. Mismas tres reglas que ATH:
//   1. El NAVEGADOR NO DECIDE si se pago. Manda un token de tarjeta
//      (Collect.js) y la referencia de la orden; esta funcion cobra, lee la
//      respuesta de NMI y marca la base con la service key.
//   2. El MONTO sale de la orden guardada en la base, nunca del body.
//   3. A NMI solo le va la referencia opaca (orderid), nunca el medicamento.
// Guarda la tarjeta en el Customer Vault cuando es una membresia, para que
// la renovacion mensual sea automatica (ver nmi-renew).
//
// 14oct-1: CODIGOS DE PRIMER MES GRATIS (tabla promo_codes, ver
//   sql-promo-primer-mes-gratis.sql). El navegador manda promo_code; esta
//   funcion lo RE-VALIDA con la service role (activo, no vencido, usos <
//   max_uses, no canjeado por este paciente, paciente sin periodo pagado
//   vigente) y SOLO entonces trata la orden como $0: NO hace un sale, hace
//   type=validate + customer_vault=add_customer (verifica la tarjeta, no
//   cobra) y guarda el vault para que nmi-renew cobre la mensual el dia 30. El
//   amount que el navegador escribio en athm_orders se IGNORA en este camino.
//   El uso del codigo se reserva (promo_reserve, atomico) ANTES de llamar a
//   NMI y se devuelve (promo_release) si la tarjeta se declina.
//   {promo_check:"CODIGO"} solo pregunta si vale (no reserva, no llama a NMI).
//
// DEPLOY
//   supabase functions deploy nmi-charge --no-verify-jwt
//   supabase secrets set NMI_SECURITY_KEY=...   (Private Security Key del portal NMI)
//   (opcional) supabase secrets set NMI_API_URL=https://secure.nmi.com/api/transact.php
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const NMI_KEY      = Deno.env.get("NMI_SECURITY_KEY") ?? "";
const NMI_URL      = Deno.env.get("NMI_API_URL") ?? "https://secure.nmi.com/api/transact.php";
const NOTIFY_FN    = Deno.env.get("NOTIFY_FUNCTION") ?? "swift-responder";
const MEMBERSHIP_DAYS = 30;
// 14oct-2: precio de la membresia en UNA constante ($50 hasta nuevo aviso).
// Tiene que ser el mismo que MEMBERSHIP_MONTHLY de nmi-renew, notify e index.html.
const MEMBERSHIP_MONTHLY = 50;
const RENEW_PRICE = MEMBERSHIP_MONTHLY;   // lo que cobra nmi-renew despues del mes gratis
export const PROMO_PLAN = "FreeFirst";
export const PROMO_RE = /^[A-Z0-9-]{3,40}$/;
// Normaliza lo que escribio el paciente. Devuelve "" si no tiene forma de
// codigo: asi nada raro llega a la base.
export function normPromo(v: unknown): string {
  const c = (v == null ? "" : String(v)).trim().toUpperCase();
  return PROMO_RE.test(c) ? c : "";
}
const PROMO_MSG: Record<string, string> = {
  invalid:          "That promo code isn't valid. Check the spelling, or continue without it.",
  inactive:         "That promo code is no longer active.",
  expired:          "That promo code has expired.",
  used_up:          "That promo code has already been used.",
  already_redeemed: "You've already used this promo code.",
  offer_used:       "You've already had a free first month with us, so this code can't be applied.",
  already_member:   "Your membership is already active, so this code can't be applied. It's for new members starting their first month.",
  no_history:       "Complete your health history first, then come back to start your free month.",
  not_membership:   "Promo codes only apply to the membership.",
};
const promoErr = (reason: string, status = 409) =>
  json({ ok: false, paid: false, valid: false, promo_invalid: true, reason, error: PROMO_MSG[reason] || PROMO_MSG.invalid }, status);
// ¿Ya esta en un periodo pagado vigente? (o es de cortesia)
export function periodoVigente(hh: Record<string, unknown> | null): boolean {
  if (!hh || !hh.paid) return false;
  if (hh.plan === "Comped") return true;
  const hasta = s(hh.membership_paid_until).slice(0, 10);
  return !!hasta && hasta >= new Date().toISOString().slice(0, 10);
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const s = (v: unknown) => (v == null ? "" : String(v)).trim();

// La API de NMI contesta con un query string: response=1&responsetext=...
export function parseNmi(txt: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(txt)) out[k] = v;
  return out;
}

// Cobrar en NMI. type=sale con token de Collect.js, o con customer_vault_id
// (renovacion). Devuelve la respuesta parseada.
export async function nmiSale(p: Record<string, string>): Promise<Record<string, string>> {
  const body = new URLSearchParams({ security_key: NMI_KEY, type: "sale", ...p });
  const r = await fetch(NMI_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  return parseNmi(await r.text());
}

// Verificar la tarjeta SIN cobrar (primer mes gratis) y guardarla en el
// Customer Vault. type=validate no mueve dinero; amount va en 0.00.
export async function nmiValidate(p: Record<string, string>): Promise<Record<string, string>> {
  const { amount: _ignorado, type: _t, ...resto } = p;
  const body = new URLSearchParams({ security_key: NMI_KEY, ...resto, type: "validate", amount: "0.00", customer_vault: "add_customer" });
  const r = await fetch(NMI_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  return parseNmi(await r.text());
}

// Lo que pasa en la base cuando un cobro SE APROBO. Compartido con nmi-renew.
// Devuelve la lista de errores de base (vacia si todo se guardo). Un cobro
// aprobado que no se registra es lo PEOR que puede pasar: se devuelve el
// error para que el paciente vea "no vuelvas a pagar" y no un exito falso.
export async function aplicarPago(db: ReturnType<typeof createClient>, order: Record<string, unknown>, nmi: Record<string, string>, vaultId: string | null, opts: { promo?: string } = {}): Promise<string[]> {
  const now = new Date().toISOString();
  const fallos: string[] = [];
  const chk = (que: string, r: { error?: { message?: string } | null }) => { if (r?.error) { console.error("[nmi] " + que + ":", r.error.message); fallos.push(que + ": " + r.error.message); } };
  const promo = opts.promo || "";
  let hastaISO = "";

  const ordUpd: Record<string, unknown> = {
    status: "paid", processor: "nmi", transaction_id: s(nmi.transactionid), paid_at: now,
    card_last4: s(nmi.cc_number).slice(-4) || null,
  };
  if (promo) {
    // Primer mes gratis: la orden queda en $0 con su codigo. Si la base aun
    // no tiene la columna/CHECK nuevos (SQL sin correr), se guarda sin ellos:
    // el canje ya quedo en promo_redemptions y el paciente no se queda sin
    // activar por un detalle de esquema.
    const r1 = await db.from("athm_orders").update({ ...ordUpd, amount: 0, promo_code: promo }).eq("ref", order.ref);
    if (r1?.error) {
      console.error("[nmi] athm_orders promo (amount 0) fallo, se guarda sin amount:", r1.error.message);
      chk("athm_orders", await db.from("athm_orders").update({ ...ordUpd, label: "First month free (" + promo + ") — $0.00" }).eq("ref", order.ref));
    }
  } else {
    chk("athm_orders", await db.from("athm_orders").update(ordUpd).eq("ref", order.ref));
  }

  const uid = s(order.user_id);
  const { data: hh, error: hhErr } = await db.from("health_history").select("*").eq("user_id", uid)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (hhErr) fallos.push("health_history read: " + hhErr.message);
  if (!hh) { fallos.push("patient has no health_history row"); return fallos; }

  if (order.kind === "membership") {
    const plan = s(order.target_id) || hh.plan || "Basic";
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const desde = hh.membership_paid_until && new Date(hh.membership_paid_until) > hoy ? new Date(hh.membership_paid_until) : hoy;
    const hasta = new Date(desde); hasta.setDate(hasta.getDate() + MEMBERSHIP_DAYS);
    hastaISO = hasta.toISOString().slice(0, 10);
    const upd: Record<string, unknown> = {
      paid: true, paid_at: hh.paid_at || now, plan: hh.plan === "Comped" ? "Comped" : plan,
      membership_paid_until: hastaISO,
      membership_cancelled: false, membership_cancelled_at: null, membership_cancel_reason: null,
      last_renewal_at: now,
    };
    if (vaultId) { upd.card_vault_id = vaultId; upd.card_last4 = s(nmi.cc_number).slice(-4) || null; }
    chk("health_history membership", await db.from("health_history").update(upd).eq("id", hh.id));
  } else if (order.kind === "legacy") {
    chk("health_history purchased", await db.from("health_history").update({ purchased: true, purchased_at: now }).eq("id", hh.id));
  } else if (order.kind === "prescription") {
    chk("prescriptions purchased", await db.from("prescriptions").update({ purchased: true, purchased_at: now }).eq("id", s(order.target_id)).eq("user_id", uid));
  }
  if (fallos.length) return fallos;

  // Recibo por correo (detached: un correo que falle no deshace un cobro).
  try {
    const amount = "$" + Number(order.amount).toFixed(2);
    const receipt = "NV-" + s(order.ref);
    const patient = { name: hh.full_name || hh.email, email: hh.email };
    let payload: unknown;
    if (order.kind === "membership" && promo) {
      payload = { event: "payment", patient, data: { amount: "$0.00", plan: "Basic", receipt, date: now,
        coupon: "First month free", free_trial: true, renews_on: hastaISO, renew_amount: "$" + RENEW_PRICE.toFixed(2),
        last4: s(nmi.cc_number).slice(-4) || null } };
    } else if (order.kind === "membership") {
      payload = { event: "payment", patient, data: { amount, plan: s(order.target_id) || "Basic", receipt, date: now } };
    } else {
      let med = "", dose = "";
      if (order.kind === "legacy") { med = s(hh.approved_medication); dose = s(hh.approved_dose); }
      else { const { data: p } = await db.from("prescriptions").select("medication,dose").eq("id", s(order.target_id)).maybeSingle(); med = s(p?.medication); dose = s(p?.dose); }
      payload = { event: "med_payment", patient, data: { medication: med, dose, amount, receipt, date: now,
        shipTo: hh.shipping_address1, shipCity: hh.shipping_city, shipState: hh.shipping_state, shipZip: hh.shipping_zip } };
    }
    await fetch(`${SUPABASE_URL}/functions/v1/${NOTIFY_FN}`, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(payload) });
  } catch (e) { console.error("receipt email failed:", e); }
  return fallos;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  if (!NMI_KEY) return json({ error: "NMI_SECURITY_KEY is not set on this function" }, 500);

  try {
    const body = await req.json().catch(() => ({}));
    const ref = s(body.ref);
    const token = s(body.payment_token);
    const saveCard = body.save_card === true;
    const checkOnly = body.promo_check != null && s(body.promo_check) !== "";
    const promoPedido = checkOnly ? s(body.promo_check) : s(body.promo_code);
    const promo = normPromo(promoPedido);
    if (!checkOnly && (!ref || !token)) return json({ error: "ref and payment_token are required" }, 400);
    // Forma del codigo ANTES de tocar la base o a NMI.
    if (promoPedido && !promo) return promoErr("invalid", checkOnly ? 200 : 400);

    // ¿Quien paga? El JWT, nunca el body.
    const auth = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!auth) return json({ error: "Sign in required" }, 401);
    const userClient = createClient(SUPABASE_URL, ANON_KEY || SERVICE_KEY, { global: { headers: { Authorization: `Bearer ${auth}` } }, auth: { persistSession: false } });
    const { data: u } = await userClient.auth.getUser(auth);
    if (!u?.user) return json({ error: "Sign in required" }, 401);

    const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    // Solo preguntar si el codigo vale (boton "Apply"). No reserva, no cobra.
    if (checkOnly) {
      const { data: hhc } = await db.from("health_history").select("*").eq("user_id", u.user.id)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (periodoVigente(hhc)) return promoErr("already_member", 200);
      const { data: chkp, error: chkErr } = await db.rpc("promo_check", { p_code: promo, p_user: u.user.id });
      if (chkErr) { console.error("[promo] promo_check:", chkErr.message); return json({ ok: false, valid: false, error: "We could not check the code right now. Try again in a moment." }, 503); }
      if (!chkp?.ok) return promoErr(s(chkp?.reason) || "invalid", 200);
      return json({ ok: true, valid: true, code: promo, today: 0, then: RENEW_PRICE });
    }

    const { data: order } = await db.from("athm_orders").select("*").eq("ref", ref).maybeSingle();
    if (!order) return json({ error: "Order not found" }, 404);
    if (order.user_id !== u.user.id) return json({ error: "Not your order" }, 403);
    if (order.status === "paid") return json({ ok: true, paid: true, already: true });
    // 'declined' se puede reintentar con otra tarjeta: no salio dinero.
    if (order.status !== "open" && order.status !== "declined") return json({ error: `Order is ${order.status}` }, 409);
    const amount = Number(order.amount);
    // Con promo el monto de la orden NO cuenta (lo escribio el navegador): el
    // servidor decide que es $0 tras validar el codigo, mas abajo.
    if (!promo && (!Number.isFinite(amount) || amount <= 0)) return json({ error: "Order has no valid amount" }, 409);

    const { data: hh } = await db.from("health_history").select("full_name,email,shipping_address1,shipping_city,shipping_state,shipping_zip")
      .eq("user_id", u.user.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const [first, ...rest] = s(hh?.full_name).split(/\s+/);

    const params: Record<string, string> = {
      payment_token: token,
      amount: amount.toFixed(2),
      orderid: ref,                       // referencia opaca: nada clinico
      order_description: "Nuvi Clinic",   // tampoco aqui
      currency: "USD",
      first_name: first || "", last_name: rest.join(" ") || "",
      email: s(hh?.email),
      address1: s(hh?.shipping_address1), city: s(hh?.shipping_city), state: s(hh?.shipping_state), zip: s(hh?.shipping_zip),
      ipaddress: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "",
    };
    // ---- PRIMER MES GRATIS ----------------------------------------------
    if (promo) {
      if (order.kind !== "membership") return promoErr("not_membership", 400);
      const { data: hhp } = await db.from("health_history").select("*").eq("user_id", u.user.id)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!hhp) return promoErr("no_history");
      if (periodoVigente(hhp)) return promoErr("already_member");
      // Reserva atomica (bloquea la fila del codigo y cuenta el uso).
      const { data: rsv, error: rsvErr } = await db.rpc("promo_reserve", { p_code: promo, p_user: u.user.id, p_ref: ref });
      if (rsvErr) { console.error("[promo] promo_reserve:", rsvErr.message); return json({ ok: false, paid: false, error: "We could not check the promo code right now. Nothing was charged. Try again in a moment." }, 503); }
      if (!rsv?.ok) return promoErr(s(rsv?.reason) || "invalid");

      let nmi: Record<string, string>;
      try { nmi = await nmiValidate(params); }
      catch (e) { nmi = { response: "3", responsetext: String(e) }; }
      const vault = s(nmi.customer_vault_id);
      const okNmi = nmi.response === "1" && !!vault;
      console.log("[nmi] validate", ref, okNmi ? "APPROVED" : "DECLINED", nmi.response_code, nmi.responsetext);
      if (!okNmi) {
        // Tarjeta declinada: el codigo NO se gasta.
        const { error: relErr } = await db.rpc("promo_release", { p_code: promo, p_user: u.user.id, p_ref: ref });
        if (relErr) console.error("[promo] promo_release:", relErr.message);
        await db.from("athm_orders").update({ status: "declined", processor: "nmi", error: s(nmi.responsetext || "no customer_vault_id").slice(0, 300) }).eq("ref", ref);
        const msg = nmi.response === "2" ? "Your card was declined. Try another card — nothing was charged."
                  : "We could not verify the card: " + (s(nmi.responsetext) || "unknown error") + ". Nothing was charged.";
        return json({ ok: false, paid: false, error: msg, code: nmi.response_code }, 402);
      }
      // Canje definitivo. Solo UNA orden puede confirmarlo.
      const { data: conf, error: confErr } = await db.rpc("promo_confirm", { p_code: promo, p_user: u.user.id, p_ref: ref });
      if (confErr || conf !== true) {
        console.error("[promo] promo_confirm fallo:", confErr?.message || conf);
        await db.from("athm_orders").update({ status: "declined", processor: "nmi", error: "promo confirm failed" }).eq("ref", ref);
        return promoErr("used_up");
      }
      const fallosP = await aplicarPago(db, { ...(order as Record<string, unknown>), amount: 0, target_id: PROMO_PLAN }, nmi, vault, { promo });
      if (fallosP.length) {
        await db.from("athm_orders").update({ status: "paid_unapplied", processor: "nmi", transaction_id: s(nmi.transactionid), error: fallosP.join(" | ").slice(0, 500) }).eq("ref", ref);
        return json({ ok: false, paid: true, charged: false,
          error: "Your card was verified (it was NOT charged), but we could not activate your free month automatically. "
               + "Do not start again — message your care team with reference " + ref + " and they will activate it.",
          detail: fallosP }, 500);
      }
      return json({ ok: true, paid: true, promo: true, amount: 0, then: RENEW_PRICE, transaction_id: s(nmi.transactionid),
                    last4: s(nmi.cc_number).slice(-4) || null, saved_card: true });
    }

    // La tarjeta se guarda SOLO para membresias (renovacion mensual). Un
    // medicamento es una compra suelta: no hay motivo para retener la tarjeta.
    if (saveCard && order.kind === "membership") params.customer_vault = "add_customer";

    const nmi = await nmiSale(params);
    const approved = nmi.response === "1";
    console.log("[nmi]", ref, approved ? "APPROVED" : "DECLINED", nmi.response_code, nmi.responsetext);

    if (!approved) {
      await db.from("athm_orders").update({ status: "declined", processor: "nmi", error: s(nmi.responsetext).slice(0, 300) }).eq("ref", ref);
      // response=2 es declinada por el banco; 3 es error de datos. Al paciente
      // se le dice algo util, no el codigo.
      const msg = nmi.response === "2" ? "Your card was declined. Try another card or pay with ATH Móvil."
                : "We could not process the card: " + (s(nmi.responsetext) || "unknown error");
      return json({ ok: false, paid: false, error: msg, code: nmi.response_code }, 402);
    }

    const fallos = await aplicarPago(db, order as Record<string, unknown>, nmi, s(nmi.customer_vault_id) || null);
    if (fallos.length) {
      // El dinero SI salio. No se puede decir "fallo" a secas: se dice que no
      // vuelva a pagar, y queda en la orden para que el equipo lo aplique.
      await db.from("athm_orders").update({ status: "paid_unapplied", processor: "nmi", transaction_id: s(nmi.transactionid), error: fallos.join(" | ").slice(0, 500) }).eq("ref", ref);
      return json({ ok: false, paid: true, charged: true,
        error: "Your card was charged (transaction " + s(nmi.transactionid) + ") but we could not update your account automatically. "
             + "DO NOT pay again — message your care team with reference " + ref + " and they will apply it.",
        detail: fallos }, 500);
    }
    return json({ ok: true, paid: true, transaction_id: s(nmi.transactionid), last4: s(nmi.cc_number).slice(-4) || null,
                  saved_card: !!s(nmi.customer_vault_id) });
  } catch (err) {
    console.error("nmi-charge error:", err);
    return json({ error: String(err) }, 500);
  }
});
