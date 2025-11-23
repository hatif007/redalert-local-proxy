// redalert-local-proxy/config/env.js
// טוען ENV + בודק חובה

require('dotenv').config();

const REQUIRED_ENV = [
  'INTERNAL_KEY',
  'PORT',
  'NODE_ENV',
  'ALLOWED_ORIGINS',
];

function ensureRequiredEnv() {
  const missing = REQUIRED_ENV.filter((key) => {
    const value = process.env[key];
    return value === undefined || String(value).trim() === '';
  });

  if (missing.length > 0) {
    console.error('❌ [ENV] Missing required environment variables (redalert-local-proxy):');
    missing.forEach((key) => console.error('   - ' + key));
    console.error('💡 Fix your .env file and restart the server.');
    process.exit(1);
  }
}

ensureRequiredEnv();

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 3000,

  internalKey: process.env.INTERNAL_KEY,

  allowedOrigins: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : [],
};

console.log('✅ [ENV] redalert-local-proxy loaded:', {
  env: config.env,
  port: config.port,
  allowedOriginsCount: config.allowedOrigins.length,
  internalKeyDefined: !!config.internalKey,
});

module.exports = config;
