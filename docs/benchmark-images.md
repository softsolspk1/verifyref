# Module 5 Image Integrity - benchmark on BioFors

## 2026-11-03: re-saved copies (same command, same 60 papers)

The 80 % rule (version 3.2.9) had lowered detection from 59 % to 52 %. A diagnostic of the 74 annotated pairs still
missed showed that about 62 never become candidates (the hash / keypoint stage does not pair them), and about 6 are
95-99 % identical pictures whose fine noise was wiped, as when one copy was re-saved or compressed again. Those now count
as findings "to check" (never "Strong"), only with structural support: thumbnail noise agreeing (whole image) or at least
20 matching keypoints (partial overlap).

| | Before | After |
|---|---|---|
| Annotated duplicate pairs found | 81 / 155 (52 %) | 87 / 155 (56 %) |
| ... as "Strong" | 49 | 49 |
| Unrelated figures (17,571 pairs): reports | 0 | 0 |
| Reports outside the annotations, "Strong" | 64 | 64 |
| Reports outside the annotations, "to check" | 95 | 103 |
| Cloned areas (IDD) / cut lines (CSTD) | unchanged | unchanged |

The remaining misses need a better candidate stage (pairs the hashes and keypoints never bring together), not a looser
match rule.

Correction, same day: the figures above are from a first version that also accepted whole images on thumbnail noise.
test/image-similarity.mjs showed that this version reports two different blots with the same band layout (99 % alike,
thumbnail "noise" following the bands), so the whole-image part was removed; only partial overlaps with 20+ matching
points remain. The two blot pairs it had recovered are dropped again, so expect about 85 / 155. The re-run of this
version was stopped for lack of memory and is still to be done.

Run 2026-10-31 with `node scripts/benchmark-images.mjs --task all --docs 60 --neg 300` on BioFors (Sabir et al., ICCV 2021,
CC0): real figure panels from published papers with expert (Bik) annotations. Each BioFors image is a single panel, so the
panel-splitting step of the live tool is not exercised here.

## Duplication between panels of one paper (EDD, 60 papers, 155 annotated pairs that could be tested)

| | Before the 2026-10-31 changes (first 40 of these papers) | After (60 papers) |
|---|---|---|
| Annotated duplicate pairs found (any level) | 54 / 102 (53%) | 91 / 155 (59%) |
| ... found as "Strong" | 40 / 102 (39%) | 46 / 155 (30%) |
| "Strong" reports on pairs not in the annotation, per paper | 2.35 | 0.98 |

What changed: a whole-panel match is "Strong" only when the full-resolution picture and its fine noise pattern agree (frames
and borders trimmed); keypoint overlaps must also match pixel by pixel in the matched regions; two views of one microscopy
field in different colour channels (merge / single channel) are never "Strong"; mirrored or rotated blot matches need a
closer noise match. Inspected false alarms that these rules removed: near-black fluorescence channels, blot strips with the
same layout and different bands, a merged image next to its own channel, ultrasound scans sharing the scanner overlay.

Remaining "Strong" reports outside the annotation, inspected: some are real duplicates the annotation does not list (same
blot, same specks); the main false-alarm classes left are flow-cytometry dot plots with similar gates (different percentages
printed on them) and a DAPI field shown plain and as a merge with a faint second channel. These are shown to the editor with
the measured agreement and the image pair, so they can be dismissed in seconds.

## Unrelated panels from different papers (false alarms)

| Image class | Panels | Pairs compared | Reports |
|---|---|---|---|
| Blot / gel | 99 | 4,851 | 0 |
| Microscopy | 160 | 12,720 | 0 (before: 2 "to check") |

## Cloned area inside one image (IDD) and splicing (CSTD)

Second pass on 2026-10-31 (`node scripts/benchmark-images.mjs --task idd|cstd --docs 60 --neg 300 --dump` writes every
report with its measurements to data/benchmark/images-dump.json):

| Cloned area (IDD) | Before | After |
|---|---|---|
| Annotated clones reported | 26 / 78 | 26 / 78 (23 located correctly) |
| ... as Strong | 13 | 12 |
| Clean images reported | 34 / 230 | 29 / 230 |
| ... as Strong | 11 | 3 |

Changes: a keypoint clone needs 13+ agreeing points (annotated clones had 14+, clean images at most 11); a block clone must
share its fine noise (0.55+, Strong from 0.8): repeated membrane / tissue texture matches only in the picture.

| Splicing (CSTD, blots) | Before | After |
|---|---|---|
| Spliced blots reported | 17 / 124 | 15 / 124 (8 located) |
| Clean blots reported | 12 / 151 | 10 / 151 |

A horizontal background step needs 12+ grey levels (clean blots stayed at 11 or below). Vertical steps do not separate
spliced from clean blots (normal lane edges look the same): they stay "to check" indicators. Splicing detection is weak.

## Limits

- BioFors annotations are not exhaustive: some "reports outside the annotation" are real duplicates.
- The engine runs in the editor's browser; figures are never sent to an outside service, so the commercial databases of all
  published figures (ImageTwin, Proofig) are not searched. The PJPS reference databases are: published PJPS papers,
  open-access papers retracted or corrected for image problems, PubMed Central and publisher open-access figures, and the
  RSIID / BioFors / BINDER research datasets.
- End-to-end check on real data: `node test/images-report-e2e.mjs` (a figure of a paper retracted for image problems,
  re-used mirrored in a test manuscript, must give a "Strong" internal duplicate, the retracted source from the reference
  database, and the Word / PDF report with the image pairs).

## Splicing: seam measures tried on 2026-11-02 (not adopted)

Three hand-made measures of a joined blot were tested on BioFors CSTD, split by paper into a tuning half (101 spliced,
1,025 clean blots) and a test half (80 spliced, 490 clean blots):

| Measure | Test half: spliced found | Test half: clean blots flagged |
|---|---|---|
| Straight seam (column jump vs neighbouring columns, ratio 3+) | 65 / 80 | 393 / 490 |
| Change of fine grain (noise) across a column, ratio 2+ | 57 / 80 | 361 / 490 |
| Seam in background-only rows (no band near the column), ratio 6+ | 12 / 80 | 78 / 490 |

None separates spliced from clean blots: ordinary lane edges and blot borders produce the same patterns. The existing
detector (background step of 12+ grey levels, 15 / 124 found, 10 / 151 clean blots flagged) was kept. Better splice
detection needs a model trained on annotated splices; it is not reachable with these measures.

## 380 keypoints per panel (2026-11-06)

ORB keypoints kept per panel raised from 260 to 380 (public/js/images/engine.js, orbCore): a copied area covering a third
of a panel kept too few of them. Measured the same day, same settings (`benchmark-public-images.mjs 60`,
`benchmark-images.mjs --task all --docs 60 --neg 300`):

| Benchmark | 260 | 380 |
|---|---|---|
| Generated partial copy (55% crop) | 18/25 | 22/25 |
| Generated copy-move | 15/25 | 18/25 |
| Generated clean pairs falsely reported | 0/30 | 0/30 |
| BioFors duplicated panels found | 87/155 (56%) | 91/155 (59%) |
| BioFors found as Strong | 49 | 55 |
| BioFors reports not in the annotation (Strong) | 167 (64) | 171 (61) |
| BioFors cloned areas found / clean images reported | 25/78 / 25/231 | 26/78 / 25/231 |
| BioFors unrelated pairs falsely reported | 0/17,571 | 0/17,571 |
| Time, 30-panel manuscript (prepare + compare) | 10.1 s | 12.9 s |

500 keypoints gave the same generated-set results as 380 at a higher cost.
