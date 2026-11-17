// Datos que carga el equipo desde el propio reporte de IUCBC (reemplaza al Google Sheet):
//   - CRM semanal por carrera: Leads en CRM, Calificados, Cierres
//   - Objetivos mensuales por carrera: Inversión, Leads, Calificados, Cierres
//
// Se guardan en Upstash Redis (Vercel → Storage / Marketplace → Upstash for Redis).
// Variables de entorno que agrega la integración (se acepta cualquiera de los dos nombres):
//   KV_REST_API_URL / UPSTASH_REDIS_REST_URL
//   KV_REST_API_TOKEN / UPSTASH_REDIS_REST_TOKEN
//
// Estructura en Redis (un hash por tipo, un campo por fila, así dos personas cargando a la vez
// no se pisan entre sí salvo que editen exactamente la misma fila):
//   iucbc:crm        campo "Carrera|YYYY-MM-DD" (lunes o 1° del mes) → JSON { leadsCRM, calificados, cierres, by, at }
//   iucbc:objetivos  campo "Carrera|YYYY-MM"                         → JSON { invTotal, leadsTotales, calificados, cierres, by, at }
//   iucbc:log        lista con los últimos cambios (quién, cuándo, qué)
//   iucbc:imported   marca de que ya se importó el histórico del Google Sheet
//
// GET  → { crm: [...], objetivos: [...], log: [...] }
// POST → body { by, crm: [{ carrera, semana, leadsCRM, calificados, cierres }],
//               objetivos: [{ mes, carrera, invTotal, leadsTotales, calificados, cierres }] }
//        semana = fecha de inicio "YYYY-MM-DD"; mes = "YYYY-MM". Un valor null borra ese dato.

const CARRERAS = [
  "Medicina", "Bioquimica", "Genetica", "Branding IUCBC",
  "Enfermería Universitaria",
  "Tecnicatura Universitaria en Prácticas Cardiológicas",
  "Tecnicatura Universitaria en Hemoterapia e Inmunohematologia",
  "Tecnicatura Universitaria en Instrumentación Quirúrgica",
];
const CRM_FIELDS = ["leadsCRM", "calificados", "cierres"];
const OBJ_FIELDS = ["invTotal", "leadsTotales", "calificados", "cierres"];
const LOG_MAX = 300;

