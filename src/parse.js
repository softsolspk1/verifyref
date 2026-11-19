// parse.js - document extraction, reference splitting/parsing, manuscript metadata and in-text citations
const { cleanDoi, splitName } = require('./text');

const DOI_REGEX = /10\.\d{4,9}\/[^\s"'<>,]*[^\s"'<>.,;:]/i;
const NUMBERED_PREFIX = /^\s*(?:\[\d{1,4}\]|\(\d{1,4}\)|\d{1,4}[.)](?!\d))\s*/;
// Harvard without parentheses: an author list (Surname AB / Surname, A.B., joined by commas, "and" or "&", optional
// et al.) then ", 2019." - the year directly after the authors, before the title
const HARVARD_NO_PARENS = /^((?:[\p{Lu}][\p{L}'’-]+(?:[ -][\p{Lu}][\p{L}'’-]+)*,?\s+(?:[\p{Lu}]\.?\s?){1,3}(?:,\s*|\s+and\s+|\s*&\s*)?)+(?:et al\.?)?)[,.]?\s+((?:1[6-9]|20)\d{2})[a-z]?\.\s+(?=\S)/u;
const BULLET_PREFIX = /^\s*[•▪·*-]\s+/;
const YEAR_RE = /\b(1[6-9]\d{2}|20\d{2})[a-z]?\b/;
// the heading of the reference list, as authors write it in a plain Word file: "References", "REFERENCES.", "7. References:",
// "Literature cited", "References and notes", "Bibliography" ...
const REF_WORDS = '(?:references?(?:\\s+(?:and\\s+notes|cited|list))?|bibliography|bibliographic\\s+references|literature(?:\\s+cited)?|works\\s+cited|cited\\s+(?:literature|references)|reference\\s+list|sources|kaynak[çc]a)';
const REF_HEADING = new RegExp(`^\\s*(?:\\d+\\.?\\s*)?${REF_WORDS}\\s*[:.]?\\s*$`, 'im');
// the heading and the first reference in one paragraph: "References: 1. Khan A ..."
const REF_HEADING_INLINE = new RegExp(`^\\s*(?:\\d+\\.?\\s*)?${REF_WORDS}\\s*[:.\\-–]\\s+(\\S.{20,})$`, 'i');
// headings that are also ordinary words: accepted only when references follow
const WEAK_HEADING = /^\s*(?:\d+\.?\s*)?(?:sources|literature)\s*[:.]?\s*$/i;
const END_HEADINGS = /^\s*(?:appendix|appendices|tables?|figure legends|figure captions|captions|list of (?:tables|figures)|supplementary (?:material|information)|author contributions|conflicts? of interest)\b/im;
// A wrapped line that starts with the year ("2020. 46(11): p. 1819-1831.") is not a new numbered entry
const YEAR_LINE = /^\s*(?:1[6-9]|20)\d{2}[a-z]?[.,;]\s/;
// Back matter that runs on after the last reference when the list has no closing heading
// any table or figure caption ("Table 4: ...", "Ta b l e 1:", "Fig. 6: ..."): a PDF puts them between and after references
const BACK_MATTER = /\s+(?:Captions\b|List of (?:[Tt]ables|[Ff]igures)\b|(?:T\s?a\s?b\s?l\s?e|Figure|Fig\.)\s*S?\d{1,2}[A-Za-z]?\s*:\s)/;

// ------------------------------------------------------------------ text repair

/** Repair common PDF extraction damage: ligatures, hyphenation, broken DOIs/URLs, spaced letters */
function repairText(text) {
  if (!text) return '';
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\u00A0|\u2009|\u202F/g, ' ')
    .replace(/^\uFEFF/, '')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/­/g, '')
    .replace(/[‐‑]/g, '-')
    // words split by line-end hyphenation: "pharma-\ncology" -> "pharmacology"
    .replace(/([a-z])-\n([a-z])/g, '$1$2')
    // DOIs and URLs broken by spaces or line breaks
    .replace(/(10\.\d{4,9})\s*\/\s*/g, '$1/')
    .replace(/(doi\.)\s+(org)/gi, '$1$2')
    .replace(/(https?:\/\/)\s+/gi, '$1')
    .replace(/\b(doi)\s*:\s*/gi, 'doi: ')
    // "P h a r m a c o l o g y" letter-spaced runs (5+ single letters)
    .replace(/\b((?:[A-Za-z] ){4,}[A-Za-z])\b/g, m => m.replace(/ /g, ''));
}

// ------------------------------------------------------------------ document extraction

