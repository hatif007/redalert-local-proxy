// redalert-local-proxy/server.js

require('dotenv').config();

const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config/env');

const app = express();

// ===================== ENV & BASIC CONFIG =====================

const PORT = config.port || process.env.PORT || 3000;
const NODE_ENV = config.nodeEnv || process.env.NODE_ENV || 'development';

// ✅ נסמוך על הפרוקסי (Cloudflare / Railway וכו') כדי ש־rate-limit יעבוד עם X-Forwarded-For
app.set('trust proxy', 1);

// מפתח פנימי בין Railway לבין השרת הביתי
let INTERNAL_KEY = process.env.INTERNAL_KEY;

// ב-prod אסור לעבוד עם מפתח דיפולטי או חסר
if (!INTERNAL_KEY && NODE_ENV === 'production') {
  console.error('[LocalProxy] FATAL: INTERNAL_KEY is not set in production!');
  process.exit(1);
}

// ב-dev אפשר להשתמש בדיפולט, אבל נדפיס אזהרה
if (!INTERNAL_KEY) {
  INTERNAL_KEY = 'dev-internal-key';
  console.warn('[LocalProxy] WARNING: Using default INTERNAL_KEY in development mode');
}

const OREF_URL = 'https://www.oref.org.il/warningMessages/alert/Alerts.json';

// הגדרות Cache / היסטוריה
const CACHE_TTL_MS = 1000;       // כמה זמן (ב־ms) לשמור תשובה לפני בקשה חדשה
const HISTORY_LIMIT = 200;       // עד כמה רשומות היסטוריה לשמור

let lastRaw = null;              // הטקסט האחרון מ־Oref
let lastParsed = null;           // JSON מנורמל (אם הצליח)
let lastFetchedAt = 0;
let history = [];                // מערך של { ts, raw, parsed }

// ===================== GLOBAL MIDDLEWARES =====================

// אבטחה בסיסית – headers
app.use(helmet());

// פרסור JSON (אם נצטרך בעתיד ל־POST)
app.use(express.json());

// CORS – ב-dev פתוח, ב-prod ניתן להגדיר ALLOWED_ORIGINS
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // קריאות ללא origin (למשל מהשרת) – נאפשר
      if (!origin) {
        return callback(null, true);
      }

      // אם לא הוגדרו origins – ב-dev נאפשר הכול, ב-prod נחסום
      if (ALLOWED_ORIGINS.length === 0) {
        if (NODE_ENV === 'development') {
          return callback(null, true);
        }
        return callback(new Error('CORS: Origin not allowed'));
      }

      if (ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error('CORS: Origin not allowed'));
    },
  })
);

// Rate limit – הגנה בסיסית מ-abuse
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 דקות
  max: NODE_ENV === 'production' ? 100 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
});

// מגבילים קריאות ל-/internal ו-/alerts-debug ו-/config
app.use(['/internal', '/alerts-debug', '/config'], apiLimiter);

// ===================== ZONES CONFIG =====================

// מסלולים לקבצי הקונפיג
const zonesConfigPath = path.join(__dirname, 'config', 'zones.config.json');
const cityZonesConfigPath = path.join(__dirname, 'config', 'city_zones.config.json');

let zonesConfig = [];
let cityZonesConfig = [];
let zonesById = new Map();       // zoneId -> zoneConfig
let cityZonesByName = new Map(); // cityName -> zoneId

function normalizeString(s) {
  if (s === null || s === undefined) return '';
  return String(s).trim();
}

function safeReadJson(filePath, defaultValue = []) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[LocalProxy] Failed to read JSON config:', filePath, err.message);
    return defaultValue;
  }
}

function buildZonesIndexes() {
  zonesById = new Map(zonesConfig.map((z) => [normalizeString(z.zoneId), z]));

  cityZonesByName = new Map(
    cityZonesConfig.map((c) => [
      normalizeString(c.cityName),
      normalizeString(c.zoneId),
    ])
  );

  console.log(
    '[LocalProxy] Zones loaded:',
    zonesById.size,
    'zoneIds,',
    cityZonesByName.size,
    'cities'
  );
}