// ---------- Redis (REST de Upstash, sin dependencias) ----------
function redisConfig() {
  const clean = v => String(v || "").trim().replace(/^["']|["']$/g, "").trim();
  const url = clean(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL).replace(/\/$/, "");
  const token = clean(process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN);
  if (!url || !token) throw new Error("Falta conectar la base de datos (Upstash Redis) al proyecto en Vercel.");
  return { url, token };
}

async function redis(commands) {
  const { url, token } = redisConfig();
  const res = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Redis: ${body.error || res.status}`);
  const failed = body.find(r => r.error);
  if (failed) throw new Error(`Redis: ${failed.error}`);
  return body.map(r => r.result);
}

const hashToObject = arr => {
  const out = {};
  for (let i = 0; i < (arr || []).length; i += 2) out[arr[i]] = arr[i + 1];
  return out;
};

// ---------- Validación ----------
const isISODate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const isYM = s => /^\d{4}-\d{2}$/.test(s || "");
function toNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Valor inválido: ${v}`);
  return Math.round(n * 100) / 100;
}

// ---------- Importación única del histórico del Google Sheet ----------
const SHEET_BASE = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQM4DGn-jO_fDvv0VabFbUdsHMlf5VVEnD0qmGLKMXNe9IDO2aUl6Ew_iGN7afWclnXHuRC7frYBrBw/pub?single=true&output=csv&gid=";
const SHEET_TABS = {
  Medicina: "0",
  Bioquimica: "910403483",
  Genetica: "1669142941",
  "Branding IUCBC": "1052618292",
  "Enfermería Universitaria": "38684080",
  "Tecnicatura Universitaria en Prácticas Cardiológicas": "624948544",
  "Tecnicatura Universitaria en Hemoterapia e Inmunohematologia": "37340132",
  "Tecnicatura Universitaria en Instrumentación Quirúrgica": "1081643568",
};
const SHEET_OBJETIVOS_GID = "1441818073";
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// "1.234,56" / "$450.000,00" / "32,5" → número (formato es-AR del Sheet)
function sheetNumber(raw) {
  let s = String(raw || "").trim().replace(/[^0-9,.\-]/g, "");
  if (!s || s === "-") return null;
  s = s.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeCarrera(raw) {
  const s = (raw || "").trim().toLowerCase();
  if (s.startsWith("med")) return "Medicina";
  if (s.startsWith("bioq")) return "Bioquimica";
  if (s.startsWith("gen")) return "Genetica";
  return CARRERAS.find(c => c.toLowerCase() === s) || null;
}

async function importFromSheet() {
  const at = new Date().toISOString();
  const by = "Importado del Google Sheet";
  const commands = [];
  for (const [carrera, gid] of Object.entries(SHEET_TABS)) {
    const res = await fetch(SHEET_BASE + gid);
    if (!res.ok) continue;
    for (const r of parseCSV(await res.text()).slice(1)) {
      const m = (r[1] || "").match(/^(\d{2})-(\d{2})-(\d{4})/);
      if (!m) continue;
      const vals = { leadsCRM: sheetNumber(r[11]), calificados: sheetNumber(r[12]), cierres: sheetNumber(r[13]) };
      if (CRM_FIELDS.every(f => vals[f] == null)) continue;
      commands.push(["HSET", "iucbc:crm", `${carrera}|${m[3]}-${m[2]}-${m[1]}`, JSON.stringify({ ...vals, by, at })]);
    }
  }
  const res = await fetch(SHEET_BASE + SHEET_OBJETIVOS_GID);
  if (res.ok) {
    for (const r of parseCSV(await res.text()).slice(1)) {
      const mi = MESES.indexOf((r[0] || "").trim().toLowerCase());
      const carrera = normalizeCarrera(r[1]);
      if (mi < 0 || !carrera) continue;
      // El Sheet guarda el mes sin año; el reporte arrancó en julio de 2026.
      const year = mi >= 6 ? 2026 : 2027;
      const vals = { invTotal: sheetNumber(r[2]), leadsTotales: sheetNumber(r[3]), calificados: sheetNumber(r[5]), cierres: sheetNumber(r[7]) };
      commands.push(["HSET", "iucbc:objetivos", `${carrera}|${year}-${String(mi + 1).padStart(2, "0")}`, JSON.stringify({ ...vals, by, at })]);
    }
  }
  if (commands.length) {
    commands.push(["LPUSH", "iucbc:log", JSON.stringify({ at, by, cambios: commands.length, detalle: "Importación inicial del histórico del Google Sheet" })]);
    await redis(commands);
  }
}

// ---------- Lectura ----------
async function readAll() {
  const [crm, obj, log] = await redis([
    ["HGETALL", "iucbc:crm"],
    ["HGETALL", "iucbc:objetivos"],
    ["LRANGE", "iucbc:log", "0", "49"],
  ]);
  const parse = s => { try { return JSON.parse(s); } catch { return {}; } };
  return {
    crm: Object.entries(hashToObject(crm)).map(([k, v]) => {
      const [carrera, semana] = k.split("|");
      return { carrera, semana, ...parse(v) };
    }),
    objetivos: Object.entries(hashToObject(obj)).map(([k, v]) => {
      const [carrera, mes] = k.split("|");
      return { carrera, mes, ...parse(v) };
    }),
    log: (log || []).map(parse),
  };
}

// ---------- Escritura ----------
async function save(body) {
  const by = String(body.by || "").trim().slice(0, 60);
  if (!by) throw new Error("Falta indicar quién carga los datos.");
  const at = new Date().toISOString();
  const commands = [];
  const detalle = [];

  const crmKeys = (body.crm || []).map(r => `${r.carrera}|${r.semana}`);
  const objKeys = (body.objetivos || []).map(r => `${r.carrera}|${r.mes}`);
  if (crmKeys.length + objKeys.length === 0) throw new Error("No hay cambios para guardar.");
  if (crmKeys.length + objKeys.length > 500) throw new Error("Demasiados cambios juntos.");

  for (const r of body.crm || []) {
    if (!CARRERAS.includes(r.carrera) || !isISODate(r.semana)) throw new Error(`Fila inválida: ${r.carrera} ${r.semana}`);
    const vals = {};
    for (const f of CRM_FIELDS) vals[f] = toNumber(r[f]);
    const key = `${r.carrera}|${r.semana}`;
    if (CRM_FIELDS.every(f => vals[f] == null)) commands.push(["HDEL", "iucbc:crm", key]);
    else commands.push(["HSET", "iucbc:crm", key, JSON.stringify({ ...vals, by, at })]);
    detalle.push(`CRM ${r.carrera} semana ${r.semana}`);
  }
  for (const r of body.objetivos || []) {
    if (!CARRERAS.includes(r.carrera) || !isYM(r.mes)) throw new Error(`Fila inválida: ${r.carrera} ${r.mes}`);
    const vals = {};
    for (const f of OBJ_FIELDS) vals[f] = toNumber(r[f]);
    const key = `${r.carrera}|${r.mes}`;
    if (OBJ_FIELDS.every(f => vals[f] == null)) commands.push(["HDEL", "iucbc:objetivos", key]);
    else commands.push(["HSET", "iucbc:objetivos", key, JSON.stringify({ ...vals, by, at })]);
    detalle.push(`Objetivos ${r.carrera} ${r.mes}`);
  }
  commands.push(["LPUSH", "iucbc:log", JSON.stringify({ at, by, cambios: detalle.length, detalle: detalle.slice(0, 20).join(", ") })]);
  commands.push(["LTRIM", "iucbc:log", "0", String(LOG_MAX - 1)]);
  await redis(commands);
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "POST") {
      await save(await readBody(req));
    } else if (req.method !== "GET") {
      res.status(405).json({ error: "Método no permitido" });
      return;
    }
    // La primera vez que se usa, trae el histórico del Google Sheet (una sola vez).
    const [first] = await redis([["SET", "iucbc:imported", new Date().toISOString(), "NX"]]);
    if (first === "OK") {
      try { await importFromSheet(); }
      catch (err) { await redis([["DEL", "iucbc:imported"]]); throw err; }
    }
    res.status(200).json(await readAll());
  } catch (err) {
    const status = /Falta conectar/.test(err.message) ? 503 : /inválid|Falta indicar|No hay cambios|Demasiados/.test(err.message) ? 400 : 502;
    res.status(status).json({ error: err.message });
  }
};
