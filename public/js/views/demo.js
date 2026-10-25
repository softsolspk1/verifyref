// views/demo.js - demonstration data for presenting the portal: fictional manuscripts with planted problems and a
// step-by-step script per module. The files are built by `npm run demo` (demo/build-demo.js) and served from /demo/.
import { esc, hasModule, ICONS } from '../core.js';

const FILES = [
  { name: 'PJPS-2025-0101_Earlier-Submission.docx', title: 'Earlier submission (PJPS-2025-0101)', text: 'Run this first in Module 4 and Module 5 (saved). It becomes the “earlier PJPS manuscript” the demonstration manuscript is matched against.' },
  { name: 'PJPS-2026-0412_Demo-Manuscript.docx', title: 'Demonstration manuscript (PJPS-2026-0412)', text: 'Word file with text, references and five figures. Use it for every module and for the Full Screening Report.' },
  { name: 'PJPS-2026-0412_Reference-List.txt', title: 'Reference list only', text: 'Seven references: genuine, mis-cited, retracted and invented ones. For Module 1 when you want to paste or upload just the list.' }
];
const FIGS = [
  ['Figure1_microscopy.png', 'a, b', 'Panel 1 re-used (rotated) as panel 2; a patch cloned inside panel 3'],
  ['Figure2_western-blot.png', 'b', 'Two blots joined: sharp background step across the whole blot; repeated lane pattern'],
  ['Figure3_charts.png', 'd', 'The same six values plotted twice, in another colour and scale'],
  ['Figure4_histology.png', 'c', 'Image file carries Stable-Diffusion generation parameters; no sensor noise'],
  ['Figure5_photo.png', 'b', 'A smooth area pasted over part of the picture (retouching)']
];

const STEPS = [
  { module: 'images', path: '/images', title: '5 · Image Integrity', items: [
    'Upload <b>PJPS-2025-0101_Earlier-Submission.docx</b>, manuscript ID <code>PJPS-2025-0101</code> → <i>Analyse figures</i> (2 figures, nothing found).',
    'Upload <b>PJPS-2026-0412_Demo-Manuscript.docx</b>, ID <code>PJPS-2026-0412</code>. Four detection groups appear: <b>a)</b> duplication, <b>b)</b> alteration &amp; manipulation, <b>c)</b> AI-generated, <b>d)</b> graph &amp; chart duplication.',
    'Open <i>Earlier PJPS manuscripts</i>: Figure 1 panel and the bar chart match the first submission. Open the forensic viewer on any finding; mark one “Ask the authors” and prepare the letter; export the confidential Word report.'
  ] },
  { module: 'papermill', path: '/papermill', title: '4 · Paper Mill Detection', items: [
    'Upload the earlier submission first (so the duplicate-submission check has something to compare), then the demonstration manuscript with the same ID; attach the saved Module 5 report.',
    'Expect HIGH: tortured phrases, AI-text leftovers (“As an AI language model…”), template wording, vague methods, the misidentified cell line HEp-2 (= HeLa), invented references, free-mail addresses, an off-topic affiliation, no ORCID, text overlap with PJPS-2025-0101 and the image findings.'
  ] },
  { module: 'references', path: '/references', title: '1 · Check Bibliography', items: [
    'Upload the demonstration manuscript or the reference list. Genuine references verify; the 2019 copy of the Foods paper is mis-cited (wrong year); the 1998 Lancet paper is retracted; three references are not found in any database.'
  ] },
  { module: 'restyle', path: '/restyle', title: '2 · Reference Style & PJPS Converter', items: [
    'Upload the manuscript: rule-by-rule PJPS compliance, then convert to the PJPS style and download the Word file with Track Changes.'
  ] },
  { module: 'citations', path: '/citations', title: '3 · Citations', items: [
    '“Ali et al., 2020” is cited but not in the list; “Iqbal et al., 2020” and others are checked in both directions. Add a source PDF for claim support, then prepare the author letter.'
  ] },
  { module: 'manuscript', path: '/manuscript', title: 'Full Screening Report', items: [
    'Upload the demonstration manuscript once: front-page summary of all five modules and the desk-review recommendation; export the editor and the author versions.'
  ] }
];

export function renderDemo(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>Demonstration data</h1>
      <p>Fictional manuscripts with planted problems, for presenting the portal. Nothing here concerns a real author, institution or paper. Download the files, then follow the steps below module by module.</p></div></div>
    <div class="card"><h3>Files</h3>
      <div class="table-wrap"><table class="t"><tr><th>File</th><th>Use</th><th></th></tr>
      ${FILES.map(f => `<tr><td><b>${esc(f.title)}</b><div class="muted">${esc(f.name)}</div></td><td>${esc(f.text)}</td><td><a class="btn btn-sm" href="/demo/${encodeURI(f.name)}" download>${ICONS.download} Download</a></td></tr>`).join('')}
      </table></div></div>
    <div class="card"><h3>Figure files <span class="muted">(also inside the manuscript — upload them separately to test the “figure files” route)</span></h3>
      <div class="table-wrap"><table class="t"><tr><th>Figure</th><th>Detection</th><th>Planted problem</th><th></th></tr>
      ${FIGS.map(([n, c, t]) => `<tr><td><img src="/demo/figures/${n}" alt="" style="height:54px;vertical-align:middle;margin-right:8px;border:1px solid var(--border,#d9dee7)"> ${esc(n.replace('.png', ''))}</td><td>${esc(c)})</td><td>${esc(t)}</td><td><a class="btn btn-sm" href="/demo/figures/${n}" download>${ICONS.download}</a></td></tr>`).join('')}
      </table></div>
      <p class="muted" style="margin:8px 0 0">a) duplication &amp; reuse · b) alteration &amp; manipulation · c) AI-generated images · d) graph &amp; chart duplication</p></div>
    ${STEPS.filter(s => hasModule(s.module)).map(s => `<div class="card"><div class="card-head"><h3>${esc(s.title)}</h3><a href="#${s.path}">Open →</a></div><ol style="margin:0;padding-left:20px;line-height:1.6">${s.items.map(i => `<li>${i}</li>`).join('')}</ol></div>`).join('')}
    <div class="alert alert-info">The screening results are aids for the editor, not verdicts. Heuristic checks (image statistics, AI-image indicators, repeated textures) can raise false alarms; the demonstration files are built so the expected findings appear.</div>`;
}
