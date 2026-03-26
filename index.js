// redalert-local-proxy/server.js
// -------------------------------------------------------------
// ✅ Red Alert Local Proxy (Physical PC) — Program vNext (FIXED)
//
// PRIMARY: OREF (Pikud HaOref)
// FALLBACK (optional): TzevaAdom alerts-history (third-party)
//
// Goals:
// 1) Always provide a normalized JSON schema for the cloud Alerts Service.
// 2) Survive OREF failures (timeouts / HTML / blocked / non-JSON) with a safe fallback.
// 3) Avoid flooding sources: single-flight + cache + exponential backoff.
// 4) Provide clear health diagnostics and ping endpoints.
//
// Security:
// - Internal endpoints require x-internal-key
// - Optional: Public API can require x-api-key (recommended in prod)
// - Rate limiting for sensitive routes
// - CORS configurable
// -------------------------------------------------------------

"use strict";

require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const config = require("./config/env");

// -------------------------------------------------------------
// 📝 File logger – writes to logs/proxy.log (max ~10MB, then rotates)
// -------------------------------------------------------------
const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, "proxy.log");
const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10MB

function writeLog(level, ...args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(String).join(" ")}\n`;
  process.stdout.write(line);
  try {
    // Simple rotation: if file > 10MB, rename to .old and start fresh
    if (fs.existsSync(LOG_FILE)) {
      const { size } = fs.statSync(LOG_FILE);
      if (size > LOG_MAX_BYTES) {
        fs.renameSync(LOG_FILE, LOG_FILE + ".old");
      }
    }
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {}
}

const log = {
  info: (...a) => writeLog("INFO", ...a),
  warn: (...a) => writeLog("WARN", ...a),
  error: (...a) => writeLog("ERROR", ...a),
};

// Patch console to also write to file
const _origLog = console.log;
const _origWarn = console.warn;
const _origError = console.error;
console.log = (...a) => writeLog("INFO", ...a);
console.warn = (...a) => writeLog("WARN", ...a);
console.error = (...a) => writeLog("ERROR", ...a);

const app = express();
app.disable("x-powered-by");

// -------------------------------------------------------------
// ✅ Fetch (Node 18+ has global fetch). Fallback to node-fetch if missing.
// -------------------------------------------------------------
const fetchFn =
  typeof global.fetch === "function"
    ? (...args) => global.fetch(...args)
    : (...args) =>
        import("node-fetch").then(({ default: fetch }) => fetch(...args));

const WebSocket = require("ws");

// -------------------------------------------------------------
// ===================== ENV & BASIC CONFIG =====================
// -------------------------------------------------------------
const PORT = Number(config.port || process.env.PORT || 3000);

// ✅ prefer real NODE_ENV first (some config/env loaders hardcode dev)
const NODE_ENV = String(process.env.NODE_ENV || config.env || "development").trim();
app.set("trust proxy", 1);

// -------- Security Keys --------
let INTERNAL_KEY = String(process.env.INTERNAL_KEY || "").trim();
if (!INTERNAL_KEY && NODE_ENV === "production") {
  console.error("[LocalProxy] FATAL: INTERNAL_KEY is not set in production!");
  process.exit(1);
}
if (!INTERNAL_KEY) {
  INTERNAL_KEY = "dev-internal-key";
  console.warn("[LocalProxy] WARNING: Using default INTERNAL_KEY in dev");
}

// Optional public key (recommended)
let API_PUBLIC_KEY = String(process.env.API_PUBLIC_KEY || "").trim();
if (!API_PUBLIC_KEY && NODE_ENV === "production") {
  console.warn("[LocalProxy] WARNING: API_PUBLIC_KEY is missing in production (public API will be open).");
}
if (!API_PUBLIC_KEY && NODE_ENV === "development") {
  // keep empty in dev = open by default
  API_PUBLIC_KEY = "";
}

// -------------------------------------------------------------
// ✅ Primary source: OREF (Pikud HaOref)
// -------------------------------------------------------------
const OREF_URL = "https://www.oref.org.il/warningMessages/alert/Alerts.json";

// -------------------------------------------------------------
// ✅ Fallback source: TzevaAdom alerts-history (third-party) — backup only
// -------------------------------------------------------------
const TZEVAADOM_FALLBACK_ENABLED =
  String(process.env.TZEVAADOM_FALLBACK_ENABLED || "false").toLowerCase() === "true";

const TZEVAADOM_HISTORY_URL = String(
  (process.env.TZEVAADOM_HISTORY_URL || "https://api.tzevaadom.co.il/alerts-history").trim()
);

// How far back we consider fallback alerts "relevant" (ms)
const TZEVAADOM_RECENCY_WINDOW_MS = Number(process.env.TZEVAADOM_RECENCY_WINDOW_MS || 180000);

// Timeout for fallback
const TZEVAADOM_TIMEOUT_MS = Number(process.env.TZEVAADOM_TIMEOUT_MS || 2500);

// -------------------------------------------------------------
// ✅ Parallel source: Tzofar
// -------------------------------------------------------------
const TZOFAR_ENABLED = String(process.env.TZOFAR_ENABLED || "true").toLowerCase() === "true";
const TZOFAR_URL = String(process.env.TZOFAR_URL || "https://api.tzofar.co.il/alerts/active").trim();
const TZOFAR_TIMEOUT_MS = Number(process.env.TZOFAR_TIMEOUT_MS || 2500);
const TZOFAR_RECENCY_WINDOW_MS = Number(process.env.TZOFAR_RECENCY_WINDOW_MS || 60000);
const TZOFAR_BACKOFF_BASE_MS = Number(process.env.TZOFAR_BACKOFF_BASE_MS || 400);
const TZOFAR_BACKOFF_MAX_MS = Number(process.env.TZOFAR_BACKOFF_MAX_MS || 15000);

// Window for deduplicating alerts from multiple parallel sources
const DEDUP_WINDOW_MS = Number(process.env.DEDUP_WINDOW_MS || 90000);

// -------------------------------------------------------------
// Cache / history / timeouts
// -------------------------------------------------------------
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 200);
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 200);
const OREF_TIMEOUT_MS = Number(process.env.OREF_TIMEOUT_MS || 2000);

// -------------------------------------------------------------
// Backoff / cooldown tuning (prevents spamming failing sources)
// -------------------------------------------------------------
const OREF_BACKOFF_BASE_MS = Number(process.env.OREF_BACKOFF_BASE_MS || 400);
const OREF_BACKOFF_MAX_MS = Number(process.env.OREF_BACKOFF_MAX_MS || 15000);

// After using fallback, wait a bit before retrying OREF aggressively
// OREF_RETRY_AFTER_FALLBACK_MS removed — OREF and TzevaAdom now run in parallel

const TZEVA_BACKOFF_BASE_MS = Number(process.env.TZEVA_BACKOFF_BASE_MS || 400);
const TZEVA_BACKOFF_MAX_MS = Number(process.env.TZEVA_BACKOFF_MAX_MS || 15000);

// Circuit breaker: after this many consecutive failures, extend backoff to CIRCUIT_OPEN_MS
// and log a warning. Prevents hammering a clearly-down source every 15s indefinitely.
const CB_OPEN_THRESHOLD = Number(process.env.CB_OPEN_THRESHOLD || 20); // ~5 min at 15s max backoff
const CB_OPEN_BACKOFF_MS = Number(process.env.CB_OPEN_BACKOFF_MS || 60000); // 60s while open

// -------------------------------------------------------------
// ⚡ Webhook push to alerts service (zero-latency path)
// -------------------------------------------------------------
const WEBHOOK_URL = (process.env.WEBHOOK_URL || "").trim();
const WEBHOOK_KEY = (process.env.WEBHOOK_KEY || INTERNAL_KEY).trim();
const WEBHOOK_INTERVAL_MS = Number(process.env.WEBHOOK_INTERVAL_MS || 150);

// -------------------------------------------------------------
// ✅ Tzeva Adom WebSocket (push channel: pre-alert + all-clear + active alerts)
// -------------------------------------------------------------
const TZEVAADOM_WS_ENABLED = String(process.env.TZEVAADOM_WS_ENABLED || "true").toLowerCase() === "true";
const TZEVAADOM_WS_URL = process.env.TZEVAADOM_WS_URL || "wss://ws.tzevaadom.co.il/socket?platform=WEB";
const WS_ALERT_TTL_MS = Number(process.env.WS_ALERT_TTL_MS || 180000); // 3 min
const WS_PRE_ALERT_TTL_MS = Number(process.env.WS_PRE_ALERT_TTL_MS || 1200000); // 20 min
const WS_ALL_CLEAR_TTL_MS = Number(process.env.WS_ALL_CLEAR_TTL_MS || 300000);  // 5 min

// -------------------------------------------------------------
// In-memory state
// -------------------------------------------------------------
let lastRaw = null;
let lastParsed = null;
let lastFetchedAt = 0;

// source of last successful fetch: "oref" | "tzevaadom" | "cache" | null
let lastSource = null;

// OREF status
let lastOrefOk = null;
let lastOrefStatus = null;
let lastOrefError = null;
let lastOrefParseOk = null;

// Fallback status
let lastTzevaOk = null;
let lastTzevaStatus = null;
let lastTzevaError = null;

// Single-flight
let inflightFetch = null;

// History (lightweight)
let history = []; // { ts, status, ok, source, rawPreview, parsed }

// Backoff state
let orefFailCount = 0;
let orefBackoffUntil = 0;
let orefLastSuccessAt = 0;

let tzevaFailCount = 0;
let tzevaBackoffUntil = 0;
let tzevaLastSuccessAt = 0;

// Tzofar state
let tzofarFailCount = 0;
let tzofarBackoffUntil = 0;
let tzofarLastSuccessAt = 0;
let lastTzofarOk = null;
let lastTzofarStatus = null;
let lastTzofarError = null;

// If we used fallback, we'll avoid hammering OREF for a short time
let orefRetryAfterFallbackUntil = 0;

// Basic stats
const stats = {
  startedAt: Date.now(),
  totalFetchAttempts: 0,
  cacheHits: 0,
  orefAttempts: 0,
  orefSuccess: 0,
  tzevaAttempts: 0,
  tzevaSuccess: 0,
  tzofarAttempts: 0,
  tzofarSuccess: 0,
  errors: 0,
};

// WebSocket state
let wsConnected = false;
let wsReconnectAttempt = 0;
let wsLastConnectedAt = null;
let wsAlertsFromWs = [];   // [{ id, title, category, cities, source, eventTs, threat, expiresAt }]
let wsPreAlert = null;     // { bodyHe, bodyEn, titleHe, citiesIds, zoneIds, receivedAt, expiresAt }
let wsAllClear = null;     // { bodyHe, citiesIds, zoneIds, receivedAt, expiresAt }

// threat ID (Pushy/WS) → category string
const WS_THREAT_CATEGORY = {
  0: "rocket",
  1: "hazmat",
  2: "terrorist",
  3: "earthquake",
  4: "tsunami",
  5: "uav",
  6: "radiological",
  9: "earthquake",
  11: "rocket",
};

// -------------------------------------------------------------
// ===================== Helpers: normalize / keys =====================
// -------------------------------------------------------------
function normalizeString(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeCityKey(s) {
  return normalizeString(s)
    .replace(/[-–—]/g, " ")
    .replace(/[״"]/g, "")
    .replace(/[׳'']/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function normalizeZoneId(id) {
  return normalizeString(id).toLowerCase();
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function safeJsonStringify(x) {
  try {
    return JSON.stringify(x);
  } catch {
    return "";
  }
}

// Simple "content hash" for dedupe at cloud side (optional)
function hashAlerts(alertsArr) {
  return safeJsonStringify(alertsArr || []);
}

// Select latest alert by eventTs (fallback to first)
function pickLatestAlert(alertsArr) {
  if (!Array.isArray(alertsArr) || alertsArr.length === 0) return null;
  let best = alertsArr[0];
  for (const a of alertsArr) {
    const tsA = Number(a?.eventTs) || 0;
    const tsB = Number(best?.eventTs) || 0;
    if (tsA > tsB) best = a;
  }
  return best;
}

// -------------------------------------------------------------
// ===================== Middleware =====================
// -------------------------------------------------------------
app.use(helmet());
app.use(express.json({ limit: "1mb" }));

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => normalizeString(s))
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      const normOrigin = normalizeString(origin);

      if (ALLOWED_ORIGINS.length === 0) {
        if (NODE_ENV === "development") return callback(null, true);
        return callback(new Error("CORS: Origin not allowed"));
      }

      if (ALLOWED_ORIGINS.includes(normOrigin)) return callback(null, true);
      return callback(new Error("CORS: Origin not allowed"));
    },
  })
);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: NODE_ENV === "production" ? 100 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
});

// Internal endpoints are protected by requireInternalKey – no rate limiting needed there
app.use(["/alerts-debug", "/config"], apiLimiter);

function requireInternalKey(req, res, next) {
  const key = normalizeString(req.headers["x-internal-key"]);
  if (!key || key !== INTERNAL_KEY) {
    return res.status(401).json({
      error: "UNAUTHORIZED_INTERNAL",
      code: "UNAUTHORIZED_INTERNAL",
    });
  }
  next();
}

// Optional public key middleware (enabled only if API_PUBLIC_KEY exists)
function requirePublicKeyIfConfigured(req, res, next) {
  if (!API_PUBLIC_KEY) return next(); // open when not configured
  const key = normalizeString(req.headers["x-api-key"]);
  if (!key || key !== API_PUBLIC_KEY) {
    return res.status(401).json({
      error: "UNAUTHORIZED_PUBLIC",
      code: "UNAUTHORIZED_PUBLIC",
    });
  }
  next();
}

// -------------------------------------------------------------
// ===================== Zones config =====================
// -------------------------------------------------------------
const zonesConfigPath = path.join(__dirname, "config", "zones.config.json");
const cityZonesConfigPath = path.join(__dirname, "config", "city_zones.config.json");
const orefCitiesConfigPath = path.join(__dirname, "config", "oref_cities.json");

let zonesConfig = [];
let cityZonesConfig = [];
let zonesById = new Map(); // zoneId(norm) -> zoneConfig
let cityZonesByName = new Map(); // cityKey -> zoneId(norm)
let cityOriginalNameByKey = new Map();
let cityNameByOrefId = new Map(); // OREF/TzevaAdom numeric cityId -> Hebrew city name

function safeReadJson(filePath, defaultValue = []) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("[LocalProxy] Failed reading JSON:", filePath, err.message);
    return defaultValue;
  }
}

function buildZonesIndexes() {
  zonesById = new Map();
  for (const z of zonesConfig) {
    const zoneIdNorm = normalizeZoneId(z.zoneId);
    if (!zoneIdNorm) continue;
    zonesById.set(zoneIdNorm, {
      ...z,
      zoneId: normalizeString(z.zoneId),
      zoneName: normalizeString(z.zoneName || z.name || ""),
    });
  }

  cityZonesByName = new Map();
  cityOriginalNameByKey = new Map();

  for (const c of cityZonesConfig) {
    const originalCityName = normalizeString(c.cityName || c.city);
    const key = normalizeCityKey(originalCityName);
    const zoneIdNorm = normalizeZoneId(c.zoneId);

    if (!key || !zoneIdNorm) continue;

    if (cityZonesByName.has(key) && cityZonesByName.get(key) !== zoneIdNorm) {
      console.warn(
        "[LocalProxy] Duplicate city mapping with different zoneId:",
        originalCityName,
        "existing=",
        cityZonesByName.get(key),
        "new=",
        zoneIdNorm,
        "(ignored)"
      );
      continue;
    }

    if (!cityZonesByName.has(key)) {
      cityZonesByName.set(key, zoneIdNorm);
      cityOriginalNameByKey.set(key, originalCityName);
    }
  }

  console.log("[LocalProxy] Zones loaded:", zonesById.size, "zoneIds,", cityZonesByName.size, "cities");
}

function loadZonesConfigs() {
  zonesConfig = safeReadJson(zonesConfigPath, []);
  cityZonesConfig = safeReadJson(cityZonesConfigPath, []);
  buildZonesIndexes();

  // Build OREF city-ID → Hebrew name map (used to resolve TzevaAdom citiesIds in pre-alerts)
  const orefCities = safeReadJson(orefCitiesConfigPath, []);
  cityNameByOrefId = new Map();
  for (const c of orefCities) {
    if (c.id > 0 && c.name) cityNameByOrefId.set(c.id, c.name);
  }
  console.log("[LocalProxy] OREF cities loaded:", cityNameByOrefId.size, "entries");
}

// Load once on boot
loadZonesConfigs();

// Resolve an array of TzevaAdom/OREF numeric city IDs to unique zone IDs
function resolveZonesFromCityIds(cityIds) {
  if (!Array.isArray(cityIds) || cityIds.length === 0) return [];
  const zoneSet = new Set();
  for (const id of cityIds) {
    const cityName = cityNameByOrefId.get(Number(id));
    if (!cityName) continue;
    const zoneId = resolveZone(cityName);
    if (zoneId) zoneSet.add(zoneId);
  }
  return Array.from(zoneSet);
}

// --------------------- zone enrich ---------------------
function resolveZone(cityName) {
  const key = normalizeCityKey(cityName);
  if (!key) return null;
  return cityZonesByName.get(key) || null;
}

function enrichAlertWithZoneInfo(alert) {
  if (!alert || typeof alert !== "object") return alert;

  const cities = Array.isArray(alert.cities)
    ? alert.cities.map((c) => normalizeString(c)).filter(Boolean)
    : [];

  const primaryCity = cities[0];
  const zoneIdNorm = resolveZone(primaryCity);

  if (!zoneIdNorm) {
    return { ...alert, cities, zoneId: null, zoneName: null, protectionTimeSeconds: null };
  }

  const zone = zonesById.get(zoneIdNorm) || {};
  return {
    ...alert,
    cities,
    zoneId: zone.zoneId || zoneIdNorm,
    zoneName: zone.zoneName || null,
    protectionTimeSeconds:
      zone.protectionTimeSeconds !== undefined ? zone.protectionTimeSeconds : null,
  };
}

function enrichParsedWithZoneInfo(parsed) {
  if (!parsed || typeof parsed !== "object") return parsed;
  if (Array.isArray(parsed.alerts)) {
    return { ...parsed, alerts: parsed.alerts.map(enrichAlertWithZoneInfo) };
  }
  return parsed;
}

// -------------------------------------------------------------
// ===================== Normalization =====================
// -------------------------------------------------------------
// Output schema (always):
// { alerts: [ { id, title, category, cities:[], source, eventTs, raw, ... } ] }

/**
 * ממיר category מספרי של פיקוד העורף ל-string סמנטי:
 *  cat 1        → "rocket"
 *  cat 2        → "uav"          (חדירת כלי טיס)
 *  cat 10       → "pre_alert" אם title מכיל "בדקות", אחרת "end_of_shelter"
 *  cat 13       → "end_of_shelter"
 *  cat 14       → "pre_alert"
 *  drill (15+)  → category_drill
 *  אחר         → "alert"
 */
function resolveOrefCategory(rawCat, title) {
  const n = Number(rawCat);
  const t = String(title || "");

  if (n === 1)  return "rocket";
  if (n === 2)  return "uav";
  if (n === 10) return t.includes("בדקות") ? "pre_alert" : "end_of_shelter";
  if (n === 13) return "end_of_shelter";
  if (n === 14) return "pre_alert";
  if (n >= 15)  return "drill";
  if (rawCat === "rocket" || rawCat === "missiles") return "rocket";
  return "alert";
}

function normalizeOrefJson(parsed, eventTsMs) {
  if (!parsed) return { alerts: [] };

  // Some OREF variants
  if (Array.isArray(parsed.alerts)) {
    return {
      alerts: parsed.alerts.map((a, idx) => {
        const title = normalizeString(a.title ?? "");
        const rawCat = a.category ?? a.cat ?? "";
        return {
          ...a,
          id: a.id ?? idx,
          title,
          category: resolveOrefCategory(rawCat, title),
          cities: Array.isArray(a.cities) ? a.cities.map((c) => normalizeString(c)).filter(Boolean) : [],
          source: "oref",
          eventTs: eventTsMs,
        };
      }),
    };
  }

  let rawAlerts = [];
  if (Array.isArray(parsed)) rawAlerts = parsed;
  else if (Array.isArray(parsed.data)) rawAlerts = parsed.data;
  else return { alerts: [] };

  const alerts = rawAlerts.map((item, idx) => {
    let cities = [];

    if (Array.isArray(item.cities)) {
      cities = item.cities.map((c) => normalizeString(c)).filter(Boolean);
    } else if (typeof item.data === "string") {
      cities = item.data
        .split(/[,\n;]/)
        .map((s) => normalizeString(s))
        .filter(Boolean);
    }

    const title = normalizeString(item.title ?? "");
    const rawCat = item.category ?? item.cat ?? "";

    return {
      id: item.id ?? idx,
      title,
      category: resolveOrefCategory(rawCat, title),
      cities,
      raw: item,
      source: "oref",
      eventTs: eventTsMs,
    };
  });

  return { alerts };
}

// TzevaAdom alerts-history expected:
// [ { id, description, alerts:[{ time, cities, threat, isDrill }] }, ... ]
function normalizeTzevaAdomJson(json) {
  const now = Date.now();
  const out = [];

  if (!Array.isArray(json)) return { alerts: [] };

  for (const row of json) {
    const alerts = Array.isArray(row?.alerts) ? row.alerts : [];
    for (const a of alerts) {
      const sec = Number(a?.time);
      if (!Number.isFinite(sec)) continue;

      const tsMs = sec * 1000;

      // ✅ "fresh past only"
      const delta = now - tsMs;
      if (delta < 0) continue;
      if (delta > TZEVAADOM_RECENCY_WINDOW_MS) continue;

      const cities = Array.isArray(a?.cities) ? a.cities.map((c) => normalizeString(c)).filter(Boolean) : [];
      if (!cities.length) continue;

      const threatNum = Number(a?.threat);
      const threat = Number.isFinite(threatNum) ? threatNum : null;
      const isDrill = a?.isDrill === true;

      out.push({
        id: `${sec}-${cities.join("|")}`,
        title: "צבע אדום",
        category: threat === 0 ? "rocket" : "alert",
        cities,
        threat,
        isDrill,
        raw: { rowId: row?.id ?? null, description: row?.description ?? null, ...a },
        source: "tzevaadom",
        eventTs: tsMs,
      });
    }
  }

  return { alerts: out };
}

// -------------------------------------------------------------
// ===================== Multi-source deduplication =====================
// -------------------------------------------------------------
// Priority: OREF (0) > Tzofar (1) > TzevaAdom-WS (2) > TzevaAdom-HTTP (3)
const SOURCE_PRIORITY = { oref: 0, tzofar: 1, "tzevaadom-ws": 2, tzevaadom: 3, "tzevaadom-direct": 4 };

function deduplicateAlerts(alertsArr) {
  // Sort by source priority so higher-priority alerts are processed first
  const sorted = [...alertsArr].sort((a, b) => {
    const pa = SOURCE_PRIORITY[a.source] ?? 99;
    const pb = SOURCE_PRIORITY[b.source] ?? 99;
    return pa - pb;
  });

  // seen: "cityKey::category" → timestamp of already-accepted alert
  const seen = new Map();
  const result = [];

  for (const alert of sorted) {
    const cities = Array.isArray(alert.cities) ? alert.cities : [];
    const cat = normalizeString(alert.category || "");
    const ts = Number(alert.eventTs) || 0;

    // An alert is a duplicate if ANY of its cities was already seen
    // from a higher-priority source within DEDUP_WINDOW_MS
    let isDuplicate = false;
    for (const city of cities) {
      const key = `${normalizeCityKey(city)}::${cat}`;
      const existing = seen.get(key);
      if (existing !== undefined && Math.abs(existing - ts) <= DEDUP_WINDOW_MS) {
        isDuplicate = true;
        break;
      }
    }

    if (isDuplicate) continue;

    // Register all cities of this alert as seen
    for (const city of cities) {
      const key = `${normalizeCityKey(city)}::${cat}`;
      if (!seen.has(key)) seen.set(key, ts);
    }

    result.push(alert);
  }

  return result;
}

// -------------------------------------------------------------
// ===================== Backoff helpers =====================
// -------------------------------------------------------------
function computeBackoffMs(failCount, baseMs, maxMs) {
  const n = Math.min(failCount, 6);
  return Math.min(maxMs, baseMs * Math.pow(2, n));
}

function canTryOrefNow() {
  const now = Date.now();
  if (now < orefBackoffUntil) return false;
  if (now < orefRetryAfterFallbackUntil) return false;
  return true;
}

function canTryTzevaNow() {
  const now = Date.now();
  if (now < tzevaBackoffUntil) return false;
  return true;
}

function canTryTzofarNow() {
  if (!TZOFAR_ENABLED) return false;
  return Date.now() >= tzofarBackoffUntil;
}

// -------------------------------------------------------------
// ===================== Network fetch helpers =====================
// -------------------------------------------------------------
async function fetchTextWithTimeout(url, timeoutMs, headers = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetchFn(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json,text/plain,*/*",
        ...headers,
      },
    });

    const text = await resp.text();
    return { resp, text };
  } finally {
    clearTimeout(t);
  }
}

async function fetchFromOrefNetwork() {
  stats.orefAttempts += 1;
  const { resp, text } = await fetchTextWithTimeout(OREF_URL, OREF_TIMEOUT_MS, {
    Referer: "https://www.oref.org.il/",
    "X-Requested-With": "XMLHttpRequest",
  });

  lastOrefStatus = resp.status;
  lastOrefOk = resp.ok;

  const trimmed = (text || "").trim();

  // Empty = no alerts (valid)
  if (!trimmed) {
    lastOrefParseOk = true;
    return { ok: resp.ok, status: resp.status, raw: text, parsed: { alerts: [] }, parseOk: true };
  }

  // If HTML / non JSON -> treat as parse fail => trigger fallback
  const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  if (!looksJson || trimmed.startsWith("<")) {
    lastOrefParseOk = false;
    throw new Error("OREF returned non-JSON response (blocked/HTML)");
  }

  const parsedTry = safeJsonParse(trimmed);
  if (!parsedTry.ok) {
    lastOrefParseOk = false;
    throw new Error(`OREF JSON parse failed: ${parsedTry.error.message}`);
  }

  lastOrefParseOk = true;
  return { ok: resp.ok, status: resp.status, raw: text, parsed: parsedTry.value, parseOk: true };
}

async function fetchFromTzofarNetwork() {
  stats.tzofarAttempts += 1;
  const { resp, text } = await fetchTextWithTimeout(TZOFAR_URL, TZOFAR_TIMEOUT_MS);

  lastTzofarStatus = resp.status;
  lastTzofarOk = resp.ok;

  const trimmed = (text || "").trim();
  if (!trimmed) return { ok: resp.ok, status: resp.status, raw: text, parsed: [] };

  const parsedTry = safeJsonParse(trimmed);
  if (!parsedTry.ok) throw new Error(`Tzofar JSON parse failed: ${parsedTry.error.message}`);

  return { ok: resp.ok, status: resp.status, raw: text, parsed: parsedTry.value };
}

// Tzofar format (flexible): array at root, or { alerts:[...] }, or { id, alerts:[...] }
// Each item: { id, cat, title, cities:[], time: unix_seconds or ms or ISO }
function normalizeTzofarJson(json, fetchedAtMs) {
  const now = fetchedAtMs || Date.now();
  const out = [];

  let rawAlerts = [];
  if (Array.isArray(json)) rawAlerts = json;
  else if (json && Array.isArray(json.alerts)) rawAlerts = json.alerts;
  else return { alerts: [] };

  for (const a of rawAlerts) {
    if (!a || typeof a !== "object") continue;

    const cities = Array.isArray(a.cities)
      ? a.cities.map((c) => normalizeString(c)).filter(Boolean)
      : [];
    if (!cities.length) continue;

    // time: unix seconds (<1e10) or unix ms (>=1e10) or ISO string
    let eventTs = now;
    if (a.time != null) {
      const n = Number(a.time);
      if (Number.isFinite(n) && n > 0) {
        eventTs = n < 1e10 ? n * 1000 : n;
      } else if (typeof a.time === "string") {
        const d = Date.parse(a.time);
        if (Number.isFinite(d)) eventTs = d;
      }
    }

    const delta = now - eventTs;
    if (delta < 0 || delta > TZOFAR_RECENCY_WINDOW_MS) continue;

    const cat = a.cat ?? a.category ?? a.threat ?? null;
    const catNum = cat !== null ? Number(cat) : NaN;

    out.push({
      id: a.id != null ? String(a.id) : `tzofar-${eventTs}-${cities.join("|")}`,
      title: normalizeString(a.title || "צבע אדום"),
      category: catNum === 1 || cat === "rocket" || cat === "missiles" ? "rocket" : "alert",
      cities,
      raw: a,
      source: "tzofar",
      eventTs,
    });
  }

  return { alerts: out };
}

async function fetchFromTzevaAdomNetwork() {
  stats.tzevaAttempts += 1;
  const { resp, text } = await fetchTextWithTimeout(TZEVAADOM_HISTORY_URL, TZEVAADOM_TIMEOUT_MS);

  lastTzevaStatus = resp.status;
  lastTzevaOk = resp.ok;

  const trimmed = (text || "").trim();
  if (!trimmed) {
    return { ok: resp.ok, status: resp.status, raw: text, parsed: [] };
  }

  const parsedTry = safeJsonParse(trimmed);
  if (!parsedTry.ok) {
    throw new Error(`TZEVAADOM JSON parse failed: ${parsedTry.error.message}`);
  }

  return { ok: resp.ok, status: resp.status, raw: text, parsed: parsedTry.value };
}

// -------------------------------------------------------------
// ===================== Smart fetch (cache + single-flight) =====================
// -------------------------------------------------------------
async function fetchAlertsSmart(force = false) {
  const now = Date.now();

  // Cache
  if (!force && lastRaw && now - lastFetchedAt < CACHE_TTL_MS) {
    stats.cacheHits += 1;
    lastSource = "cache";
    return {
      raw: lastRaw,
      parsed: lastParsed,
      fromCache: true,
      status: lastOrefStatus ?? lastTzevaStatus ?? 200,
      ok: lastOrefOk ?? lastTzevaOk ?? true,
      source: lastParsed?.alerts?.[0]?.source || lastSource || "cache",
    };
  }

  // Single-flight
  if (!force && inflightFetch) return inflightFetch;

  inflightFetch = (async () => {
    stats.totalFetchAttempts += 1;
    const fetchedAt = Date.now();

    try {
      lastOrefError = null;
      lastTzevaError = null;

      // ---- Run all sources in parallel ----
      const [orefResult, tzofarResult, tzevaResult] = await Promise.allSettled([
        canTryOrefNow()
          ? fetchFromOrefNetwork()
          : Promise.reject(new Error(`OREF in backoff until ${new Date(Math.max(orefBackoffUntil, orefRetryAfterFallbackUntil)).toISOString()}`)),
        canTryTzofarNow()
          ? fetchFromTzofarNetwork()
          : Promise.reject(new Error(`Tzofar in backoff until ${new Date(tzofarBackoffUntil).toISOString()}`)),
        TZEVAADOM_FALLBACK_ENABLED && canTryTzevaNow()
          ? fetchFromTzevaAdomNetwork()
          : Promise.reject(new Error(TZEVAADOM_FALLBACK_ENABLED ? `TzevaAdom in backoff until ${new Date(tzevaBackoffUntil).toISOString()}` : "TzevaAdom fallback disabled")),
      ]);

      // ---- Process OREF ----
      let orefAlerts = [];
      if (orefResult.status === "fulfilled") {
        try {
          const normalized = normalizeOrefJson(orefResult.value.parsed, fetchedAt);
          orefAlerts = (normalized.alerts || []).map(a => ({ ...a, source: "oref" }));
          lastOrefOk = true;
          lastOrefStatus = orefResult.value.status;
          orefFailCount = 0;
          orefBackoffUntil = 0;
          orefLastSuccessAt = fetchedAt;
          stats.orefSuccess += 1;
        } catch (e) {
          lastOrefOk = false;
          lastOrefError = e.message;
          orefFailCount += 1;
          const orefBackoff = orefFailCount >= CB_OPEN_THRESHOLD ? CB_OPEN_BACKOFF_MS : computeBackoffMs(orefFailCount, OREF_BACKOFF_BASE_MS, OREF_BACKOFF_MAX_MS);
          if (orefFailCount === CB_OPEN_THRESHOLD) log.warn(`[CB] OREF circuit open after ${orefFailCount} failures — backing off ${CB_OPEN_BACKOFF_MS / 1000}s`);
          orefBackoffUntil = fetchedAt + orefBackoff;
        }
      } else {
        lastOrefOk = false;
        lastOrefError = orefResult.reason?.message || String(orefResult.reason);
        if (orefResult.reason?.isNetworkError) {
          orefFailCount += 1;
          const orefBackoff = orefFailCount >= CB_OPEN_THRESHOLD ? CB_OPEN_BACKOFF_MS : computeBackoffMs(orefFailCount, OREF_BACKOFF_BASE_MS, OREF_BACKOFF_MAX_MS);
          if (orefFailCount === CB_OPEN_THRESHOLD) log.warn(`[CB] OREF circuit open after ${orefFailCount} failures — backing off ${CB_OPEN_BACKOFF_MS / 1000}s`);
          orefBackoffUntil = fetchedAt + orefBackoff;
        }
      }

      // ---- Process Tzofar ----
      let tzofarAlerts = [];
      if (tzofarResult.status === "fulfilled") {
        try {
          const normalized = normalizeTzofarJson(tzofarResult.value.parsed, fetchedAt);
          tzofarAlerts = (normalized.alerts || []).map(a => ({ ...a, source: "tzofar" }));
          lastTzofarOk = true;
          lastTzofarStatus = tzofarResult.value.status;
          tzofarFailCount = 0;
          tzofarBackoffUntil = 0;
          tzofarLastSuccessAt = fetchedAt;
          stats.tzofarSuccess += 1;
        } catch (e) {
          lastTzofarOk = false;
          lastTzofarError = e.message;
          tzofarFailCount += 1;
          tzofarBackoffUntil = fetchedAt + computeBackoffMs(tzofarFailCount, TZOFAR_BACKOFF_BASE_MS, TZOFAR_BACKOFF_MAX_MS);
        }
      } else {
        lastTzofarOk = false;
        lastTzofarError = tzofarResult.reason?.message || String(tzofarResult.reason);
        if (tzofarResult.reason?.isNetworkError) {
          tzofarFailCount += 1;
          tzofarBackoffUntil = fetchedAt + computeBackoffMs(tzofarFailCount, TZOFAR_BACKOFF_BASE_MS, TZOFAR_BACKOFF_MAX_MS);
        }
      }

      // ---- Process TzevaAdom ----
      let tzevaAlerts = [];
      if (tzevaResult.status === "fulfilled") {
        try {
          const normalized = normalizeTzevaAdomJson(tzevaResult.value.parsed);
          tzevaAlerts = (normalized.alerts || []).map(a => ({ ...a, source: "tzevaadom" }));
          lastTzevaOk = true;
          lastTzevaStatus = tzevaResult.value.status;
          tzevaFailCount = 0;
          tzevaBackoffUntil = 0;
          tzevaLastSuccessAt = fetchedAt;
          stats.tzevaSuccess += 1;
          // ✅ FIX: לא לדחות OREF כשTzevaAdom עובד — שניהם צריכים לרוץ במקביל
        } catch (e) {
          lastTzevaOk = false;
          lastTzevaError = e.message;
          tzevaFailCount += 1;
          tzevaBackoffUntil = fetchedAt + computeBackoffMs(tzevaFailCount, TZEVA_BACKOFF_BASE_MS, TZEVA_BACKOFF_MAX_MS);
        }
      } else {
        lastTzevaOk = false;
        lastTzevaError = tzevaResult.reason?.message || String(tzevaResult.reason);
        if (tzevaResult.reason?.isNetworkError) {
          tzevaFailCount += 1;
          tzevaBackoffUntil = fetchedAt + computeBackoffMs(tzevaFailCount, TZEVA_BACKOFF_BASE_MS, TZEVA_BACKOFF_MAX_MS);
        }
      }

      // ---- Merge + deduplicate ----
      const allAlerts = deduplicateAlerts([...orefAlerts, ...tzofarAlerts, ...tzevaAlerts]);

      // Only throw if ALL sources were rejected (network/parse errors) —
      // empty alerts array is valid: it means no active alerts right now.
      const allSourcesRejected =
        orefResult.status === "rejected" &&
        tzofarResult.status === "rejected" &&
        tzevaResult.status === "rejected";

      if (allSourcesRejected) {
        stats.errors += 1;
        const errMsg = [
          lastOrefError && `OREF: ${lastOrefError}`,
          lastTzofarError && `Tzofar: ${lastTzofarError}`,
          lastTzevaError && `TzevaAdom: ${lastTzevaError}`,
        ].filter(Boolean).join(" | ");
        log.error("[LocalProxy]", errMsg || "All alert sources failed");

        // Emergency: if OREF was skipped only because of backoff (not a real network failure),
        // bypass the backoff immediately and retry OREF. This prevents missing real alarms
        // when Tzofar/TzevaAdom are unavailable and OREF is only blocked by our own backoff timer.
        const orefWasInBackoff = orefResult.reason?.message?.includes("backoff");
        if (orefWasInBackoff) {
          log.warn("[LocalProxy] All sources failed + OREF was in backoff — forcing emergency OREF retry");
          orefBackoffUntil = 0;
          orefRetryAfterFallbackUntil = 0;
          try {
            const emRes = await fetchFromOrefNetwork();
            const emNorm = normalizeOrefJson(emRes.parsed, Date.now());
            const emAlerts = (emNorm.alerts || []).map(a => ({ ...a, source: "oref" }));
            orefFailCount = 0;
            orefBackoffUntil = 0;
            orefLastSuccessAt = Date.now();
            stats.orefSuccess += 1;
            const emParsed = { alerts: emAlerts };
            const emRaw = JSON.stringify(emParsed);
            lastRaw = emRaw;
            lastParsed = emParsed;
            lastFetchedAt = Date.now();
            lastSource = "oref";
            log.info("[LocalProxy] Emergency OREF retry succeeded, alerts:", emAlerts.length);
            return { raw: emRaw, parsed: emParsed, fromCache: false, status: 200, ok: true, source: "oref" };
          } catch (emErr) {
            log.error("[LocalProxy] Emergency OREF retry also failed:", emErr.message);
            orefFailCount += 1;
            orefBackoffUntil = Date.now() + computeBackoffMs(orefFailCount, OREF_BACKOFF_BASE_MS, OREF_BACKOFF_MAX_MS);
          }
        }

        // Return stale cached data if available — do NOT throw.
        // This ensures the Alerts Service still gets a response and can
        // detect new alerts from the cache instead of getting a 500 error.
        if (lastRaw && lastParsed) {
          return {
            raw: lastRaw,
            parsed: lastParsed,
            fromCache: true,
            stale: true,
            status: 200,
            ok: true,
            source: `stale(${lastSource || "unknown"})`,
          };
        }
        // No cache at all — now we throw (first boot with no data)
        throw new Error(errMsg || "All alert sources failed");
      }

      // Build merged source string from sources that actually responded
      const sourceParts = [];
      if (orefResult.status === "fulfilled") sourceParts.push("oref");
      if (tzofarResult.status === "fulfilled") sourceParts.push("tzofar");
      if (tzevaResult.status === "fulfilled") sourceParts.push("tzevaadom");
      const mergedSource = sourceParts.join("+") || "unknown";

      const mergedParsed = { alerts: allAlerts };
      const mergedRaw = JSON.stringify(mergedParsed);

      lastRaw = mergedRaw;
      lastParsed = mergedParsed;
      lastFetchedAt = fetchedAt;
      lastSource = mergedSource;

      history.push({
        ts: fetchedAt,
        status: 200,
        ok: true,
        source: mergedSource,
        rawPreview: mergedRaw.substring(0, 4000),
        parsed: mergedParsed,
      });
      if (history.length > HISTORY_LIMIT) history = history.slice(history.length - HISTORY_LIMIT);

      return { raw: mergedRaw, parsed: mergedParsed, fromCache: false, status: 200, ok: true, source: mergedSource };
    } catch (err) {
      stats.errors += 1;
      throw err;
    } finally {
      inflightFetch = null;
    }
  })();

  return inflightFetch;
}

// -------------------------------------------------------------
// ===================== Tzeva Adom WebSocket (push channel) =====================
// -------------------------------------------------------------
function startTzevaAdomWebSocket() {
  if (!TZEVAADOM_WS_ENABLED) {
    log.info("[WS] Tzeva Adom WebSocket disabled (TZEVAADOM_WS_ENABLED=false)");
    return;
  }

  log.info(`[WS] Connecting to ${TZEVAADOM_WS_URL} (attempt ${wsReconnectAttempt + 1})`);

  let ws;
  try {
    ws = new WebSocket(TZEVAADOM_WS_URL, {
      headers: {
        "Origin": "https://www.tzevaadom.co.il",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      handshakeTimeout: 10000,
    });
  } catch (e) {
    log.error("[WS] Failed to create WebSocket:", e.message);
    wsReconnectAttempt++;
    const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempt), 30000);
    setTimeout(startTzevaAdomWebSocket, delay);
    return;
  }

  ws.on("open", () => {
    wsConnected = true;
    wsLastConnectedAt = Date.now();
    wsReconnectAttempt = 0;
    log.info("[WS] Connected to Tzeva Adom WebSocket");
  });

  ws.on("message", (data) => {
    const now = Date.now();
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }

    if (msg.type === "ALERT") {
      const d = msg.data || {};
      const cities = Array.isArray(d.cities) ? d.cities.map((c) => normalizeString(c)).filter(Boolean) : [];
      const threatNum = Number(d.threat);
      const category = WS_THREAT_CATEGORY[threatNum] || "alert";
      const isDrill = d.isDrill === true;

      log.info(`[WS] ALERT: threat=${d.threat} category=${category} cities=${cities.length} drill=${isDrill}`);

      if (!isDrill && cities.length > 0) {
        wsAlertsFromWs = cities.map((city) => ({
          id: `ws-${now}-${city}`,
          title: "צבע אדום",
          category,
          cities: [city],
          source: "tzevaadom-ws",
          eventTs: now,
          threat: threatNum,
          expiresAt: now + WS_ALERT_TTL_MS,
        }));
        // Bust polling cache so next request includes these immediately
        lastFetchedAt = 0;
      }

    } else if (msg.type === "SYSTEM_MESSAGE") {
      const d = msg.data || {};

      if (d.instructionType === 0) {
        // Pre-alert (התראה מקדימה)
        log.info("[WS] PRE-ALERT:", d.bodyHe || d.titleHe || "(no text)");
        const preAlertCityIds = Array.isArray(d.citiesIds) ? d.citiesIds : [];
        wsPreAlert = {
          bodyHe: d.bodyHe || "",
          bodyEn: d.bodyEn || "",
          titleHe: d.titleHe || "",
          citiesIds: preAlertCityIds,
          zoneIds: resolveZonesFromCityIds(preAlertCityIds),
          receivedAt: now,
          expiresAt: now + WS_PRE_ALERT_TTL_MS,
        };
        log.info(`[WS] PRE-ALERT resolved ${preAlertCityIds.length} cityIds → ${wsPreAlert.zoneIds.length} zones:`, wsPreAlert.zoneIds.join(", ") || "(none)");
        // Bust cache so the pre-alert appears on next poll
        lastFetchedAt = 0;

      } else if (d.instructionType === 1) {
        // All-clear / end of stay (ניתן לצאת מהמרחב המוגן)
        log.info("[WS] ALL-CLEAR:", d.bodyHe || "(no text)");
        const allClearCityIds = Array.isArray(d.citiesIds) ? d.citiesIds : [];
        wsAllClear = {
          bodyHe: d.bodyHe || "",
          citiesIds: allClearCityIds,
          zoneIds: resolveZonesFromCityIds(allClearCityIds),
          receivedAt: now,
          expiresAt: now + WS_ALL_CLEAR_TTL_MS,
        };
        log.info(`[WS] ALL-CLEAR resolved ${allClearCityIds.length} cityIds → ${wsAllClear.zoneIds.length} zones:`, wsAllClear.zoneIds.join(", ") || "(none — broadcast)");
        // Clear WS-injected alerts — stay in shelter is over
        wsAlertsFromWs = [];
        lastFetchedAt = 0;
      }
    }
  });

  ws.on("close", (code) => {
    wsConnected = false;
    wsReconnectAttempt++;
    const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempt), 30000);
    log.warn(`[WS] Disconnected (code=${code}), reconnecting in ${delay}ms (attempt ${wsReconnectAttempt})`);
    setTimeout(startTzevaAdomWebSocket, delay);
  });

  ws.on("error", (err) => {
    // close event will handle reconnect; just log here
    log.error("[WS] Error:", err.message);
  });
}

// -------------------------------------------------------------
// ===================== Public API helpers =====================
// -------------------------------------------------------------
function healthPayload() {
  const now = Date.now();
  return {
    status: "ok",
    env: NODE_ENV,
    uptimeSec: Math.round(process.uptime()),
    lastFetchedAt,
    lastFetchedAtIso: lastFetchedAt ? new Date(lastFetchedAt).toISOString() : null,
    lastSource,
    sources: {
      oref: { ok: lastOrefOk, status: lastOrefStatus, error: lastOrefError, failCount: orefFailCount, lastSuccessAt: orefLastSuccessAt },
      tzofar: { ok: lastTzofarOk, status: lastTzofarStatus, error: lastTzofarError, failCount: tzofarFailCount, lastSuccessAt: tzofarLastSuccessAt, enabled: TZOFAR_ENABLED },
      tzevaadom: { ok: lastTzevaOk, status: lastTzevaStatus, error: lastTzevaError, failCount: tzevaFailCount, lastSuccessAt: tzevaLastSuccessAt, enabled: TZEVAADOM_FALLBACK_ENABLED },
      tzevaadomWs: {
        enabled: TZEVAADOM_WS_ENABLED,
        connected: wsConnected,
        lastConnectedAt: wsLastConnectedAt,
        reconnectAttempt: wsReconnectAttempt,
        activeWsAlerts: wsAlertsFromWs.filter((a) => a.expiresAt > now).length,
        preAlert: wsPreAlert && wsPreAlert.expiresAt > now ? true : false,
        allClear: wsAllClear && wsAllClear.expiresAt > now ? true : false,
      },
    },
  };
}

function buildAlertsEnvelope(result, enrichedParsed) {
  const now = Date.now();

  // Clean up expired WS alerts
  wsAlertsFromWs = wsAlertsFromWs.filter((a) => a.expiresAt > now);

  // Merge WS-pushed alerts with polling alerts (dedup by city+category)
  const pollingAlerts = Array.isArray(enrichedParsed?.alerts) ? enrichedParsed.alerts : [];
  const allAlerts = wsAlertsFromWs.length > 0
    ? deduplicateAlerts([...wsAlertsFromWs, ...pollingAlerts])
    : pollingAlerts;

  const contentHash = hashAlerts(allAlerts);

  // WS events: pre-alert and all-clear (expire automatically)
  const activePreAlert = wsPreAlert && wsPreAlert.expiresAt > now ? wsPreAlert : null;
  const activeAllClear = wsAllClear && wsAllClear.expiresAt > now ? wsAllClear : null;

  return {
    ts: lastFetchedAt || null,
    tsIso: lastFetchedAt ? new Date(lastFetchedAt).toISOString() : null,
    source: result?.source || lastSource || null,
    fromCache: !!result?.fromCache,
    ok: result?.ok !== false,
    httpStatus: result?.status ?? null,
    contentHash,
    alerts: allAlerts,
    wsEvents: {
      preAlert: activePreAlert
        ? { bodyHe: activePreAlert.bodyHe, titleHe: activePreAlert.titleHe, citiesIds: activePreAlert.citiesIds, zoneIds: activePreAlert.zoneIds || [], receivedAt: activePreAlert.receivedAt }
        : null,
      allClear: activeAllClear
        ? { bodyHe: activeAllClear.bodyHe, citiesIds: activeAllClear.citiesIds || [], zoneIds: activeAllClear.zoneIds || [], receivedAt: activeAllClear.receivedAt }
        : null,
    },
  };
}

// -------------------------------------------------------------
// ===================== Routes =====================
// -------------------------------------------------------------

// Public health (open)
app.get("/health", (req, res) => res.json(healthPayload()));

// ✅ API v1 meta (compat) — JSON directly (no redirect)
// Optional protection via x-api-key if API_PUBLIC_KEY is configured.
app.get("/api/v1/meta", requirePublicKeyIfConfigured, (req, res) => res.json(healthPayload()));

// Legacy alias (optional)
app.get("/alerts", requirePublicKeyIfConfigured, (req, res) => res.json(healthPayload()));

// ✅ Public: active alerts list (normalized + enriched)
app.get("/api/v1/alerts/active", requirePublicKeyIfConfigured, async (req, res, next) => {
  try {
    const result = await fetchAlertsSmart(false);
    const enrichedParsed = enrichParsedWithZoneInfo(result.parsed);
    return res.json(buildAlertsEnvelope(result, enrichedParsed));
  } catch (err) {
    next(err);
  }
});

// ✅ Public: latest alert (normalized + enriched)
// Returns 204 when no active alerts (but still returns envelope)
app.get("/api/v1/alerts/latest", requirePublicKeyIfConfigured, async (req, res, next) => {
  try {
    const result = await fetchAlertsSmart(false);
    const enrichedParsed = enrichParsedWithZoneInfo(result.parsed);
    const envlp = buildAlertsEnvelope(result, enrichedParsed);

    const latest = pickLatestAlert(envlp.alerts);
    if (!latest) {
      return res.status(204).json({ ...envlp, alert: null, alertsCount: 0 });
    }
    return res.json({ ...envlp, alert: latest, alertsCount: envlp.alerts.length });
  } catch (err) {
    next(err);
  }
});

// Optional convenience: /api/v1/alerts -> active
app.get("/api/v1/alerts", requirePublicKeyIfConfigured, async (req, res, next) => {
  try {
    const result = await fetchAlertsSmart(false);
    const enrichedParsed = enrichParsedWithZoneInfo(result.parsed);
    return res.json(buildAlertsEnvelope(result, enrichedParsed));
  } catch (err) {
    next(err);
  }
});

// DEBUG city->zone (public)
app.get("/debug/city", (req, res) => {
  const rawName = req.query.name;
  const inputName = normalizeString(rawName);
  const key = normalizeCityKey(rawName);

  if (!inputName) {
    return res.status(400).json({ error: "MISSING_NAME", message: "missing ?name=" });
  }

  const zoneIdNorm = cityZonesByName.get(key);
  if (!zoneIdNorm) {
    return res.status(404).json({
      found: false,
      input: inputName,
      normalizedKey: key,
      message: "city not found in city_zones.config.json",
    });
  }

  const zone = zonesById.get(zoneIdNorm) || null;
  const originalCityName = cityOriginalNameByKey.get(key) || inputName;

  return res.json({
    found: true,
    input: inputName,
    normalizedKey: key,
    city: originalCityName,
    zoneId: zone ? zone.zoneId : zoneIdNorm,
    zoneName: zone ? zone.zoneName || zone.name || null : null,
  });
});

// Internal: proxy-health (used by cloud Alerts Service)
app.get("/internal/proxy-health", requireInternalKey, async (req, res) => {
  const now = Date.now();
  const ageMs = lastFetchedAt ? now - lastFetchedAt : null;

  let ok = true;
  let message = "using cached data";
  let statusCode = lastOrefStatus ?? lastTzevaStatus ?? 200;
  let source = lastSource || null;

  try {
    const result = await fetchAlertsSmart(false);
    statusCode = result.status ?? statusCode;
    source = result.source || source;

    if (result.ok === false) {
      ok = false;
      message = `source returned HTTP ${statusCode}`;
    } else {
      message = `last fetch OK (${result.fromCache ? "cache" : "fresh"}) from ${source}`;
    }
  } catch (e) {
    ok = false;
    message = e.message || "fetch failed";
  }

  const alertsCount = lastParsed && Array.isArray(lastParsed.alerts) ? lastParsed.alerts.length : 0;

  res.json({
    status: ok ? "up" : "degraded",
    env: NODE_ENV,
    now: new Date(now).toISOString(),

    source: {
      lastSource: source,
      cacheTtlMs: CACHE_TTL_MS,
      lastFetchedAt: lastFetchedAt || null,
      lastFetchedAtIso: lastFetchedAt ? new Date(lastFetchedAt).toISOString() : null,
      ageMs,
      contentHash: lastParsed?.alerts ? hashAlerts(lastParsed.alerts) : "",
      message,
    },

    oref: {
      ok: lastOrefOk,
      httpStatus: lastOrefStatus,
      parseOk: lastOrefParseOk,
      lastError: lastOrefError,
      timeoutMs: OREF_TIMEOUT_MS,
      backoffMs: orefBackoffUntil ? Math.max(0, orefBackoffUntil - Date.now()) : 0,
      failCount: orefFailCount,
      lastSuccessAt: orefLastSuccessAt || null,
      lastSuccessAtIso: orefLastSuccessAt ? new Date(orefLastSuccessAt).toISOString() : null,
      retryAfterFallbackMs: orefRetryAfterFallbackUntil
        ? Math.max(0, orefRetryAfterFallbackUntil - Date.now())
        : 0,
    },

    tzofar: {
      enabled: TZOFAR_ENABLED,
      url: TZOFAR_URL,
      ok: lastTzofarOk,
      httpStatus: lastTzofarStatus,
      lastError: lastTzofarError,
      timeoutMs: TZOFAR_TIMEOUT_MS,
      recencyWindowMs: TZOFAR_RECENCY_WINDOW_MS,
      backoffMs: tzofarBackoffUntil ? Math.max(0, tzofarBackoffUntil - Date.now()) : 0,
      failCount: tzofarFailCount,
      lastSuccessAt: tzofarLastSuccessAt || null,
      lastSuccessAtIso: tzofarLastSuccessAt ? new Date(tzofarLastSuccessAt).toISOString() : null,
    },

    tzevaadom: {
      enabled: TZEVAADOM_FALLBACK_ENABLED,
      url: TZEVAADOM_HISTORY_URL,
      ok: lastTzevaOk,
      httpStatus: lastTzevaStatus,
      lastError: lastTzevaError,
      timeoutMs: TZEVAADOM_TIMEOUT_MS,
      recencyWindowMs: TZEVAADOM_RECENCY_WINDOW_MS,
      backoffMs: tzevaBackoffUntil ? Math.max(0, tzevaBackoffUntil - Date.now()) : 0,
      failCount: tzevaFailCount,
      lastSuccessAt: tzevaLastSuccessAt || null,
      lastSuccessAtIso: tzevaLastSuccessAt ? new Date(tzevaLastSuccessAt).toISOString() : null,
    },

    alerts: { count: alertsCount },

    zones: { zoneIds: zonesById.size, cities: cityZonesByName.size },

    history: { count: history.length, limit: HISTORY_LIMIT },

    stats: {
      startedAt: stats.startedAt,
      startedAtIso: new Date(stats.startedAt).toISOString(),
      totalFetchAttempts: stats.totalFetchAttempts,
      cacheHits: stats.cacheHits,
      orefAttempts: stats.orefAttempts,
      orefSuccess: stats.orefSuccess,
      tzofarAttempts: stats.tzofarAttempts,
      tzofarSuccess: stats.tzofarSuccess,
      tzevaAttempts: stats.tzevaAttempts,
      tzevaSuccess: stats.tzevaSuccess,
      errors: stats.errors,
    },
  });
});

// Internal: ping Tzofar (HTTP + parse)
app.get("/internal/tzofar-ping", requireInternalKey, async (req, res) => {
  const t0 = Date.now();
  try {
    const r = await fetchFromTzofarNetwork();
    const latencyMs = Date.now() - t0;
    const normalized = normalizeTzofarJson(r.parsed, t0);
    res.json({
      ok: !!r.ok,
      httpStatus: r.status,
      latencyMs,
      alertCount: normalized.alerts?.length ?? 0,
      rawPreview: (r.raw || "").substring(0, 500),
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, latencyMs: Date.now() - t0 });
  }
});

// Internal: ping OREF (HTTP + parse)
app.get("/internal/oref-ping", requireInternalKey, async (req, res) => {
  const t0 = Date.now();
  try {
    const r = await fetchFromOrefNetwork();
    const latencyMs = Date.now() - t0;

    res.json({
      ok: !!r.ok,
      httpStatus: r.status ?? null,
      latencyMs,
      parseOk: !!r.parseOk,
      timeoutMs: OREF_TIMEOUT_MS,
      url: OREF_URL,
    });
  } catch (e) {
    res.status(502).json({
      ok: false,
      latencyMs: Date.now() - t0,
      error: e.message,
      timeoutMs: OREF_TIMEOUT_MS,
      url: OREF_URL,
    });
  }
});

// Internal: ping TzevaAdom (HTTP + parse)
app.get("/internal/tzevaadom-ping", requireInternalKey, async (req, res) => {
  const t0 = Date.now();
  try {
    const r = await fetchFromTzevaAdomNetwork();
    const latencyMs = Date.now() - t0;

    const itemsCount = Array.isArray(r.parsed) ? r.parsed.length : 0;

    res.json({
      ok: !!r.ok,
      httpStatus: r.status ?? null,
      latencyMs,
      parseOk: true,
      itemsCount,
      url: TZEVAADOM_HISTORY_URL,
      timeoutMs: TZEVAADOM_TIMEOUT_MS,
      recencyWindowMs: TZEVAADOM_RECENCY_WINDOW_MS,
      enabled: TZEVAADOM_FALLBACK_ENABLED,
    });
  } catch (e) {
    res.status(502).json({
      ok: false,
      latencyMs: Date.now() - t0,
      error: e.message,
      url: TZEVAADOM_HISTORY_URL,
      enabled: TZEVAADOM_FALLBACK_ENABLED,
    });
  }
});

// Internal: debug fetch (force refresh + fallback if needed)
app.get("/alerts-debug", requireInternalKey, async (req, res, next) => {
  try {
    const result = await fetchAlertsSmart(true);
    res.json({
      status: 200,
      source: result.source,
      ok: result.ok,
      httpStatus: result.status,
      fromCache: result.fromCache,
      length: result.raw ? result.raw.length : 0,
      preview: (result.raw || "").substring(0, 240),
      parsedSample: result.parsed ? safeJsonStringify(result.parsed).substring(0, 400) : null,
    });
  } catch (err) {
    next(err);
  }
});

// Internal: raw (whatever last source returned)
app.get("/internal/alerts-raw", requireInternalKey, async (req, res, next) => {
  try {
    const result = await fetchAlertsSmart(false);
    res.status(200).set("Content-Type", "text/plain; charset=utf-8").send(result.raw || "");
  } catch (err) {
    next(err);
  }
});

// Internal: normalized + zone info + transparent statuses
app.get("/internal/alerts-normalized", requireInternalKey, async (req, res, next) => {
  try {
    const result = await fetchAlertsSmart(false);
    const enrichedParsed = enrichParsedWithZoneInfo(result.parsed);

    const alertsArr = Array.isArray(enrichedParsed?.alerts) ? enrichedParsed.alerts : [];
    const contentHash = hashAlerts(alertsArr);

    res.json({
      ts: lastFetchedAt,
      tsIso: lastFetchedAt ? new Date(lastFetchedAt).toISOString() : null,
      source: result.source,
      fromCache: result.fromCache,
      contentHash,
      parsed: enrichedParsed,

      primary: { ok: lastOrefOk, httpStatus: lastOrefStatus, parseOk: lastOrefParseOk, lastError: lastOrefError },
      fallback: { enabled: TZEVAADOM_FALLBACK_ENABLED, ok: lastTzevaOk, httpStatus: lastTzevaStatus, lastError: lastTzevaError },
    });
  } catch (err) {
    next(err);
  }
});

// Internal: history (preview)
app.get("/internal/alerts-history", requireInternalKey, (req, res) => {
  const limit = parseInt(normalizeString(req.query.limit || "50"), 10);
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, HISTORY_LIMIT) : 50;

  const trimmed = history.slice(Math.max(history.length - safeLimit, 0));
  res.json({ count: trimmed.length, items: trimmed });
});

// Public config endpoints
app.get("/config/zones", (req, res) => res.json(zonesConfig));
app.get("/config/city-zones", (req, res) => res.json(cityZonesConfig));

// Reload config without restart
app.post("/internal/reload-config", requireInternalKey, (req, res) => {
  try {
    loadZonesConfigs();
    res.json({ status: "OK", zones: zonesConfig.length, cities: cityZonesConfig.length });
  } catch (err) {
    console.error("[LocalProxy] reload-config error:", err.message);
    res.status(500).json({ error: "RELOAD_CONFIG_ERROR" });
  }
});

// -------------------------------------------------------------
// ✅ Not Found handler (JSON) — prevents HTML "Cannot GET ..."
// -------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: "not_found", path: req.path });
});

// -------------------------------------------------------------
// ===================== Global error handler =====================
// -------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error("[LocalProxy] Error:", err.message);
  const status = err.status || 500;

  const payload = {
    error: true,
    status,
    code: err.code || "INTERNAL_SERVER_ERROR",
    message: NODE_ENV === "development" ? err.message : "Internal server error",
  };

  if (NODE_ENV === "development" && err.stack) payload.stack = err.stack;
  res.status(status).json(payload);
});

// -------------------------------------------------------------
// ⚡ Webhook self-poll loop – detects hash change, pushes to alerts service
// -------------------------------------------------------------
let _webhookLastHash = "";
let _webhookFailCount = 0;

async function webhookTick() {
  try {
    const result = await fetchAlertsSmart(false);
    const enrichedParsed = enrichParsedWithZoneInfo(result.parsed);
    const envelope = buildAlertsEnvelope(result, enrichedParsed);

    // ✅ FIX: כלול wsEvents ב-hash כדי לזהות שינויי preAlert / allClear
    // גם כשאין שינוי ברשימת האזעקות עצמה.
    const wsEventsKey = JSON.stringify({
      preAlert: envelope.wsEvents?.preAlert?.receivedAt ?? null,
      allClear: envelope.wsEvents?.allClear?.receivedAt ?? null,
    });
    const fullHash = envelope.contentHash + "|" + wsEventsKey;

    if (fullHash === _webhookLastHash) return;
    _webhookLastHash = fullHash;

    if (!WEBHOOK_URL) return;

    fetchFn(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-key": WEBHOOK_KEY,
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(2000),
    })
      .then((r) => {
        if (r.ok) {
          _webhookFailCount = 0;
        } else {
          _webhookFailCount++;
          if (_webhookFailCount % 10 === 1)
            log.warn(`[webhook] HTTP ${r.status} (fail #${_webhookFailCount})`);
        }
      })
      .catch((e) => {
        _webhookFailCount++;
        if (_webhookFailCount % 10 === 1)
          log.warn(`[webhook] error (fail #${_webhookFailCount}):`, e.message);
      });
  } catch (_) {
    // fetchAlertsSmart errors are logged internally
  }
}

