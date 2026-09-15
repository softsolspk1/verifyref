// verifier.js - Reference Parsing & Verification Engine
const https = require('https');

// In-memory cache for CrossRef and Handle API results
const cache = new Map();

// Regex patterns
const DOI_REGEX = /10\.\d{4,9}\/[^\s"'<>,]*[^\s"'<>.,;:]/i;
const NUMBERED_PREFIX_REGEX = /^\s*(?:\[\d{1,4}\]|\(\d{1,4}\)|\d{1,4}[.)])\s+/;
const BULLET_PREFIX_REGEX = /^\s*[•▪·*-]\s+/;

/**
 * Clean and normalize text
 */
function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/^\ufeff/, '')
    .trim();
}

/**
 * Split raw bibliography text into individual reference items
 */
function splitReferences(rawText, strategy = 'auto') {
  const text = cleanText(rawText);
  if (!text) return { entries: [], strategy: 'empty' };

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  if (strategy === 'one-per-line') {
    return { entries: lines, strategy: 'one-per-line' };
  }

  if (strategy === 'blank-line') {
    const entries = text
      .split(/\n\s*\n+/)
      .map(e => e.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    return { entries, strategy: 'blank-line' };
  }

  if (strategy === 'numbered') {
    return { entries: splitByNumbered(text), strategy: 'numbered' };
  }

  // AUTO DETECTION
  // Check if numbered or bulleted in at least 2 lines
  const numberedLinesCount = lines.filter(l => NUMBERED_PREFIX_REGEX.test(l) || BULLET_PREFIX_REGEX.test(l)).length;
  if (numberedLinesCount >= 2) {
    return { entries: splitByNumbered(text), strategy: 'numbered' };
  }

  // Check blank line splitting
  const blankLineEntries = text
    .split(/\n\s*\n+/)
    .map(e => e.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  if (blankLineEntries.length >= 2) {
    return { entries: blankLineEntries, strategy: 'blank-line' };
  }

  // Line continuation heuristic
  const continuationEntries = splitByLineContinuation(text);
  return { entries: continuationEntries, strategy: 'line-with-continuation' };
}

function splitByNumbered(text) {
  const lines = text.split('\n');
  const entries = [];
  let current = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (NUMBERED_PREFIX_REGEX.test(trimmed) || BULLET_PREFIX_REGEX.test(trimmed)) {
      if (current.trim()) {
        entries.push(current.trim());
      }
      current = trimmed;
    } else {
      current += current ? ' ' + trimmed : trimmed;
    }
  }

  if (current.trim()) {
    entries.push(current.trim());
  }
  return entries;
}

function splitByLineContinuation(text) {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  const entries = [];
  let current = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!current) {
      current = trimmed;
      continue;
    }

    // Determine if line is continuation or new entry
    const isNewEntry =
      NUMBERED_PREFIX_REGEX.test(trimmed) ||
      BULLET_PREFIX_REGEX.test(trimmed) ||
      (!/^[a-z(]/i.test(trimmed) &&
        !/^(?:pp?\.|vol|no\.|doi|https?:|pages?)/i.test(trimmed) &&
        (/\b(?:1[7-9]|20)\d{2}\b/.test(current) || DOI_REGEX.test(current) || current.length > 90));

    if (isNewEntry) {
      entries.push(current);
      current = trimmed;
    } else {
      current += ' ' + trimmed;
    }
  }

  if (current) {
    entries.push(current);
  }
  return entries;
}

/**
 * Extract fields from reference string
 */
