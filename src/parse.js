// parse.js - document extraction, reference splitting/parsing, manuscript metadata and in-text citations
const { cleanDoi, splitName } = require('./text');

const DOI_REGEX = /10\.\d{4,9}\/[^\s"'<>,]*[^\s"'<>.,;:]/i;
const NUMBERED_PREFIX = /^\s*(?:\[\d{1,4}\]|\(\d{1,4}\)|\d{1,4}[.)](?!\d))\s*/;
const BULLET_PREFIX = /^\s*[•▪·*-]\s+/;
const YEAR_RE = /\b(1[6-9]\d{2}|20\d{2})[a-z]?\b/;
const REF_HEADING = /^\s*(?:\d+\.?\s*)?(references?|bibliography|literature cited|works cited|reference list|cited literature|kaynak[çc]a)\s*:?\s*$/im;
const END_HEADINGS = /^\s*(?:appendix|appendices|tables?|figure legends|figure captions|captions|list of (?:tables|figures)|supplementary (?:material|information)|author contributions|conflicts? of interest)\b/im;
// A wrapped line that starts with the year ("2020. 46(11): p. 1819-1831.") is not a new numbered entry
const YEAR_LINE = /^\s*(?:1[6-9]|20)\d{2}[a-z]?[.,;]\s/;
// Back matter that runs on after the last reference when the list has no closing heading
const BACK_MATTER = /\s+(?:Captions\b|List of (?:[Tt]ables|[Ff]igures)\b|(?:Table|Figure|Fig\.)\s*S?1\s*:\s)/;

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
  for (const m of src.matchAll(/@(\w+)\s*\{\s*([^,]*),([\s\S]*?)\n\}\s*(?=@|$)/g)) {
    const fields = {};
    for (const f of m[3].matchAll(/(\w+)\s*=\s*(\{((?:[^{}]|\{[^{}]*\})*)\}|"([^"]*)"|(\d+))/g)) {
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

function splitReferences(rawText, strategy = 'auto') {
  const text = repairText(rawText).trim();
  if (!text) return { entries: [], strategy: 'empty' };
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

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

  return { entries: trimBackMatter(splitContinuation(lines)), strategy: 'line-with-continuation' };
}

/** Drop figure/table captions that ran on into the last entry (or became entries of their own) */
function trimBackMatter(entries) {
  const out = [];
  for (const e of entries) {
    if (/^(?:Captions\b|List of (?:tables|figures)\b)/i.test(e)) break;
    const m = e.match(BACK_MATTER);
    if (m) { const head = e.slice(0, m.index).trim(); if (head.length > 15) out.push(head); break; }
    out.push(e);
  }
  return out;
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

/** Line-continuation heuristic for unnumbered author-year lists (each entry starts "Surname, X." or "Surname X,") */
function splitContinuation(lines) {
  const entries = [];
  let cur = '';
  const startsEntry = l => /^[\p{Lu}][\p{L}'’\-]+(?:\s+[\p{Lu}][\p{L}'’\-]+)?,?\s+(?:[\p{Lu}]\.?\s*){1,3}[,.&(]/u.test(l) ||
    /^[\p{Lu}][\p{L}'’\-]+,\s+[\p{Lu}]/u.test(l) || /^(?:[\p{Lu}]\.\s?){1,3}[\p{Lu}][\p{L}'’\-]+,/u.test(l);
  for (const line of lines) {
    const curDone = cur && (YEAR_RE.test(cur) || DOI_REGEX.test(cur)) && /[.)\d]$/.test(cur);
    const strongEnd = cur && (YEAR_RE.test(cur) || DOI_REGEX.test(cur)) && /(?:\d[.)]?|10\.\S+)$/.test(cur);
    if (!cur) cur = line;
    else if ((NUMBERED_PREFIX.test(line) && !YEAR_LINE.test(line)) || (startsEntry(line) && (curDone || cur.length > 60)) || (strongEnd && /^[\p{Lu}[]/u.test(line))) {
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
    // "Smith JA" (Vancouver)
    let m = p.match(/^([\p{L}'’\- ]+?)\s+((?:[\p{Lu}]\.?){1,4})$/u);
    if (m) { out.push({ family: m[1], given: m[2] }); continue; }
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
  const yParen = core.match(/\(\s*(1[6-9]\d{2}|20\d{2})[a-z]?(?:,\s*[A-Za-z]+\.?(?:\s+\d{1,2})?)?\s*\)/);
  const yAny = core.match(/(?:^|[\s,;.])(1[6-9]\d{2}|20\d{2})([a-z])?(?=[\s;:,.)]|$)/);
  const yearM = yParen || yAny;
  if (yearM) {
    const y = parseInt(yearM[1], 10);
    if (y <= new Date().getFullYear() + 1) ref.year = y;
    const suf = core.match(new RegExp(`${yearM[1]}([a-z])\\b`));
    if (suf) ref.yearSuffix = suf[1];
  }

  // Volume(issue):pages patterns
  const vip =
    core.match(/(?:vol\.?\s*)?(\d{1,4})\s*\(\s*([\w\-–/ ]{1,12})\s*\)\s*[:,]?\s*(?:pp?\.?\s*)?([A-Za-z]?\d{1,9}(?:\s*[-–—]\s*[A-Za-z]?\d{1,9})?)/i) ||
    core.match(/vol\.?\s*(\d{1,4}),?\s*(?:no\.?|issue)\s*([\w\-–]{1,8}),?\s*(?:pp?\.?\s*)([A-Za-z]?\d{1,6}(?:\s*[-–—]\s*[A-Za-z]?\d{1,6})?)/i) ||
    core.match(/;\s*(\d{1,4})\s*:\s*()([A-Za-z]?\d{1,6}(?:\s*[-–—]\s*[A-Za-z]?\d{1,6})?)/) ||
    core.match(/,\s*(?:vol\.?\s*)?(\d{1,4})\s*()[,:]\s*(?:pp?\.?\s*)?([A-Za-z]?\d{1,6}\s*[-–—]\s*[A-Za-z]?\d{1,6}|e\d{3,8}|\d{4,8})\b/i) ||
    // article-number locators: "372: n71"
    core.match(/\b(\d{1,4})\s*()\s*:\s*([enE][A-Za-z]?\d{1,9})\b/);
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
  ref.firstAuthorSurname = ref.authors[0]?.family || null;
  ref.looksLikeBook = !!ref.looksLikeBook || !!ref.isbn || (/\b(?:press|publisher|publishing|edition|ed\.|eds\.|books?)\b/i.test(core) && !ref.volume);
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
    .split(/,?\s*(?:vol\.?\s*)?\d{1,4}\s*\(|,\s*\d|;|\s(?:1[6-9]|20)\d{2}\b|,\s*(?:vol|no|pp)\b|\.\s+(?:In|Available|Retrieved|Accessed)\b/i)[0]
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

function findReferenceSection(text) {
  const lines = text.split('\n');
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (REF_HEADING.test(lines[i]) && lines[i].trim().length < 40) { start = i; break; }
  }
  if (start === -1) return { body: text, references: '', found: false };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (END_HEADINGS.test(lines[i]) && lines[i].trim().length < 60) { end = i; break; }
  }
  return {
    body: lines.slice(0, start).join('\n'),
    references: lines.slice(start + 1, end).join('\n').trim(),
    found: true
  };
}

const AFFIL_RE = /\b(university|department|dept\.?|institute|faculty|college|hospital|school|centre|center|laborator|pakistan|karachi|lahore|islamabad|e-?mail|corresponding|@)/i;

/** Detect title, authors, affiliations, abstract and keywords from the first page of a manuscript */
function extractManuscriptMeta(text) {
  const head = text.slice(0, 8000);
  const lines = head.split('\n').map(l => l.trim()).filter(Boolean);
  const meta = { title: '', authors: [], affiliations: [], abstract: '', keywords: [] };

  const absIdx = lines.findIndex(l => /^(?:abstract|summary)\b[:.\s]*/i.test(l));
  const skip = l => /^(?:original (?:research )?article|research (?:article|paper)|review article|short communication|case report|manuscript|running title|title:?)$/i.test(l) || /^page \d+/i.test(l);
  const headLines = (absIdx > 0 ? lines.slice(0, absIdx) : lines.slice(0, 12)).filter(l => !skip(l));

  // Labelled title-page lines: "Manuscript ID: …", "Authors: …", "Corresponding author: …", "Running title: …"
  const LABEL = /^(manuscript (?:id|no\.?|number|code)|paper id|submission id|authors?|corresponding authors?|correspondence|e-?mails?|running (?:head|title)|short title|received|accepted|revised|article type|orcid(?: ids?)?)\s*[:\-–]\s*(.*)$/i;
  // Title: first substantial line(s) not looking like authors/affiliations
  let i = 0;
  const titleParts = [];
  while (i < headLines.length && titleParts.join(' ').length < 250) {
    const l = headLines[i].replace(/^title:\s*/i, '');
    if (LABEL.test(l) || AFFIL_RE.test(l) || (titleParts.length && looksLikeAuthorLine(l))) break;
    if (l.split(' ').length >= 3 || titleParts.length) titleParts.push(l);
    i++;
    if (titleParts.length && /[a-z]$/.test(l) === false && l.length < 60) break;
  }
  meta.title = titleParts.join(' ').replace(/\s+/g, ' ').trim();

  for (; i < headLines.length; i++) {
    const l = headLines[i];
    const lab = l.match(LABEL);
    if (lab) {
      const k = lab[1].toLowerCase();
      if (/^(manuscript|paper|submission)/.test(k)) meta.manuscriptCode = lab[2].trim().split(/\s+/)[0] || '';
      else if (/^authors?$/.test(k) && looksLikeAuthorLine(lab[2])) meta.authors.push(...parseAuthorLine(lab[2]));
      continue;
    }
    if (/@/.test(l)) continue;
    if (AFFIL_RE.test(l)) meta.affiliations.push(l.replace(/^[\d*†‡§¹²³⁴⁵⁶⁷⁸⁹,\s]+/, ''));
    else if (looksLikeAuthorLine(l)) meta.authors.push(...parseAuthorLine(l));
  }

  if (absIdx >= 0) {
    const absText = [];
    const first = lines[absIdx].replace(/^(?:abstract|summary)\b[:.\s]*/i, '');
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
  return meta;
}

function looksLikeAuthorLine(l) {
  if (l.length > 400 || /[.:]\s+[a-z]/.test(l)) return false;
  const names = l.replace(/[\d*†‡§¹²³⁴⁵⁶⁷⁸⁹]+/g, '').split(/\s*(?:,|;|\band\b|&)\s*/).filter(Boolean);
  return names.length >= 1 && names.every(n => /^[\p{Lu}][\p{L}.'’\-]*(?:\s+[\p{Lu}][\p{L}.'’\-]*){0,4}$/u.test(n.trim()));
}

function parseAuthorLine(l) {
  return l.replace(/[\d*†‡§¹²³⁴⁵⁶⁷⁸⁹]+/g, '').split(/\s*(?:,|;|\band\b|&)\s*/).map(s => s.trim()).filter(s => s.length > 2).map(n => ({ name: n, ...splitName(n) }));
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

const NAME_TOKEN = "[\\p{Lu}][\\p{L}'’\\-]+(?:\\s(?:van|von|de|der|da|del|di|al|el|ul|ur)\\s[\\p{Lu}][\\p{L}'’\\-]+)?";

/** Find author-year citations: (Smith, 2020), (Smith & Lee, 2019a; Khan et al., 2021), Smith et al. (2020) */
function extractAuthorYearCitations(body) {
  const cites = [];
  const yearList = '((?:1[6-9]\\d{2}|20\\d{2})[a-z]?(?:\\s*,\\s*(?:1[6-9]\\d{2}|20\\d{2})[a-z]?)*)';
  const authorPart = `(${NAME_TOKEN}(?:\\s+et\\s+al\\.?|\\s*(?:&|and)\\s*${NAME_TOKEN})?)`;

  // Parenthetical groups
  for (const m of body.matchAll(/\(([^()]{4,400}?(?:1[6-9]\d{2}|20\d{2})[a-z]?[^()]*?)\)/g)) {
    for (const part of m[1].split(/\s*;\s*/)) {
      const pm = part.replace(/^(?:e\.g\.,?|see|cf\.|also|i\.e\.,?)\s+/i, '').match(new RegExp(`^${authorPart},?\\s+${yearList}`, 'u'));
      if (pm) addAuthorYear(cites, pm[1], pm[2], m, body);
    }
  }
  // Narrative: Smith et al. (2020), Smith and Jones (2019a, 2020)
  for (const m of body.matchAll(new RegExp(`${authorPart}\\s+\\(${yearList}\\)`, 'gu'))) addAuthorYear(cites, m[1], m[2], m, body);
  return cites;
}

function addAuthorYear(cites, authorStr, years, m, body) {
  const etAl = /et\s+al/i.test(authorStr);
  const names = authorStr.replace(/\s+et\s+al\.?/i, '').split(/\s*(?:&|\band\b)\s*/).map(s => s.trim()).filter(Boolean);
  if (/^(?:In|The|This|These|Table|Figure|Fig|Eq|Section|Chapter|Since|From|During|Between|After|Before|Until|January|February|March|April|May|June|July|August|September|October|November|December|Spring|Summer|Autumn|Winter)$/i.test(names[0])) return;
  for (const y of years.split(/\s*,\s*/)) {
    const ym = y.match(/^(\d{4})([a-z]?)$/);
    if (!ym) continue;
    cites.push({
      authors: names, etAl, year: parseInt(ym[1], 10), suffix: ym[2] || '',
      text: m[0].slice(0, 160), index: m.index, para: paraNo(body, m.index),
      context: body.slice(Math.max(0, m.index - 80), m.index + m[0].length + 40).replace(/\s+/g, ' ')
    });
  }
}

module.exports = {
  DOI_REGEX, repairText, extractDocument, parseBibtex, parseRis, splitReferences, parseReferenceEntry,
  parseAuthors, findReferenceSection, extractManuscriptMeta, extractNumericCitations, extractAuthorYearCitations,
  expandRange, splitSentences
};
