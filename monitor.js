"use strict";
// monitor.js — ShelterAlert System Monitor
// Runs every 2 minutes via PM2, sends Telegram alerts on failures
// Auto-heals: restarts cloudflared when tunnel is down

require("dotenv").config();

const { execSync } = require("child_process");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "8601796994:AAFqMjZzy9OWtFSDX0vkkdc6Z1DNupwwv8g";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "6513084356";
const CHECK_INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS || 2 * 60 * 1000); // 2 min

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
      if (!j.sources?.oref?.ok) return `OREF down: ${j.sources?.oref?.error || "unknown"}`;
      return null;
    },
    // Auto-heal: restart cloudflared when tunnel is unreachable
    heal: async () => {
      if (!canHeal()) {
        console.log("[monitor] heal skipped — too many restarts in last hour");
        return "heal skipped (יותר מדי restarts בשעה האחרונה)";
      }
      try {
        console.log("[monitor] 🔧 Restarting cloudflared...");
        // Kill existing cloudflared and restart via tunnel run
        execSync("powershell -Command \"Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force\"", { timeout: 10000 });
        await sleep(2000);
        execSync(
          "start /B cloudflared tunnel run redalert-proxy > C:\\redalert-local-proxy\\logs\\cloudflared.log 2>&1",
          { shell: "cmd.exe", timeout: 5000 }
        );
        healLog.push(Date.now());
        console.log("[monitor] 🔧 cloudflared restarted");
        return "cloudflared הופעל מחדש";
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
      if (j.tunnel?.status !== "up") return `tunnel status: ${j.tunnel?.status}`;
      if (j.tunnel?.failCount > 3) return `tunnel failCount=${j.tunnel?.failCount}`;
      return null;
    },
    // No auto-heal for Railway — it's a cloud service we don't control
    heal: null,
  },
];

// Track consecutive failures per check
const failCounts = {};
const ALERT_AFTER_FAILS = 2;

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
    const error = check.validate(json);

    if (error) {
      failCounts[key] = (failCounts[key] || 0) + 1;
      console.log(`[monitor] ⚠️  ${key} — ${error} (fail #${failCounts[key]})`);

      if (failCounts[key] >= ALERT_AFTER_FAILS) {
        let healMsg = "";
        if (check.heal) {
          healMsg = await check.heal();
          healMsg = `\n🔧 תיקון אוטומטי: ${healMsg}`;
        }
        await sendTelegram(
          `🚨 <b>ShelterAlert — תקלה</b>\n\n${key}\n❌ ${error}${healMsg}\n\n🕐 ${new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}`
        );
      }
    } else {
      if (failCounts[key] >= ALERT_AFTER_FAILS) {
        await sendTelegram(
          `✅ <b>ShelterAlert — שוחזר</b>\n\n${key}\n✔️ חזר לפעולה תקינה\n\n🕐 ${new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}`
        );
      }
      failCounts[key] = 0;
      console.log(`[monitor] ✅ ${key} — ok`);
    }
  } catch (e) {
    failCounts[key] = (failCounts[key] || 0) + 1;
    console.log(`[monitor] ❌ ${key} — ${e.message} (fail #${failCounts[key]})`);

    if (failCounts[key] >= ALERT_AFTER_FAILS) {
      let healMsg = "";
      if (check.heal) {
        healMsg = await check.heal();
        healMsg = `\n🔧 תיקון אוטומטי: ${healMsg}`;
      }
      await sendTelegram(
        `🚨 <b>ShelterAlert — תקלה</b>\n\n${key}\n❌ ${e.message}${healMsg}\n\n🕐 ${new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}`
      );
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

// Run immediately, then on interval
runChecks();
setInterval(runChecks, CHECK_INTERVAL_MS);

console.log(`[monitor] Started — checking every ${CHECK_INTERVAL_MS / 1000}s`);
