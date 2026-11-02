// citas-ics — Supabase Edge Function (2 nov 2026). DEPLOY: --no-verify-jwt.
// Calendario iCal con las citas de UN medico, para suscribirse desde Google
// Calendar / Notion Calendar / Apple. GET ?k=<token de staff_calendar_feeds>.
// Privacidad: el calendario es personal (Gmail, sin BAA), asi que cada cita
// sale solo con las INICIALES del paciente y el tipo de visita. Nada clinico.
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SITE = "https://nuviclinic.com";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function rest(p: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${p}`, { headers: { apikey: SB, Authorization: `Bearer ${SB}` } });
  if (!r.ok) throw new Error("DB " + r.status);
  return r.json();
}
export function iniciales(n: string): string {
  const p = String(n || "").trim().split(/\s+/).filter(Boolean);
  if (!p.length) return "Paciente";
  const ini = (p.length > 1 ? [p[0], p[p.length - 1]] : [p[0]]).map((w) => w[0].toUpperCase() + ".");
  return ini.join("");
}
// "9:00 AM" -> minutos
// Acepta "9:00 AM" y tambien "09:00" / "17:00" (las citas que pone el staff).
export function minutos(t: string): number {
  const m = String(t || "").trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if (!m) return -1;
  let h = parseInt(m[1], 10);
  if (m[3]) { h = h % 12; if (m[3].toUpperCase() === "PM") h += 12; }
  return h * 60 + parseInt(m[2], 10);
}
// Puerto Rico es UTC-4 todo el ano (sin horario de verano).
export function utc(fecha: string, mins: number): string {
  const [y, mo, d] = fecha.split("-").map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, 0, 0) + (mins + 240) * 60000);
  return t.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
const esc = (s: string) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

Deno.serve(async (req) => {
  try {
    const k = new URL(req.url).searchParams.get("k") || "";
    if (!UUID.test(k)) return new Response("Not found", { status: 404 });
    const f = await rest(`staff_calendar_feeds?select=staff_user_id&token=eq.${k}&limit=1`);
    if (!Array.isArray(f) || !f.length) return new Response("Not found", { status: 404 });
    const sid = f[0].staff_user_id;
    const desde = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const hasta = new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10);
    const aps = await rest(`appointments?select=id,user_id,appointment_date,appointment_time,status,type,duration_minutes,ticket_number&np_user_id=eq.${sid}&status=neq.cancelled&appointment_date=gte.${desde}&appointment_date=lte.${hasta}&order=appointment_date.asc`);
    const ids = [...new Set((aps || []).map((a: any) => a.user_id))];
    const nombres: Record<string, string> = {};
    const pruebas = new Set<string>();   // cuentas de prueba: no van al calendario
    if (ids.length) {
      const hh = await rest(`health_history?select=user_id,full_name,is_test,created_at&user_id=in.(${ids.join(",")})&order=created_at.desc`);
      for (const h of hh || []) {
        if (h.is_test) pruebas.add(h.user_id);
        if (!nombres[h.user_id]) nombres[h.user_id] = h.full_name || "";
      }
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const L: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//NuVi Clinic//Citas//ES", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      "X-WR-CALNAME:NuVi — Mis citas", "X-WR-TIMEZONE:America/Puerto_Rico", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"];
    for (const a of aps || []) {
      if (pruebas.has(a.user_id)) continue;
      const m = minutos(a.appointment_time);
      if (m < 0) continue;
      const dur = Number(a.duration_minutes) || 30;
      const tipo = a.type === "np_interview" ? "Evaluación" : "Visita";
      L.push("BEGIN:VEVENT", `UID:${a.id}@nuviclinic.com`, `DTSTAMP:${stamp}`,
        `DTSTART:${utc(a.appointment_date, m)}`, `DTEND:${utc(a.appointment_date, m + dur)}`,
        `SUMMARY:${esc(`NuVi · ${tipo} — ${iniciales(nombres[a.user_id])}`)}`,
        `DESCRIPTION:${esc(`Videollamada de ${dur} min. ${a.ticket_number ? "Ticket " + a.ticket_number + ". " : ""}Abre el portal: ${SITE}`)}`,
        `URL:${SITE}`, `LOCATION:${SITE}`, "END:VEVENT");
    }
    L.push("END:VCALENDAR");
    return new Response(L.join("\r\n") + "\r\n", { headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-store" } });
  } catch (e) {
    console.error(e);
    return new Response("Error", { status: 500 });
  }
});
