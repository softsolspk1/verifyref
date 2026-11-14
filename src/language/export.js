// language/export.js - Module 6 downloads: the edited text as a Word document, or as a Word document with tracked changes
// (every edit since upload as an insertion or deletion the author can accept or reject in Word), and a language report.
const D = require('docx');

const tokens = s => s.match(/\s+|[^\s]+/g) || [];

/** Longest-common-subsequence diff of two arrays -> [{ t: '=', '+', '-', v }] */
function diff(a, b, eq = (x, y) => x === y) {
  const n = a.length, m = b.length;
  // trim the common start and end first: most paragraphs change in one place
  let s = 0;
  while (s < n && s < m && eq(a[s], b[s])) s++;
  let e = 0;
  while (e < n - s && e < m - s && eq(a[n - 1 - e], b[m - 1 - e])) e++;
  const A = a.slice(s, n - e), B = b.slice(s, m - e);
  const out = a.slice(0, s).map(v => ({ t: '=', v }));
  if (A.length * B.length > 4e6) {                     // too large to align: whole block replaced
    out.push(...A.map(v => ({ t: '-', v })), ...B.map(v => ({ t: '+', v })));
  } else {
    const L = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
    for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = eq(A[i], B[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < A.length && j < B.length) {
      if (eq(A[i], B[j])) { out.push({ t: '=', v: A[i] }); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: '-', v: A[i++] }); else out.push({ t: '+', v: B[j++] });
    }
    while (i < A.length) out.push({ t: '-', v: A[i++] });
    while (j < B.length) out.push({ t: '+', v: B[j++] });
  }
  out.push(...a.slice(n - e).map(v => ({ t: '=', v })));
  return out;
}

const heading = (text, level = D.HeadingLevel.HEADING_1) => new D.Paragraph({ text, heading: level });
const isHeading = p => p.trim().length > 0 && p.trim().length < 60 && !/[.:;,]$/.test(p.trim()) && p.trim().split(/\s+/).length <= 7 && /^[A-Z0-9]/.test(p.trim());

/** Clean Word document of the text */
async function cleanDocx(title, text) {
  const children = text.split('\n').map(p => (isHeading(p) ? new D.Paragraph({ children: [new D.TextRun({ text: p, bold: true })] }) : new D.Paragraph({ children: [new D.TextRun(p)] })));
  return D.Packer.toBuffer(new D.Document({ creator: 'Softsols Language Editing', title, sections: [{ children }] }));
}

/** Word document with the changes from original to text as tracked revisions */
async function trackedDocx(title, original, text, author = 'Language Editing') {
  const date = new Date().toISOString();
  let id = 1;
  const runs = ops => ops.map(o => {
    if (o.t === '=') return new D.TextRun(o.v);
    if (o.t === '+') return new D.InsertedTextRun({ text: o.v, id: id++, author, date });
    return new D.DeletedTextRun({ text: o.v, id: id++, author, date });
  });
  const pa = original.split('\n'), pb = text.split('\n');
  const paras = diff(pa, pb);
  const children = [];
  // a deleted paragraph followed by an inserted one is the same paragraph edited: word-level changes inside it
  for (let k = 0; k < paras.length; k++) {
    const o = paras[k];
    if (o.t === '=') { children.push(new D.Paragraph({ children: [new D.TextRun(o.v)] })); continue; }
    if (o.t === '-' && paras[k + 1]?.t === '+') {
      const merged = [];
      for (const w of diff(tokens(o.v), tokens(paras[k + 1].v))) {
        const last = merged[merged.length - 1];
        if (last && last.t === w.t) last.v += w.v; else merged.push({ ...w });
      }
      children.push(new D.Paragraph({ children: runs(merged) }));
      k++;
      continue;
    }
    children.push(new D.Paragraph({ children: runs([o]) }));
  }
  return D.Packer.toBuffer(new D.Document({ creator: 'Softsols Language Editing', title, features: { trackRevisions: true }, sections: [{ children }] }));
}

/** Language report: score, statistics, open suggestions grouped by area */
async function reportDocx({ title, score, stats, tone, issues = [], structure }) {
  const AREA = { correctness: 'Correctness', clarity: 'Clarity', engagement: 'Engagement', delivery: 'Delivery', style: 'Academic style' };
  const cell = (t, bold = false) => new D.TableCell({ children: [new D.Paragraph({ children: [new D.TextRun({ text: String(t ?? ''), bold })] })] });
  const table = rows => new D.Table({ width: { size: 100, type: D.WidthType.PERCENTAGE }, rows: rows.map((r, i) => new D.TableRow({ children: r.map(c => cell(c, i === 0)) })) });
  const children = [
    heading('Language Editing report', D.HeadingLevel.TITLE),
    new D.Paragraph({ children: [new D.TextRun({ text: title || 'Untitled document', bold: true })] }),
    new D.Paragraph(`Generated ${new Date().toLocaleString('en-GB')}`),
    heading('Overall'),
    table([['Measure', 'Value'], ['Overall score', `${score?.overall ?? '-'} / 100`], ['Words', stats?.words], ['Sentences', stats?.sentences], ['Reading time', `${Math.ceil((stats?.readingTime || 0) / 60)} min`],
      ['Flesch reading ease', `${stats?.readability?.flesch} (${stats?.readability?.label || ''})`], ['Flesch-Kincaid grade', stats?.readability?.grade], ['Average sentence length', `${stats?.avgSentenceLength} words`],
      ['Tone', (tone?.tones || []).map(t => t.label).join(', ') || '-']]),
    heading('Suggestions by area'),
    table([['Area', 'Open suggestions', 'Assessment'], ...Object.entries(AREA).map(([k, l]) => [l, score?.counts?.[k] ?? 0, score?.areas?.[k] || ''])])
  ];
  if (structure?.sections?.length) {
    children.push(heading('Manuscript structure'), table([['Section', 'Words'], ...structure.sections.map(s => [s.heading, s.words])]));
    if (structure.missing?.length) children.push(new D.Paragraph(`Sections not found: ${structure.missing.join(', ')}.`));
  }
  for (const [k, l] of Object.entries(AREA)) {
    const list = issues.filter(i => i.category === k).slice(0, 60);
    if (!list.length) continue;
    children.push(heading(l, D.HeadingLevel.HEADING_2), table([['Text', 'Issue', 'Suggestion'], ...list.map(i => [String(i.text).slice(0, 160), `${i.title}: ${i.message}`, (i.replacements || []).filter(Boolean).slice(0, 2).join(' / ') || (i.replacements?.[0] === '' ? '(remove)' : '')])]));
  }
  return D.Packer.toBuffer(new D.Document({ creator: 'Softsols Language Editing', title: 'Language Editing report', sections: [{ children }] }));
}

module.exports = { cleanDocx, trackedDocx, reportDocx, diff };
