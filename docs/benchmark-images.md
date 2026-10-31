# Module 5 Image Integrity - benchmark on BioFors

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

| Task | Flagged (positives) | Flagged (negatives) | "Strong" on negatives |
|---|---|---|---|
| Cloned area (IDD) | 26 / 78 (33%), located correctly in 23 | 26 / 231 (11%) | 4 |
| Cut / sharp transition (CSTD) | 15 / 121 (12%) | 15 / 140 (11%) | 0 |

Splicing (cut / sharp transition) is not separated from ordinary images by the current detectors: these reports are shown as
"to check" only and should be read as indicators. Cloned-area detection finds about a third of the annotated cases.

## Limits

- BioFors annotations are not exhaustive: some "reports outside the annotation" are real duplicates.
- The engine runs in the editor's browser; figures are never sent to an outside service, so the commercial databases of all
  published figures (ImageTwin, Proofig) are not searched. The PJPS reference databases are: published PJPS papers,
  open-access papers retracted or corrected for image problems, PubMed Central and publisher open-access figures, and the
  RSIID / BioFors / BINDER research datasets.
- End-to-end check on real data: `node test/images-report-e2e.mjs` (a figure of a paper retracted for image problems,
  re-used mirrored in a test manuscript, must give a "Strong" internal duplicate, the retracted source from the reference
  database, and the Word / PDF report with the image pairs).