function loadZonesConfigs() {
  zonesConfig = safeReadJson(zonesConfigPath, []);
  cityZonesConfig = safeReadJson(cityZonesConfigPath, []);
  buildZonesIndexes();
}

// טעינה חד-פעמית בעת עליית השרת
loadZonesConfigs();

// ===================== ZONES LOGIC =====================

function resolveZone(cityName) {
  const cleanCity = normalizeString(cityName);
  if (!cleanCity) return null;
  return cityZonesByName.get(cleanCity) || null;
}

function enrichAlertWithZoneInfo(alert) {
  if (!alert || typeof alert !== 'object') return alert;

  const cities = Array.isArray(alert.cities) ? alert.cities : [];
  const primaryCity = cities[0];

  const zoneId = resolveZone(primaryCity);
  if (!zoneId) {
    return {
      ...alert,
      zoneId: null,
      zoneName: null,
      protectionTimeSeconds: null,
    };
  }

  const zone = zonesById.get(zoneId) || {};

  return {
    ...alert,
    zoneId,
    zoneName: zone.zoneName || null,
    protectionTimeSeconds:
      zone.protectionTimeSeconds !== undefined
        ? zone.protectionTimeSeconds
        : null,
  };
}

function enrichParsedWithZoneInfo(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;

  if (Array.isArray(parsed.alerts)) {
    return {
      ...parsed,
      alerts: parsed.alerts.map(enrichAlertWithZoneInfo),
    };
  }

  if (Array.isArray(parsed.cities)) {
    return enrichAlertWithZoneInfo(parsed);
  }

  return parsed;
}

// ===================== OREF FETCH + CACHE =====================

async function fetchFromOref(force = false) {
  const now = Date.now();

  // Cache מקומי
  if (!force && lastRaw && now - lastFetchedAt < CACHE_TTL_MS) {
    return { raw: lastRaw, parsed: lastParsed, fromCache: true };
  }

  const response = await fetch(OREF_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://www.oref.org.il/',
      'X-Requested-With': 'XMLHttpRequest',
    },
  });

  const text = await response.text();

  lastRaw = text;
  lastFetchedAt = now;

  let parsed = null;
  const trimmed = text.trim();
  if (trimmed && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      console.warn('Failed to parse Oref JSON:', e.message);
    }
  }

  // שכבת נירמול → תמיד מחזירים parsed.alerts
  const normalized = normalizeOrefJson(parsed);
  lastParsed = normalized;

  // שמירת היסטוריה
  history.push({
    ts: now,
    raw: text,
    parsed: normalized,
  });
  if (history.length > HISTORY_LIMIT) {
    history = history.slice(history.length - HISTORY_LIMIT);
  }

  return { raw: text, parsed: normalized, fromCache: false, status: response.status };
}

// ===================== NORMALIZATION LAYER =====================

/**
 * הפיכת JSON מה-OREF למבנה אחיד:
 * { alerts: [ { id, title, cities: [...], raw: {...} } ] }
 */
function normalizeOrefJson(parsed) {
  if (!parsed) {
    return { alerts: [] };
  }

  if (Array.isArray(parsed.alerts)) {
    return { alerts: parsed.alerts };
  }

  let rawAlerts = [];

  if (Array.isArray(parsed)) {
    rawAlerts = parsed;
  } else if (Array.isArray(parsed.data)) {
    rawAlerts = parsed.data;
  } else {
    return { alerts: [] };
  }

  const alerts = rawAlerts.map((item, idx) => {
    let cities = [];

    if (Array.isArray(item.cities)) {
      cities = item.cities;
    } else if (typeof item.data === 'string') {
      cities = item.data
        .split(/[,\n;]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }

    return {
      id: item.id ?? idx,
      title: item.title ?? null,
      category: item.category ?? item.cat ?? null,
      cities,
      raw: item,
    };
  });

  return { alerts };
}

// ===================== MIDDLEWARE =====================

function requireInternalKey(req, res, next) {
  const key = req.headers['x-internal-key'];

  if (!key || key !== INTERNAL_KEY) {
    return res.status(401).json({
      error: 'UNAUTHORIZED_INTERNAL',
      code: 'UNAUTHORIZED_INTERNAL',
    });
  }

  next();
}

// ===================== ROUTES =====================

// בדיקת בריאות בסיסית (פתוח לכולם)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    env: NODE_ENV,
    uptimeSec: Math.round(process.uptime()),
    lastFetchedAt,
  });
});

