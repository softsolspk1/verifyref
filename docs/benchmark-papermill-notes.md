# Paper Mill Detection - what the benchmark found and what changed

Benchmark: `node scripts/benchmark-papermill.js 150` (150 papers retracted for paper-mill reasons vs 126 matched
ordinary papers, text signals only). Full tables: `docs/benchmark-papermill.md`. Re-score the same papers after a code
change with `node scripts/benchmark-papermill.js 150 --rescore`.

| Version | Retracted flagged MEDIUM+ | Controls flagged MEDIUM+ |
|---|---|---|
| First benchmark | 57/150 (38.0%) | 39/126 (31.0%) |
| After fixing "hidden text" and the methods weight | 6/150 (4.0%) | 2/126 (1.6%) |
| After ICLAC register (598 cell lines) and suspect typos | 7/150 (4.7%) | 2/126 (1.6%) |

## Defects the benchmark exposed (now fixed)
- **Hidden text** treated every word that mixed Latin and Greek letters as a disguise. In science that is normal
  (TNFα, ΔΔCt, NF-κB, SIRPα): it fired on 38% of retracted and 33% of ordinary papers and nothing else. It now flags
  Cyrillic letters and Greek *look-alike capitals* inside Latin words, and ignores soft hyphens (ordinary typesetting).
- **Methods gaps** fired on about 75% of both groups and could lift any paper to MEDIUM on their own. Their weight is
  now 1 in total.

## What the numbers mean
- Text signals alone catch few retracted papers (about 5%): most mill papers read cleanly. They are useful as one
  input beside reference, author and image evidence, not as a verdict.
- The signals that do separate the groups: tortured phrases (8 vs 2) and misidentified cell lines (11 vs 2).
- The fixes were chosen on principle (what a disguise is), not by fitting thresholds, but they were evaluated on the
  same papers that exposed them. Run a fresh sample (`node scripts/benchmark-papermill.js 150`) to check.
- With a realistic 2% share of mill papers, a MEDIUM/HIGH flag from the text signals alone is mostly a false alarm:
  report it as "worth a look", never as a finding.

## Reference and ORCID signals (added 30 Oct 2026)

`node scripts/benchmark-papermill-refs.js [--titles]` scores the same 150 + 126 papers on their reference lists (read
from the cached JATS files) against Retraction Watch (`data/public-images/retractionwatch.csv`).

| Signal | Mill-retracted | Control |
|---|---|---|
| References to journals with >= 20 paper-mill retractions: >= 3 refs and >= 15% of the list (low, weight 1) | 16/150 | 3/126 |
| Same, >= 5 refs and >= 20% (medium, weight 2) | 9/150 | 1/126 |
| Cites a paper retracted for paper-mill reasons (already in Module 4) | 8/150 | 2/126 |
| Cites 2+ such papers | 4/150 | 0/126 |
| Title similarity >= 0.6 to a paper-mill-retracted title (**not used**) | 9/150 | 4/126 |

- **Mill-affected journals** (spec 4.2) is now a Module 4 signal (`mill-journals`). The journal index is computed from
  the Retraction Watch table on each server (85 journals at the 20-retraction threshold), so it follows the daily
  Retraction Watch refresh. Abbreviated journal names in reference lists are matched word by word to the full names.
  Legitimate pharmacy papers cite several of these journals (e.g. Evid Based Complement Alternat Med, Oxid Med Cell
  Longev), so only a reference list built largely on them counts, and the weight is low.
- **ORCID + Retraction Watch** (spec 4.3 "by name + ORCID"): the DOIs on every ORCID record given in the manuscript are
  matched exactly against Retraction Watch (`orcid-mill-retraction`, `orcid-retraction`). This is identity-confirmed,
  unlike the name match, and a paper found this way is not counted again by the name match. It cannot be benchmarked on
  these papers (the retracted papers' ORCID records were not collected).
- **Title templates** were tested and rejected: mill titles are formulaic, but so are ordinary titles in the same
  journals, and the separation (about 2:1 at 0.6, none above 0.7) is too weak to show editors.
- Same caveat as above: thresholds were chosen on these papers; with mill papers at about 2% of submissions, the low
  level of this signal is a pointer, not a finding.

## Journal-list signals (2026-10-31)

`node scripts/benchmark-papermill-refs.js --lists` on the same 150 paper-mill retractions and 126 ordinary papers, with the
lists loaded on 2026-10-31 (Retraction Watch Hijacked Journal Checker, Problematic Paper Screener citejacked list, Elsevier's
Scopus discontinued titles of September 2026, Beall's list):

| Signal | Mill-retracted | Control |
|---|---|---|
| Cites a citejacked journal (Problematic Paper Screener) | 0/150 | 0/126 |
| Cites a journal discontinued by Scopus, after coverage ended | 6/150 | 6/126 |
| 3+ such references (Scopus discontinued) | 1/150 | 0/126 |
| Cites a journal with a known hijacked clone (name match) | 4/150 | 10/126 |
| Cites a journal on Beall's list | 15/150 | 8/126 |

Consequences in Module 4: one or two Scopus-discontinued references carry no weight (shown for information), three or more
weigh 1; a hijacked-clone match by journal name only carries no weight ("check that the article comes from the genuine
journal") - only a reference link on a clone website counts as a hijacked-journal reference; citejacked references stay a
signal (the screener's own detector) although none occurred in this sample.
