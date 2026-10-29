// desktop/updater.js - automatic updates from the web platform, so users never reinstall by hand.
//   Installed copy (NSIS): electron-updater downloads the new installer in the background from
//     <platform>/api/desktop-app/update/latest.yml and installs it silently when the app closes (or at once on
//     "Restart now").
//   Portable copy: the new portable .exe is downloaded next to the running one and swapped in when the app closes
//     (a small detached script waits for the file to be released, replaces it and, on "Restart now", starts it).
// The database and datasets live in the user profile, so an update never touches them.
const { app, dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const CHECK_EVERY = 4 * 3600 * 1000;

function newer(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

function start({ getWindow, remoteUrl, log, appName }) {
  if (!app.isPackaged) return; // running from source: nothing to update
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
  let asked = false;
  const offerRestart = (version, restart) => {
    if (asked) return;
    asked = true;
    const win = getWindow();
    dialog.showMessageBox(win, {
      type: 'info', title: appName, buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
      message: `Version ${version} has been downloaded.`,
      detail: 'It is installed automatically when you close the application, or now with a quick restart. Your reports, datasets and settings are kept.'
    }).then(r => { if (r.response === 0) restart(); }).catch(() => {});
  };

  if (portableExe) return startPortable({ portableExe, remoteUrl, log, offerRestart });

  let updater;
  try { ({ autoUpdater: updater } = require('electron-updater')); } catch (e) { log('Updater not available:', e.message); return; }
  updater.logger = { info: m => log('Update:', m), warn: m => log('Update warning:', m), error: m => log('Update error:', m), debug: () => {} };
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.disableDifferentialDownload = true; // whole installer from the platform's storage
  const feed = async () => {
    const base = (await remoteUrl()) || 'https://verifyref.vercel.app';
    updater.setFeedURL({ provider: 'generic', url: `${base.replace(/\/+$/, '')}/api/desktop-app/update` });
  };
  updater.on('update-downloaded', info => {
    log('Update downloaded:', info.version);
    offerRestart(info.version, () => updater.quitAndInstall(true, true));
  });
  updater.on('error', e => log('Update check failed:', e?.message || e));
  const check = () => feed().then(() => updater.checkForUpdates()).catch(e => log('Update check failed:', e.message));
  setTimeout(check, 20000);
  setInterval(check, CHECK_EVERY).unref();
}

function startPortable({ portableExe, remoteUrl, log, offerRestart }) {
  const pending = `${portableExe}.update`;
  let ready = null; // version downloaded and verified
  let restartAfter = false;

  const check = async () => {
    try {
      const base = (await remoteUrl()) || 'https://verifyref.vercel.app';
      const res = await fetch(`${base}/api/desktop-app/latest`, { signal: AbortSignal.timeout(15000) });
      const r = (await res.json()).release;
      const file = r?.files?.find(f => f.kind === 'portable');
      if (!r || !file || !newer(r.version, app.getVersion()) || ready === r.version) return;
      log('Portable update: downloading', r.version);
      const dl = await fetch(`${base}/api/desktop-app/download/portable`);
      if (!dl.ok) throw new Error(`download HTTP ${dl.status}`);
      const tmp = `${pending}.part`;
      const hash = crypto.createHash('sha512');
      const out = fs.createWriteStream(tmp);
      let size = 0;
      for await (const chunk of dl.body) { hash.update(chunk); size += chunk.length; if (!out.write(chunk)) await new Promise(res2 => out.once('drain', res2)); }
      await new Promise((res2, rej) => out.end(err => (err ? rej(err) : res2())));
      if (file.size && size !== file.size) throw new Error(`size ${size} instead of ${file.size}`);
      if (file.sha512 && hash.digest('base64') !== file.sha512) throw new Error('checksum mismatch');
      fs.renameSync(tmp, pending);
      ready = r.version;
      log('Portable update ready:', r.version);
      offerRestart(r.version, () => { restartAfter = true; app.quit(); });
    } catch (e) {
      log('Portable update failed:', e.message);
      fs.rm(`${pending}.part`, { force: true }, () => {});
    }
  };

  // When the app closes: replace the .exe once Windows releases it (retries up to a minute), then optionally restart
  app.on('will-quit', () => {
    if (!ready || !fs.existsSync(pending)) return;
    const script = path.join(os.tmpdir(), `pjps-portable-update-${process.pid}.cmd`);
    fs.writeFileSync(script, [
      '@echo off', 'set n=0',
      ':retry', `move /y "${pending}" "${portableExe}" >nul 2>&1 && goto done`,
      'set /a n+=1', 'if %n% geq 60 goto end', 'timeout /t 1 /nobreak >nul', 'goto retry',
      ':done', restartAfter ? `start "" "${portableExe}"` : 'rem',
      ':end', 'del "%~f0"'
    ].join('\r\n'));
    spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  });

  setTimeout(check, 20000);
  setInterval(check, CHECK_EVERY).unref();
}

module.exports = { start, newer };