async function extractDocument(buffer, filename, mimetype) {
  const ext = (filename.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (ext === '.pdf' || mimetype === 'application/pdf') {
    const pdfParse = require('pdf-parse');
    let data;
    // a plain Uint8Array copy: pdf-parse's old pdf.js keeps state from the previous document when given a Node Buffer and
    // then rejects about one valid PDF in three as "bad XRef entry" (test/remediation.js)
    try { data = await pdfParse(new Uint8Array(buffer)); } catch (e) { throw new Error('This PDF could not be read (it may be damaged, password-protected or a scan). Save it again as PDF or upload the Word file instead.'); }
    if (!(data.text || '').trim()) throw new Error('No text could be read from this PDF - it looks like a scanned image. Upload the Word file, or a PDF with selectable text.');
    return { text: repairText(data.text || ''), format: 'pdf' };
  }
  if (ext === '.docx' || /wordprocessingml/.test(mimetype || '')) {
    const mammoth = require('mammoth');
    // Use HTML so superscript citation numbers survive as [n]
    const { value: rawHtml } = await mammoth.convertToHtml({ buffer }, { convertImage: mammoth.images.imgElement(() => ({ src: '' })) });
    // Footnotes: mammoth lists them after the body. Put each note's text where it is called, so citations inside footnotes
    // count as citations and the note text is not mistaken for a reference-list entry.
    let html = rawHtml;
    const notes = new Map();
    html = html.replace(/<ol>\s*(<li id="(?:footnote|endnote)-\d+">[\s\S]*?)<\/ol>\s*$/, (m, items) => {
      for (const li of items.matchAll(/<li id="((?:footnote|endnote)-\d+)">([\s\S]*?)<\/li>/g)) notes.set(li[1], li[2].replace(/<a href="#(?:footnote|endnote)-ref-\d+">[^<]*<\/a>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      return '';
    });
    if (notes.size) {
      html = html.replace(/<sup>\s*<a href="#((?:footnote|endnote)-\d+)"[^>]*>[^<]*<\/a>\s*<\/sup>/g, (m, id) => ` Footnote: ${notes.get(id) || ''} `);
    }
    const text = html
      .replace(/<sup>\s*([\d,\s–\-]+)\s*<\/sup>/g, (m, n) => `[${n.replace(/\s+/g, '')}]`)
      .replace(/<\/(p|h\d|li|tr)>/g, '\n')
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<\/t[dh]>/g, '\t')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    return { text: repairText(text), format: 'docx' };
  }
  if (ext === '.odt' || /opendocument\.text/.test(mimetype || '')) {
    const JSZip = require('jszip');
    let xml;
    try { xml = await (await JSZip.loadAsync(buffer)).file('content.xml').async('string'); } catch (e) { throw new Error('This OpenDocument (.odt) file could not be read. Save it as .docx and upload that.'); }
    const text = xml
      .replace(/<text:(?:tab)\/>/g, '\t').replace(/<text:line-break\/>/g, '\n')
      .replace(/<\/text:(?:p|h|list-item)>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    return { text: repairText(text), format: 'odt' };
  }
  if (ext === '.doc' || (/msword/.test(mimetype || '') && ext !== '.docx')) {
    try {
      const WordExtractor = require('word-extractor');
      const d = await new WordExtractor().extract(buffer);
      return { text: repairText([d.getBody(), d.getFootnotes ? d.getFootnotes() : ''].filter(Boolean).join('\n')), format: 'doc' };
    } catch (e) { throw new Error('This old Word (.doc) file could not be read. Open it in Word, save as .docx and upload that.'); }
  }
  const raw = buffer.toString('utf8');
  if (ext === '.rtf' || /^\{\\rtf/.test(raw.slice(0, 10))) return { text: repairText(rtfToText(raw)), format: 'rtf' };
  if (ext === '.bib' || /@\w+\s*\{/.test(raw.slice(0, 2000))) return { text: raw, format: 'bibtex', entries: parseBibtex(raw) };
  if (ext === '.ris' || /^TY\s{2}-/m.test(raw.slice(0, 2000))) return { text: raw, format: 'ris', entries: parseRis(raw) };
  return { text: repairText(raw), format: 'text' };
}

/** Plain text of an RTF document (control words, groups and hex escapes removed) */
function rtfToText(rtf) {
  let out = '';
  const stack = [];
  let skip = false;
  for (let i = 0; i < rtf.length; i++) {
    const c = rtf[i];
    if (c === '{') { stack.push(skip); const nxt = rtf.slice(i + 1, i + 30); if (/^\\\*|^\\(?:fonttbl|colortbl|stylesheet|info|pict|header|footer|footnote)/.test(nxt)) skip = true; }
    else if (c === '}') { skip = stack.pop() || false; }
    else if (c === '\\') {
      const m = rtf.slice(i + 1).match(/^([a-zA-Z]+)(-?\d+)? ?/);
      if (m) {
        i += m[0].length;
        if (!skip) { if (m[1] === 'par' || m[1] === 'line') out += '\n'; else if (m[1] === 'tab') out += '\t'; else if (m[1] === 'u') { out += String.fromCharCode(parseInt(m[2], 10) < 0 ? parseInt(m[2], 10) + 65536 : parseInt(m[2], 10)); i++; } }
      } else {
        const n = rtf[i + 1];
        if (n === "'") { if (!skip) out += String.fromCharCode(parseInt(rtf.slice(i + 2, i + 4), 16)); i += 3; }
        else { if (!skip && (n === '\\' || n === '{' || n === '}')) out += n; i++; }
      }
    } else if (!skip && c !== '\r' && c !== '\n') out += c;
  }
  return out;
}

// ------------------------------------------------------------------ BibTeX / RIS

function parseBibtex(src) {
  const entries = [];
  // entries are found by matching braces, so an entry on one line (Google Scholar, Zotero) or with its closing brace
  // anywhere is read; @comment, @string and @preamble are not references
  const blocks = [];
  for (const m of src.matchAll(/@(\w+)\s*([{(])/g)) {
    const type = m[1].toLowerCase();
    if (['comment', 'string', 'preamble'].includes(type)) continue;
    const open = m[2], close = open === '{' ? '}' : ')';
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === open) depth++;
      else if (src[i] === close && --depth === 0) break;
    }
    const inner = src.slice(m.index + m[0].length, i);
    const comma = inner.indexOf(',');
    if (comma >= 0) blocks.push([null, type, inner.slice(0, comma).trim(), inner.slice(comma + 1)]);
  }
  for (const m of blocks) {
    const fields = {};
    for (const f of m[3].matchAll(/(\w[\w-]*)\s*=\s*(\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}|"([^"]*)"|(\w+))/g)) {
      fields[f[1].toLowerCase()] = (f[3] ?? f[4] ?? f[5] ?? '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
    }
    const authors = (fields.author || '').split(/\s+and\s+/i).filter(Boolean).map(splitName);
    const pages = (fields.pages || '').replace(/-{1,2}/, '-');
    const raw = [
      authors.map(a => `${a.family}, ${a.given}`).join('; '),
      fields.year ? `(${fields.year})` : '',
      fields.title ? `${fields.title}.` : '',
      fields.journal || fields.booktitle || fields.publisher || '',
      fields.volume ? `${fields.volume}${fields.number ? `(${fields.number})` : ''}` : '',
      pages,
      fields.doi ? `https://doi.org/${fields.doi}` : ''
    ].filter(Boolean).join(' ');
    entries.push({
      raw, title: fields.title || '', authors, year: parseInt(fields.year, 10) || null,
      journal: fields.journal || fields.booktitle || '', volume: fields.volume || '', issue: fields.number || '', pages,
      doi: cleanDoi(fields.doi), isbn: fields.isbn || null, url: fields.url || null, type: m[1].toLowerCase()
    });
  }
  return entries;
}

function parseRis(src) {
  const entries = [];
  let cur = null;
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(/^([A-Z][A-Z0-9])\s{2}-\s?(.*)$/);
    if (!m) continue;
    const [, tag, val] = m;
    if (tag === 'TY') cur = { authors: [], type: val.trim() };
    else if (!cur) continue;
    else if (tag === 'ER') {
      const raw = [
        cur.authors.map(a => `${a.family}, ${a.given}`).join('; '),
        cur.year ? `(${cur.year})` : '', cur.title ? `${cur.title}.` : '', cur.journal || '',
        cur.volume ? `${cur.volume}${cur.issue ? `(${cur.issue})` : ''}` : '', cur.pages || '',
        cur.doi ? `https://doi.org/${cur.doi}` : ''
      ].filter(Boolean).join(' ');
      entries.push({ ...cur, raw });
      cur = null;
    } else if (tag === 'AU' || tag === 'A1') cur.authors.push(splitName(val));
    else if (tag === 'TI' || tag === 'T1') cur.title = val.trim();
    else if (tag === 'JO' || tag === 'T2' || tag === 'JF') cur.journal = cur.journal || val.trim();
    else if (tag === 'PY' || tag === 'Y1') cur.year = parseInt(val, 10) || null;
    else if (tag === 'VL') cur.volume = val.trim();
    else if (tag === 'IS') cur.issue = val.trim();
    else if (tag === 'SP') cur.pages = val.trim();
    else if (tag === 'EP') cur.pages = `${cur.pages || ''}-${val.trim()}`;
    else if (tag === 'DO') cur.doi = cleanDoi(val);
    else if (tag === 'SN') cur.isbn = val.trim();
    else if (tag === 'UR') cur.url = val.trim();
  }
  return entries;
}

// ------------------------------------------------------------------ splitting

/** A paragraph holding several numbered references ("1. Khan A ... 2. Ali B ...") as one line per reference */
function splitInlineNumbered(line) {
  // short lines too: a chain of consecutive numbers starting at 1 ([1] ... [2] ...) is what decides
  if (line.length < 60) return [line];
  const marks = [...line.matchAll(/(?:^|\s)\[?(\d{1,3})[.)\]]\s+(?=\p{Lu})/gu)].map(m => ({ n: +m[1], at: m.index + (m[0].startsWith(' ') ? 1 : 0) }));
  // the longest chain of consecutive numbers (1, 2, 3 ...) among the marks
  let best = [];
  for (let i = 0; i < marks.length; i++) {
    const chain = [marks[i]];
    for (let j = i + 1; j < marks.length; j++) if (marks[j].n === chain[chain.length - 1].n + 1) chain.push(marks[j]);
    if (chain.length > best.length) best = chain;
  }
  if (best.length < 2 || (best[0].n !== 1 && best.length < 3)) return [line];
  // "... Part 1. News Letter ... Chap 2. Taylor & Francis ..." inside a run of unnumbered author-year references (a PDF
  // flattened to one line): a numbered list starts at the beginning, not after thousands of characters of other entries
  const avg = (line.length - best[0].at) / best.length;
  if (best.length < 5 && best[0].at > Math.max(300, 3 * avg)) return [line];
  // ... or when the text before "1." is already a whole author-year reference ("Khan A (2016). Title. Journal, 4: 1-5.")
  if (best.length < 5 && best[0].at > 0 && /\((?:1[6-9]|20)\d{2}[a-z]?\)\.\s+\S[^]{15,}?\d\s*[-–]\s*\d+\.\s/.test(line.slice(0, best[0].at))) return [line];
  const out = [];
  if (best[0].at > 0) out.push(line.slice(0, best[0].at).trim());
  best.forEach((m, k) => out.push(line.slice(m.at, k + 1 < best.length ? best[k + 1].at : line.length).trim()));
  return out.filter(Boolean);
}

function splitReferences(rawText, strategy = 'auto') {
  const text = dropRunningHeads(repairText(rawText)).trim();
  if (!text) return { entries: [], strategy: 'empty' };
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean).flatMap(splitInlineNumbered);

  if (strategy === 'one-per-line') return { entries: lines, strategy };
  if (strategy === 'blank-line') return { entries: splitBlank(text), strategy };
  if (strategy === 'numbered') return { entries: splitNumbered(lines), strategy };

  const numberedLines = lines.filter(l => (NUMBERED_PREFIX.test(l) && !YEAR_LINE.test(l)) || BULLET_PREFIX.test(l));
  const nums = numberedLines.map(l => parseInt((l.match(/\d{1,4}/) || [])[0], 10)).filter(n => !isNaN(n));
  const sequential = nums.length >= 2 && nums.filter((n, i) => i === 0 || n === nums[i - 1] + 1).length >= nums.length * 0.8;
  const bullets = numberedLines.length - nums.length;
  if ((sequential && nums.length >= lines.length * 0.15) || bullets >= 2) return { entries: trimBackMatter(splitNumbered(lines)), strategy: 'numbered' };

  const blank = splitBlank(text);
  if (blank.length >= 2 && blank.length >= lines.length * 0.3) return { entries: trimBackMatter(blank), strategy: 'blank-line' };

  return { entries: trimBackMatter(splitContinuation(lines.flatMap(splitInlineAuthorYear))).map(dropLeadingRunningHead), strategy: 'line-with-continuation' };
}

/** A PDF's running head of authors before an entry: "Alamgeer et al Isselbacher EM (2001). ..." */
function dropLeadingRunningHead(e) {
  return e.replace(/^(?:[\p{Lu}][\p{L}'’-]+\s){1,3}et al\.?\s+(?=[\p{Lu}][\p{L}'’-]+(?:\s[\p{Lu}][\p{L}'’-]+)?\s+\p{Lu}{1,3}\b[^()]{0,250}\((?:1[6-9]|20)\d{2})/u, '');
}

/** Drop figure/table captions that ran on into the last entry (or became entries of their own) */
function trimBackMatter(entries) {
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (/^(?:Captions\b|List of (?:tables|figures)\b)/i.test(e)) break;
    const m = e.match(BACK_MATTER);
    if (m) {
      const head = e.slice(0, m.index).trim(); if (head.length > 15) out.push(head);
      // a PDF puts a figure or table in the middle of the list (published articles, page by page): the caption is left
      // out and the list goes on when references follow it; after a Word manuscript's list only captions and tables do
      const next = entries.slice(i + 1, i + 4);
      if (next.length >= 2 && next.filter(looksLikeReference).length >= Math.min(2, next.length)) continue;
      break;
    }
    out.push(e);
  }
  return out;
}

/** A PDF's running header inside the text: "Pak. J. Pharm. Sci., Vol.30, No.5, September 2017, pp.1625-1628 1628" */
const RUNNING_HEAD = /\s*(?:[\p{Lu}][\p{L}.]*\s?){1,6},?\s*Vol\.?\s*\d+\s*(?:\(\w+\))?,?\s*No\.?\s*\d+(?:\s*\(\w+\))?,?\s*(?:Special\s+Issue,?\s*)?(?:[\p{Lu}][\p{L}]+(?:-[\p{Lu}][\p{L}]+)?\s+)?(?:1[89]|20)\d{2},?\s*pp\.?\s*(\d+)\s*-\s*(\d+)\s+(\d+)\b/gu;
function dropRunningHeads(text) {
  return text.replace(RUNNING_HEAD, (all, a, b, page) => (+page >= +a && +page <= +b ? ' ' : all))
    // the authors' running head with the page number, on lines of its own: "HOSAM O. ELANSARY\nET AL.,\n1856"
    .replace(/(^|\n)[ \t]*[\p{Lu}][\p{Lu}.'’ -]{2,60}\s*\n?\s*ET\.?\s*AL\.?,?\s*\n?\s*\d{1,5}[ \t]*(?=\n|$)/gu, '$1');
}

function splitBlank(text) {
  return text.split(/\n\s*\n+/).map(e => e.replace(/\s+/g, ' ').trim()).filter(e => e.length > 15);
}

function splitNumbered(lines) {
  const entries = [];
  let cur = '';
  for (const line of lines) {
    if ((NUMBERED_PREFIX.test(line) && !(cur && YEAR_LINE.test(line))) || BULLET_PREFIX.test(line)) {
      if (cur.trim()) entries.push(cur.trim());
      cur = line;
    } else {
      cur += cur ? ' ' + line : line;
    }
  }
  if (cur.trim()) entries.push(cur.trim());
  return entries.filter(e => e.length > 15);
}

/**
 * Unnumbered references run together on one line (copied from a PDF): split where one reference ends with its pages or
 * DOI and a full stop and the next begins with an author ("…: 55-63. Khan A, Ali B and Shah C (2019). …"); both parts
 * must have a year, so a title or journal name with a capital after a number is not cut
 */
function splitInlineAuthorYear(line) {
  if (line.length < 120) return [line];
  // the next reference's authors: "Khan A, ...", "Barrett KE and ...", "Percie du Sert N, ...", "De Nunzio C, ...", "Wang H H, ...";
  // the one before may end with its pages, a DOI or a word ("... Marcel Dekker, New York. Khan A ...")
  let parts = line.split(/(?<=(?:10\.\S+|[\p{L}\d)\]])\.)\s+(?=[\p{Lu}][\p{L}'’-]+(?:\s(?:(?:van|de|da|du|del|der|den|von|la|le|el|dos|das|di)\s)*[\p{Lu}][\p{L}'’-]+)?,?\s+(?:[\p{Lu}]\.?\s?){1,4}(?:,|\s+and\s|\s*&|\s*\(\s*(?:1[6-9]|20)\d{2}|\s+et al))/u);
  // no full stop between them ("... 54(5): 261- 266 Johansen JS, ... (2014)"), or an organisation as the author
  // ("... 211-213. ESCOP (2003). ..."): only where the bracketed year of the next one follows closely
  parts = parts.flatMap(p => p.split(/(?<=\d)\s+(?=[\p{Lu}][\p{L}'’-]+,?\s+(?:[\p{Lu}]\.?\s?){1,4}(?:,|\s+and\s|\s*&|\s+et al)[^()]{0,200}\((?:1[6-9]|20)\d{2}[a-z]?\))|(?<=[\p{L}\d)\]]\.\]?)\s+(?=[\p{Lu}][\p{L}'’&,-]*(?:\s+[\p{L}'’&,-]+){0,7}\s*\((?:1[6-9]|20)\d{2}[a-z]?\)\.\s)/u));
  // the one before ends without a full stop ("... 16(3) Roszczenko P and ...", "... chamomile.htm Kaneko T, ...") or a
  // PDF's running head stands between them ("... et al Farber JL (1994). ..."): a whole author list up to "(2006)." with
  // no sentence end inside it, never cut inside an author list (after a comma, "and" or initials) or an editors' list,
  // and only where the text before the cut is already a reference of its own (its "(2003)." and title)
  parts = parts.flatMap(cutBeforeAuthorList).flatMap(cutAfterPages);
  // a cut inside a surname of several words leaves its first words behind ("... 76: 593-595. Del" | "Rosario Espinoza Mora M,
  // Bohm M ... (2014)"): they go back to the reference they begin
  // ... and a cut at an initial just before the year ("... 5186. Das S and Ganesh E." | "A (2010). ...", "... Zahra G and Alma." |
  // "UD (2011)", "... Xiang L and Huang et al." | "W (2004)"): everything after the page numbers of the reference before goes
  // with the year
  for (let i = 0; i + 1 < parts.length; i++) {
    const m = parts[i].match(/(?<=[\d)]\.)\s+((?:[\p{Lu}][\p{L}'’-]*)(?:\s+[\p{Lu}][\p{L}'’-]*){0,2})\s*$/u);
    if (m && /^[\p{Lu}]/u.test(parts[i + 1])) { parts[i] = parts[i].slice(0, m.index); parts[i + 1] = `${m[1]} ${parts[i + 1]}`; continue; }
    if (/^[^()]{0,14}\((?:1[6-9]|20)\d{2}[a-z]?\)/.test(parts[i + 1]) && parts[i].length < 250 && !YEAR_RE.test(parts[i]) && i > 0) {
      parts.splice(i, 2, `${parts[i].trim()} ${parts[i + 1]}`); i--; continue;   // "Das S and Ganesh E." | "A (2010). ..."
    }
    if (/^[^()]{0,14}\((?:1[6-9]|20)\d{2}[a-z]?\)/.test(parts[i + 1])) {
      const ends = [...parts[i].matchAll(/(?:\d{1,6}\s?[-–—]\s?\d{1,6}|:\s?[eE]?\d{1,9})\.\s+(?=[\p{Lu}\p{Ll}])/gu)];
      const last = ends[ends.length - 1];
      const tail = last ? parts[i].slice(last.index + last[0].length) : '';
      if (last && tail.length > 1 && tail.length < 250 && !/\((?:1[6-9]|20)\d{2}/.test(tail) && OPENED.test(parts[i].slice(0, last.index + last[0].length))) {
        parts[i] = parts[i].slice(0, last.index + last[0].length).trim(); parts[i + 1] = `${tail.trim()} ${parts[i + 1]}`;
      }
    }
  }
  if (parts.length < 2) return [line];
  const out = [];
  for (const p of parts) {
    // a piece without a year is not a reference of its own ("... Smith J. Jones K, ..." inside one author list)
    if (out.length && !YEAR_RE.test(p)) out[out.length - 1] += ' ' + p;
    else out.push(p);
  }
  // text before the first reference (a running head, a page footer) goes with it rather than stopping every split
  if (out.length > 1 && !YEAR_RE.test(out[0])) out.splice(0, 2, out[0] + ' ' + out[1]);
  return out.every(p => YEAR_RE.test(p)) ? out : [line];
}

const NEXT_AUTHORS = /(?<=[^\s,;&])(?<!\band|\bIn:?|\beds?\.?|\b\p{Lu}{1,3}\.?)\s+(?=[\p{Lu}][\p{L}'’-]+(?:\s(?:(?:van|de|da|du|del|der|den|von|la|le|el|dos|das|di)\s)*[\p{Lu}][\p{L}'’-]+){0,2}\s+(?:\p{Lu}(?:-?\p{Lu}){0,3}|(?:\p{Lu}\.\s?){1,3})(?:,\s|\s+and\s|\s*&\s)(?:[^().:]|(?<=\b\p{Lu})\.){0,250}\((?:1[6-9]|20)\d{2}\s?[a-z]?\s?\)\.|[\p{Lu}][\p{L}'’-]+\s+\p{Lu}{1,3}\s*\((?:1[6-9]|20)\d{2}[a-z]?\)\.\s)/gu;
const OPENED = /\((?:1[6-9]|20)\d{2}\s?[a-z]?\s?\)\.?\s+\S.{15,}/su;
function cutBeforeAuthorList(p) {
  const out = []; let from = 0;
  for (const m of p.matchAll(NEXT_AUTHORS)) {
    if (!OPENED.test(p.slice(from, m.index))) continue;
    out.push(p.slice(from, m.index)); from = m.index + m[0].length;
  }
  out.push(p.slice(from));
  return out;
}

/**
 * The reference before ends with its pages and a full stop ("76: 593-595.", "21(7):294–9.", "28: 53-63.") and the next one's
 * "(2014)" follows within 250 characters: a new reference, whatever form its author list has ("Del Rosario Espinoza Mora M",
 * "H Fukui, Saito H", "de Arriba SG1", "Ritch KRCEM", "Huang et al. W"; 240 published PJPS articles, 18 Nov 2026). Only
 * where the text before the cut is already a reference of its own, and never after "In:" (a chapter's book and editors).
 */
const AFTER_PAGES = /(?<=(?:\b\d{1,6}\s?[-–—]\s?\d{1,6}|:\s?[a-zA-Z]{0,4}\d{1,9})\.)\s*(?=(?:(?:de|da|van|von|del|der|den|di|du|dos|la|le|el)\s)?[\p{Lu}][^()]{1,250}?\((?:1[6-9]|20)\d{2}[a-z]?\)\.?(?:\s|$))/gu;
function cutAfterPages(p) {
  const out = []; let from = 0;
  for (const m of p.matchAll(AFTER_PAGES)) {
    const head = p.slice(from, m.index);
    if (!OPENED.test(head) || /\bIn:\s*[^.]*$/.test(head)) continue;
    out.push(head); from = m.index + m[0].length;
  }
  out.push(p.slice(from));
  return out.filter(s => s.trim());
}

/** Line-continuation heuristic for unnumbered author-year lists (each entry starts "Surname, X." or "Surname X,") */
function splitContinuation(lines) {
  const entries = [];
  let cur = '';
  const startsEntry = l => /^[\p{Lu}][\p{L}'’\-]+(?:\s+(?:(?:van|de|da|du|del|der|den|von|la|le|el|dos|das|di)\s+)*[\p{Lu}][\p{L}'’\-]+)?,?\s+(?:[\p{Lu}]\.?\s*){1,4}(?:[,.&(]|and\s|et al)/u.test(l) ||
    /^[\p{Lu}][\p{L}'’\-]+,\s+[\p{Lu}]/u.test(l) || /^(?:[\p{Lu}]\.\s?){1,3}[\p{Lu}][\p{L}'’\-]+,/u.test(l);
  for (const line of lines) {
    // a PDF's running head between two pages: "HOSAM O. ELANSARY ET AL., 1856"
    if (/^[\p{Lu}][\p{Lu}.\s'’-]+\sET\.?\s*AL\.?,?\s*\d{1,5}$/u.test(line)) continue;
    // the line ends inside the author list ("..., R." / "..., A.K.M.M.") or just after the year that follows the authors
    // ("Chandra, S., D.S. Rawat and J. Rastogi. 2015."): the next line belongs to the same reference
    const midAuthors = cur && !YEAR_RE.test(cur) && /(?:,|\b\p{Lu}\.|\band|&|\p{L}-)$/u.test(cur);
    const yearOnly = cur && /\s(?:1[6-9]|20)\d{2}[a-z]?\.$/.test(cur) && (cur.match(/\b(?:1[6-9]|20)\d{2}\b/g) || []).length === 1 && !/\(\s*(?:1[6-9]|20)\d{2}/.test(cur);
    if (midAuthors || yearOnly) { cur += ' ' + line; continue; }
    const curDone = cur && (YEAR_RE.test(cur) || DOI_REGEX.test(cur)) && /[.)\d]$/.test(cur);
    const strongEnd = cur && (YEAR_RE.test(cur) || DOI_REGEX.test(cur)) && /(?:\d[.)]?|10\.\S+)$/.test(cur);
    // an organisation as the author, on a line of its own after a finished entry: "World Health Organization (2013). ...",
    // "Clinical and Laboratory Standards Institute (CLSI) (2011). ..." (was run into the entry before it)
    const orgEntry = curDone && /^[\p{Lu}][\p{L}'’&.-]*(?:\s+(?:of|and|for|the|on|in|&|[\p{Lu}][\p{L}'’&.-]*|\([\p{Lu}]{2,10}\))){1,10},?\s*\(\s*(?:1[6-9]|20)\d{2}[a-z]?\s*\)/u.test(line);
    if (!cur) cur = line;
    else if ((NUMBERED_PREFIX.test(line) && !YEAR_LINE.test(line)) || (startsEntry(line) && (curDone || cur.length > 60)) || (strongEnd && /^[\p{Lu}[]/u.test(line)) || orgEntry) {
      entries.push(cur);
      cur = line;
    } else cur += ' ' + line;
  }
  if (cur) entries.push(cur);
  return entries.filter(e => e.length > 15);
}

// ------------------------------------------------------------------ reference field parsing

function parseAuthors(segment) {
  let s = segment.replace(/\bet al\.?/i, '').replace(/\s+/g, ' ').trim().replace(/[.,;]$/, '');
  if (!s) return [];
  // Group / corporate author
  const corpWords = /\b(?:organi[sz]ation|association|society|institute|council|ministry|department|agency|commission|committee|foundation|board|authority|group|consortium|programme|program|centre|center|office|bureau|federation|union|university|who|fda|ema|unicef)\b/i;
  if (!/,|\band\b|&/.test(s) && !/^[\p{Lu}][\p{L}'’\-]+\s+[\p{Lu}]{1,3}$/u.test(s) && (s.split(' ').length > 3 || corpWords.test(s))) {
    return [{ given: '', family: s, corporate: true }];
  }
  s = s.replace(/,?\s*(?:&|\band\b)\s*/gi, ', ');
  const parts = s.split(/\s*[,;]\s*/).filter(Boolean);
  const out = [];
  const isInitials = p => /^(?:[\p{Lu}]\.?\s?-?){1,4}$/u.test(p.trim());
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (isInitials(p) && out.length && !out[out.length - 1].given) {
      out[out.length - 1].given = p; // "Smith, J. A." -> family, given
      continue;
    }
    // "Smith JA" (Vancouver), also with spaced initials: "Guarino M P", "Ko C W"
    let m = p.match(/^([\p{L}'’\-]+(?:\s[\p{L}'’\-]{2,})*)\s+((?:[\p{Lu}]\.?\s){1,3}[\p{Lu}]\.?)$/u) || p.match(/^([\p{L}'’\- ]+?)\s+((?:[\p{Lu}]\.?){1,4})$/u);
    if (m) { out.push({ family: m[1], given: m[2].replace(/\s+/g, '') }); continue; }
    // "J. A. Smith" (IEEE)
    m = p.match(/^((?:[\p{Lu}]\.\s?-?){1,4})\s*([\p{L}'’\- ]+)$/u);
    if (m) { out.push({ family: m[2].trim(), given: m[1].trim() }); continue; }
    // "Smith" waiting for initials, or a full "John Smith"
    if (p.split(' ').length === 1) out.push({ family: p, given: '' });
    else out.push(splitName(p));
  }
  return out.filter(a => a.family && a.family.length > 1 && !/^\d/.test(a.family)).slice(0, 60);
}

/** Extract structured fields from a single reference string */
function parseReferenceEntry(raw, index) {
  const cleaned = repairText(raw).replace(/\s+/g, ' ').trim();
  let body = cleaned.replace(NUMBERED_PREFIX, '').replace(BULLET_PREFIX, '');
  // the title run into an abbreviated journal without a space ("... FIX concentrate.Eur.J.Pharm.Sci.,153: 105485"); not
  // inside a DOI or web address
  if (!/https?:|www\.|doi/i.test(body)) body = body.replace(/([a-z]{3,})\.(?=(?:[A-Z][a-z]{0,8}\.\s?){2,})/g, '$1. ').replace(/([A-Z][a-z]{0,8}\.),(?=\d)/g, '$1, ');

  const ref = { index, raw: cleaned, doi: null, doiAsWritten: null, pmid: null, arxiv: null, isbn: null, urls: [], authors: [], title: '', journal: '', year: null, volume: '', issue: '', pages: '' };

  // Identifiers
  const doiMatch = body.match(DOI_REGEX);
  if (doiMatch) { ref.doiAsWritten = doiMatch[0]; ref.doi = cleanDoi(doiMatch[0]); }
  const pmid = body.match(/\bPMID:?\s*(\d{5,9})\b/i);
  if (pmid) ref.pmid = pmid[1];
  const arxiv = body.match(/arxiv(?:\.org\/abs\/|:)\s*([a-z\-]+\/\d{7}|\d{4}\.\d{4,5})(v\d+)?/i);
  if (arxiv) ref.arxiv = arxiv[1];
  const isbn = body.match(/ISBN(?:-1[03])?:?\s*([\d\-X ]{10,17})/i);
  if (isbn) ref.isbn = isbn[1].replace(/[\s-]/g, '');
  ref.urls = [...body.matchAll(/https?:\/\/[^\s<>"]+[^\s<>".,;)]/gi)].map(m => m[0].replace(/\((?:Accessed|Retrieved)\b.*$/i, ''));
  const accessed = body.match(/\(?\b(?:Accessed|Retrieved)(?:\s+on)?\s*:?\s*([^)\]]*?\d{4})\s*\)?/i);

  // Remove identifiers/URLs before field parsing
  let core = body
    .replace(/https?:\/\/[^\s]+/gi, ' ')
    .replace(/\bdoi:?\s*10\.\S+/gi, ' ')
    .replace(DOI_REGEX, ' ')
    .replace(/\b(?:PMID|PMCID):?\s*\w+/gi, ' ')
    // access notes ("Available from:", "Accessed 12 May 2020", "Retrieved from") - not the word "available" in a title
    .replace(/\[?(?:(?:Accessed|Retrieved)(?:\s+on)?\s*:?\s*(?:\d|[A-Z][a-z]{2})|(?:Available|Retrieved)\s+(?:from|at|online)\b|(?:Accessed|Available)\s*:)[^.\]]*[.\]]/gi, ' ')
    .replace(/\s+/g, ' ').trim();

  // Year: prefer "(2020)" then ";2020" / ", 2020."
  const yParen = core.match(/\(\s*(1[6-9]\d{2}|20\d{2})\s?[a-z]?(?:,\s*[A-Za-z]+\.?(?:\s+\d{1,2})?)?\s*\)/);
  const yAny = core.match(/(?:^|[\s,;.])(1[6-9]\d{2}|20\d{2})([a-z])?(?=[\s;:,.)]|$)/);
  const yearM = yParen || yAny;
  if (yearM) {
    const y = parseInt(yearM[1], 10);
    if (y <= new Date().getFullYear() + 1) ref.year = y;
    // "(2010a)", and "(2010 a )" as a PDF spaces it (cited "2010a": a missing reference on published PJPS articles)
    const suf = core.match(new RegExp(`${yearM[1]}([a-z])\\b`)) || core.match(new RegExp(`\\(\\s*${yearM[1]}\\s([a-z])\\s*\\)`));
    if (suf) ref.yearSuffix = suf[1];
  }

  // Volume(issue):pages patterns
  const vip =
    core.match(/(?:vol\.?\s*)?(\d{1,4})\s*\(\s*([\w\-–/ ]{1,12})\s*\)\s*[:,]?\s*(?:pp?\.?\s*)?([A-Za-z]?\d{1,9}(?:\s*[-–—]\s*[A-Za-z]?\d{1,9})?)/i) ||
    core.match(/vol\.?\s*(\d{1,4}),?\s*(?:no\.?|issue)\s*([\w\-–]{1,8}),?\s*(?:pp?\.?\s*)([A-Za-z]?\d{1,6}(?:\s*[-–—]\s*[A-Za-z]?\d{1,6})?)/i) ||
    core.match(/;\s*(\d{1,4})\s*:\s*()([A-Za-z]?\d{1,6}(?:\s*[-–—]\s*[A-Za-z]?\d{1,6})?)/) ||
    core.match(/,\s*(?:vol\.?\s*)?(\d{1,4})\s*()[,:]\s*(?:pp?\.?\s*)?([A-Za-z]?\d{1,6}[A-Za-z]?\s*[-–—]\s*[A-Za-z]?\d{1,6}[A-Za-z]?|e\d{3,8}|\d{4,8})(?![\w-])/i) ||
    // article-number locators: "372: n71"
    core.match(/\b(\d{1,4})\s*()\s*:\s*([enE][A-Za-z]?\d{1,9})\b/) ||
    // at the end of the entry (published PJPS references, 18 Nov 2026): an online journal's volume and article number
    // ("BMC Pediatr., 11: 60."), "Article ID" / "ID" numbers ("2019: ID 5162687"), e-locators ("9(43): eadh0215"), and
    // volume and pages after a journal name written without its comma ("Baghdad Sci. J. 20: 15-20.")
    core.match(/(?:,|\.)\s*(\d{1,4})\s*()\s*:\s*(?:Article\s+)?(?:ID\s*)?(\d[\dX]{0,19})\s*\.?\s*$/i) ||
    core.match(/(?:,|\.)\s*(\d{1,4})\s*(?:\(\s*([\w\-–/ ]{1,12})\s*\))?\s*:\s*(?:Article\s+)?ID\s*:?\s*(\d{3,9})\b/i) ||
    core.match(/\b(\d{1,4})\s*\(\s*([\w\-–/ ]{1,12})\s*\)\s*:\s*([a-z]{1,4}\d{3,9})\s*\.?\s*$/i) ||
    core.match(/\.\s*(\d{1,4})\s*()\s*:\s*(\d{1,6}\s*[-–—]\s*\d{1,6})\s*\.?\s*$/);
  if (vip) {
    ref.volume = vip[1];
    ref.issue = (vip[2] || '').trim();
    ref.pages = vip[3].replace(/\s+/g, '').replace(/[–—]/g, '-');
  } else {
    const pp = core.match(/\bpp?\.\s*([A-Za-z]?\d{1,6}(?:\s*[-–—]\s*[A-Za-z]?\d{1,6})?)/i);
    if (pp) ref.pages = pp[1].replace(/\s+/g, '').replace(/[–—]/g, '-');
  }

  // MDPI / AMA with dotted initials: Surname I.I., Surname I. Title. Abbrev. Journal. Year;Vol(Issue):pages.
  const dotted = parseDottedVancouver(core);
  if (dotted) {
    Object.assign(ref, dotted);
    return finishEntry(ref, core, accessed);
  }

  // Elsevier numbered: I. Surname, I. Surname, Title, Journal, Vol (Year) pages.
  const elsevier = parseElsevierNumbered(core);
  if (elsevier) {
    Object.assign(ref, elsevier);
    return finishEntry(ref, core, accessed);
  }

  // EndNote "Numbered": Surname, I., I. Surname, and I. Surname, Title. Journal, Year. Vol(Issue): p. pages.
  const endnote = parseEndNote(core);
  if (endnote) {
    Object.assign(ref, endnote);
    return finishEntry(ref, core, accessed);
  }

  // Title in quotes (IEEE / Harvard / MLA)
  const quoted = core.match(/[“"‘']([^“”"]{12,400}?)[,.]?[”"’'](?=[\s,.]|$)/);
  let harvard = null;

  // Nature / Science: Surname, I., Surname, I. & Surname, I. Title. Journal Vol, pages (Year).
  const nature = !yParen || core.indexOf(yParen[0]) > core.length - 12
    ? core.match(/^((?:[\p{Lu}][\p{L}'’\-]+(?:\s[\p{Lu}][\p{L}'’\-]+)?,\s*(?:[\p{Lu}]\.\s?){1,3}(?:,\s*|\s*&\s*|\s+and\s+)?)+)\s+(.{12,300}?)\.\s+([^.]*?(?:\.[^.]*?)*?)\s+(\d{1,4}),\s*([A-Za-z]?\d{1,6}(?:\s*[-–—]\s*[A-Za-z]?\d{1,6})?)\s*\(\s*((?:1[6-9]|20)\d{2})\s*\)\.?$/u)
    : null;
  if (nature && !quoted) {
    ref.authors = parseAuthors(nature[1]);
    ref.title = nature[2];
    ref.journal = nature[3].replace(/\.$/, '');
    ref.volume = nature[4];
    ref.pages = nature[5].replace(/\s+/g, '').replace(/[–—]/g, '-');
    ref.year = parseInt(nature[6], 10);
  } else if (yParen && core.indexOf(yParen[0]) > 3) {
    // APA / Harvard / PJPS: Authors (Year). Title. Journal, vol(issue), pages.
    const yi = core.indexOf(yParen[0]);
    ref.authors = parseAuthors(core.slice(0, yi));
    const after = core.slice(yi + yParen[0].length).replace(/^[\s.,:]+/, '');
    if (quoted && after.includes(quoted[1])) {
      ref.title = quoted[1];
      ref.journal = journalFrom(after.slice(after.indexOf(quoted[0]) + quoted[0].length));
    } else {
      const segs = splitSentences(after);
      ref.title = segs[0] || '';
      ref.journal = journalFrom(after.slice(after.indexOf(ref.title) + ref.title.length));
    }
  } else if (!quoted && (harvard = core.match(HARVARD_NO_PARENS))) {
    // Harvard without parentheses: Khan A, Ali B and Shah C, 2019. Title. Journal, 32(1): 1-5.
    ref.authors = parseAuthors(harvard[1]);
    const after = core.slice(harvard[0].length);
    ref.title = splitSentences(after)[0] || '';
    ref.journal = journalFrom(after.slice(after.indexOf(ref.title) + ref.title.length));
  } else if (quoted) {
    // IEEE: A. Author, B. Author, "Title," Journal, vol. ..., year.
    const qi = core.indexOf(quoted[0]);
    ref.authors = parseAuthors(core.slice(0, qi).replace(/[.,]?\s*(?:1[6-9]\d{2}|20\d{2})[a-z]?\s*[.,]?\s*$/, '')); // Chicago: the year sits before the title
    ref.title = quoted[1];
    ref.journal = journalFrom(core.slice(qi + quoted[0].length));
  } else {
    // Vancouver / NLM: Authors. Title. Journal. Year;Vol(Issue):Pages.
    const auth = core.match(/^((?:[\p{Lu}][\p{L}'’\-]+(?:[ \-][\p{Lu}][\p{L}'’\-]+)*\s+[\p{Lu}]{1,3}(?:,\s*|\.\s+|\s+(?=et al)))+)(?:et al\.?\s*)?/u);
    let rest = core;
    if (auth && auth[0].length > 3) {
      ref.authors = parseAuthors(auth[0]);
      rest = core.slice(auth[0].length);
    }
    const segs = splitSentences(rest);
    if (!auth && segs.length >= 2) {
      ref.authors = parseAuthors(segs.shift());
      rest = rest.slice(rest.indexOf(segs[0]));
    }
    ref.title = segs[0] || core;
    ref.journal = journalFrom(rest.slice(rest.indexOf(ref.title) + ref.title.length));
  }

  return finishEntry(ref, core, accessed);
}

/** Shared clean-up once the fields are in place: trim punctuation, flag books / web pages / edited-book chapters */
function finishEntry(ref, core, accessed) {
  ref.title = ref.title.replace(/\s*\[[^\]]*\]\s*$/, '').replace(/^[\s"“'‘]+|[\s"”'’.,]+$/g, '').trim();
  ref.journal = ref.journal.replace(/\s*\[Internet\]/i, '').replace(/^[\s"“'‘]+|[\s"”'’.,]+$/g, '').replace(/\b(?:Retrieved|Available)\b.*$/i, '').trim();
  if (/^\d+$/.test(ref.journal)) ref.journal = '';
  // Elsevier Harvard: the volume follows the journal name without a comma ("Cell 144, 646-674", "Eur. Chem. Bull. 12,
  // 1897-1908"): the journal was read as "Cell 144", so it could not be looked up and the volume and pages were lost
  const jv = ref.journal.match(/^(.*[^\d\s])\s+(\d{1,4})$/);
  if (jv && jv[1].replace(/[^\p{L}]/gu, '').length >= 3 && (!ref.volume || ref.volume === jv[2]) && Number(jv[2]) !== ref.year) {
    ref.journal = jv[1].trim();
    ref.volume = jv[2];
    if (!ref.pages) {
      const pm = core.match(new RegExp(String.raw`\b${jv[2]}\s*,\s*(?:pp?\.?\s*)?([A-Za-z]?\d{1,6}(?:\s*[-–—]\s*[A-Za-z]?\d{1,6})?)\b`));
      if (pm && !(/^\d{4}$/.test(pm[1]) && Number(pm[1]) === ref.year)) ref.pages = pm[1].replace(/\s+/g, '').replace(/[–—]/g, '-');
    }
  }
  // authors written "SURNAME, I.I., SURNAME, I.I., Title" without a year after them: the later authors were read as the
  // start of the title, so the title search found nothing
  const lead = ref.title.match(/^((?:[\p{Lu}][\p{L}'’\-]+,\s*(?:[\p{Lu}]\.\s?){1,3},\s*)+)(?=\S)/u);
  if (lead && ref.title.length - lead[0].length >= 15) {
    ref.authors = [...ref.authors, ...parseAuthors(lead[1].replace(/,\s*$/, ''))];
    ref.title = ref.title.slice(lead[0].length).trim();
  }
  ref.firstAuthorSurname = ref.authors[0]?.family || null;
  // books, theses and pharmacopoeias with no volume (published PJPS references: "CBS Publishers", "Ph.D. thesis",
  // "British Pharmacopoeia (2016). Her Majesty's Stationery Office", "Springer Science & Business Media", "Bailliere Tindall")
  ref.looksLikeBook = !!ref.looksLikeBook || !!ref.isbn || (/\b(?:press|publishers?|publishing|edition|edn|ed\.|eds\.|books?|thesis|dissertation|pharmacop[oe]{1,2}ia|formulary|handbook|textbook|monographs?|wiley|springer|elsevier|academic|tindall|saunders|lippincott|mcgraw|churchill|mosby|pergamon|crc|taylor\s*&\s*francis|stationery|stationary office|marcel dekker)\b/i.test(core) && !ref.volume);
  ref.looksLikeWeb = ref.urls.length > 0 && !ref.doi && !ref.volume;
  if (ref.looksLikeWeb) { ref.type = 'webpage'; ref.url = ref.urls[0]; if (accessed) ref.accessed = accessed[1].trim(); }
  // Edited-book chapter: "Title. In: Gilman AG, Goodman LS (eds.), Book title, 7th ed., Publisher, Place, pp. 446-472."
  const ch = core.match(/\bIn:\s*(.+?)\s*\(\s*eds?\.?\s*\)\s*,?\s*(.+)$/i);
  if (ch && !ref.volume) {
    const bits = ch[2].replace(/\.\s*$/, '').split(/\s*,\s*/);
    ref.type = 'book-chapter'; ref.editors = ch[1].trim(); ref.bookTitle = (bits.shift() || '').trim();
    const rest = [];
    for (const b of bits) { const ed = b.match(/^(\d+(?:st|nd|rd|th)?\s+ed\.?)$/i); if (ed) ref.edition = ed[1]; else if (/^pp?\.?\s*\d/i.test(b)) ref.pages = b.replace(/^pp?\.?\s*/i, '').replace(/[–—]/g, '-').replace(/\s+/g, ''); else rest.push(b); }
    if (rest.length) { ref.publisher = rest[0]; if (rest[1]) ref.place = rest.slice(1).join(', '); }
    ref.journal = ref.bookTitle; ref.looksLikeBook = true;
  }
  return ref;
}

// EndNote "Numbered" output style: first author "Surname, I.", later authors "I. Surname", then ", Title. Journal, Year. Vol(Issue): p. pages."
const EN_INIT = String.raw`(?:[\p{Lu}][\p{Ll}]?\.\s?-?\s?)+`;
// Later authors' initials, where EndNote sometimes runs the journal abbreviation in ("D.J.E.j.o.m.c. Shin")
const EN_INIT_LATER = String.raw`[\p{Lu}][\p{Ll}]?\.\s?-?\s?(?:[\p{L}][\p{Ll}]?\.\s?-?\s?)*`;
const EN_FAM = String.raw`(?:(?:van|von|de|da|del|der|den|di|du|la|le|al|el|bin|ter)\s)*[\p{L}][\p{L}'’\-]*(?:\s(?:(?:van|von|de|da|del|der|den|di|du|dos|la|le)\s)?[\p{Lu}][\p{L}'’\-]*){0,2}`;
const EN_AUTHORS = new RegExp(String.raw`^(${EN_FAM},\s?${EN_INIT}(?:(?:,\s*and\s+|\s+and\s+|,\s*)${EN_INIT_LATER}\s?${EN_FAM})*(?:,?\s*et\s+al\.?)?)(?:\s*,\s+|(?<=al\.)\s+)(?=\S)`, 'u');
const EN_YEAR = String.raw`((?:1[6-9]|20)\d{2})([a-z])?`;
// "61(9): p. 892-906" | "335: p. 141-151" | "78" | "p. 98-103" | "14, 57"
const EN_LOCATOR = /^(?:(\d{1,5})(?:\s*\(\s*([^)]{1,15}?)\s*\))?)?(?:\s*[:,]?\s*(?:pp?\.\s*)?([A-Za-z]?\d[\w\-–—]*))?\s*\.?$/;

// MDPI / AMA output style: "Jeong W.Y., Kwon M., Kim K.S. Recent advances ... A review. Biomater. Res. 2021;25:24."
// The journal abbreviation has full stops too, so the title ends at the first full stop after which only journal words follow.
const DV_INIT = String.raw`[\p{Lu}]\.(?:\s?-?[\p{Lu}]\.)*`;
const DV_AUTHOR = String.raw`${EN_FAM}\s${DV_INIT}`;
const DV_AUTHORS = new RegExp(String.raw`^(${DV_AUTHOR}(?:,\s*(?:and\s+)?${DV_AUTHOR})*(?:,?\s*et\s+al\.?)?)\s+(?=\S)`, 'u');
const DV_TAIL = new RegExp(String.raw`^(.+?)\s+${EN_YEAR}(?:\s+[A-Z][a-z]{2}(?:\s+\d{1,2})?)?;\s*(\d{1,5}[A-Za-z]?)?\s*(?:\(\s*([^)]{1,12}?)\s*\))?\s*(?::\s*([A-Za-z]?\d[\w\-–—]*))?\s*\.?$`, 'u');
const JOURNAL_WORD = /^(?:[\p{Lu}][\p{L}\-']*\.?|of|and|the|in|for|on|&|\([^)]*\)[\p{L}.\-]*|[\p{Lu}\d]+:?)$/u;

function parseDottedVancouver(core) {
  const am = core.match(DV_AUTHORS);
  if (!am) return null;
  const rest = core.slice(am[0].length).trim();
  const t = rest.match(DV_TAIL);
  if (!t) return null;
  const before = t[1].replace(/\.\s*$/, '');
  let title = null, journal = null;
  const stops = /\.\s+/g;
  let m;
  while ((m = stops.exec(before))) {
    const j = before.slice(m.index + m[0].length).trim();
    if (j && j.split(/\s+/).every(w => JOURNAL_WORD.test(w))) { title = before.slice(0, m.index).trim(); journal = j; break; }
  }
  if (!title || title.length < 8) return null;
  const authors = am[1].replace(/,?\s*et\s+al\.?\s*$/, '').split(/\s*,\s*(?:and\s+)?/).map(a => {
    const x = a.trim().match(new RegExp(String.raw`^(${EN_FAM})\s(${DV_INIT})$`, 'u'));
    return x ? { family: x[1].trim(), given: x[2].trim() } : null;
  }).filter(Boolean);
  if (!authors.length) return null;
  return { authors, title, journal: journal.replace(/\.$/, ''), year: +t[2], ...(t[3] ? { yearSuffix: t[3] } : {}), volume: t[4] || '', issue: (t[5] || '').trim(),
    pages: (t[6] || '').replace(/\s+/g, '').replace(/[–—]/g, '-') };
}

// Elsevier numbered output style (Journal of Drug Delivery Science and Technology, Int J Pharm ...):
// "U.K. Mandal, B. Chatterjee, F.G. Senjoti, Title, Journal, 11 (2016) 575-584."
const ELS_AUTHOR = String.raw`${EN_INIT_LATER}\s?${EN_FAM}`;
const ELS_AUTHORS = new RegExp(String.raw`^(${ELS_AUTHOR}(?:(?:,\s*(?:and\s+)?|\s+and\s+)${ELS_AUTHOR})*(?:,?\s*et\s+al\.?)?),\s+(?=\S)`, 'u');
const ELS_TAIL = new RegExp(String.raw`^(.+),\s*(?:(\d{1,5}[A-Za-z]?)\s*(?:\(\s*([^)]{1,12}?)\s*\)\s*)?)?\(\s*${EN_YEAR}\s*\)\s*(?:(?:pp?\.\s*)?([A-Za-z]?\d[\w\-–—]*))?\s*\.?$`, 'u');

// "..., Journal, 7 2020." (volume and year, no brackets)
const ELS_TAIL_BARE = new RegExp(String.raw`^(.+),\s*(\d{1,5})\s+${EN_YEAR}\s*\.?$`, 'u');

function parseElsevierNumbered(core) {
  const am = core.match(ELS_AUTHORS);
  if (!am) return null;
  const rest = core.slice(am[0].length).trim();
  const t = rest.match(ELS_TAIL) || (m => m && [m[0], m[1], m[2], '', m[3], m[4], ''])(rest.match(ELS_TAIL_BARE));
  if (!t) return null;
  const cut = t[1].lastIndexOf(',');
  if (cut < 0) return null;
  const title = t[1].slice(0, cut).trim(), journal = t[1].slice(cut + 1).trim();
  if (title.length < 8 || !journal) return null;
  const authors = am[1].replace(/,?\s*et\s+al\.?\s*$/, '').split(/\s*,\s*(?:and\s+)?|\s+and\s+/).map(p => {
    const m = p.trim().match(new RegExp(String.raw`^(${EN_INIT_LATER})\s?(${EN_FAM})$`, 'u'));
    return m ? { family: m[2].trim(), given: m[1].trim() } : null;
  }).filter(Boolean);
  if (!authors.length) return null;
  return { authors, title, journal, volume: t[2] || '', issue: (t[3] || '').trim(), year: +t[4], ...(t[5] ? { yearSuffix: t[5] } : {}),
    pages: (t[6] || '').replace(/\s+/g, '').replace(/[–—]/g, '-') };
}

/** "Surname, I., I. Surname, and I. Surname, et al." -> [{ family, given }] */
function endNoteAuthors(seg) {
  const s = seg.replace(/,?\s*et\s+al\.?\s*$/, '').trim();
  const first = s.match(new RegExp(String.raw`^(${EN_FAM}),\s?(${EN_INIT})`, 'u'));
  if (!first) return [];
  const out = [{ family: first[1].trim(), given: first[2].trim() }];
  const later = s.slice(first[0].length).replace(/^[\s,]*(?:and\s+)?/, '').split(/\s*,\s*(?:and\s+)?|\s+and\s+/).filter(Boolean);
  for (const p of later) {
    const m = p.trim().match(new RegExp(String.raw`^(${EN_INIT_LATER})\s?(${EN_FAM})$`, 'u'));
    if (m) out.push({ family: m[2].trim(), given: m[1].trim() });
  }
  return out;
}

function parseEndNote(core) {
  if (/\(\s*(?:1[6-9]|20)\d{2}[a-z]?\s*\)/.test(core)) return null; // APA / Harvard / Nature put the year in parentheses
  const am = core.match(EN_AUTHORS);
  if (!am) return null;
  const authors = endNoteAuthors(am[1]);
  if (!authors.length) return null;
  const rest = core.slice(am[0].length).trim();
  const pages = s => (s || '').replace(/\s+/g, '').replace(/[–—]/g, '-');

  // Chapter: Title, in Book Title, I. Editor and I. Editor, Editors. Year, Publisher: Place. p. 275-313.
  const ch = rest.match(new RegExp(String.raw`^(.+?),\s+in\s+(.+?),\s+(.+?),\s+(?:Editors?|Eds?)\.\s*${EN_YEAR},\s*([^.:]+?)(?::\s*([^.]+?))?\.\s*(?:pp?\.\s*([\w\-–—]+))?\.?$`, 'u'));
  if (ch) {
    return { authors, title: ch[1], type: 'book-chapter', bookTitle: ch[2], journal: ch[2], editors: ch[3], year: +ch[4], ...(ch[5] ? { yearSuffix: ch[5] } : {}),
      publisher: ch[6].trim(), ...(ch[7] ? { place: ch[7].trim() } : {}), pages: pages(ch[8]), looksLikeBook: true };
  }

  // Article: Title. Journal, Year. Vol(Issue): p. pages.
  const art = rest.match(new RegExp(String.raw`^(.+),\s*${EN_YEAR}(?:[.:]\s*(.*?))?\s*$`, 'u'));
  if (art) {
    const loc = (art[4] || '').match(EN_LOCATOR);
    const segs = splitSentences(art[1]);
    if (loc && segs.length >= 2) {
      // Rejoin an abbreviated journal split on its full stops ("Int. J. Pharm")
      const journal = [segs.pop()];
      while (segs.length > 1 && /^[\p{Lu}][\p{L}&]{0,6}$/u.test(segs[segs.length - 1])) journal.unshift(segs.pop());
      return { authors, title: segs.join('. '), journal: journal.join('. '), year: +art[2], ...(art[3] ? { yearSuffix: art[3] } : {}),
        volume: loc[1] || '', issue: (loc[2] || '').trim(), pages: pages(loc[3]) };
    }
  }

  // No journal given: Title. Year. Vol: p. pages.
  const nj = rest.match(new RegExp(String.raw`^(.+?)\.\s+${EN_YEAR}[.:]\s*(.+?)\s*$`, 'u'));
  const njLoc = nj && nj[4].match(EN_LOCATOR);
  if (njLoc) return { authors, title: nj[1], year: +nj[2], ...(nj[3] ? { yearSuffix: nj[3] } : {}), volume: njLoc[1] || '', issue: (njLoc[2] || '').trim(), pages: pages(njLoc[3]) };

  // Book or report: Title. Year, Publisher: Place.
  const bk = rest.match(new RegExp(String.raw`^(.+?)\.\s+${EN_YEAR}(?:,\s*([^.:]+?)(?::\s*([^.]+?))?)?\.?$`, 'u'));
  if (bk) {
    return { authors, title: bk[1], year: +bk[2], ...(bk[3] ? { yearSuffix: bk[3] } : {}),
      ...(bk[4] ? { publisher: bk[4].trim(), looksLikeBook: true, type: 'book' } : {}), ...(bk[5] ? { place: bk[5].trim() } : {}) };
  }
  // Title only (no year or source given)
  if (splitSentences(rest).length === 1 && !YEAR_RE.test(rest)) return { authors, title: rest.replace(/\.$/, '') };
  return null;
}

/** Journal / container name: text after the title up to volume, year or page information */
function journalFrom(rest) {
  return String(rest || '')
    .replace(/^[\s.,?!:]+/, '')
    .replace(/^In:?\s+/i, '')
    .split(/,?\s*(?:vol\.?\s*)?\d{1,4}\s*\(|,\s*\d|;|\s(?:1[6-9]|20)\d{2}\b|,\s*(?:vol|no|pp)\b|\.\s+(?:In|Available|Retrieved|Accessed)\b|(?<=\.)\s*\d{1,4}\s*:\s*\d/i)[0]
    .replace(/[.,:\s]+$/, '')
    .trim();
}

/** Split on sentence-ending periods but not on initials ("J. A.") or abbreviations ("et al.") */
function splitSentences(s) {
  const out = [];
  let buf = '';
  const tokensArr = s.split(/(\.\s+|\?\s+|!\s+)/);
  for (let i = 0; i < tokensArr.length; i += 2) {
    const piece = tokensArr[i];
    const sep = tokensArr[i + 1] || '';
    buf += piece + sep;
    const lastWord = piece.split(/\s+/).pop() || '';
    const isInitial = /^[\p{Lu}]$/u.test(lastWord) || /^(?:[\p{Lu}]\.)+[\p{Lu}]$/u.test(lastWord);
    const isAbbrev = /^(?:al|vs|eds?|vol|no|pp|Jr|Dr|St|Inc|Ltd|Co)$/i.test(lastWord);
    if (sep && (isInitial || isAbbrev) && !/\?|!/.test(sep)) continue;
    if (buf.trim()) out.push(buf.trim().replace(/[.?!]$/, '').trim());
    buf = '';
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

// ------------------------------------------------------------------ manuscript structure

/**
 * A line that reads like a reference-list entry, not like prose: it starts with an author ("Khan A,", "Khan, A.", "1. Khan AB",
 * "[3] Smith J") or an organisation followed by "(2021)", and it carries a year
 */
function looksLikeReference(line) {
  const l = String(line || '').trim();
  if (l.length < 25 || l.length > 1500 || !/\b(?:1[89]|20)\d{2}[a-z]?\b/.test(l)) return false;
  const lead = l.replace(/^(?:\[\d{1,3}\]|\d{1,3}[.)])\s*/, '');
  return /^(?:[\p{Ll}]{1,4}\s){0,2}\p{Lu}[\p{L}'’-]+,?\s+(?:\p{Lu}\.?[\s-]?){1,3}(?:[,.;&]|\s(?:and|et)\b|\s\(|$)/u.test(lead)
    || /^\p{Lu}[\p{L}\s&.,'’-]{2,120}?\s\((?:1[89]|20)\d{2}[a-z]?\)\.\s/u.test(lead);
}

/** No heading: the run of reference-like lines at the end of the document (back matter after it is left out) */
function trailingReferences(lines) {
  let end = -1;
  for (let i = lines.length - 1; i >= 0 && end < 0; i--) if (looksLikeReference(lines[i])) end = i;
  if (end < 0) return null;
  let start = end, hits = 0, misses = 0;
  for (let i = end; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    if (looksLikeReference(lines[i])) { start = i; hits++; misses = 0; } else if (++misses >= 2) break;
  }
  const bodyWords = lines.slice(0, start).join(' ').split(/\s+/).filter(Boolean).length;
  return hits >= 3 && bodyWords >= 100 ? { start, end: end + 1 } : null;
}

/** reference list after a heading inside a long run-together line -> { body, references, found } or null */
function flatReferenceSection(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].length < 1600) continue;
    const re = new RegExp(String.raw`(?:^|[\s.])(?:\d+\.?\s*)?(REFERENCES|References|BIBLIOGRAPHY|Bibliography|LITERATURE CITED|Literature cited|Literature Cited)\s*[:.]?\s+(?=\S)`, 'g');
    let last = null;
    for (const m of lines[i].matchAll(re)) {
      const after = lines[i].slice(m.index + m[0].length);
      // entries must follow, and the list must reach towards the end of the text (not "references" in a sentence)
      if (after.length > 200 && looksLikeReference(after.slice(0, 400)) && (after.match(/\b(?:1[6-9]|20)\d{2}[a-z]?\b/g) || []).length >= 3) last = m;
    }
    if (!last) continue;
    const at = last.index + last[0].length;
    return {
      body: [...lines.slice(0, i), lines[i].slice(0, last.index)].join('\n'),
      references: [lines[i].slice(at), ...lines.slice(i + 1)].join('\n').trim(),
      found: true, flattened: true
    };
  }
  return null;
}

function findReferenceSection(text) {
  const lines = text.split('\n');
  let start = -1, inline = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (REF_HEADING.test(lines[i]) && l.length < 40) {
      // "Sources" / "Literature" alone are ordinary words too: a heading only when references follow
      if (WEAK_HEADING.test(l) && lines.slice(i + 1, i + 6).filter(looksLikeReference).length < 2) continue;
      start = i; break;
    }
    const m = l.length < 1600 && l.match(REF_HEADING_INLINE);
    if (m && looksLikeReference(m[1])) { start = i; inline = m[1]; break; }
  }
  let end = lines.length;
  if (start === -1) {
    // text with its line breaks lost (some PDFs give a whole page or the whole article as one line): the last
    // "REFERENCES" / "References" heading inside a long line that is followed by reference entries
    const flat = flatReferenceSection(lines);
    if (flat) return flat;
    // no heading at all (a plain Word document): the reference-like lines at the end are the list
    const t = trailingReferences(lines);
    if (!t) return { body: text, references: '', found: false };
    return { body: lines.slice(0, t.start).join('\n'), references: lines.slice(t.start, t.end).join('\n').trim(), found: true, headingless: true };
  }
  for (let i = start + 1; i < lines.length; i++) {
    if (END_HEADINGS.test(lines[i]) && lines[i].trim().length < 60) { end = i; break; }
  }
  return {
    body: lines.slice(0, start).join('\n'),
    references: [inline, ...lines.slice(start + 1, end)].filter(x => x !== null).join('\n').trim(),
    found: true
  };
}

const AFFIL_RE = /\b(university|department|dept\.?|institute|faculty|college|hospital|school|centre|center|laborator|pakistan|karachi|lahore|islamabad|e-?mail|corresponding|@)/i;

/** Detect title, authors, affiliations, abstract and keywords from the first page of a manuscript */
function extractManuscriptMeta(text) {
  const head = text.slice(0, 8000);
  const lines = [];
  // a PDF title page puts each affiliation mark, and the comma or "AND" after it, on a line of its own:
  // "HOSAM O. ELANSARY¹, KHALID F. ALMUTAIRI" / "1" / ", ADEL M. AL-SAIF" ... "AND" / "ABDULLAH ALEBIDI": one author line
  for (const raw of head.split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    const prev = lines[lines.length - 1];
    if (prev && !/^(?:abstract|summary)\b/i.test(l) && (/^[\d⁰¹²³⁴⁵⁶⁷⁸⁹*#†‡,\s]{1,8}$/.test(l) || /^,/.test(l) || /(?:,|\s(?:AND|and|&))$/.test(prev) && /^[\p{Lu}]/u.test(l) && l.length < 200 && !AFFIL_RE.test(l))) lines[lines.length - 1] = `${prev} ${l}`.replace(/\s+,/g, ',');
    else lines.push(l);
  }
  const meta = { title: '', authors: [], affiliations: [], abstract: '', keywords: [] };

  const absIdx = lines.findIndex(l => /^(?:【\s*)?(?:abstract|summary)\b[:.\s】]*/i.test(l));
  const skip = l => /^(?:original (?:research )?article|research (?:article|paper)|review article|short communication|case report|manuscript|running title|title:?)$/i.test(l) || /^page \d+/i.test(l)
    // a published article's header: "Pak. J. Bot., 58(9): 1849-1856, September 2026.", "Received: ...", "ARTICLE doi: ..."
    || /^[\p{Lu}][\p{L}.]*(?:\s[\p{L}.&]+){0,5},?\s*\d+\s*\(\s*[\w-]+\s*\)\s*:\s*\d+/u.test(l) || /^(?:received|revised|accepted|online|published)\b/i.test(l) || /^(?:article|research article)?\s*doi\s*:/i.test(l);
  const headLines = (absIdx > 0 ? lines.slice(0, absIdx) : lines.slice(0, 12)).filter(l => !skip(l));

  // Labelled title-page lines: "Manuscript ID: …", "Authors: …", "Corresponding author: …", "Running title: …"
  const LABEL = /^(manuscript (?:id|no\.?|number|code)|paper id|submission id|authors?|corresponding authors?|correspondence|e-?mails?|running (?:head|title)|short title|received|accepted|revised|article type|orcid(?: ids?)?)\s*[:\-–]\s*(.*)$/i;
  // Title: first substantial line(s) not looking like authors/affiliations
  let i = 0;
  const titleParts = [], labelled = [];
  while (i < headLines.length && titleParts.join(' ').length < 250) {
    const l = headLines[i].replace(/^title:\s*/i, '');
    // a title can name a department ("... in the Emergency Department"): an affiliation line starts with its mark or lists
    // places with commas
    const affiliation = AFFIL_RE.test(l) && (/^(?:\[\s*\d|[\d¹²³⁴⁵⁶⁷⁸⁹*#⁎†])/.test(l) || (l.match(/,/g) || []).length >= 2 || titleParts.length > 0);
    // a labelled line above the title ("Running Title: J. regia Attenuates Ethanol Damage", "Manuscript ID: ...") is read with
    // the other labels below; it ended the search and left the title empty (report 217: novelty not assessed)
    if (!titleParts.length && LABEL.test(l) && !/^(?:authors?|corresponding|correspondence|e-?mail)/i.test(l)) { labelled.push(l); i++; continue; }
    if (LABEL.test(l) || affiliation || (titleParts.length && looksLikeAuthorLine(l))) break;
    if (l.split(' ').length >= 3 || titleParts.length) titleParts.push(l);
    i++;
    if (titleParts.length && /[a-z]$/.test(l) === false && l.length < 60) break;
  }
  meta.title = titleParts.join(' ').replace(/\s+/g, ' ').trim();

  for (const raw of [...labelled, ...headLines.slice(i)]) {
    // "* Corresponding Author:": the role mark before a label
    const l = raw.replace(/^[*#†‡]+\s*(?=[A-Za-z][A-Za-z -]{0,30}:)/, '');
    const lab = l.match(LABEL);
    if (lab) {
      const k = lab[1].toLowerCase();
      if (/^(manuscript|paper|submission)/.test(k)) meta.manuscriptCode = lab[2].trim().split(/\s+/)[0] || '';
      else if (/^authors?$/.test(k) && looksLikeAuthorLine(lab[2])) meta.authors.push(...parseAuthorLine(lab[2]));
      continue;
    }
    if (/@/.test(l)) continue;
    if (AFFIL_RE.test(l)) meta.affiliations.push(l.replace(/^(?:\[[\d,\s]*\]|[\d*†‡§¹²³⁴⁵⁶⁷⁸⁹⁎#,\s])+/, ''));
    else if (looksLikeAuthorLine(l)) meta.authors.push(...parseAuthorLine(l));
  }

  // the same person named again (corresponding-author line)
  meta.authors = meta.authors.filter((x, k, all) => all.findIndex(y => y.name.toLowerCase() === x.name.toLowerCase()) === k);
  if (absIdx >= 0) {
    const absText = [];
    const first = lines[absIdx].replace(/^(?:【\s*)?(?:abstract|summary)\b[:.\s】]*/i, '');
    if (first) absText.push(first);
    for (let j = absIdx + 1; j < lines.length; j++) {
      if (/^(?:key\s*words?|index terms)\b/i.test(lines[j]) || /^(?:\d+\.?\s*)?introduction\b/i.test(lines[j])) break;
      absText.push(lines[j]);
      if (absText.join(' ').length > 3500) break;
    }
    meta.abstract = absText.join(' ').replace(/\s+/g, ' ').trim();
  }
  const kw = head.match(/(?:key\s*words?|index terms)\s*[:\-–]\s*([^\n]+)/i);
  if (kw) meta.keywords = kw[1].split(/[;,•·]/).map(s => s.trim().replace(/\.$/, '')).filter(Boolean).slice(0, 12);
  if (!meta.title || !meta.abstract) flatMeta(head, meta);
  return meta;
}

/**
 * A title page flattened to one line (a PDF copied as text, the corpus store): "Pak. J. Pharm. Sci., Vol.27, No.3, May 2014,
 * pp.703-711 703 Identification of a helicase-like protein ... phage 4 gene Qi Zhang 1 , Qiupeng Li 1 , ... Abstract: DNA
 * helicases ... Keywords: ...". The abstract is what stands between "Abstract" and "Keywords" / "Introduction"; the title is
 * what follows the journal's running head, up to the first author with an affiliation mark ("Chi Ma 1 *,"). Measured on 200
 * published PJPS articles (18 Nov 2026): none had a title or abstract read before.
 */
function flatMeta(head, meta) {
  if ((head.slice(0, 3000).match(/\n/g) || []).length > 6) return;   // a normal title page: the line reader has done its best
  if (!meta.abstract) {
    const ab = head.match(/\b(?:abstract|summary)\b\s*[:.]?\s*([\s\S]{150,3500}?)\s*(?:\bkey\s*words?\b|\bindex terms\b|\bintroduction\b)/i);
    if (ab) meta.abstract = ab[1].replace(/\s+/g, ' ').trim();
  }
  if (!meta.keywords.length) {
    const kw = head.match(/\bkey\s*words?\s*[:\-–]\s*(.{3,400}?)\s*(?:\bintroduction\b|$)/i);
    if (kw) meta.keywords = kw[1].split(/[;,•·]/).map(s => s.trim().replace(/\.$/, '')).filter(w => w && w.length < 60).slice(0, 12);
  }
  if (!meta.title) {
    const absAt = head.search(/\b(?:abstract|summary)\b\s*[:.]?/i);
    let front = (absAt > 0 ? head.slice(0, absAt) : head.slice(0, 1500)).replace(/\s+/g, ' ');
    // the journal's running head: "Pak. J. Pharm. Sci., Vol.31, No.3(Special), May 2018, pp.1151-1156 1151"
    front = front.replace(/^.{0,160}?\bpp\.?\s*\d+\s*[-–]\s*\d+\s+\d+\s+/i, '').replace(/^.{0,120}?\bdoi\.org\/\S+\s+/i, '');
    // the first author written "Name Surname 1 ," / "Name Surname1*," / "Name Surname 1, 2 *"
    // ("Jie Zhu 1 △ ,"), one name with a mark ("Alamgeer 1 *,"), or in capitals ("LATEEF SAKA KASIM, 1*")
    const au = front.match(/\s(?=[\p{Lu}][\p{L}'’-]+(?:[\s-][\p{Lu}](?:[\p{L}'’-]+|\.)?){1,3}\s?(?:[*†#△▲]\s?)?[\d¹²³⁴⁵⁶⁷⁸⁹]{1,2}(?:\s?,\s?\d{1,2})*\s?(?:[*†#△▲]\s?){0,3}(?:,|and\b)|[\p{Lu}][\p{Ll}'’-]+\s?\d{1,2}\s?[*†#△▲]\s?,|(?:[\p{Lu}]{2,}\s){1,3}[\p{Lu}]{2,},\s?\d{1,2}\s?\*?)/u);
    const t = au ? front.slice(0, au.index).trim() : '';
    if (t.length >= 20 && t.length <= 300 && !/\b(?:abstract|department|university)\b/i.test(t)) meta.title = t.replace(/[.\s]+$/, '');
    // the authors ("Qi Zhang 1 , Qiupeng Li 1 , ... and Lianbing Lin 1 *") up to the first affiliation ("1 Biotechnology
    // Research Center, ..."), then the affiliations, each after its number
    if (au && !meta.authors.length) {
      const rest = front.slice(au.index).trim();
      const affAt = rest.search(/\s[*†#]?\s?\d{1,2}\s?[*†#]?\s?(?=(?:[\p{Lu}][\p{L}.&'’-]*\s){0,6}(?:Department|Dept\.?|Faculty|College|School|Institute|Laboratory|Center|Centre|University|Hospital|Division|Key Laboratory|Research)\b)|\s(?=(?:Department|Dept\.?|Faculty|College|School|Institute)\s+of\b)/u);
      const names = (affAt > 0 ? rest.slice(0, affAt) : '').replace(/[\d¹²³⁴⁵⁶⁷⁸⁹*†#△▲]+/g, ' ').split(/\s*,\s*|\s+and\s+|\s*&\s*/)
        .map(s => s.replace(/\s+/g, ' ').trim()).filter(s => /^[\p{Lu}][\p{L}'’.-]*(?:\s[\p{L}'’.-]+){0,4}$/u.test(s) && s.length <= 60);
      if (names.length && names.length <= 30) meta.authors = names.map(n => ({ name: n }));
      // (the line reader may have taken the whole one-line page for one affiliation)
      if (affAt > 0 && (!meta.affiliations.length || meta.affiliations.some(a => a.length > 400))) {
        meta.affiliations = rest.slice(affAt).split(/\s[*†#]?\s?\d{1,2}\s?[*†#]?\s?(?=[\p{Lu}])/u).map(s => s.replace(/\s+/g, ' ').trim())
          .filter(s => s.length > 8 && AFFIL_RE.test(s)).slice(0, 15);
      }
    }
    if (!meta.title) unmarkedAuthors(front, meta);
  }
}

/**
 * A one-line title page whose authors carry no numbered marks: "... flower extract Ampai Phrutivorapongkul, Kanokwan
 * Kiattisin, ... and Pimporn Leelapornpisid* Department of ...", or all in capitals ("... METHOD RABIA BUSHRA, NOUSHEEN
 * ASLAM AND MASUD-UR-REHMAN* Department ..."). The author list is read back from the first affiliation: the names after
 * the first are separated by commas and "and"; the first one has as many words as the others usually have, and the title
 * is what comes before it. 90 of 250 published PJPS articles had no title read (19 Nov 2026).
 */
function unmarkedAuthors(front, meta) {
  const AFF = /\b(?:Department|Dept\.|Faculty|College|School|Institute|Laboratory|Laboratoire|Centre|Center|University|Universit[éy]|Hospital|Division|Ministry|Graduate|State Key|Key Laboratory)\b/u;
  const at = front.search(AFF);
  if (at < 30) return;
  let seg = front.slice(0, at);
  // the corresponding author's mark ends the list ("Leelapornpisid* State Key ...", "BOGDADY HH ** Protein Research")
  const mark = seg.search(/[*†#]+\s*(?:[\p{Lu}][\p{L}]*\s*){0,3}$/u);
  if (mark > 0) seg = seg.slice(0, mark);
  seg = seg.replace(/[*†#\d¹²³⁴⁵⁶⁷⁸⁹]+/g, ' ').replace(/\s+/g, ' ').trim()
    // an old running head whose numbers the text lost: "Pakistan Journal of Pharmaceutical Sciences Vol. , No. , July , pp. - "
    .replace(/^.{0,80}?\b(?:Sciences?|Sci\.)\s*(?:,\s*)?(?:Vol\.?\s*)?[\s,.():;-]*(?:No\.?[\s,.()-]*)?(?:(?:January|February|March|April|May|June|July|August|September|October|November|December)\b[\s,.]*)?(?:pp\.?\s*[\w.]*\s*-\s*)?/i, m => (/pakistan|pak\./i.test(m) ? '' : m))
    .replace(/^Vol\.?[\s,.():;-]*/, '').replace(/^(?:ORIGINAL ARTICLE|REVIEW(?: ARTICLE)?|REPORT|SHORT COMMUNICATION|CASE REPORT)\s+/, '');
  // affiliation words just before the keyword ("Hongjie Gao Pharmacy Department", "Analytical Chemistry Laboratory")
  const AFF_WORD = /^(?:Pharmacy|Pharmaceutical|Pharmacology|Chemistry|Analytical|Research|Section|Unit|Care|Intensive|Technology|Sciences?|Medicine|Medical|Clinical|Biology|Biochemistry|Microbiology|Agricultural|Protein|Food|Health|National|Engineering|Nursing|Surgery|General|Central|Public|Applied|Molecular|Environmental|Cyprus|Bahcesehir|Lanzhou)$/i;
  let w = seg.split(' ');
  while (w.length > 3 && AFF_WORD.test(w[w.length - 1])) w.pop();
  seg = w.join(' ');
  // a name: capitalised words, none of them a title word ("ROLE OF NA-K-ATPASE") or an affiliation word
  const isName = s => /^(?:[\p{Lu}][\p{L}'’.-]*)(?:\s[\p{Lu}][\p{L}'’.-]*){0,4}$/u.test(s) && s.length <= 50 &&
    !s.split(' ').some(x => /^(?:OF|IN|THE|FOR|ON|TO|WITH|BY|FROM|AS|AT|ITS|INTO|VIA|A|AN)$/i.test(x) || AFF_WORD.test(x));
  // the pieces between commas and "and", with where each starts, so the title keeps its own "and" and commas
  const parts = [];
  let from = 0;
  for (const m of seg.matchAll(/\s*,\s*|\s+(?:and|AND|&)\s+/g)) { parts.push({ s: seg.slice(from, m.index), at: from }); from = m.index + m[0].length; }
  parts.push({ s: seg.slice(from), at: from });
  const names = [];
  let firstKnown = false;
  while (parts.length > 1 && isName(parts[parts.length - 1].s)) {
    const p = parts[parts.length - 1], ws = p.s.split(' ');
    // in capitals a title's last words run into the first name after its "AND" ("... AND FEMALE RATS NAJMA SHAHEEN"):
    // four words or more in capitals end the list, their last two being the first author, the rest the title's end
    if (ws.length >= 4 && p.s === p.s.toUpperCase() && names.length) { names.unshift(ws.slice(-2).join(' ')); p.s = ws.slice(0, -2).join(' '); firstKnown = true; break; }
    names.unshift(parts.pop().s);
  }
  const head = seg.slice(0, parts[parts.length - 1].at + parts[parts.length - 1].s.length).trim();
  if (firstKnown) {
    if (head.length >= 20 && head.length <= 300) { meta.title = head.replace(/[.\s,]+$/, ''); if (!meta.authors.length) meta.authors = names.map(n => ({ name: n })); }
    return;
  }
  const words = head.split(' ');
  let k = 2;
  if (names.length) { const n = names.map(s => s.split(' ').length).sort((a, b) => a - b); k = Math.min(3, Math.max(2, n[Math.floor(n.length / 2)])); }
  // the first author: its last k words, all capitalised ("Ampai Phrutivorapongkul", "RABIA BUSHRA", "Gujun Yan")
  const first = words.slice(-k);
  if (!first.every(w => /^[\p{Lu}][\p{L}'’.-]*$/u.test(w))) return;
  const title = words.slice(0, -k).join(' ').replace(/[.\s,]+$/, '');
  if (title.length < 20 || title.length > 300 || /\b(?:abstract|department|university)\b/i.test(title)) return;
  meta.title = title;
  if (!meta.authors.length) meta.authors = [first.join(' '), ...names].map(n => ({ name: n }));
}

// affiliation and role marks written after (or between) author names: 1, ¹, [2], [1,3], 2,*, 1#, ⁎, †, [] ...
const AUTHOR_MARK = /(?:\[\s*[\d,\s–-]*\]|[\d⁰¹²³⁴⁵⁶⁷⁸⁹*#⁎†‡§¶✉](?:\s*,\s*(?=[\d⁰¹²³⁴⁵⁶⁷⁸⁹*#⁎†‡§¶]))?)+/g;
// degrees and titles that follow or precede a name on a title page
const DEGREE = /^(?:ph\.?\s?d|m\.?\s?d|m\.?\s?phil|m\.?\s?sc|b\.?\s?sc|m\.?\s?pharm|pharm\.?\s?d|mbbs|fcps|frcp|professor|prof|dr|associate professor|assistant professor|lecturer)\.?$/i;
/** The names of a title-page author line, the marks between them read as separators: ['Lei Wang', 'Fareeha Majid', ...] */
// a degree after a name, with a letter affiliation mark glued on: "Sadia Suri Kashif Ph.D.,a#", "Muhammad Naveed Ph.D.d,"
// (initials such as "M. D. Smith" are not taken: a degree here is never followed by a letter)
const DEGREE_AFTER = /\s*\b(?:Ph\.?\s?D|M\.?\s?Phil|M\.?\s?Sc|B\.?\s?Sc|M\.?\s?Pharm|Pharm\.?\s?D|MBBS|FCPS|FRCP)\b\.?(?:[a-h](?![A-Za-z]))?(?![A-Za-z])/g;
function authorNames(l) {
  return String(l).replace(DEGREE_AFTER, ',').replace(AUTHOR_MARK, ',').split(/\s*(?:,|;|\band\b|&)\s*/)
    .map(n => n.trim().replace(/^[a-h]\s+(?=\p{Lu})/u, '').replace(/^(?:dr|prof|professor)\.?\s+/i, '').replace(/\s+/g, ' '))
    // a lone letter left over from the affiliation marks "a", "b#*" ("Ph.D.,c Muhammad Naveed": the mark before the next name)
    .filter(n => n && !DEGREE.test(n) && !/^[a-h]$/.test(n));
}
// a person's name: 2-5 capitalised words (or initials + surname); one word or all capitals is not taken ("SELUMETINIB",
// "FOR PEER REVIEW"), nor a place, institution or heading word
const NOT_A_NAME = /\b(?:university|college|department|institute|hospital|school|faculty|centre|center|laboratory|province|china|pakistan|india|iran|egypt|saudi|arabia|turkey|review|abstract|keywords?|introduction|systems?|article|research)\b/i;
const isPersonName = n => /^[\p{Lu}][\p{L}.'’\-]*(?:\s+[\p{Lu}][\p{L}.'’\-]*){1,4}$/u.test(n) && !NOT_A_NAME.test(n) && (n !== n.toUpperCase() || /^(?:[\p{Lu}]\.\s*)+[\p{Lu}][\p{L}'’\-]+$/u.test(n));

// an author line in capitals ("HOSAM O. ELANSARY¹, KHALID F. ALMUTAIRI 1 AND ...") is read in ordinary case when it carries
// the affiliation marks; a title in capitals has none
const titleCase = s => s.toLowerCase().replace(/(^|[\s.'’-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
const caseOf = l => (l === l.toUpperCase() && /\p{Lu}{3}/u.test(l) && /[\d⁰¹²³⁴⁵⁶⁷⁸⁹*†]/.test(l) ? titleCase(l).replace(/\bAnd\b/g, 'and') : l);

function looksLikeAuthorLine(l) {
  l = caseOf(l);
  if (l.length > 400 || /[.:]\s+[a-z]/.test(l)) return false;
  const names = authorNames(l);
  return names.length >= 1 && names.every(isPersonName);
}

function parseAuthorLine(l) {
  return authorNames(caseOf(l)).filter(isPersonName).map(n => ({ name: n, ...splitName(n) }));
}

// ------------------------------------------------------------------ in-text citations

function expandRange(spec) {
  const out = [];
  for (const part of spec.split(/\s*,\s*/)) {
    const m = part.match(/^(\d{1,4})\s*[-–—]\s*(\d{1,4})$/);
    if (m) {
      const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (b >= a && b - a < 100) for (let k = a; k <= b; k++) out.push(k);
    } else if (/^\d{1,4}$/.test(part)) out.push(parseInt(part, 10));
  }
  return out;
}

/** Find numbered citations: [1], [2,3], [4-6], and (1)/(1-3) when numeric style dominates */
function extractNumericCitations(body, maxRef) {
  const cites = [];
  const push = (m, nums, style) => {
    const ctxStart = Math.max(0, m.index - 80);
    cites.push({ nums, text: m[0], index: m.index, style, para: paraNo(body, m.index), context: body.slice(ctxStart, m.index + m[0].length + 40).replace(/\s+/g, ' ') });
  };
  for (const m of body.matchAll(/\[(\s*\d{1,4}(?:\s*[-–—,]\s*\d{1,4})*\s*)\]/g)) push(m, expandRange(m[1]), 'bracket');
  if (cites.length < 3) {
    for (const m of body.matchAll(/\((\s*\d{1,3}(?:\s*[-–—,]\s*\d{1,3})*\s*)\)/g)) {
      const nums = expandRange(m[1]);
      if (nums.length && nums.every(n => n >= 1 && n <= Math.max(maxRef * 1.5, 10))) push(m, nums, 'paren');
    }
  }
  return cites;
}

/** Paragraph number (counting non-empty lines) of a position in the manuscript text */
function paraNo(body, index) {
  return (body.slice(0, index).match(/[^\n]+/g) || []).length + 1;
}

// surname particles written in lower case: van der Berg, de Souza, al Hassan, bin Abdullah
const PARTICLE = '(?:van|von|de|der|den|da|del|della|di|du|la|le|al|el|ul|ur|bin|ibn|abu|dos|das|ter|ten)';
const CAP = "[\\p{Lu}][\\p{L}'’\\-]+";
// one surname, with particles before or inside it (narrative citations: a capitalised word before it may start the sentence)
const NAME_TOKEN = `(?:${PARTICLE}\\s){0,3}${CAP}(?:\\s(?:${PARTICLE}\\s){1,2}${CAP})?`;
// at the start of a parenthetical citation also several capitalised words: De Silva, World Health Organization, Centers for
// Disease Control (an organisation as author)
const PAREN_NAME = `(?:${PARTICLE}\\s){0,3}${CAP}(?:\\s(?:(?:${PARTICLE}|of|for|on|the)\\s){0,2}${CAP}){0,6}`;

/** Find author-year citations: (Smith, 2020), (Smith & Lee, 2019a; Khan et al., 2021), Smith et al. (2020) */
function extractAuthorYearCitations(body) {
  const cites = [];
  // years, and a letter alone after a lettered year: (Khan et al., 2020a, b) cites 2020a and 2020b
  const yearList = '((?:1[6-9]\\d{2}|20\\d{2})[a-z]?(?:\\s*,\\s*(?:(?:1[6-9]\\d{2}|20\\d{2})[a-z]?|[a-z](?=\\s*[,;)]|\\s*$)))*)';
  const authorPart = `(${NAME_TOKEN}(?:\\s+et\\s+al\\.?|\\s*(?:&|and)\\s*${NAME_TOKEN})?)`;
  // several authors named in brackets: (Shah, Iqbal and Khan, 2018), (Moniz, Verissimo et al., 2007)
  const parenAuthor = `(${PAREN_NAME}(?:(?:\\s*(?:,|&|and)\\s*${PAREN_NAME})*\\s+et\\s+al\\.?|(?:\\s*,\\s*${PAREN_NAME})*\\s*,?\\s*(?:&|and)\\s*${PAREN_NAME})?)`;
  const onlyYears = new RegExp(`^${yearList}$`, 'u');
  const covered = [];

  // Parenthetical groups, and bracketed ones written with author and year: [IOM, 2001; ATSDR, 2008]
  for (const m of [...body.matchAll(/\(([^()]{2,400}?(?:1[6-9]\d{2}|20\d{2})[a-z]?[^()]*?)\)/g), ...body.matchAll(/\[([^[\]]{2,400}?\p{L}{2}[^[\]]*?(?:1[6-9]\d{2}|20\d{2})[a-z]?[^[\]]*?)\]/gu)]) {
    covered.push([m.index, m.index + m[0].length]);
    // works are separated by semicolons, but often by "and", ", and", a colon or a comma after a year, or nothing at all:
    // (Ahmad et al., 2019 and Butt et al., 2020), (Boulton et al., 2001, and Davies, 2003), (Huff et al., 1995 Johnson et al., 1995)
    let lastAuthor = null;
    for (const raw of m[1].split(/\s*;\s*|(?<=\b(?:1[6-9]\d{2}|20\d{2})[a-z]?)(?:\s*(?:,\s*(?:and\s+)?|:\s*|\band\s+)|\s+)(?=(?:e\.g\.,?\s+|see\s+)?\p{Lu}(?:[\p{Ll}'’]|\p{Lu}+\s*,\s*(?:1[6-9]|20)\d{2}))/u)) {
      const part = normalizeCitation(raw.replace(/^(?:e\.g\.,?|see|cf\.|also|i\.e\.,?)\s+/i, ''));
      const pm = part.match(new RegExp(`^${parenAuthor}(,\\s*|\\s+)${yearList}`, 'u'));
      // an acronym followed by an old "year" is a product or strain number: (RPMI 1640), (MT 1631), (ATCC 1911), (Shimadzu UV-1700)
      // an instrument and its model with the maker or country: (Shimadzu 1601, Japan), (UV 2000, Hitachi) - no comma before
      // the number and no other year in the brackets
      const model = pm && !pm[2].includes(',') && m[1].trim().startsWith(pm[0]) && /^\s*,\s*\p{Lu}[^\d;]*$/u.test(m[1].trim().slice(pm[0].length));
      // the author of a species name: "Genus : Acanthaster (Gervais, 1841)", "Nigella sativa (Linnaeus, 1753)"
      const before = body.slice(Math.max(0, m.index - 40), m.index);
      const taxon = pm && +pm[3].slice(0, 4) < 1900 && (/\b(?:genus|species|family|order)\s*:?\s*\p{Lu}\p{Ll}+\s*$/iu.test(before) || /\b\p{Lu}(?:\p{Ll}+|\.)\s+\p{Ll}{3,}\s*$/u.test(before));
      if (pm && !model && !taxon && !(/^[\p{Lu}\d\s-]+$/u.test(pm[1]) && !pm[2].includes(',') && +pm[3].slice(0, 4) < 1950) && !/-$/.test(pm[1])) { addAuthorYear(cites, pm[1], pm[3], m, body); lastAuthor = pm[1]; continue; }
      // more years of the same authors after a semicolon: (Wanxi et al., 2013a; 2013b; 2012a)
      const ym = lastAuthor && part.match(onlyYears);
      if (ym) addAuthorYear(cites, lastAuthor, ym[1], m, body);
    }
  }
  // Narrative: Smith et al. (2020), Smith and Jones (2019a, 2020)
  // (and possessive: Khan et al.'s (2019) study)
  for (const m of body.matchAll(new RegExp(`${authorPart}(?:['’]s)?\\s+\\(${yearList}\\)`, 'gu'))) addAuthorYear(cites, m[1], m[2], m, body);
  // Narrative without brackets, only after "et al." (the author list makes it a citation): "White et al 1968 reported",
  // "described by Magnani, et al., 1998."
  for (const m of body.matchAll(new RegExp(`(${NAME_TOKEN}),?\\s+et\\.?\\s*al\\.?,?\\s+((?:1[6-9]\\d{2}|20\\d{2})[a-z]?)\\b(?![\\d)])`, 'gu'))) {
    if (covered.some(([a, b]) => m.index >= a && m.index < b)) continue;
    addAuthorYear(cites, m[1] + ' et al.', m[2], m, body);
  }
  return cites;
}

/** The forms authors write a citation in, read as the usual one: "Bischoff, et al.", "Moriarty et. al.", "Hagger et al,",
 *  "Ahmed W et al", "Zheng, J et al", "Berendes H., 1992", "and 1997" after a year */
function normalizeCitation(part) {
  return part
    .replace(/\s*,?\s*\bet\.?\s*al\b\.?,?/gi, ' et al.,')
    .replace(/(\p{L}{2,})\s*,?\s+(?:\p{Lu}\.?){1,3}(?<![\p{Ll}])\b\.?(?=\s+(?:et al|and\b|&)|\s*,\s*(?:1[6-9]|20)\d{2})/gu, '$1')
    .replace(/(\b(?:1[6-9]|20)\d{2}[a-z]?)\s+(?:and|&)\s+(?=(?:1[6-9]|20)\d{2}\b)/g, '$1, ')
    .replace(/ et al\.,(\s*)$/, ' et al.$1');
}

function addAuthorYear(cites, authorStr, years, m, body) {
  const etAl = /et\s+al/i.test(authorStr);
  const names = authorStr.replace(/\s+et\s+al\.?/i, '').split(/\s*(?:&|\band\b|,)\s*/).map(s => s.trim()).filter(Boolean);
  if (/^(?:In|The|This|These|Table|Figure|Fig|Eq|Section|Chapter|Since|From|During|Between|After|Before|Until|January|February|March|April|May|June|July|August|September|October|November|December|Spring|Summer|Autumn|Winter)$/i.test(names[0])) return;
  let last = null;
  for (const y of years.split(/\s*,\s*/)) {
    // a letter alone takes the year before it, when that year had a letter too (2020a, b)
    const ym = y.match(/^(\d{4})([a-z]?)$/) || (/^[a-z]$/.test(y) && last?.[2] ? [y, last[1], y] : null);
    if (!ym) continue;
    last = ym;
    cites.push({
      authors: names, etAl, year: parseInt(ym[1], 10), suffix: ym[2] || '',
      text: m[0].slice(0, 160), index: m.index, para: paraNo(body, m.index),
      context: body.slice(Math.max(0, m.index - 80), m.index + m[0].length + 40).replace(/\s+/g, ' ')
    });
  }
}

module.exports = {
  DOI_REGEX, repairText, extractDocument, parseBibtex, parseRis, splitReferences, parseReferenceEntry,
  parseAuthors, findReferenceSection, looksLikeReference, extractManuscriptMeta, extractNumericCitations, extractAuthorYearCitations,
  expandRange, splitSentences
};
