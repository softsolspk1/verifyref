// desktop/main.js - PJPS Reference Checker for Windows. Starts the same application engine as the web platform on
// 127.0.0.1 with an embedded PostgreSQL-compatible database (PGlite) in the user's profile, and shows it in a window.
// Sign-in and synchronisation go to the web platform; most checks keep working offline.
const { app, BrowserWindow, Menu, shell, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_NAME = 'PJPS Reference Checker';
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId('pk.softsols.pjps-reference-checker');

const userData = app.getPath('userData');
const dataDir = path.join(userData, 'data');
fs.mkdirSync(dataDir, { recursive: true });

// Defaults shipped with the installer (web platform address), overridable from the sign-in screen
let shipped = {};
for (const p of [path.join(__dirname, 'desktop-config.json'), path.join(process.resourcesPath || '', 'desktop-config.json')]) {
  try { shipped = JSON.parse(fs.readFileSync(p, 'utf8')); break; } catch (e) { /* not present */ }
}

process.env.APP_MODE = 'desktop';
process.env.PGLITE_DIR = path.join(dataDir, 'db');
process.env.DATA_DIR = dataDir;
process.env.ENV_FILE = path.join(userData, 'settings.env'); // optional local overrides (API keys)
if (!process.env.REMOTE_URL && shipped.remoteUrl) process.env.REMOTE_URL = shipped.remoteUrl;
if (shipped.contactEmail && !process.env.CONTACT_EMAIL) process.env.CONTACT_EMAIL = shipped.contactEmail;
delete process.env.DATABASE_URL;

// The application engine sits next to this file when packaged, one folder up during development
const serverPath = fs.existsSync(path.join(__dirname, 'server.js')) ? path.join(__dirname, 'server.js') : path.join(__dirname, '..', 'server.js');

let win = null;
let baseUrl = null;
const logFile = path.join(userData, 'app.log');
const log = (...a) => { try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${a.join(' ')}\n`); } catch (e) { /* ignore */ } };
for (const k of ['log', 'error', 'warn']) { const orig = console[k]; console[k] = (...a) => { log(k.toUpperCase(), ...a.map(String)); orig.apply(console, a); }; }

function isLocal(url) { return baseUrl && url.startsWith(baseUrl); }

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 900, minHeight: 600, show: false,
    title: APP_NAME, icon: path.join(__dirname, 'build', 'icon.ico'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f151b' : '#f4f6f8',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true }
  });
  win.once('ready-to-show', () => win.show());
  // Links to other sites (DOIs, journal homepages) open in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => { if (!isLocal(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!isLocal(url)) { e.preventDefault(); shell.openExternal(url); } });
  win.loadURL(baseUrl + '/');
}

function buildMenu() {
  const go = hash => win && win.loadURL(`${baseUrl}/app#${hash}`);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Sync && offline queue', accelerator: 'Ctrl+Shift+S', click: () => go('/desktop') },
      { label: 'My Activity', click: () => go('/activity') },
      { type: 'separator' },
      { label: 'Open data folder', click: () => shell.openPath(userData) },
      { type: 'separator' },
      { role: 'quit', label: 'Exit' }
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools', label: 'Developer tools' }] },
    { label: 'Help', submenu: [
      { label: 'View log file', click: () => shell.openPath(logFile) },
      { label: `About ${APP_NAME}`, click: () => dialog.showMessageBox(win, { type: 'info', title: APP_NAME, message: `${APP_NAME} ${app.getVersion()}`, detail: `Desktop edition with offline mode.\n© ${new Date().getFullYear()} Softsols Pakistan\n\nData folder: ${userData}` }) }
    ] }
  ]));
}

/** Tell the user when the web platform runs a newer version */
async function checkForUpdate() {
  const remote = process.env.REMOTE_URL;
  if (!remote) return;
  try {
    const r = await fetch(`${remote.replace(/\/+$/, '')}/api/app`, { signal: AbortSignal.timeout(8000) });
    const { version } = await r.json();
    const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
    if (version && newer(version, app.getVersion())) {
      dialog.showMessageBox(win, { type: 'info', title: 'Update available', message: `Version ${version} of ${APP_NAME} is available.`, detail: 'Ask your administrator for the new installer. Your data is kept when you install it.' });
    }
  } catch (e) { /* offline or no platform */ }
}

app.whenReady().then(async () => {
  try {
    const server = require(serverPath);
    const port = await server.start({ port: 0 });
    baseUrl = `http://127.0.0.1:${port}`;
    log('Started on', baseUrl);
  } catch (e) {
    log('Startup failed', e.stack || e.message);
    dialog.showErrorBox(APP_NAME, `The application could not start:\n\n${e.message}\n\nDetails are in ${logFile}`);
    app.quit();
    return;
  }
  buildMenu();
  createWindow();
  setTimeout(checkForUpdate, 15000);
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
// Close the embedded database cleanly (flushes it to disk) before the process exits
let closing = false;
app.on('before-quit', e => {
  if (closing || !baseUrl) return;
  closing = true;
  e.preventDefault();
  const db = require(path.join(path.dirname(serverPath), 'src', 'db.js'));
  Promise.race([db.close(), new Promise(r => setTimeout(r, 5000))]).catch(() => {}).finally(() => app.exit(0));
});
