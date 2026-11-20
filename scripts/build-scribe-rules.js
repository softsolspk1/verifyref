#!/usr/bin/env node
// build-scribe-rules.js - PJPS Scribe (Module 6) rules for both engines.
//   1. src/language/dict/typos.txt: typing slips found in published papers ("postive", "trasfected") from the word counts
//      of scripts/build-research-lexicon.js, and drug names written in another language's form ("metformine",
//      "dexamethason", "omeprazol"); the in-house spelling reports them with the right word first.
//   2. LanguageTool files for the grammar server: grammar_custom.xml (the rule bank of src/language/bank.js and the typos
//      as LanguageTool rules, each with its example) and spelling_custom.txt (the research vocabulary and author names, so
//      the server's spelling knows medical and pharmaceutical terms).
//   3. --deploy: the files go to a staging copy of LanguageTool on the server first (port 8082); every rule's example is
//      checked there (the wrong form must be found at its place, the corrected form must not be); rules that fail are left
//      out, and only a set with no failures is installed on the live server (with the n-gram data switched on when it is
//      on the server), which is then restarted and checked.
//
//   node scripts/build-scribe-rules.js [--counts F] [--no-typos] [--out DIR] [--deploy] [--host user@ip] [--key F]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');
const B = require('../src/language/bank');

const argv = process.argv.slice(2);
const opt = (name, d) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : d);
const ROOT = path.join(__dirname, '..');
const DICT = path.join(ROOT, 'src', 'language', 'dict');
const COUNTS = opt('counts', 'D:/pjps-tmp/research-lexicon-counts.json.gz');
const OUT = opt('out', 'D:/pjps-tmp/scribe-languagetool');
const HOST = opt('host', process.env.LANGUAGETOOL_SSH || 'ubuntu@149.118.45.69');
const KEY = opt('key', path.join(require('os').homedir(), '.ssh', 'oracle_languagetool'));

const lines = f => fs.readFileSync(f, 'utf8').split('\n').map(w => w.trim()).filter(w => w && !w.startsWith('#'));

// ------------------------------------------------------------------ typos.txt
const ALPHA = 'abcdefghijklmnopqrstuvwxyz';
function edits1(w) {
  const out = new Set();
  for (let i = 0; i <= w.length; i++) {
    const a = w.slice(0, i), b = w.slice(i);
    if (b) out.add(a + b.slice(1));
    if (b.length > 1) out.add(a + b[1] + b[0] + b.slice(2));
    for (const c of ALPHA) { if (b) out.add(a + c + b.slice(1)); out.add(a + c + b); }
  }
  out.delete(w);
  return out;
}

/** the kind of slip between typo k and word e, or null when it is not a typing slip inside the word */
function slip(k, e) {
  let i = 0; while (i < k.length && i < e.length && k[i] === e[i]) i++;
  let j = 0; while (j < k.length - i && j < e.length - i && k[k.length - 1 - j] === e[e.length - 1 - j]) j++;
  const tk = k.length - i - j, te = e.length - i - j;
  // an edit at the first two letters or the last three is a different word or a piece of one (lability, produc, valuea)
  if (i < 2 || Math.min(k.length, e.length) - i < 3) return null;
  if (k.length === e.length && tk === 2 && k[i] === e[i + 1] && k[i + 1] === e[i]) return 'transpose';
  if (tk === 0 && te === 1) return e[i] === e[i - 1] || e[i] === e[i + 1] ? 'single-for-double' : 'dropped';
  if (tk === 1 && te === 0) return k[i] === k[i - 1] || k[i] === k[i + 1] ? 'double-for-single' : null;
  if (tk === 1 && te === 1 && /[aeiou]/.test(k[i]) && /[aeiou]/.test(e[i])) return 'vowel';
  return null;
}

