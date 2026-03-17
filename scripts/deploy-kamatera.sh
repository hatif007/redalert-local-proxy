#!/bin/bash
# ============================================================
# deploy-kamatera.sh
# סקריפט התקנה מלאה לפרוקסי על שרת Kamatera / Ubuntu חדש
# הרץ כ: bash deploy-kamatera.sh
# ============================================================

set -e
echo "🚀 Starting redalert-proxy deployment..."

# ── 1. System update ─────────────────────────────────────────
echo "📦 Updating system..."
apt-get update -y && apt-get upgrade -y
apt-get install -y git curl ufw

# ── 2. Node.js 20 LTS ────────────────────────────────────────
echo "📦 Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node -v && npm -v

# ── 3. PM2 ───────────────────────────────────────────────────
echo "📦 Installing PM2..."
npm install -g pm2

# ── 4. Clone repo ────────────────────────────────────────────
echo "📂 Cloning proxy repo..."
mkdir -p /opt/redalert
cd /opt/redalert

if [ -d "proxy" ]; then
  echo "Repo exists — pulling latest..."
  cd proxy && git pull
else
  git clone https://github.com/hatif007/redalert-local-proxy.git proxy
  cd proxy
fi

# ── 5. Install dependencies ──────────────────────────────────
echo "📦 Installing npm packages..."
npm install --production

# ── 6. .env file ─────────────────────────────────────────────
echo "⚙️  Creating .env..."
cat > .env << 'ENVEOF'
INTERNAL_KEY=testkey123
NODE_ENV=production
PORT=3000
ALLOWED_ORIGINS=http://localhost:8080,http://localhost:3000,https://tunnel.shelter-alert.com

API_PUBLIC_KEY=redalert-mobile-v1-public

# Tzofar – disabled
TZOFAR_ENABLED=false

# TzevaAdom fallback
TZEVAADOM_FALLBACK_ENABLED=true
TZEVAADOM_HISTORY_URL=https://api.tzevaadom.co.il/alerts-history
TZEVAADOM_TIMEOUT_MS=10000
TZEVAADOM_RECENCY_WINDOW_MS=180000

# OREF settings
OREF_TIMEOUT_MS=8000
OREF_BACKOFF_MAX_MS=8000
OREF_BACKOFF_BASE_MS=400

CACHE_TTL_MS=200
RAW_TUNNEL_URL=https://tunnel.shelter-alert.com
BASE_TUNNEL_URL=https://tunnel.shelter-alert.com

# Webhook push to alerts service
WEBHOOK_URL=https://api.shelter-alert.com/internal/alert-webhook
WEBHOOK_KEY=testkey123
WEBHOOK_INTERVAL_MS=150
ENVEOF

echo "✅ .env created"

# ── 7. PM2 startup ───────────────────────────────────────────
echo "⚙️  Configuring PM2..."
mkdir -p logs

pm2 delete redalert-proxy 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash || true

# ── 8. Firewall ──────────────────────────────────────────────
echo "🔥 Configuring firewall..."
ufw allow 22/tcp   # SSH
ufw allow 3000/tcp # Proxy port
ufw --force enable

# ── 9. Verify ────────────────────────────────────────────────
echo ""
echo "⏳ Waiting for proxy to start..."
sleep 4
curl -s http://localhost:3000/health | grep -o '"status":"[^"]*"' || echo "⚠️  Health check failed"

echo ""
echo "============================================"
echo "✅ Deployment complete!"
echo "   Proxy running on port 3000"
SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
echo "   Server IP: $SERVER_IP"
echo ""
echo "📌 NEXT STEP — Update Railway env var:"
echo "   TUNNEL_URL=http://$SERVER_IP:3000"
echo "============================================"
