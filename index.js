const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const OREF_URL = 'https://www.oref.org.il/warningMessages/alert/Alerts.json';

// מפתח פנימי בין Railway לבין השרת הביתי
const INTERNAL_KEY = process.env.INTERNAL_KEY || 'dev-internal-key';

// הגדרות Cache / היסטוריה
const CACHE_TTL_MS = 1000;       // כמה זמן (ב־ms) לשמור תשובה לפני בקשה חדשה
const HISTORY_LIMIT = 200;       // עד כמה רשומות היסטוריה לשמור

let lastRaw = null;              // הטקסט האחרון מ־Oref
let lastParsed = null;           // JSON אחרי נירמול (אם הצליח)
let lastFetchedAt = 0;
let history = [];                // מערך של { ts, raw, parsed }

// Middleware לבדיקת מפתח פנימי
function requireInternalKey(req, res, next) {
  const key = req.headers['x-internal-key'];
  if (!key || key !== INTERNAL_KEY) {
    return res.status(401).json({ error: 'UNAUTHORIZED_INTERNAL' });
  }
  next();
}

// פונקציה שמביאה את הנתונים מפיקוד העורף + Cache
async function fetchFromOref(force = false) {
  const now = Date.now();

  // אם יש Cache טרי ולא מכריחים רענון
  if (!force && lastRaw && now - lastFetchedAt < CACHE_TTL_MS) {
    return { raw: lastRaw, parsed: lastParsed, fromCache: true };
  }

  const response = await fetch(OREF_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://www.oref.org.il/',
      'X-Requested-With': 'XMLHttpRequest',
    },
  });

  const text = await response.text();

  lastRaw = text;
  lastFetchedAt = now;

  // ננסה לפרש כ־JSON (אם באמת יש תוכן)
  let parsed = null;
  const trimmed = text.trim();
  if (trimmed && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      console.warn('Failed to parse Oref JSON:', e.message);
    }
  }
  lastParsed = parsed;

  // הוספה להיסטוריה (אם יש מידע אמיתי)
  history.push({
    ts: now,
    raw: text,
    parsed,
  });
  if (history.length > HISTORY_LIMIT) {
    history = history.slice(history.length - HISTORY_LIMIT);
  }

  return { raw: text, parsed, fromCache: false, status: response.status };
}

// ---- ROUTES ----

// בדיקת בריאות בסיסית (פתוח לכולם)
app.get('/health', (req, res) => {
  res.send('LOCAL PROXY OK');
});

// DEBUG – לראות מה קורה מול Oref (פתוח – רק לפיתוח)
app.get('/alerts-debug', async (req, res) => {
  try {
    const result = await fetchFromOref(true); // מכריח רענון
    res.json({
      status: 200,
      fromCache: result.fromCache,
      length: result.raw.length,
      preview: result.raw.substring(0, 200),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// API פנימי – גישה רק דרך Railway עם X-Internal-Key

// 1) נתונים גולמיים כמו שהם (Raw)
app.get('/internal/alerts-raw', requireInternalKey, async (req, res) => {
  try {
    const result = await fetchFromOref(false);
    res
      .status(200)
      .set('Content-Type', 'text/plain; charset=utf-8')
      .send(result.raw);
  } catch (err) {
    console.error(err);
    res.status(500).send('ERROR');
  }
});

// 2) נתונים מנורמלים (JSON) – אם הפענוח הצליח
app.get('/internal/alerts-normalized', requireInternalKey, async (req, res) => {
  try {
    const result = await fetchFromOref(false);
    res.json({
      ts: lastFetchedAt,
      fromCache: result.fromCache,
      parsed: result.parsed,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 3) היסטוריה בסיסית
app.get('/internal/alerts-history', requireInternalKey, (req, res) => {
  const limit = parseInt(req.query.limit || '50', 10);
  const trimmed = history.slice(Math.max(history.length - limit, 0));
  res.json({
    count: trimmed.length,
    items: trimmed,
  });
});

app.listen(PORT, () => {
  console.log(`Local Red Alert proxy listening on http://localhost:${PORT}`);
  console.log('Using INTERNAL_KEY:', INTERNAL_KEY ? '[SET]' : '[DEFAULT]');
});
