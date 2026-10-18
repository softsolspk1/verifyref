// config.js - environment configuration (reads .env without external deps)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const env = process.env;

module.exports = {
  ROOT,
  DATA_DIR: path.join(ROOT, 'data'),
  PORT: parseInt(env.PORT || '3005', 10),
  APP_NAME: 'PJPS Reference Checker',
  APP_VENDOR: 'Softsols Pakistan',
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
  MAX_REFERENCES: parseInt(env.MAX_REFERENCES || '250', 10),
  SESSION_DAYS: parseInt(env.SESSION_DAYS || '14', 10)
};