function parseReferenceEntry(raw, index) {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  
  // Extract DOI
  const doiMatch = cleaned.match(DOI_REGEX);
  let doi = null;
  let doiAsWritten = null;

  if (doiMatch) {
    let extracted = doiMatch[0].trim();
    while (extracted && '.,;:)}]'.includes(extracted[extracted.length - 1])) {
      extracted = extracted.slice(0, -1);
    }
    if (/^10\.\d{4,9}\/.+/i.test(extracted)) {
      doi = extracted.toLowerCase();
      doiAsWritten = extracted;
    }
  }

  // Extract Year (e.g., (2019) or 2019)
  let year = null;
  const yearInParen = cleaned.match(/\(\s*((?:1[7-9]|20)\d{2})[a-z]?\s*\)/);
  if (yearInParen) {
    year = parseInt(yearInParen[1], 10);
  } else {
    const yearMatch = cleaned.match(/\b((?:1[7-9]|20)\d{2})[a-z]?\b/);
    if (yearMatch) {
      const y = parseInt(yearMatch[1], 10);
      if (y <= new Date().getFullYear() + 2) {
        year = y;
      }
    }
  }

  // Extract First Author Surname
  let firstAuthorSurname = null;
  let textWithoutPrefix = cleaned
    .replace(NUMBERED_PREFIX_REGEX, '')
    .replace(BULLET_PREFIX_REGEX, '');

  if (year) {
    const yearIdx = textWithoutPrefix.search(new RegExp(`\\(?\\s*${year}`));
    if (yearIdx > 0) {
      textWithoutPrefix = textWithoutPrefix.slice(0, yearIdx);
    }
  }

  const authorSegment = textWithoutPrefix.slice(0, 140).split(/[,;&]|\band\b/i)[0]?.trim();
  if (authorSegment) {
    const cleanedAuthor = authorSegment.replace(/[^\p{L}'’-]/gu, ' ').trim();
    const parts = cleanedAuthor.split(/\s+/).filter(p => p.length > 1 && !/^[A-Z]\.?$/.test(p));
    if (parts.length > 0) {
      // Typically surname is first in APA "Smith, J." or last in Nature "J. Smith"
      firstAuthorSurname = parts[0];
    }
  }

  return {
    index,
    raw: cleaned,
    doi,
    doiAsWritten,
    year,
    firstAuthorSurname
  };
}

/**
 * Helper to make HTTPS requests with User-Agent & timeout
 */
function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'ReferenceVerifierPortal/1.0 (mailto:admin@referenceverifier.org)',
        'Accept': 'application/json',
        ...(options.headers || {})
      },
      timeout: options.timeout || 12000
    };

    const req = https.request(reqOptions, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve({ ok: true, status: res.statusCode, data: JSON.parse(data) });
          } catch (e) {
            resolve({ ok: false, status: res.statusCode, error: 'Invalid JSON response' });
          }
        } else {
          resolve({ ok: false, status: res.statusCode, data: null });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 408, error: 'Request timeout' });
    });

    req.on('error', err => {
      resolve({ ok: false, status: 500, error: err.message });
    });

    req.end();
  });
}

/**
 * Check DOI in global Handle Registry
 */
async function checkDoiHandle(doi) {
  const cacheKey = `handle:${doi}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const res = await fetchJson(`https://doi.org/api/handles/${encodeURIComponent(doi)}`);
    // responseCode 1 = SUCCESS (exists in global handle system)
    // responseCode 100 = HANDLE_NOT_FOUND (does not exist anywhere)
    const exists = res.ok && res.data && res.data.responseCode === 1;
    const result = { exists, responseCode: res.data?.responseCode };
    cache.set(cacheKey, result);
    return result;
  } catch (err) {
    return { exists: false, error: err.message };
  }
}

/**
 * Query CrossRef for DOI metadata
 */
async function lookupCrossRefByDoi(doi) {
  const cacheKey = `crossref:${doi}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const res = await fetchJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
    if (res.ok && res.data && res.data.message) {
      cache.set(cacheKey, { found: true, work: res.data.message });
      return { found: true, work: res.data.message };
    }
    return { found: false, status: res.status };
  } catch (err) {
    return { found: false, error: err.message };
  }
}

/**
 * Query CrossRef Bibliographic search when no DOI is provided
 */
async function searchCrossRefBibliographic(rawText) {
  const cacheKey = `search:${rawText.slice(0, 100)}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const query = encodeURIComponent(rawText.slice(0, 250));
    const res = await fetchJson(`https://api.crossref.org/works?query.bibliographic=${query}&rows=1`);
    if (res.ok && res.data && res.data.message && res.data.message.items?.length > 0) {
      const topItem = res.data.message.items[0];
      const result = { found: true, item: topItem, score: topItem.score };
      cache.set(cacheKey, result);
      return result;
    }
    return { found: false };
  } catch (err) {
    return { found: false, error: err.message };
  }
}

