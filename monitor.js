"use strict";
// monitor.js — ShelterAlert System Monitor
// Runs every 2 minutes via PM2, sends Telegram alerts on failures

require("dotenv").config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "8601796994:AAFqMjZzy9OWtFSDX0vkkdc6Z1DNupwwv8g";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "6513084356";
const CHECK_INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS || 2 * 60 * 1000); // 2 min

// Endpoints to check
const CHECKS = [
  {
    name: "🏠 Tunnel (home proxy)",
    url: "https://tunnel.shelter-alert.com/health",
    validate: (j) => {
      if (j.status !== "ok") return "status != ok";
      if (!j.sources?.oref?.ok) return `OREF down: ${j.sources?.oref?.error || "unknown"}`;
      return null; // ok
    },
  },
  {
    name: "☁️ Railway API",
    url: "https://api.shelter-alert.com/health",
    validate: (j) => {
      if (!j.ok) return "ok=false";
      if (j.tunnel?.status !== "up") return `tunnel status: ${j.tunnel?.status}`;
      if (j.tunnel?.failCount > 3) return `tunnel failCount=${j.tunnel?.failCount}`;
      return null;
    },
  },
];

// Track consecutive failures per check to avoid spam
const failCounts = {};
const ALERT_AFTER_FAILS = 2; // alert only after 2 consecutive failures

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

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const json = await resp.json();
    const error = check.validate(json);

    if (error) {
      failCounts[key] = (failCounts[key] || 0) + 1;
      console.log(`[monitor] ⚠️  ${key} — ${error} (fail #${failCounts[key]})`);
      if (failCounts[key] >= ALERT_AFTER_FAILS) {
        await sendTelegram(`🚨 <b>ShelterAlert — תקלה</b>\n\n${key}\n❌ ${error}\n\n🕐 ${new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}`);
      }
    } else {
      if (failCounts[key] >= ALERT_AFTER_FAILS) {
        // Was previously alerting, now recovered
        await sendTelegram(`✅ <b>ShelterAlert — שוחזר</b>\n\n${key}\n✔️ חזר לפעולה תקינה\n\n🕐 ${new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}`);
      }
      failCounts[key] = 0;
      console.log(`[monitor] ✅ ${key} — ok`);
    }
  } catch (e) {
    failCounts[key] = (failCounts[key] || 0) + 1;
    console.log(`[monitor] ❌ ${key} — ${e.message} (fail #${failCounts[key]})`);
    if (failCounts[key] >= ALERT_AFTER_FAILS) {
      await sendTelegram(`🚨 <b>ShelterAlert — תקלה</b>\n\n${key}\n❌ ${e.message}\n\n🕐 ${new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}`);
    }
  }
}

async function runChecks() {
  console.log(`[monitor] Running checks at ${new Date().toISOString()}`);
  await Promise.all(CHECKS.map(checkEndpoint));
}

// Run immediately, then on interval
runChecks();
setInterval(runChecks, CHECK_INTERVAL_MS);

console.log(`[monitor] Started — checking every ${CHECK_INTERVAL_MS / 1000}s`);
