// test/audit-lib.js - shared helpers for the audit tests: boots the web edition on an in-memory database and gives
// a small API client (JSON, multipart, jobs).
process.env.PGLITE_DIR = process.env.AUDIT_DB || 'memory://';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.PORT = '0';
delete process.env.APP_MODE;
delete process.env.DATABASE_URL;

async function boot() {
  const app = require('../server');
  const port = await app.start({ port: 0 });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const keep = r => { const c = r.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; };
  const api = {
    base,
    async json(method, p, body) {
      const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      keep(r);
      return { status: r.status, data: await r.json().catch(() => ({})) };
    },
    async form(p, fields, files = {}) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      for (const [k, f] of Object.entries(files)) fd.append(k, new Blob([f.buffer]), f.name);
      const r = await fetch(base + p, { method: 'POST', body: fd, headers: { Cookie: cookie } });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    },
    async raw(p) { const r = await fetch(base + p, { headers: { Cookie: cookie } }); return { status: r.status, type: r.headers.get('content-type'), buffer: Buffer.from(await r.arrayBuffer()) }; },
    async job(id, maxSeconds = 600) {
      for (let i = 0; i < maxSeconds * 2; i++) {
        await new Promise(r => setTimeout(r, 500));
        const j = (await api.json('GET', `/api/jobs/${id}`)).data;
        if (j.status === 'done' || j.status === 'error') return j;
      }
      return { status: 'timeout' };
    }
  };
  const r = await api.json('POST', '/api/auth/login', { email: 'admin@test.local', password: 'admin-pass-123' });
  if (!r.data.success) throw new Error('login failed');
  return api;
}
module.exports = { boot };