function buildTypos() {
  const nspell = require('nspell'), D = f => fs.readFileSync(path.join(DICT, f));
  const us = nspell(D('en-US.aff'), D('en-US.dic')), gb = nspell(D('en-GB.aff'), D('en-GB.dic'));
  const known = w => us.correct(w) || gb.correct(w);
  const research = new Set(lines(path.join(DICT, 'research.txt')).map(w => w.toLowerCase()));
  const names = new Set(lines(path.join(DICT, 'names.txt')).map(w => w.toLowerCase()));
  const real = w => known(w) || research.has(w);
  const c = JSON.parse(zlib.gunzipSync(fs.readFileSync(COUNTS)).toString('utf8'));
  const df = new Map(c.df), low = new Map(c.lowerDf);
  const out = new Map();
  // 1. slips in published papers: a word no dictionary has, written in lower case, one typing slip from a real word that
  //    papers use at least 500 times as often (2,000 times for a changed vowel); Latin and other-language endings kept out
  for (const [k, n] of df) {
    if (k.length < 7 || real(k) || names.has(k) || (low.get(k) || 0) < n * 0.5) continue;
    let best = null, bm = 0;
    for (const e of edits1(k)) { if (!real(e)) continue; const m = df.get(e) || 0; if (m > bm) { bm = m; best = e; } }
    if (!best || bm < 100 || bm < n * 500) continue;
    const kind = slip(k, best);
    if (!kind || (kind === 'dropped' && best.length < 8) || (kind === 'vowel' && bm < n * 2000)) continue;
    if (/(?:us|um|ae|os|as|es|ii|o)$/.test(k) && !/(?:us|um|ae|os|as|es|ii|o)$/.test(best)) continue;
    out.set(k, [best, 'published']);
  }
  // 2. drug names in another language's form: metformine, ciprofloxacine (French), dexamethason, omeprazol, furosemid
  //    (German, Spanish), amoxicilin (one l); only for drugs the papers name often, and only forms no dictionary has
  const DRUG_IN = /(?:mycin|micin|cillin|oxacin|formin|statin|parin|insulin|aspirin|ampicin|picin|rubicin|platin|taxel|ulin)$/;
  const DRUG_INE = /(?:amine|idine|azine|azepine|apine|caine|xetine|tyline|pramine|dipine|ephrine|oline|ozine|ycine|osine|izine|rphine|tropine|otine|ffeine|odeine|zosine|statine|ptyline|olamine|thrine|amivudine|citabine)$/;
  const DRUG_ONE = /(?:olone|isone|asone|idone|sterone|azone|oxone|thasone|ulone)$/;
  // ordinary words and suppliers with these endings (examine, magazine, HyClone, PLoS ONE)
  const NOT_DRUG = /^(?:examine|magazine|gasoline|standalone|serpentine|cyclone|famine|subclone|euroclone|diaclone|hyclone|plosone|tassone|nagamine|abalone|trampoline|vaseline|routine|determine|feminine|masculine|genuine|discipline|machine|medicine|marine|uterine|urine|engine|cuisine)$/;
  const DRUG_IDE = /(?:semide|clamide|pramide|thiazide|ramide|tamide|lamide|pamide|zolamide)$/;
  const DRUG_OLE = /(?:azole|prazole|dazole|nazole|mazole|conazole)$/;
  let drugs = 0;
  const add = (v, w) => {
    if (v.length < 6 || v === w || real(v) || names.has(v) || out.has(v)) return;
    if ((df.get(v) || 0) * 50 > (df.get(w) || 0)) return; // a form papers use often is a real variant, not a slip
    out.set(v, [w, 'drug']); drugs++;
  };
  for (const [w, n] of df) {
    if (n < 30 || w.length < 7 || !real(w) || NOT_DRUG.test(w) || names.has(w)) continue;
    if (DRUG_IN.test(w)) add(`${w}e`, w);
    if (DRUG_INE.test(w) || DRUG_ONE.test(w) || DRUG_IDE.test(w) || DRUG_OLE.test(w)) add(w.slice(0, -1), w);
    if (/cillin$/.test(w)) add(w.replace(/cillin$/, 'cilin'), w);
    if (/mycin$/.test(w)) add(w.replace(/mycin$/, 'micin'), w);
    if (/micin$/.test(w)) add(w.replace(/micin$/, 'mycin'), w);
    if (/ph/.test(w) && /(?:amine|azine|ine)$/.test(w) && n >= 100) add(w.replace('ph', 'f'), w);
  }
  // 3. the hand-picked medical slips of spell.js stay where they are (TYPOS); none of them is repeated here
  const S = require('../src/language/spell');
  for (const k of Object.keys(S.HAND_TYPOS || {})) out.delete(k);
  const rows = [...out].sort((a, b) => a[0].localeCompare(b[0])).map(([k, [w, kind]]) => `${k}\t${w}\t${kind}`);
  fs.writeFileSync(path.join(DICT, 'typos.txt'), `# PJPS Scribe typing slips (typo, word, source), built ${new Date().toISOString().slice(0, 10)} by scripts/build-scribe-rules.js: "published" = seen in published papers next to the word they meant (${c.docs} papers), "drug" = a drug name in another language's form. One per line.\n${rows.join('\n')}\n`);
  console.log(`typos.txt: ${rows.length} (${rows.length - drugs} published slips, ${drugs} drug-name forms)`);
}

