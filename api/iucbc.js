// Datos de pauta del reporte de IUCBC leídos en vivo desde la API de Google Ads
// (antes "Inversión Google" y "Leads Google" se cargaban a mano en el Google Sheet).
// Meta, Leads en CRM, Calificados, Cierres y Objetivos siguen saliendo del Sheet.
//
// Variables de entorno en Vercel:
//   GADS_CLIENT_ID           cliente OAuth del proyecto de Google Cloud "ads-reporting"
//   GADS_CLIENT_SECRET
//   GADS_REFRESH_TOKEN       refresh token del usuario con acceso al MCC
//   GADS_LOGIN_CUSTOMER_ID   MCC IUCBC (2595192648)
//   IUCBC_GADS_CUSTOMER_ID   opcional, cuenta IUCBC (default 6357789790)
//
// Devuelve una fila por carrera y semana (lunes a domingo, cortada en el cambio de mes,
// igual que las filas del Sheet):
//   google: [{ carrera, mes, semana, inversion, leads }]
// "leads" es la métrica Conversiones de Google Ads (formulario de contacto + WhatsApp,
// las conversiones principales de la cuenta).

const API_VERSION = "v26";
const SINCE = "2026-07-06"; // primera semana del reporte
const TZ = "America/Argentina/Buenos_Aires";
const DEFAULT_CUSTOMER_ID = "6357789790";

const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

// Campaña de Google Ads → carrera del reporte (el nombre tiene que coincidir con CAMPAIGNS
// en iucbc/index.html). Primero por ID; si aparece una campaña nueva, se asigna por nombre.
const CAMPAIGN_IDS = {
  "22752755179": "Medicina",          // IUCBC - Search - Medicina
  "22748994950": "Medicina",          // BB - IUCBC - Pmax - Medicina
  "22749013913": "Bioquimica",        // IUCBC - Search - Bioquimica
  "22752720148": "Bioquimica",        // BB - IUCBC - Pmax - Bioquimica
  "22752743242": "Genetica",          // IUCBC - Search - Genética
  "22742807922": "Genetica",          // BB - IUCBC - Pmax - Genética
  "22617424700": "Branding IUCBC",    // IUCBC - Search - Marca
  "24254702585": "Enfermería Universitaria",                                     // Search - Enfermeria 2026
  "24260201932": "Tecnicatura Universitaria en Prácticas Cardiológicas",         // Search - Prac Cardio 2026
  "24260229571": "Tecnicatura Universitaria en Hemoterapia e Inmunohematologia", // Search - Hemoterapia 2026
  "24249228690": "Tecnicatura Universitaria en Instrumentación Quirúrgica",      // Search - Inst Quir 2026
};
const CAMPAIGN_PATTERNS = [
  [/medicina/i, "Medicina"],
  [/bioqu/i, "Bioquimica"],
  [/gen[eé]tica/i, "Genetica"],
  [/marca|branding/i, "Branding IUCBC"],
  [/enfermer/i, "Enfermería Universitaria"],
  [/cardio/i, "Tecnicatura Universitaria en Prácticas Cardiológicas"],
  [/hemoter/i, "Tecnicatura Universitaria en Hemoterapia e Inmunohematologia"],
  [/instrum|quir/i, "Tecnicatura Universitaria en Instrumentación Quirúrgica"],
];

function carreraOf(id, name) {
  if (CAMPAIGN_IDS[id]) return CAMPAIGN_IDS[id];
  const hit = CAMPAIGN_PATTERNS.find(([re]) => re.test(name || ""));
  return hit ? hit[1] : null;
}

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

const clean = v => String(v || "").trim().replace(/^["']|["']$/g, "").trim();
const digits = v => clean(v).replace(/\D/g, "");

async function accessToken(clientId, clientSecret, refreshToken) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`OAuth Google: ${body.error_description || body.error || res.status}`);
  }
  return body.access_token;
}

async function searchStream(customerId, loginCustomerId, token, query) {
  const res = await fetch(
    `https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/googleAds:searchStream`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "login-customer-id": loginCustomerId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    }
  );
  const body = await res.json();
  if (!res.ok) {
    const err = Array.isArray(body) ? body[0] && body[0].error : body.error;
    throw new Error(`Google Ads API: ${(err && err.message) || `HTTP ${res.status}`}`);
  }
  return (Array.isArray(body) ? body : [body]).flatMap(chunk => chunk.results || []);
}

function toRows(results) {
  const rows = new Map();
  const unmapped = new Map();
  for (const r of results) {
    const cost = Number((r.metrics || {}).costMicros || 0) / 1e6;
    const conv = Number((r.metrics || {}).conversions || 0);
    if (!cost && !conv) continue;
    const { id, name } = r.campaign;
    const carrera = carreraOf(id, name);
    if (!carrera) {
      const u = unmapped.get(id) || { id, name, inversion: 0 };
      u.inversion += cost;
      unmapped.set(id, u);
      continue;
    }
    const { mes, semana } = bucketOf(r.segments.date);
    const k = `${carrera}|${semana}`;
    const row = rows.get(k) || { carrera, mes, semana, inversion: 0, leads: 0 };
    row.inversion += cost;
    row.leads += conv;
    rows.set(k, row);
  }
  return {
    google: [...rows.values()].map(r => ({
      ...r,
      inversion: Math.round(r.inversion * 100) / 100,
      leads: Math.round(r.leads),
    })),
    unmapped: [...unmapped.values()].map(u => ({ ...u, inversion: Math.round(u.inversion * 100) / 100 })),
  };
}

module.exports = async (req, res) => {
  const clientId = clean(process.env.GADS_CLIENT_ID);
  const clientSecret = clean(process.env.GADS_CLIENT_SECRET);
  const refreshToken = clean(process.env.GADS_REFRESH_TOKEN);
  const loginCustomerId = digits(process.env.GADS_LOGIN_CUSTOMER_ID);
  const customerId = digits(process.env.IUCBC_GADS_CUSTOMER_ID) || DEFAULT_CUSTOMER_ID;
  if (!clientId || !clientSecret || !refreshToken || !loginCustomerId) {
    res.status(500).json({ error: "Faltan GADS_CLIENT_ID, GADS_CLIENT_SECRET, GADS_REFRESH_TOKEN o GADS_LOGIN_CUSTOMER_ID en Vercel." });
    return;
  }
  try {
    const until = todayAR();
    const token = await accessToken(clientId, clientSecret, refreshToken);
    const results = await searchStream(customerId, loginCustomerId, token,
      "SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, metrics.conversions " +
      `FROM campaign WHERE segments.date BETWEEN '${SINCE}' AND '${until}'`);
    const data = toRows(results);
    // Cache en el edge de Vercel: 15 min fresco, hasta 1 h sirviendo el anterior mientras refresca.
    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
    res.status(200).json({ ...data, since: SINCE, until, updatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
};
