// refresh-methods-signal.js - re-runs the Module 4 "methods / ethics" check (src/papermill/studyEthics.js) on saved
// Full Screening and Paper Mill reports, from the manuscript text kept in the PJPS text repository, and updates the
// saved report (signal, risk level, front page). Optionally marks the image report the screening made as part of it.
//   node scripts/refresh-methods-signal.js <checkId> [<checkId> ...] [--embed-images]
require('../src/config');
const db = require('../src/db');
const corpus = require('../src/corpus');
const P = require('../src/papermill');
const { loadCheck, screeningSummary } = require('../src/pipeline');

const ids = process.argv.slice(2).filter(a => /^\d+$/.test(a)).map(Number);
const EMBED = process.argv.includes('--embed-images');

(async () => {
  await db.init();
  for (const id of ids) {
    const row = await db.one('SELECT id, user_id, kind FROM checks WHERE id = $1', [id]);
    if (!row) { console.log(`#${id}: not found`); continue; }
    const c = await loadCheck(row.user_id, id);
    const r = c?.result;
    const pm = r?.kind === 'papermill' ? r : r?.papermill;
    if (!pm?.signals) { console.log(`#${id}: no paper-mill section`); continue; }
    const doc = await db.one('SELECT * FROM corpus_docs WHERE source_key = $1', [`check:${id}`]);
    if (!doc) { console.log(`#${id}: manuscript text not kept - run the screening again`); continue; }
    const text = await corpus.docText(doc);
    const before = pm.signals.find(s => s.code === 'methods');
    // the same signal as papermill/index.js textSignals
    const fresh = (await P.textSignals(text, text, [])).find(s => s.code === 'methods') || null;
    pm.signals = pm.signals.filter(s => s.code !== 'methods');
    if (fresh) pm.signals.push(fresh);
    const old = pm.risk;
    pm.risk = { ...pm.risk, ...P.riskLevel(pm.signals) };
    if (r.screening) r.screening = screeningSummary(r);
    await db.query('UPDATE checks SET result = $1 WHERE id = $2', [JSON.stringify(r), id]);
    await require('../src/reportStore').offload(id, r);
    console.log(`#${id}: methods ${before ? `"${before.title}" (${before.evidence.map(e => e.text).join('; ')})` : 'none'} -> ${fresh ? `"${fresh.title}" (${fresh.evidence.map(e => e.text).join('; ')})` : 'none'}; risk ${old?.level} ${old?.score} -> ${pm.risk.level} ${pm.risk.score}`);
    if (EMBED && r.images?.checkId) {
      await db.query("UPDATE checks SET embedded_in = $1 WHERE id = $2 AND user_id = $3 AND kind = 'images'", [id, r.images.checkId, row.user_id]);
      console.log(`#${id}: image report #${r.images.checkId} is now shown only inside this report`);
    }
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