// DEBUG – לראות מה קורה מול Oref
app.get('/alerts-debug', async (req, res, next) => {
  try {
    const result = await fetchFromOref(true); // מכריח רענון
    res.json({
      status: 200,
      fromCache: result.fromCache,
      length: result.raw.length,
      preview: result.raw.substring(0, 200),
      parsedSample: result.parsed
        ? JSON.stringify(result.parsed).substring(0, 300)
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// 1) נתונים גולמיים כמו שהם (Raw)
app.get('/internal/alerts-raw', requireInternalKey, async (req, res, next) => {
  try {
    const result = await fetchFromOref(false);
    res
      .status(200)
      .set('Content-Type', 'text/plain; charset=utf-8')
      .send(result.raw);
  } catch (err) {
    next(err);
  }
});

// 2) נתונים מנורמלים + ZoneInfo
app.get(
  '/internal/alerts-normalized',
  requireInternalKey,
  async (req, res, next) => {
    try {
      const result = await fetchFromOref(false);

      const enrichedParsed = enrichParsedWithZoneInfo(result.parsed);

      res.json({
        ts: lastFetchedAt,
        fromCache: result.fromCache,
        parsed: enrichedParsed,
      });
    } catch (err) {
      next(err);
    }
  }
);

// 3) היסטוריה בסיסית
app.get('/internal/alerts-history', requireInternalKey, (req, res) => {
  const limit = parseInt(req.query.limit || '50', 10);
  const trimmed = history.slice(Math.max(history.length - limit, 0));
  res.json({
    count: trimmed.length,
    items: trimmed,
  });
});

// ===================== CONFIG ENDPOINTS (PUBLIC) =====================

// כל אזורי ההתגוננות (zones.config.json)
app.get('/config/zones', (req, res) => {
  try {
    res.json(zonesConfig);
  } catch (err) {
    console.error('[LocalProxy] /config/zones error:', err.message);
    res.status(500).json({ error: 'ZONES_CONFIG_ERROR' });
  }
});

// מיפוי עיר -> אזור (city_zones.config.json)
app.get('/config/city-zones', (req, res) => {
  try {
    res.json(cityZonesConfig);
  } catch (err) {
    console.error('[LocalProxy] /config/city-zones error:', err.message);
    res.status(500).json({ error: 'CITY_ZONES_CONFIG_ERROR' });
  }
});

// אופציונלי: רענון קבצי קונפיג בלי להפעיל את השרת מחדש
app.post('/internal/reload-config', requireInternalKey, (req, res) => {
  try {
    loadZonesConfigs();
    res.json({
      status: 'OK',
      zones: zonesConfig.length,
      cities: cityZonesConfig.length,
    });
  } catch (err) {
    console.error('[LocalProxy] reload-config error:', err.message);
    res.status(500).json({ error: 'RELOAD_CONFIG_ERROR' });
  }
});

// ===================== GLOBAL ERROR HANDLER =====================

app.use((err, req, res, next) => {
  console.error('[LocalProxy] Error:', err.message);

  const status = err.status || 500;

  const payload = {
    error: true,
    status,
    code: err.code || 'INTERNAL_SERVER_ERROR',
    message: NODE_ENV === 'development' ? err.message : 'Internal server error',
  };

  if (NODE_ENV === 'development' && err.stack) {
    payload.stack = err.stack;
  }

  res.status(status).json(payload);
});

// ===================== SERVER START =====================

app.listen(PORT, () => {
  console.log(`Local Red Alert proxy listening on http://localhost:${PORT}`);
  console.log('[LocalProxy] ENV:', NODE_ENV);
  console.log(
    '[LocalProxy] INTERNAL_KEY:',
    INTERNAL_KEY ? '[SET]' : '[MISSING]'
  );
});
