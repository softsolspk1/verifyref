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

## Candidate signals screened on 2026-11-02 (none adopted)

The 276 benchmark papers (150 paper-mill retractions, 126 ordinary papers from the same journals and years) were split
in two halves by PMC number; a signal had to separate the groups in both halves.

| Candidate | Half A: mill / control | Half B: mill / control | Decision |
|---|---|---|---|
| Fewer than 30 references | 35/70 / 8/64 | 31/80 / 16/62 | not stable across halves |
| Fewer than 30 references and no ORCID iD | 23/70 / 6/64 | 22/80 / 9/62 | not used: both are common in ordinary PJPS submissions, so most flags would be honest papers |
| Accepted within 45 days | 14/70 / 4/64 | 13/80 / 7/62 | not stable; not known at submission anyway |
| No funding / "none" | 51/70 / 40/64 | 59/80 / 43/62 | no separation |
| No ORCID iD for any author | 46/70 / 39/64 | 57/80 / 37/62 | no separation |
| Hospital affiliation | 54/70 / 40/64 | 51/80 / 36/62 | no separation |
| Data available only on request | 34/70 / 25/64 | 45/80 / 25/62 | weak |
| "Proliferation, migration and invasion" | 10/70 / 3/64 | 12/80 / 4/62 | already a signal (template wording) |
| Same wording + Chinese free-mail domain | 10/70 / 2/64 | 10/80 / 2/62 | not used: it singles authors out by country of their e-mail provider |
| ceRNA / "sponge" axis | 2/70 / 3/64 | 10/80 / 2/62 | not stable |

Text and metadata alone stay weak at telling paper-mill papers apart; the reference, author (ORCID, retractions,
watchlist) and image evidence carry most of the weight.

## Look-alike signal and papermill.txt candidates (2026-11-04)

Measured on the same 276 papers, set on one half (even PMC numbers) and checked on the other.

**Adopted - title + abstract against known mill products** (`mill-lookalike`, the approach of Clear Skies' Papermill
Alarm). The manuscript's title + abstract is compared (TF-IDF, words and two-word phrases) with the title + abstract of
13,447 papers Retraction Watch lists as retracted for paper-mill reasons (abstracts from OpenAlex,
`scripts/load-mill-abstracts.js`, file `data/papermill/mill-abstracts.json.gz`, copied from R2 by the servers). The
paper's own record is left out. `node scripts/benchmark-papermill-lookalike.js`:

| Closest mill retraction | Half A mill / ordinary | Half B mill / ordinary | All |
|---|---|---|---|
| >= 0.14 (low, weight 2) | 17/70 / 2/64 | 25/80 / 5/62 | 42/150 / 7/126 |
| >= 0.17 (medium, weight 3) | 7/70 / 0/64 | 9/80 / 3/62 | 16/150 / 3/126 |
| >= 0.20 (medium, weight 4) | 4/70 / 0/64 | 4/80 / 0/62 | 8/150 / 0/126 |

Added to the text signals: MEDIUM or HIGH for **38/150 mill papers (was 24/150)** and 3/126 ordinary papers (was 2/126;
the new one is a network-pharmacology study of a traditional-medicine decoction). Without the abstracts file the title
alone is compared (>= 0.5: 15/150 vs 4/126, weight 1; >= 0.6 or 3 look-alikes: weight 2).
Caveat: the benchmark mill papers' sister papers from the same special issues are in the index; most were retracted after
these papers appeared. Counting only retractions dated before each paper's publication, the separation nearly vanishes
(>= 0.2: 1/150 vs 0/126). For a new submission the index holds every mill retraction to date, so the signal finds new
output of the mills already exposed, not of new mills.

**Measured and not adopted** (no stable separation in both halves):

| Candidate (papermill.txt) | Half A mill / ordinary | Half B mill / ordinary |
|---|---|---|
| >= 30% of references share no content word with the title / abstract ("irrelevant citations") | 3/70 / 2/64 | 5/80 / 1/62 |
| 3+ references on off-domain subjects (computing, education, economics ...) in a non-technical paper | 2/70 / 6/64 | 4/80 / 1/62 |
| 60%+ of references from the 3 years before the paper | 9/70 / 3/64 | 12/80 / 6/62 |
| Reference titles narrowly alike (mean overlap >= 0.2) | 8/70 / 6/64 | 11/80 / 7/62 |
| Title words missing from the body ("buzzwords without follow-through"), 2+ | 9/70 / 7/64 | 10/80 / 6/62 |
| Percentages in the abstract not found in the body, 2+ | 4/70 / 0/64 | 1/80 / 2/62 |
| Outside the journal's scope (no pharmaceutical / biomedical subject) | 24/150 / 28/126 (all) | |

Out of scope is shown to the editor with weight 0 (`out-of-scope`): an editorial question, not evidence of a mill here.
The cover-letter checks (`cover-*`) and waves of same-template submissions by other authors (`submission-wave`) cannot be
benchmarked on published papers (no cover letters, no PJPS submission stream); they carry low weights (1-2).

## Whole module and new candidate signals (2026-11-06)

`scripts/benchmark-papermill-combined.js` scores the module as the live tool does: text signals, look-alike and the
reference signals added up into one risk level. 150 mill papers / 126 ordinary papers, MEDIUM or HIGH:

| Scoring | Half A mill / ordinary | Half B mill / ordinary | All |
|---|---|---|---|
| Text signals only | | | 24/150 vs 2/126 |
| All measurable signals (before 6 Nov) | 24/70 vs 2/64 | 22/80 vs 4/62 | 46/150 vs 6/126 |
| One cited mill retraction = weight 2, not HIGH (adopted) | 24/70 vs 1/64 | 22/80 vs 4/62 | 46/150 vs 5/126 |

45 of the 104 mill papers still LOW have no signal at all. Candidates measured on the cached full texts
(`scripts/explore-papermill-features.js`, `scripts/benchmark-papermill-meaning.js`), none adopted:

| Candidate | Mill | Ordinary | Why not |
|---|---|---|---|
| All author e-mails free-mail | 35/150 | 36/126 | no separation |
| Chinese free-mail (163, qq, 126 ...) | 34/150 | 27/126 | no separation |
| Half the references share < 2 topic words with the paper | 5/150 | 4/126 | no separation |
| Fewer than 25 references | 38/150 | 16/126 | half A 21/70 vs 4/64 but half B 17/80 vs 12/62 |
| Data "available upon request" | 84/150 | 52/126 | weak (likelihood ratio about 1.3) |
| Meaning look-alike: 3+ mill retractions at cosine >= 0.7 (all-MiniLM-L6-v2, 13,417 mill abstracts) | 24/150 | 4/126 | alone it separates (both halves), but added to the module: 48/150 vs 8/126 (+2 mill, +3 false alarms) - it finds mostly the papers the word look-alike already finds |

The meaning index (`scripts/build-mill-embeddings.js`, data/papermill/mill-embeddings.*) and `millIndex.meaningLookalikes`
are kept for later tests; the live tool does not use them.