/**
 * Fallback to DataCite API for datasets and other registries
 */
async function lookupDataCiteByDoi(doi) {
  const cacheKey = `datacite:${doi}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const res = await fetchJson(`https://api.datacite.org/dois/${encodeURIComponent(doi)}`);
    if (res.ok && res.data && res.data.data) {
      const attrs = res.data.data.attributes || {};
      const result = {
        found: true,
        work: {
          title: [attrs.titles?.[0]?.title || 'Registered Dataset / Publication'],
          'container-title': [attrs.publisher || 'DataCite Registry'],
          issued: { 'date-parts': [[attrs.publicationYear || null]] },
          author: (attrs.creators || []).map(c => ({ family: c.name || c.familyName, given: c.givenName })),
          DOI: doi
        }
      };
      cache.set(cacheKey, result);
      return result;
    }
    return { found: false };
  } catch (err) {
    return { found: false };
  }
}

/**
 * Detect retractions, expressions of concern, corrections
 */
function inspectRetractions(work) {
  const notices = [];
  let isRetracted = false;

  // 1. CrossRef update-to field
  if (Array.isArray(work['update-to'])) {
    for (const update of work['update-to']) {
      const type = (update.type || '').toLowerCase();
      const label = (update.label || '').toLowerCase();
      if (type.includes('retraction') || label.includes('retraction')) {
        isRetracted = true;
        notices.push({
          type: 'Retraction',
          label: update.label || 'Retracted',
          doi: update.DOI,
          source: update.source || 'CrossRef / Retraction Watch'
        });
      } else if (type.includes('correction') || label.includes('correction')) {
        notices.push({
          type: 'Correction',
          label: update.label || 'Correction published',
          doi: update.DOI
        });
      } else if (type.includes('concern')) {
        notices.push({
          type: 'Expression of Concern',
          label: update.label || 'Expression of Concern',
          doi: update.DOI
        });
      }
    }
  }

  // 2. Relation field (e.g. is-retracted-by)
  if (work.relation) {
    if (work.relation['is-retracted-by']) {
      isRetracted = true;
      notices.push({
        type: 'Retraction',
        label: 'Retracted article',
        doi: work.relation['is-retracted-by'][0]?.id
      });
    }
  }

  // 3. Title check for explicit RETRACTED banner
  const title = (work.title?.[0] || '');
  if (/^(?:RETRACTED|WITHDRAWN|RETRACTION|EXPRESSION OF CONCERN)[\s:]+/i.test(title)) {
    isRetracted = true;
    if (!notices.some(n => n.type === 'Retraction')) {
      notices.push({
        type: 'Retraction',
        label: 'Marked as Retracted in official registry title',
        source: 'Publisher record'
      });
    }
  }

  return { isRetracted, notices };
}

/**
 * Detect discrepancies between citation text and registered metadata
 */
