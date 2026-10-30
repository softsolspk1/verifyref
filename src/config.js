// config.js - environment configuration (reads .env without external deps)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const envFile = process.env.ENV_FILE || path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const env = process.env;
const DESKTOP = env.APP_MODE === 'desktop';

module.exports = {
  ROOT,
  // The data folder is not deployed (it is mirrored on Cloudflare R2): on Vercel files are copied from R2 into /tmp on use
  DATA_DIR: env.DATA_DIR || (env.VERCEL ? '/tmp/pjps-data' : path.join(ROOT, 'data')),
  PORT: parseInt(env.PORT || '3005', 10),
  APP_NAME: 'PJPS Data Integrity System',
  APP_VENDOR: 'Softsols Pakistan',
  APP_VERSION: '3.2.4',
  // Desktop edition: local server on 127.0.0.1 with an embedded database, synchronised with the web platform
  DESKTOP,
  REMOTE_URL: (env.REMOTE_URL || '').replace(/\/+$/, ''),
  // Journal the checker is run for (used for citation-stacking checks)
  HOME_JOURNAL: {
    name: env.HOME_JOURNAL_NAME || 'Pakistan Journal of Pharmaceutical Sciences',
    issn: (env.HOME_JOURNAL_ISSN || '1011-601X').split(',').map(s => s.trim()).filter(Boolean)
  },
  CONTACT_EMAIL: env.CONTACT_EMAIL || 'editor@pjps.pk',
  ADMIN_EMAIL: env.ADMIN_EMAIL || '',
  ADMIN_PASSWORD: env.ADMIN_PASSWORD || '',
  OPENALEX_API_KEY: env.OPENALEX_API_KEY || '',
  S2_API_KEY: env.S2_API_KEY || '',
  NCBI_API_KEY: env.NCBI_API_KEY || '',
  GOOGLE_BOOKS_API_KEY: env.GOOGLE_BOOKS_API_KEY || '',
  // CORE (core.ac.uk): optional free key - higher rate limit and open-access full texts
  CORE_API_KEY: env.CORE_API_KEY || '',
  // Google Scholar through SerpApi (serpapi.com, paid): last resort for references no free database could verify
  SERPAPI_KEY: env.SERPAPI_KEY || '',
  MAX_REFERENCES: parseInt(env.MAX_REFERENCES || '250', 10),
  // Uploads: files larger than Vercel's 4.5 MB request limit go from the browser straight to Cloudflare R2
  MAX_UPLOAD_MB: parseInt(env.MAX_UPLOAD_MB || '500', 10),
  R2: { accountId: env.R2_ACCOUNT_ID || '', accessKeyId: env.R2_ACCESS_KEY_ID || '', secretAccessKey: env.R2_SECRET_ACCESS_KEY || '', bucket: env.R2_BUCKET || '' },
  SESSION_DAYS: parseInt(env.SESSION_DAYS || '14', 10),
  // E-mail notifications (alerts, retraction notices). Leave SMTP_HOST empty for in-app notifications only.
  SMTP: {
    host: env.SMTP_HOST || '',
    port: parseInt(env.SMTP_PORT || '587', 10),
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || env.CONTACT_EMAIL || ''
  },
  PUBLIC_URL: (env.PUBLIC_URL || '').replace(/\/+$/, '')
};
