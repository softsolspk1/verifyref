// desktop/stage.js - assembles desktop/app/ (the folder electron-builder packages): the shared application engine
// (server.js, src/, public/), the Electron entry point and production dependencies.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'app');
const rootPkg = require(path.join(ROOT, 'package.json'));
const deskPkg = require(path.join(__dirname, 'package.json'));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const copy = (from, to = from) => fs.cpSync(path.join(ROOT, from), path.join(OUT, to), { recursive: true });
copy('server.js');
copy('src');
copy('public');
fs.copyFileSync(path.join(__dirname, 'main.js'), path.join(OUT, 'main.js'));
fs.mkdirSync(path.join(OUT, 'build'), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'build', 'icon.ico'), path.join(OUT, 'build', 'icon.ico'));

// The web platform address the installer is pre-configured with (editable on the sign-in screen)
const cfgFile = path.join(__dirname, 'desktop-config.json');
// REMOTE_URL=https://… npm run desktop:dist bakes the platform address into the installer
if (!fs.existsSync(cfgFile) || process.env.REMOTE_URL) {
  const prev = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
  fs.writeFileSync(cfgFile, JSON.stringify({ contactEmail: 'editor@pjps.pk', ...prev, remoteUrl: (process.env.REMOTE_URL || prev.remoteUrl || '').replace(/\/+$/, '') }, null, 2));
}
fs.copyFileSync(cfgFile, path.join(OUT, 'desktop-config.json'));

// Runtime dependencies only; pg and the Vercel helper are not used by the embedded database but are required lazily
const deps = { ...rootPkg.dependencies };
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify({
  name: deskPkg.name, productName: deskPkg.productName, version: deskPkg.version, description: deskPkg.description,
  author: deskPkg.author, main: 'main.js', dependencies: deps
}, null, 2));
console.log('Installing production dependencies into desktop/app …');
execSync('npm install --omit=dev --no-audit --no-fund', { cwd: OUT, stdio: 'inherit' });
console.log('Staged', OUT);