function detectDiscrepancies(parsedRef, work) {
  const discrepancies = [];
  const notes = [];

  // 1. Publication Year Check
  const regYear =
    work.issued?.['date-parts']?.[0]?.[0] ||
    work['published-print']?.['date-parts']?.[0]?.[0] ||
    work['published-online']?.['date-parts']?.[0]?.[0] ||
    null;

  if (parsedRef.year && regYear) {
    const diff = Math.abs(parsedRef.year - regYear);
    if (diff > 1) {
      discrepancies.push({
        field: 'year',
        severity: 'high',
        message: `Publication year discrepancy: citation states ${parsedRef.year}, but registry record is ${regYear}.`,
        cited: String(parsedRef.year),
        registered: String(regYear)
      });
    } else if (diff === 1) {
      notes.push(`Minor year variance (citation ${parsedRef.year} vs registry ${regYear}) likely due to advance online vs print date.`);
    }
  }

  // 2. Author Surname Check
  const regAuthors = work.author || [];
  const familyNames = regAuthors
    .map(a => (a.family || a.name || '').trim().toLowerCase())
    .filter(Boolean);

  if (parsedRef.firstAuthorSurname && familyNames.length > 0) {
    const citedAuthor = parsedRef.firstAuthorSurname.toLowerCase();
    const matchesAny = familyNames.some(fam => fam.includes(citedAuthor) || citedAuthor.includes(fam));

    if (!matchesAny) {
      const primaryAuthor = regAuthors[0]?.family || regAuthors[0]?.name || 'Unknown';
      discrepancies.push({
        field: 'author',
        severity: 'high',
        message: `Author discrepancy: citation specifies '${parsedRef.firstAuthorSurname}', but registered first author is '${primaryAuthor}'.`,
        cited: parsedRef.firstAuthorSurname,
        registered: primaryAuthor
      });
    }
  }

  // 3. Title sanity check
  const regTitle = (work.title?.[0] || '').toLowerCase();
  const rawLower = parsedRef.raw.toLowerCase();

  // Extract potential distinctive title keywords (words with length > 5)
  const regKeywords = regTitle.replace(/[^\p{L}0-9\s]/gu, ' ').split(/\s+/).filter(w => w.length > 5);
  if (regKeywords.length >= 3) {
    const matches = regKeywords.filter(kw => rawLower.includes(kw));
    const ratio = matches.length / regKeywords.length;
    if (ratio < 0.25) {
      discrepancies.push({
        field: 'title',
        severity: 'medium',
        message: `Title or citation mismatch: The cited text does not appear to match the registered title ('${work.title?.[0]}'). Possible wrong DOI attached.`,
        cited: '(text in citation)',
        registered: work.title?.[0]
      });
    }
  }

  return { discrepancies, notes, regYear };
}

/**
 * Verify a single reference entry
 */
