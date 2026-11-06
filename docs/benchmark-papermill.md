# Paper Mill Detection - text-signal benchmark

Generated 2026-11-06. 150 papers retracted for paper-mill reasons (Retraction Watch) against 126 ordinary papers from the same journals and years (Europe PMC open access, not in Retraction Watch). Only the offline text signals were scored: the same `textSignals` function the live tool uses.

## Flag rates

| Threshold | Papers flagged | Rate | 95% interval |
|---|---|---|---|
| Retracted papers flagged MEDIUM or HIGH (recall) | 24/150 | 16.0% | 11.0% – 22.7% |
| Retracted papers flagged HIGH | 3/150 | 2.0% | 0.7% – 5.7% |
| Control papers flagged MEDIUM or HIGH (false-positive rate) | 2/126 | 1.6% | 0.4% – 5.6% |
| Control papers flagged HIGH | 0/126 | 0.0% | 0.0% – 3.0% |

Precision when the tool says MEDIUM or HIGH (with this 50/50 sample): 92.3%. In real submissions mill papers are much rarer than 50%, so real-world precision is lower: with 2% mill papers and the rates above, roughly 17.1% of flagged papers would truly be mill papers.

## Which signals fire

| Signal | Retracted | Control |
|---|---|---|
| cell-lines | 11/150 | 2/126 |
| methods | 93/150 | 71/126 |
| mill-template | 24/150 | 5/126 |
| off-scope | 8/150 | 2/126 |
| primers | 1/150 | 0/126 |
| statistics | 1/150 | 1/126 |
| suspect | 2/150 | 1/126 |
| template | 7/150 | 10/126 |
| tortured | 8/150 | 2/126 |

## Control papers flagged (false positives to inspect)

- MEDIUM (4) https://doi.org/10.1155/2021/4979249 - off-scope:medium
- MEDIUM (4) https://doi.org/10.1155/2022/2586711 - off-scope:medium

## Limits of this benchmark

- The Problematic Paper Screener fingerprints were themselves built from papers like these, so the recall figure measures recognition of known cases and overstates performance on new mill output.
- Controls come from the same journals and could contain undiscovered mill papers, which would inflate the false-positive rate slightly.
- Many mill papers are retracted for image, authorship or peer-review reasons that leave no trace in the text; the text signals cannot catch those.
- Only open-access papers could be tested.