// ------------------------------------------------------------------ LanguageTool grammar_custom.xml
const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const CATEGORY = {
  'medical-confusion': ['PJPS_CONFUSED_WORDS', 'PJPS Scribe: confused words in medical writing', 'grammar'],
  preposition: ['PJPS_PREPOSITIONS', 'PJPS Scribe: prepositions and fixed expressions', 'grammar'],
  'l2-grammar': ['PJPS_GRAMMAR', 'PJPS Scribe: grammar', 'grammar'],
  'noun-number': ['PJPS_NOUN_FORMS', 'PJPS Scribe: plural and uncountable nouns', 'grammar'],
  'medical-term': ['PJPS_MEDICAL_TERMS', 'PJPS Scribe: medical and statistical terms', 'terminology'],
  'species-name': ['PJPS_SPECIES', 'PJPS Scribe: species names', 'terminology'],
  'abbreviation-case': ['PJPS_ABBREVIATIONS', 'PJPS Scribe: abbreviations', 'terminology'],
  'unit-style': ['PJPS_UNITS', 'PJPS Scribe: units', 'typographical'],
  'redundant-acronym': ['PJPS_REDUNDANCY', 'PJPS Scribe: redundant acronyms', 'style'],
  wordy: ['PJPS_WORDINESS', 'PJPS Scribe: wordiness', 'style'],
  'academic-usage': ['PJPS_ACADEMIC', 'PJPS Scribe: academic usage', 'style'],
  typo: ['PJPS_TYPOS', 'PJPS Scribe: medical and research spelling slips', 'misspelling']
};
/** LanguageTool's English tokens: hyphenated words stay whole; full stops, slashes, plus signs, brackets and apostrophes split,
 *  and so does a hyphen that does not join two words ("mean+/-SD" is mean + / - SD on the server) */
