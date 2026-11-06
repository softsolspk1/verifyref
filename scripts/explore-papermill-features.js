// scripts/explore-papermill-features.js - candidate Module 4 signals measured on the benchmark papers of
// benchmark-papermill.js (150 paper-mill retractions vs 126 ordinary papers of the same journals and years), from the
// cached JATS full texts: e-mail domains, reference relevance to the paper's topic, reference-list shape, statements.
// Each candidate is printed for half A and half B (odd / even PMC number): a signal is only worth adding if it separates
// the groups on both halves. Usage: node scripts/explore-papermill-features.js [--json out.json]
const fs = require('fs');
const path = require('path');
const { FREE_MAIL } = require('../src/papermill/lists');

const DIR = path.join(__dirname, '..', 'data', 'benchmark');
const clean = x => String(x || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set('the of and in to a for on with by from is are was were as at an or its their this that these those be been into than via using based study effect effects analysis role new between among after during under over patients patient clinical research review case cases'.split(' '));
const words = t => [...new Set(clean(t).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !STOP.has(w)).map(w => w.replace(/(ies|es|s)$/, '')))];

const bench = JSON.parse(fs.readFileSync(path.join(DIR, 'results.json'), 'utf8'));
const rows = [];
for (const b of bench) {
  const f = path.join(DIR, 'xml', `${b.pmcid}.xml`);
  if (!fs.existsSync(f)) continue;
  const xml = fs.readFileSync(f, 'utf8');
  const front = (xml.match(/<front>[\s\S]*?<\/front>/) || [''])[0];
  const title = clean((front.match(/<article-title[^>]*>([\s\S]*?)<\/article-title>/) || [])[1]);
  const abs = clean((front.match(/<abstract[\s\S]*?<\/abstract>/) || [''])[0]);
  const emails = [...new Set([...xml.matchAll(/<email[^>]*>([^<]+)<\/email>/g)].map(m => m[1].trim().toLowerCase()))];
  const free = emails.filter(e => FREE_MAIL.test(e));
  const refs = [...((xml.match(/<ref-list[\s\S]*<\/ref-list>/) || [''])[0]).matchAll(/<ref[ >][\s\S]*?<\/ref>/g)].map(m => m[0]);
  const refTitles = refs.map(r => clean((r.match(/<article-title[^>]*>([\s\S]*?)<\/article-title>/) || [])[1])).filter(t => t.length > 15);
  const topic = new Set(words(`${title} ${abs}`));
  // share of the reference titles sharing no content word with the paper's title + abstract
  const unrelated = refTitles.length ? refTitles.filter(t => !words(t).some(w => topic.has(w))).length / refTitles.length : null;
  const unrelated2 = refTitles.length ? refTitles.filter(t => words(t).filter(w => topic.has(w)).length < 2).length / refTitles.length : null;
  const years = refs.map(r => parseInt((r.match(/<year[^>]*>(\d{4})/) || [])[1], 10)).filter(Boolean);
  const pubYear = parseInt(b.year, 10) || null;
  const recent = years.length && pubYear ? years.filter(y => y >= pubYear - 3).length / years.length : null;
  const body = clean((xml.match(/<body>[\s\S]*<\/body>/) || [''])[0]);
  const back = clean((xml.match(/<back>[\s\S]*<\/back>/) || [''])[0]);
  rows.push({
    group: b.group, half: parseInt(b.pmcid.replace(/\D/g, ''), 10) % 2 ? 'B' : 'A', pmcid: b.pmcid, title,
    emails: emails.length, freeAll: emails.length > 0 && free.length === emails.length, freeAny: free.length > 0,
    cnMail: emails.some(e => /@(163|126|qq|sina|yeah|139|foxmail|aliyun|sohu)\.(com|cn)$/.test(e)),
    refs: refs.length, refTitles: refTitles.length, unrelated, unrelated2, recent,
    upon: /available (?:from|upon|on) (?:the )?(?:corresponding author|request)|upon (?:reasonable )?request/i.test(back + ' ' + body.slice(-6000)),
    noFunding: /(?:did not receive|received no|no) (?:specific )?(?:funding|grant)|not funded|no funding/i.test(back),
    words: body.split(/\s+/).length
  });
}
const share = (g, h, fn) => { const r = rows.filter(x => x.group === g && (!h || x.half === h)); return `${r.filter(fn).length}/${r.length}`; };
const show = (label, fn) => console.log(`${label.padEnd(58)} A: ${share('mill', 'A', fn).padEnd(7)} ${share('control', 'A', fn).padEnd(7)} | B: ${share('mill', 'B', fn).padEnd(7)} ${share('control', 'B', fn).padEnd(7)} | all ${share('mill', null, fn)} vs ${share('control', null, fn)}`);
console.log('candidate signal'.padEnd(58), 'mill / ordinary per half');
show('all e-mails free-mail', r => r.freeAll);
show('any free-mail', r => r.freeAny);
show('Chinese free-mail (163, qq, 126 ...)', r => r.cnMail);
for (const t of [0.3, 0.4, 0.5, 0.6]) show(`references unrelated to the topic >= ${t} (10+ titled refs)`, r => r.refTitles >= 10 && r.unrelated >= t);
for (const t of [0.5, 0.6, 0.7, 0.8]) show(`references sharing < 2 topic words >= ${t} (10+ titled refs)`, r => r.refTitles >= 10 && r.unrelated2 >= t);
for (const t of [0.15, 0.25]) show(`recent references (last 3 years) <= ${t}`, r => r.recent !== null && r.refs >= 10 && r.recent <= t);
show('fewer than 25 references', r => r.refs > 0 && r.refs < 25);
show('data "available upon request"', r => r.upon);
show('no funding stated', r => r.noFunding);
const j = process.argv.indexOf('--json');
if (j > 0) fs.writeFileSync(process.argv[j + 1], JSON.stringify(rows, null, 1));
