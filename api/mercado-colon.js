// Datos del reporte de Mercado Colón leídos en vivo desde la Marketing API de Meta
// (antes venían de un Google Sheet cargado a mano).
//
// Variables de entorno en Vercel:
//   META_ACCESS_TOKEN          token del usuario del sistema (BriefBang App, permiso ads_read)
//   MERCADO_COLON_AD_ACCOUNT   act_1646545253526806
//
// Devuelve las mismas filas que antes salían del Sheet, una por semana (lunes a domingo,
// cortada en el cambio de mes):
//   Locatarios: { campana, mes, semana, inversion, leads }
//   Branding:   { campana, mes, semana, objetivo, inversion, resultado, contenido }
//
// Clasificación: campañas con objetivo de Leads → Locatarios; el resto → Branding,
// donde el resultado es el que Meta reporta para el objetivo de optimización y el
// contenido es el nombre del anuncio.

const API_VERSION = "v21.0";
const SINCE = "2026-10-01"; // inicio de la pauta de Mercado Colón
const TZ = "America/Argentina/Buenos_Aires";

const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

// Nombre legible del resultado que devuelve Meta (results[].indicator).
const OBJETIVOS = {
  total_profile_visits: "Visitas al perfil y a la página",
  profile_visit_view: "Visitas al perfil y a la página",
  reach: "Alcance",
  impressions: "Impresiones",
  link_click: "Clics en el enlace",
  landing_page_view: "Visitas a la página de destino",
  video_thruplay_watched_actions: "Reproducciones de video (ThruPlay)",
  post_engagement: "Interacciones con la publicación",
  "onsite_conversion.messaging_conversation_started_7d": "Conversaciones iniciadas",
};
const LEAD_ACTIONS = ["lead", "onsite_conversion.lead_grouped"];

const pad = n => String(n).padStart(2, "0");
const dmy = d => `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
const isoToDate = s => new Date(s + "T00:00:00Z");

function todayAR() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()); // YYYY-MM-DD
}

// Semana lunes-domingo cortada en el cambio de mes, igual que las filas del Sheet.
function bucketOf(dateStr) {
  const d = isoToDate(dateStr);
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  const start = monday < monthStart ? monthStart : monday;
  const end = sunday > monthEnd ? monthEnd : sunday;
  return { mes: MESES[d.getUTCMonth()], semana: `${dmy(start)} al ${dmy(end)}` };
}

const num = v => (v == null || v === "" ? 0 : Number(v) || 0);
const actionValue = (actions, types) => {
  for (const t of types) {
    const a = (actions || []).find(x => x.action_type === t);
    if (a) return num(a.value);
  }
  return 0;
};

async function fetchAllInsights(account, token, until) {
  const params = new URLSearchParams({
    level: "ad",
    time_increment: "1",
    time_range: JSON.stringify({ since: SINCE, until }),
    fields: "campaign_name,objective,ad_name,spend,actions,results",
    limit: "500",
    access_token: token,
  });
  let url = `https://graph.facebook.com/${API_VERSION}/${account}/insights?${params}`;
  const rows = [];
  while (url) {
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok || body.error) {
      const msg = body.error ? body.error.message : `HTTP ${res.status}`;
      throw new Error(`Meta API: ${msg}`);
    }
    rows.push(...(body.data || []));
    url = body.paging && body.paging.next;
  }
  return rows;
}

function toRecords(daily) {
  const leads = new Map();
  const brand = new Map();
  for (const r of daily) {
    const spend = num(r.spend);
    const { mes, semana } = bucketOf(r.date_start);
    if (r.objective === "OUTCOME_LEADS" || r.objective === "LEAD_GENERATION") {
      const k = `${mes}|${semana}`;
      const row = leads.get(k) || { campana: "Locatarios", mes, semana, inversion: 0, leads: 0 };
      row.inversion += spend;
      row.leads += actionValue(r.actions, LEAD_ACTIONS);
      leads.set(k, row);
    } else {
      const res = (r.results || [])[0];
      const indicator = res ? res.indicator : "";
      const resultado = res ? num(((res.values || [])[0] || {}).value) : 0;
      const objetivo = OBJETIVOS[indicator] || indicator || "Sin objetivo";
      const contenido = (r.ad_name || "").trim();
      const k = `${mes}|${semana}|${objetivo}|${contenido}`;
      const row = brand.get(k) || { campana: "Branding", mes, semana, objetivo, inversion: 0, resultado: 0, contenido };
      row.inversion += spend;
      row.resultado += resultado;
      brand.set(k, row);
    }
  }
  const round = row => ({ ...row, inversion: Math.round(row.inversion * 100) / 100 });
  return {
    locatarios: [...leads.values()].map(round),
    branding: [...brand.values()].filter(r => r.inversion > 0 || r.resultado > 0).map(round),
  };
}

module.exports = async (req, res) => {
  // Tolera valores pegados con espacios/comillas y el ID de cuenta con o sin "act_".
  const clean = v => String(v || "").trim().replace(/^["']|["']$/g, "").trim();
  const token = clean(process.env.META_ACCESS_TOKEN);
  const rawAccount = clean(process.env.MERCADO_COLON_AD_ACCOUNT).replace(/^act_/i, "").replace(/\D/g, "");
  const account = rawAccount ? `act_${rawAccount}` : "";
  if (!token || !account) {
    res.status(500).json({ error: "Faltan META_ACCESS_TOKEN o MERCADO_COLON_AD_ACCOUNT en Vercel." });
    return;
  }
  try {
    const until = todayAR();
    const daily = await fetchAllInsights(account, token, until);
    const data = toRecords(daily);
    // Cache en el edge de Vercel: 15 min fresco, hasta 1 h sirviendo el anterior mientras refresca.
    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
    res.status(200).json({ ...data, updatedAt: new Date().toISOString(), until });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
};
