#!/usr/bin/env node
// scripts/publish-desktop.js - put the Windows desktop build on the web portal: uploads the installer and the portable
// version from desktop/dist to Cloudflare R2 (downloads/desktop/<version>/) and records the release. Signed-in users
// and the sign-in page offer it for download, and every installed or portable desktop updates itself to it
// (latest.yml for the installed copies, size + SHA-512 for the portable ones).
//
//   npm run desktop:dist                       build (pre-set to the platform address in desktop/desktop-config.json)
//   npm run desktop:publish -- --notes "…"     upload and publish
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../src/db');
const R2 = require('../src/uploads');

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const DIST = path.join(__dirname, '..', 'desktop', 'dist');
const { version } = require('../desktop/package.json');

const sha512 = file => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha512');
  fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('base64'))).on('error', reject);
});

(async () => {
  if (!R2.enabled()) throw new Error('Cloudflare R2 is not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET).');
  const names = fs.existsSync(DIST) ? fs.readdirSync(DIST) : [];
  const pick = re => names.find(n => re.test(n) && n.includes(version));
  const wanted = [['setup', pick(/Setup.*\.exe$/i)], ['portable', pick(/Portable.*\.exe$/i)]].filter(([, n]) => n);
  if (!wanted.length) throw new Error(`No ${version} build in desktop/dist. Run: npm run desktop:dist`);
  const ymlFile = path.join(DIST, 'latest.yml');
  const updateYml = fs.existsSync(ymlFile) ? fs.readFileSync(ymlFile, 'utf8') : null;
  if (!updateYml || !updateYml.includes(`version: ${version}`)) throw new Error(`desktop/dist/latest.yml is missing or not for ${version}: rebuild with npm run desktop:dist`);
  await db.init();
  const files = [];
  for (const [kind, name] of wanted) {
    const file = path.join(DIST, name);
    const size = fs.statSync(file).size;
    const key = `downloads/desktop/${version}/${name}`;
    console.log(`Uploading ${name} (${(size / 1048576).toFixed(1)} MB) …`);
    if (size > 200e6) await R2.putFileMultipart(key, file, size, 'application/vnd.microsoft.portable-executable', { onPart: (i, n) => console.log(`  part ${i}/${n}`) });
    else await R2.putFileStream(key, file, size, 'application/vnd.microsoft.portable-executable');
    files.push({ kind, name, key, size, sha512: await sha512(file) });
  }
  const release = { version, publishedAt: new Date().toISOString(), notes: opt('notes'), files, updateYml };
  await db.setMeta('desktop_release', JSON.stringify(release));
  console.log(`Published desktop ${version}: ${files.map(f => f.name).join(', ')} — installed and portable desktops update themselves`);
  await db.close();
})().catch(e => { console.error(e.message); process.exit(1); });