if (WEBHOOK_URL) {
  setInterval(webhookTick, WEBHOOK_INTERVAL_MS).unref();
  log.info(`[webhook] enabled → ${WEBHOOK_URL} every ${WEBHOOK_INTERVAL_MS}ms`);
} else {
  log.info("[webhook] disabled (WEBHOOK_URL not set)");
}

// -------------------------------------------------------------
// ===================== Process hardening =====================
// -------------------------------------------------------------
process.on("unhandledRejection", (err) => {
  console.error("[LocalProxy] unhandledRejection:", err);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("[LocalProxy] uncaughtException:", err);
  process.exit(1);
});

// Graceful shutdown — allows PM2 / Docker to restart cleanly
const _server = app.listen; // captured below after listen() call
let _httpServer;

function gracefulShutdown(signal) {
  console.log(`[LocalProxy] ${signal} received — shutting down gracefully`);
  if (_httpServer) {
    _httpServer.close(() => {
      console.log("[LocalProxy] HTTP server closed");
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
  setTimeout(() => {
    console.error("[LocalProxy] Force exit after 10s timeout");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));

// -------------------------------------------------------------
// ===================== Start server =====================
// -------------------------------------------------------------
_httpServer = app.listen(PORT, () => {
  console.log(`[LocalProxy] listening on http://127.0.0.1:${PORT}`);
  console.log("[LocalProxy] ENV:", NODE_ENV);
  console.log("[LocalProxy] INTERNAL_KEY:", INTERNAL_KEY ? "[SET]" : "[MISSING]");
  console.log("[LocalProxy] API_PUBLIC_KEY:", API_PUBLIC_KEY ? "[SET]" : "[MISSING/OPEN]");
  console.log("[LocalProxy] OREF_TIMEOUT_MS:", OREF_TIMEOUT_MS);
  console.log("[LocalProxy] TZOFAR_ENABLED:", TZOFAR_ENABLED);
  console.log("[LocalProxy] TZOFAR_URL:", TZOFAR_URL);
  console.log("[LocalProxy] TZOFAR_TIMEOUT_MS:", TZOFAR_TIMEOUT_MS);
  console.log("[LocalProxy] TZEVAADOM_FALLBACK_ENABLED:", TZEVAADOM_FALLBACK_ENABLED);
  console.log("[LocalProxy] TZEVAADOM_HISTORY_URL:", TZEVAADOM_HISTORY_URL);
  console.log("[LocalProxy] TZEVAADOM_WS_ENABLED:", TZEVAADOM_WS_ENABLED);
  console.log("[LocalProxy] DEDUP_WINDOW_MS:", DEDUP_WINDOW_MS);
  console.log("[LocalProxy] Sources: OREF + " + (TZOFAR_ENABLED ? "Tzofar" : "Tzofar[OFF]") + " + " + (TZEVAADOM_FALLBACK_ENABLED ? "TzevaAdom-HTTP" : "TzevaAdom-HTTP[OFF]") + " + " + (TZEVAADOM_WS_ENABLED ? "TzevaAdom-WS" : "TzevaAdom-WS[OFF]") + " (parallel)");

  // Start WebSocket push channel (non-blocking)
  startTzevaAdomWebSocket();
});