const ltTokens = s => {
  const out = [];
  for (const m of s.matchAll(/'s\b|’s\b|[.\/+(),;:±'’]|[^\s.\/+(),;:±'’]+/g)) {
    const space = m.index > 0 && /\s/.test(s[m.index - 1]);
    const lead = m[0].match(/^-+(?=[^-])/);
    if (!lead) { out.push({ t: m[0], space }); continue; }
    for (let k = 0; k < lead[0].length; k++) out.push({ t: '-', space: k === 0 && space });
    out.push({ t: m[0].slice(lead[0].length), space: false });
  }
  return out;
};
const ctxToken = (alts, cs) => {
  // a context word: the alternatives as one regular expression (case as written for case-sensitive rules)
  const re = alts.split('|').map(a => (/^\\[.()]$/.test(a) ? a : a.replace(/\\d/g, '[0-9]'))).join('|');
  return `<token regexp="yes"${cs ? ' case_sensitive="yes"' : ''}>${xml(re)}</token>`;
};

function ruleXml(id, e) {
  const toks = ltTokens(e.find);
  const pat = [];
  // number contexts: LanguageTool splits "10.5" into three tokens, so the last digits are what comes before a unit
  if (e.before) pat.push(ctxToken(e.before.replace(/\\d\+\(\?:\[\.,\]\\d\+\)\?/g, '\\d+'), false));
  pat.push('<marker>');
  toks.forEach((t, k) => pat.push(`<token${k && !t.space ? ' spacebefore="no"' : ''}${e.cs ? ' case_sensitive="yes"' : ''}>${xml(t.t)}</token>`));
  pat.push('</marker>');
  if (e.after) pat.push(ctxToken(e.after.replace(/\\d\+\(\?:\[\.,\]\\d\+\)\?%\?/g, '\\d+').replace(/\(\?:19\|20\)\\d\\d/g, '(19|20)\\d\\d'), false));
  else if (e.na) pat.push(`<token negate="yes" regexp="yes">${xml(e.na.replace(/\\d\+\(\?:\[\.,\]\\d\+\)\?%\?/g, '\\d+'))}</token>`);
  const reps = e.to.filter(r => r !== '');
  const sugg = reps.map(r => `<suggestion>${xml(r)}</suggestion>`).join(' or ');
  const bad = e.example.bad.slice(0, e.example.offset) + `<marker>${xml(e.find)}</marker>` + e.example.bad.slice(e.example.offset + e.find.length);
  const badXml = xml(e.example.bad.slice(0, e.example.offset)) + `<marker>${xml(e.find)}</marker>` + xml(e.example.bad.slice(e.example.offset + e.find.length));
  void bad;
  return `<rule id="${id}" name="${xml(`${e.find} → ${reps.join(' / ')}`)}">
<pattern>${pat.join('')}</pattern>
<message>${xml(e.message)}${sugg ? ` Suggestion: ${sugg}.` : ''}</message>
<example correction="${xml(reps.join('|'))}">${badXml}</example>${e.example.good ? `\n<example>${xml(e.example.good)}</example>` : ''}
</rule>`;
}

/** the typos of typos.txt and the slips spell.js lists by hand (HAND_TYPOS), each typo once */
function allTypos() {
  const out = [...B.typoList()], seen = new Set(out.map(t => t.typo.toLowerCase()));
  for (const [typo, word] of Object.entries(require('../src/language/spell').HAND_TYPOS || {})) {
    if (seen.has(typo.toLowerCase()) || !/^[A-Za-z][A-Za-z'-]*$/.test(typo)) continue;
    seen.add(typo.toLowerCase());
    out.push({ typo, word, kind: 'published' });
  }
  return out;
}

/** [{ id, xml, check: { bad, good, offset, length } }] for the bank and the typos; `drop` ids are left out */
function ltRules(drop = new Set()) {
  const out = [];
  for (const e of B.entries()) {
    if (!e.to.some(r => r !== '')) continue; // a deletion: the in-house rule offers it (LanguageTool would show no fix)
    const id = `PJPS_${e.id.toUpperCase().replace(/-/g, '_')}`;
    if (drop.has(id)) continue;
    out.push({ id, group: e.rule, xml: ruleXml(id, e), check: { bad: e.example.bad, good: e.example.good, offset: e.example.offset, length: e.find.length } });
  }
  let n = 0;
  for (const { typo, word, kind } of allTypos()) {
    const id = `PJPS_TYPO_${++n}`;
    if (drop.has(id)) continue;
    const msg = kind === 'drug' ? `"${typo}" is how the name is spelled in another language; in English it is "${word}".` : `"${typo}" is a common slip for "${word}".`;
    const bad = `We measured ${typo} in the samples.`;
    out.push({
      id, group: 'typo', check: { bad, good: `We measured ${word} in the samples.`, offset: 12, length: typo.length },
      xml: `<rule id="${id}" name="${xml(`${typo} → ${word}`)}">
<pattern><token>${xml(typo)}</token></pattern>
<message>${xml(msg)} Suggestion: <suggestion>${xml(word)}</suggestion>.</message>
<example correction="${xml(word)}">We measured <marker>${xml(typo)}</marker> in the samples.</example>
</rule>`
    });
  }
  return out;
}

function writeLt(rules) {
  fs.mkdirSync(OUT, { recursive: true });
  const byCat = new Map();
  for (const r of rules) { const k = r.group; if (!byCat.has(k)) byCat.set(k, []); byCat.get(k).push(r.xml); }
  const body = [...byCat].map(([g, list]) => {
    const [id, name, type] = CATEGORY[g];
    return `<category id="${id}" name="${xml(name)}" type="${type}">\n${list.join('\n')}\n</category>`;
  }).join('\n');
  fs.writeFileSync(path.join(OUT, 'grammar_custom.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<!-- PJPS Scribe rules for medical and pharmaceutical manuscripts: made by scripts/build-scribe-rules.js from
     src/language/bank.js, src/language/dict/typos.txt and HAND_TYPOS in src/language/spell.js (${rules.length} rules). Do not edit here. -->
<rules lang="en" xsi:noNamespaceSchemaLocation="../rules.xsd" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
${body}
</rules>
`);
  // the research vocabulary, the subject-area terms and author names for the server's spelling (LanguageTool's own list stays as it is)
  // known slips stay out of it, so the server's spelling flags them as well as the typo rules
  const slips = new Set(allTypos().map(t => t.typo.toLowerCase()));
  const words = new Set([...lines(path.join(DICT, 'research.txt')), ...lines(path.join(DICT, 'subjects.txt')), ...lines(path.join(DICT, 'names.txt'))].filter(w => /^[A-Za-z][A-Za-z'-]*$/.test(w) && !slips.has(w.toLowerCase())));
  fs.writeFileSync(path.join(OUT, 'spelling_custom.txt'), `# Add terms here that should be accepted by the LanguageTool spell checker, one word or phrase per line\n# PJPS Scribe research vocabulary and author names (${words.size}), from scripts/build-scribe-rules.js\n${[...words].join('\n')}\n`);
  const counts = {};
  for (const r of rules) counts[r.group] = (counts[r.group] || 0) + 1;
  console.log(`grammar_custom.xml: ${rules.length} rules`, counts, `\nspelling_custom.txt: ${words.size} words -> ${OUT}`);
}

// ------------------------------------------------------------------ deploy and check on the server
const sshArgs = ['-i', KEY, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=20'];
function ssh(cmd, { quiet } = {}) {
  const r = spawnSync('ssh', [...sshArgs, HOST, cmd], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (!quiet && r.stdout) process.stdout.write(r.stdout);
  if (r.status !== 0) throw new Error(`ssh failed (${r.status}): ${(r.stderr || '').trim().slice(0, 400)}`);
  return r.stdout;
}
function scp(files, dest) {
  const r = spawnSync('scp', [...sshArgs, ...files, `${HOST}:${dest}`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`scp failed: ${r.stderr}`);
}
const RULES_DIR = 'org/languagetool/rules/en', SPELL_DIR = 'org/languagetool/resource/en/hunspell';

/** a staging copy of the live install with the new files, on 127.0.0.1:8082 */
function stage() {
  scp([path.join(OUT, 'grammar_custom.xml'), path.join(OUT, 'spelling_custom.txt')], '/tmp/');
  ssh(`set -e
[ -f /tmp/lt-stage.pid ] && kill $(cat /tmp/lt-stage.pid) 2>/dev/null; rm -f /tmp/lt-stage.pid; true
sudo rm -rf /opt/lt-stage && sudo cp -r /opt/languagetool /opt/lt-stage && sudo chown -R ubuntu /opt/lt-stage
cp /tmp/grammar_custom.xml /opt/lt-stage/${RULES_DIR}/grammar_custom.xml
cp /tmp/spelling_custom.txt /opt/lt-stage/${SPELL_DIR}/spelling_custom.txt
cd /opt/lt-stage
{ echo cacheSize=0; echo maxTextLength=200000; echo maxCheckTimeMillis=120000; [ -d /opt/languagetool-ngrams/en ] && echo languageModel=/opt/languagetool-ngrams || true; } > server.properties
nohup java -Xms512m -Xmx6g -cp languagetool-server.jar org.languagetool.server.HTTPServer --config server.properties --port 8082 < /dev/null > /tmp/lt-stage.log 2>&1 &
echo $! > /tmp/lt-stage.pid
for i in $(seq 1 90); do curl -fsS http://127.0.0.1:8082/v2/languages >/dev/null 2>&1 && break; sleep 2; done
curl -fsS http://127.0.0.1:8082/v2/languages >/dev/null || { tail -40 /tmp/lt-stage.log; exit 1; }
echo staged`);
}

/** an SSH tunnel to the staging server: http://127.0.0.1:18082 */
async function tunnel() {
  const p = spawn('ssh', [...sshArgs, '-N', '-L', '18082:127.0.0.1:8082', HOST], { stdio: 'ignore' });
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try { if ((await fetch('http://127.0.0.1:18082/v2/languages')).ok) return p; } catch { /* not yet */ }
  }
  p.kill();
  throw new Error('no tunnel to the staging server');
}

async function ltCheck(url, text, categories) {
  const body = new URLSearchParams({ text, language: 'en-US', level: 'picky' });
  if (categories) { body.set('enabledCategories', categories.join(',')); body.set('enabledOnly', 'true'); }
  const r = await fetch(`${url}/v2/check`, { method: 'POST', body });
  if (!r.ok) throw new Error(`LanguageTool ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return (await r.json()).matches || [];
}

/** every rule's examples on the server -> ids of the rules that failed */
async function verify(url, rules) {
  const cats = Object.values(CATEGORY).map(c => c[0]);
  const items = [];
  for (const r of rules) {
    items.push({ r, text: r.check.bad, bad: true });
    if (r.check.good) items.push({ r, text: r.check.good, bad: false });
  }
  const failed = new Map();
  const SEP = '\n\n';
  for (let i = 0; i < items.length; i += 200) {
    const batch = items.slice(i, i + 200);
    const starts = []; let pos = 0;
    for (const it of batch) { starts.push(pos); pos += it.text.length + SEP.length; }
    const matches = await ltCheck(url, batch.map(b => b.text).join(SEP), cats);
    batch.forEach((it, k) => {
      const mine = matches.filter(m => m.rule.id === it.r.id && m.offset >= starts[k] && m.offset < starts[k] + it.text.length);
      if (it.bad && !mine.some(m => m.offset - starts[k] === it.r.check.offset)) failed.set(it.r.id, 'not found in its example');
      if (!it.bad && mine.length) failed.set(it.r.id, 'found in the corrected sentence');
    });
    process.stdout.write(`\rchecked ${Math.min(i + 200, items.length)}/${items.length} examples, ${failed.size} rules failed`);
  }
  process.stdout.write('\n');
  return failed;
}

/** seconds the server takes for the manuscripts in article/ (Word text), with and without the PJPS rules */
async function timing(url) {
  let text = '';
  try {
    const mammoth = require('mammoth');
    for (const f of fs.readdirSync(path.join(ROOT, 'article')).filter(n => n.endsWith('.docx')).slice(0, 3)) text += (await mammoth.extractRawText({ path: path.join(ROOT, 'article', f) })).value + '\n\n';
  } catch { /* no manuscripts here */ }
  if (!text) return null;
  text = text.slice(0, 18000);
  const t0 = Date.now(); const all = await ltCheck(url, text); const t1 = Date.now();
  return { chars: text.length, ms: t1 - t0, matches: all.length, pjps: all.filter(m => m.rule.id.startsWith('PJPS_')).length };
}

async function deploy() {
  let drop = new Set();
  let rules = ltRules(drop);
  for (let round = 1; round <= 3; round++) {
    writeLt(rules);
    console.log(`== staging round ${round}`);
    stage();
    const t = await tunnel();
    let failed;
    try {
      failed = await verify('http://127.0.0.1:18082', rules);
      if (!failed.size) {
        const tm = await timing('http://127.0.0.1:18082');
        if (tm) console.log(`timing: ${tm.chars} characters in ${tm.ms} ms, ${tm.matches} suggestions (${tm.pjps} from the PJPS rules)`);
      }
    } finally { t.kill(); }
    if (!failed.size) break;
    for (const [id, why] of failed) console.log(`  left out ${id}: ${why}`);
    drop = new Set([...drop, ...failed.keys()]);
    rules = ltRules(drop);
    if (round === 3) throw new Error('rules still failing after 3 rounds; nothing installed');
  }
  fs.writeFileSync(path.join(OUT, 'left-out.json'), JSON.stringify([...drop], null, 1));
  if (argv.includes('--stage-only')) {
    ssh(`[ -f /tmp/lt-stage.pid ] && kill $(cat /tmp/lt-stage.pid) 2>/dev/null; rm -f /tmp/lt-stage.pid; true; sudo rm -rf /opt/lt-stage`);
    console.log(`staging passed with ${rules.length} PJPS rules (${drop.size} left out); live server not changed`);
    return;
  }
  console.log(`== installing ${rules.length} PJPS rules on the live server`);
  ssh(`set -e
[ -f /tmp/lt-stage.pid ] && kill $(cat /tmp/lt-stage.pid) 2>/dev/null; rm -f /tmp/lt-stage.pid; true
sudo rm -rf /opt/lt-stage
cd /opt/languagetool
# the files they replace are kept, to go back: sudo cp /opt/languagetool-backup/* into place and restart
sudo mkdir -p /opt/languagetool-backup
[ -f ${RULES_DIR}/grammar_custom.xml ] && sudo cp ${RULES_DIR}/grammar_custom.xml /opt/languagetool-backup/ || true
sudo cp ${SPELL_DIR}/spelling_custom.txt /opt/languagetool-backup/ && sudo cp server.properties /opt/languagetool-backup/
sudo cp /tmp/grammar_custom.xml ${RULES_DIR}/grammar_custom.xml
sudo cp /tmp/spelling_custom.txt ${SPELL_DIR}/spelling_custom.txt
if [ -d /opt/languagetool-ngrams/en ] && ! grep -q languageModel server.properties; then echo languageModel=/opt/languagetool-ngrams | sudo tee -a server.properties >/dev/null; fi
sudo chown -R languagetool:languagetool /opt/languagetool /opt/languagetool-ngrams
sudo systemctl restart languagetool
for i in $(seq 1 90); do curl -fsS http://127.0.0.1:8081/v2/languages >/dev/null 2>&1 && break; sleep 2; done
curl -fsS http://127.0.0.1:8081/v2/check -d language=en-US -d "text=We found prostrate cancer and postive results." | grep -o '"id":"PJPS_[A-Z_0-9]*"' | sort -u
cat server.properties`);
  console.log('installed');
}

(async () => {
  if (!argv.includes('--no-typos')) {
    if (fs.existsSync(COUNTS)) buildTypos(); else console.log(`no word counts at ${COUNTS}: typos.txt kept as it is`);
  }
  if (argv.includes('--deploy')) await deploy();
  else writeLt(ltRules());
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
