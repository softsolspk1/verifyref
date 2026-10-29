#!/usr/bin/env node
// scripts/publish-desktop.js - put the Windows desktop build on the web portal: uploads the installer and the portable
// version from desktop/dist to Cloudflare R2 (downloads/desktop/<version>/) and records the release, so signed-in users
// download it from the "Desktop application" page.
//
//   npm run desktop:dist                       build (REMOTE_URL=https://… pre-sets the platform address)
//   npm run desktop:publish -- --notes "…"     upload and publish
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const R2 = require('../src/uploads');

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const DIST = path.join(__dirname, '..', 'desktop', 'dist');
const { version } = require('../desktop/package.json');

(async () => {
  if (!R2.enabled()) throw new Error('Cloudflare R2 is not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET).');
  const names = fs.existsSync(DIST) ? fs.readdirSync(DIST) : [];
  const pick = re => names.find(n => re.test(n) && n.includes(version));
  const wanted = [['setup', pick(/Setup.*\.exe$/i)], ['portable', pick(/Portable.*\.exe$/i)]].filter(([, n]) => n);
  if (!wanted.length) throw new Error(`No ${version} build in desktop/dist. Run: npm run desktop:dist`);
  await db.init();
  const files = [];
  for (const [kind, name] of wanted) {
    const file = path.join(DIST, name);
    const size = fs.statSync(file).size;
    const key = `downloads/desktop/${version}/${name}`;
    console.log(`Uploading ${name} (${(size / 1048576).toFixed(1)} MB) …`);
    if (size > 200e6) await R2.putFileMultipart(key, file, size, 'application/vnd.microsoft.portable-executable', { onPart: (i, n) => console.log(`  part ${i}/${n}`) });
    else await R2.putFileStream(key, file, size, 'application/vnd.microsoft.portable-executable');
    files.push({ kind, name, key, size });
  }
  const release = { version, publishedAt: new Date().toISOString(), notes: opt('notes'), files };
  await db.setMeta('desktop_release', JSON.stringify(release));
  console.log(`Published desktop ${version}: ${files.map(f => f.name).join(', ')}`);
  await db.close();
})().catch(e => { console.error(e.message); process.exit(1); });
