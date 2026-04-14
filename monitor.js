"use strict";
// monitor.js — ShelterAlert System Monitor
// Runs every 2 minutes via PM2, sends Telegram alerts on failures
// Auto-heals: restarts cloudflared when tunnel is down

require("dotenv").config();

const { execSync } = require("child_process");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "8601796994:AAFqMjZzy9OWtFSDX0vkkdc6Z1DNupwwv8g";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "6513084356";
// Turbo mode: run every 1 min for the next 4 hours, then revert to 2 min
const TURBO_UNTIL = Date.now() + 4 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS || 60 * 1000); // 1 min (turbo)

// Auto-heal: max 3 restarts per hour to avoid restart loops
const MAX_HEALS_PER_HOUR = 3;
const healLog = []; // timestamps of recent heals

function canHeal() {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  // Remove old entries
  while (healLog.length && healLog[0] < oneHourAgo) healLog.shift();
  return healLog.length < MAX_HEALS_PER_HOUR;
}

// Endpoints to check
const CHECKS = [
  {
    name: "🏠 Tunnel (home proxy)",
    url: "https://tunnel.shelter-alert.com/health",
    validate: (j) => {
      if (j.status !== "ok") return "status != ok";
      // OREF can be briefly in backoff (normal) — only alert if no success in last 10 minutes AND TzevaAdom WS is also down
      const orefLastSuccess = j.sources?.oref?.lastSuccessAt;
      const wsConnected = j.sources?.tzevaadomWs?.connected;
      if (orefLastSuccess && orefLastSuccess > 0 && !wsConnected) {
        const orefStaleMs = Date.now() - orefLastSuccess;
        if (orefStaleMs > 10 * 60 * 1000) {
          return `OREF לא הצליח כבר ${Math.round(orefStaleMs / 60000)} דקות (גם WS מנותק)`;
        }
      }
      return null;
    },
    // Auto-heal: restart cloudflared when tunnel is unreachable
    heal: async () => {
      if (!canHeal()) {
        console.log("[monitor] heal skipped — too many restarts in last hour");
        return "heal skipped (יותר מדי restarts בשעה האחרונה)";
      }
      try {
        console.log("[monitor] 🔧 Restarting cloudflared via systemctl...");
        execSync("systemctl restart cloudflared", { timeout: 15000 });
        healLog.push(Date.now());
        console.log("[monitor] 🔧 cloudflared restarted via systemctl");
        return "cloudflared הופעל מחדש (systemctl)";
      } catch (e) {
        console.error("[monitor] heal failed:", e.message);
        return `heal נכשל: ${e.message}`;
      }
    },
  },
  {
    name: "☁️ Railway API",
    url: "https://api.shelter-alert.com/health",
    validate: (j) => {
      if (!j.ok) return "ok=false";
      // Tunnel check — require 3+ consecutive failures to avoid false alarms on transient hiccups
      if (j.tunnel?.status !== "up" && !j.tunnel?.directFallback?.active && (j.tunnel?.failCount ?? 0) >= 3) {
        return `tunnel status: ${j.tunnel?.status} (אין fallback, failures=${j.tunnel?.failCount})`;
      }
      // MongoDB check
      if (j.history?.mongoReady === false) {
        return "MongoDB לא מחובר";
      }
      // FCM check
      if (j.push?.firebaseReady === false) {
        return "FCM לא מאותחל";
      }
      // Token cache check
      if (j.push?.tokenCache?.ready === false && j.history?.mongoReady === true) {
        return "Token cache לא מוכן (MongoDB מחובר אך cache לא נבנה)";
      }
      // WS TzevaAdom check — if disconnected for >5 min, PRE_ALERT/ALL_CLEAR won't reach users
      const ws = j.wsDirectFallback;
      if (ws && ws.connected === false && ws.reconnectAttempt > 5) {
        const downSince = ws.lastConnectedAt
          ? `(מנותק ${Math.round((Date.now() - ws.lastConnectedAt) / 60000)} דקות)`
          : "(מעולם לא התחבר)";
        return `WebSocket TzevaAdom מנותק — ${ws.reconnectAttempt} ניסיונות חיבור ${downSince}`;
      }
      const ps = j.push?.lastPushStats;
      const lastPushAt = j.push?.lastPushAt;
      const pushIsRecent = lastPushAt && (Date.now() - lastPushAt) < 10 * 60 * 1000;
      if (pushIsRecent && ps && ps.attempted > 0 && ps.sentTo === 0 && ps.failed > 0) {
        return `FCM: ${ps.failed}/${ps.attempted} נכשלו — ${ps.lastError || "שגיאה לא ידועה"}`;
      }
      return null;
    },
    heal: null,
  },
  {
    name: "🔔 Oref end-to-end",
    url: "https://api.shelter-alert.com/health",
    validate: async () => {
      // Compare our API vs Oref directly
      try {
        const [orefResp, ourResp] = await Promise.all([
          fetch("https://www.oref.org.il/WarningMessages/alert/alerts.json", {
            headers: { Referer: "https://www.oref.org.il/", "X-Requested-With": "XMLHttpRequest" },
            signal: AbortSignal.timeout(8000),
          }),
          fetch("https://api.shelter-alert.com/alerts/current", {
            signal: AbortSignal.timeout(8000),
          }),
        ]);
        const orefText = await orefResp.text();
        const ourJson = await ourResp.json();

        const orefHasAlerts = orefText && orefText.trim().length > 10;
        const ourHasAlerts = ourJson?.alerts?.length > 0 || ourJson?.length > 0;

        if (orefHasAlerts && !ourHasAlerts) {
          return "⚠️ Oref מדווח אזעקות אך השרת שלנו לא מחזיר כלום!";
        }
        return null;
      } catch (e) {
        // Not a hard failure — log only
        console.log(`[monitor] Oref comparison skipped: ${e.message}`);
        return null;
      }
    },
    heal: null,
  },
];

