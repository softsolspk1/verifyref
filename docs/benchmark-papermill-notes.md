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