async function verifyReference(entry) {
  const result = {
    index: entry.index,
    raw: entry.raw,
    doi: entry.doi,
    doiAsWritten: entry.doiAsWritten,
    year: entry.year,
    firstAuthorSurname: entry.firstAuthorSurname,
    status: 'unknown',
    statusLabel: 'Pending',
    tone: 'neutral',
    work: null,
    notices: [],
    discrepancies: [],
    notes: [],
    suggestedDoi: null
  };

  // Case A: Reference includes a DOI
  if (entry.doi) {
    // 1. Try CrossRef
    let crRes = await lookupCrossRefByDoi(entry.doi);

    if (crRes.found && crRes.work) {
      const work = crRes.work;
      const { isRetracted, notices } = inspectRetractions(work);
      const { discrepancies, notes, regYear } = detectDiscrepancies(entry, work);

      const authorsFormatted = (work.author || [])
        .slice(0, 4)
        .map(a => a.family ? `${a.family} ${a.given ? a.given[0] + '.' : ''}` : a.name)
        .join(', ') + ((work.author || []).length > 4 ? ' et al.' : '');

      result.work = {
        title: work.title?.[0] || '(No title recorded)',
        containerTitle: work['container-title']?.[0] || work.publisher || '',
        year: regYear,
        authors: authorsFormatted,
        volume: work.volume,
        issue: work.issue,
        page: work.page,
        doi: entry.doi,
        url: `https://doi.org/${entry.doi}`
      };
      result.notices = notices;
      result.discrepancies = discrepancies;
      result.notes = notes;

      if (isRetracted) {
        result.status = 'retracted';
        result.statusLabel = 'Retracted';
        result.tone = 'bad';
      } else if (discrepancies.length > 0) {
        result.status = 'discrepancy';
        result.statusLabel = 'Check details';
        result.tone = 'warn';
      } else {
        result.status = 'verified';
        result.statusLabel = 'Verified';
        result.tone = 'good';
      }
      return result;
    }

    // 2. Not in CrossRef? Try DataCite
    let dcRes = await lookupDataCiteByDoi(entry.doi);
    if (dcRes.found && dcRes.work) {
      const work = dcRes.work;
      const { discrepancies, notes, regYear } = detectDiscrepancies(entry, work);

      result.work = {
        title: work.title?.[0] || 'Registered Dataset / Artifact',
        containerTitle: work['container-title']?.[0] || 'DataCite Registry',
        year: regYear,
        authors: (work.author || []).map(a => a.family).join(', '),
        doi: entry.doi,
        url: `https://doi.org/${entry.doi}`
      };
      result.discrepancies = discrepancies;
      result.notes = notes;
      result.status = discrepancies.length > 0 ? 'discrepancy' : 'verified';
      result.statusLabel = discrepancies.length > 0 ? 'Check details' : 'Verified (DataCite)';
      result.tone = discrepancies.length > 0 ? 'warn' : 'good';
      return result;
    }

    // 3. Fallback: Check DOI Handle Registry directly
    const handleRes = await checkDoiHandle(entry.doi);
    if (handleRes.exists) {
      result.status = 'not-in-crossref';
      result.statusLabel = 'Registered in other DOI agency';
      result.tone = 'neutral';
      result.notes.push('DOI resolves successfully in the global Handle registry, but full bibliographic metadata is hosted outside CrossRef/DataCite.');
      result.work = {
        title: 'Resolving DOI (External Registry)',
        containerTitle: 'Global DOI Foundation',
        doi: entry.doi,
        url: `https://doi.org/${entry.doi}`
      };
      return result;
    }

    // 4. Failed in both CrossRef and Handle Registry -> Unregistered / AI Hallucination!
    result.status = 'unregistered';
    result.statusLabel = 'Does not resolve';
    result.tone = 'bad';
    result.notes.push('This DOI is not registered with CrossRef, DataCite, or the global DOI Foundation. It may be an AI hallucination or a typo.');
    return result;
  }

  // Case B: Reference has NO DOI -> Search CrossRef bibliographic database
  const searchRes = await searchCrossRefBibliographic(entry.raw);
  if (searchRes.found && searchRes.item) {
    const item = searchRes.item;
    const regYear = item.issued?.['date-parts']?.[0]?.[0];
    const authorsFormatted = (item.author || [])
      .slice(0, 3)
      .map(a => a.family || a.name)
      .join(', ') + ((item.author || []).length > 3 ? ' et al.' : '');

    const { isRetracted, notices } = inspectRetractions(item);

    result.status = isRetracted ? 'retracted' : 'probable-match';
    result.statusLabel = isRetracted ? 'Retracted Match' : 'Probable match';
    result.tone = isRetracted ? 'bad' : 'neutral';
    result.suggestedDoi = item.DOI;
    result.notices = notices;
    result.work = {
      title: item.title?.[0] || '(No title)',
      containerTitle: item['container-title']?.[0] || '',
      year: regYear,
      authors: authorsFormatted,
      doi: item.DOI,
      url: `https://doi.org/${item.DOI}`
    };
    result.notes.push(`Found corresponding publication in CrossRef database with DOI: ${item.DOI}.`);
    return result;
  }

  // No match found
  result.status = 'no-match';
  result.statusLabel = 'Not matched';
  result.tone = 'neutral';
  result.notes.push('No matching record could be identified in public registries. Reference may be an unpublished manuscript, grey literature, or book without DOI.');
  return result;
}

/**
 * Batch verification runner with concurrency limit
 */
async function verifyAllReferences(references, concurrency = 5, onProgress = null) {
  const results = new Array(references.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < references.length) {
      const idx = currentIndex++;
      try {
        const res = await verifyReference(references[idx]);
        results[idx] = res;
      } catch (err) {
        results[idx] = {
          index: references[idx].index,
          raw: references[idx].raw,
          status: 'check-failed',
          statusLabel: 'Check failed',
          tone: 'neutral',
          notes: [err.message]
        };
      }
      if (typeof onProgress === 'function') {
        onProgress(idx + 1, references.length, results[idx]);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, references.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

module.exports = {
  cleanText,
  splitReferences,
  parseReferenceEntry,
  verifyReference,
  verifyAllReferences
};