// Track consecutive failures per check
const failCounts = {};
const lastAlertAt = {}; // cooldown: don't re-alert for same issue within 15 min
const ALERT_AFTER_FAILS = 2;
const ALERT_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes between repeated alerts

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendTelegram(text) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" });
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(10000),
    });
    const json = await resp.json();
    if (!json.ok) console.error("[monitor] Telegram error:", json.description);
  } catch (e) {
    console.error("[monitor] Failed to send Telegram message:", e.message);
  }
}

async function checkEndpoint(check) {
  const key = check.name;
  try {
    const resp = await fetch(check.url, {
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const json = await resp.json();
    const error = await check.validate(json);

    if (error) {
      failCounts[key] = (failCounts[key] || 0) + 1;
      console.log(`[monitor] ⚠️  ${key} — ${error} (fail #${failCounts[key]})`);

      if (failCounts[key] >= ALERT_AFTER_FAILS) {
        const now = Date.now();
        if (!lastAlertAt[key] || now - lastAlertAt[key] > ALERT_COOLDOWN_MS) {
          lastAlertAt[key] = now;
          let healMsg = "";
          if (check.heal) {
            healMsg = await check.heal();
            healMsg = `\n🔧 תיקון אוטומטי: ${healMsg}`;
          }
          await sendTelegram(
            `🚨 <b>ShelterAlert — תקלה</b>\n\n${key}\n❌ ${error}${healMsg}\n\n🕐 ${new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}`
          );
        } else {
          console.log(`[monitor] 🔇 ${key} — cooldown (${Math.round((ALERT_COOLDOWN_MS - (Date.now() - lastAlertAt[key])) / 60000)}m נשאר)`);
        }
      }
    } else {
      if (failCounts[key] >= ALERT_AFTER_FAILS) {
        await sendTelegram(
          `✅ <b>ShelterAlert — שוחזר</b>\n\n${key}\n✔️ חזר לפעולה תקינה\n\n🕐 ${new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}`
        );
      }
      lastAlertAt[key] = 0;
      failCounts[key] = 0;
      console.log(`[monitor] ✅ ${key} — ok`);
    }
  } catch (e) {
    failCounts[key] = (failCounts[key] || 0) + 1;
    console.log(`[monitor] ❌ ${key} — ${e.message} (fail #${failCounts[key]})`);

    if (failCounts[key] >= ALERT_AFTER_FAILS) {
      const now = Date.now();
      if (!lastAlertAt[key] || now - lastAlertAt[key] > ALERT_COOLDOWN_MS) {
        lastAlertAt[key] = now;
        let healMsg = "";
        if (check.heal) {
          healMsg = await check.heal();
          healMsg = `\n🔧 תיקון אוטומטי: ${healMsg}`;
        }
        await sendTelegram(
          `🚨 <b>ShelterAlert — תקלה</b>\n\n${key}\n❌ ${e.message}${healMsg}\n\n🕐 ${new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}`
        );
      } else {
        console.log(`[monitor] 🔇 ${key} — cooldown (${Math.round((ALERT_COOLDOWN_MS - (Date.now() - lastAlertAt[key])) / 60000)}m נשאר)`);
      }
    }
  }
}

async function runChecks() {
  console.log(`[monitor] Running checks at ${new Date().toISOString()}`);
  // Run sequentially so heal of tunnel happens before Railway check
  for (const check of CHECKS) {
    await checkEndpoint(check);
  }
}

// Run immediately, then on dynamic interval (1 min for 4 hours, then 2 min)
runChecks();

function scheduleNext() {
  const now = Date.now();
  const interval = now < TURBO_UNTIL ? 60 * 1000 : 2 * 60 * 1000;
  setTimeout(async () => {
    await runChecks();
    scheduleNext();
  }, interval);
}
scheduleNext();

const turboMinsLeft = Math.round((TURBO_UNTIL - Date.now()) / 60000);
console.log(`[monitor] Started — turbo mode (1 min) for ${turboMinsLeft} more minutes, then 2 min`);

// ---------------------------------------------------------
// 📡 FCM Canary — silent push every hour to verify FCM pipeline
// ---------------------------------------------------------
const CANARY_DEVICE_ID = process.env.CANARY_DEVICE_ID || "0ce6de38-061a-4c3f-b82a-4e51733deff8";
const CANARY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const RAILWAY_API = "https://api.shelter-alert.com";
const INTERNAL_KEY = process.env.INTERNAL_KEY;
if (!INTERNAL_KEY) {
  console.error("[monitor] INTERNAL_KEY missing — refusing to start");
  process.exit(1);
}

async function runFcmCanary() {
  try {
    const resp = await fetch(`${RAILWAY_API}/debug/send-test-push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_KEY },
      body: JSON.stringify({ deviceId: CANARY_DEVICE_ID }),
      signal: AbortSignal.timeout(15000),
    });
    const json = await resp.json();
    if (json.ok && json.fcmResponseId) {
      console.log(`[canary] ✅ FCM push OK — ${json.fcmResponseId}`);
    } else {
      throw new Error(json.error || json.message || "no fcmResponseId");
    }
  } catch (e) {
    console.error(`[canary] ❌ FCM push FAILED: ${e.message}`);
    await sendTelegram(
      `🚨 <b>FCM Canary נכשל!</b>\n\nה-push השעתי לא הגיע.\n❌ ${e.message}\n\n🕐 ${new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}`
    );
  }
}

// Run after 1 min delay (let services settle), then every hour
setTimeout(() => {
  runFcmCanary();
  setInterval(runFcmCanary, CANARY_INTERVAL_MS);
}, 60 * 1000);
