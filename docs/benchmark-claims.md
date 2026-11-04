# Module 3.B claim support - benchmark on SciFact

Run 2026-11-02 with `node scripts/benchmark-claims.js --split train|dev` on SciFact (Wadden et al., EMNLP 2020,
CC BY-NC 2.0): expert-written scientific claims, each paired with the abstract it cites and labelled SUPPORT,
CONTRADICT or NOT ENOUGH INFO (NEI). Each pair goes through the same matcher as the live tool (`src/tools/match.js`),
on the abstract only. Changes were tuned on the train split; the dev split was not used for tuning.

## Dev split (340 claim-abstract pairs, held out)

| Label \ verdict | Full | Partial | Contradicts | Not supported |
|---|---|---|---|---|
| SUPPORT (138) before | 32 | 54 | 6 | 46 |
| SUPPORT (138) after | 31 | 52 | 9 | 46 |
| CONTRADICT (71) before | 10 | 19 | 7 | 35 |
| CONTRADICT (71) after | 9 | 17 | 10 | 35 |
| NEI (131) before / after | 3 | 16 | 3 | 109 |

- A claim with no evidence in the abstract passes as "Full support" in 2% of cases.
- 60% of supported claims are found (Full or Partial) from the abstract alone; the full text, when available, finds more.
- A contradicted claim passes as "Full support" in 13% of cases (was 14%) and is flagged as contradicted in 14% (was 10%).

What changed: the direction of the effect is now read next to the terms the claim and the source share ("X impedes Y"
against "X promotes Y"), not only for the text as a whole. A rule for negated word forms (inaccurate / accurate) was
tried and dropped: on the train split it flagged as many supported claims as contradicted ones.

## 2026-11-03: opposite wording and proportions in words

| | Train before | Train after | Dev (held out) before | Dev after |
|---|---|---|---|---|
| Contradicted claims passed as Full | 27/194 (14%) | 18/194 (9%) | 9/71 (13%) | 9/71 (13%) |
| Contradicted claims flagged | 27 (14%) | 33 (17%) | 10 (14%) | 10 (14%) |
| Supported claims found (Full or Partial) | 213/370 | 213/370 | 83/138 | 83/138 |
| No-evidence claims passed as Full | 3/355 | 3/355 | 3/131 | 2/131 |

What changed: a curated table of opposite wordings about the same subject ("UCP1-dependent" / "UCP1-independent",
"scarce" / "expanded", "immune to" / "hypersensitive", "ineffective" / "improved outcomes", "slows" / "promoted"), and
proportions and amounts written in words ("one in two" against "one in five", "$5 billion" against "$750 million") are
compared like figures. It costs nothing on supported claims. On the held-out dev split the gain is small (one fewer
no-evidence claim passed as Full): the remaining contradictions need an understanding of meaning, which a word-based
matcher does not have.

## Limits

The matcher compares words, numbers, negation and direction of effect; it does not understand meaning. Most remaining
contradictions in SciFact are reversals that need understanding ("enhances p53 function" against "enhanced
suppression of p53"). A local natural-language-inference model would be the next step. Every verdict shows the
evidence passage, so the editor can check it.

## 2026-11-04: a language model reads the passages for meaning

The matcher's three best passages now go to a small natural-language-inference model running on the server
(`Xenova/nli-deberta-v3-xsmall`: DeBERTa-v3 trained on SNLI / MultiNLI, ONNX 8-bit, about 85 MB; `src/tools/nli.js`).
It gives, for each passage, the probability that it states the claim (entailment) or the opposite (contradiction). The
decision rule (thresholds in `RULE`) was fitted on the train split under limits on false alarms (no-evidence claims
passed as Full at most 2%, supported claims called contradicted at most 8%) and measured on the held-out dev split
with `node scripts/benchmark-claims.js --split dev` (`--words` gives the matcher alone).

| | Train before | Train after | Dev (held out) before | Dev after |
|---|---|---|---|---|
| Supported claims found (Full or Partial) | 58% | 71% | 60% (83/138) | **73% (101/138)** |
| Supported claims judged Full | 22% | 32% | 22% (31/138) | 28% (39/138) |
| Contradicted claims flagged as contradicted | 17% | 35% | 14% (10/71) | **27% (19/71)** |
| Contradicted claims passed as Full | 9% | 4% | 13% (9/71) | **1% (1/71)** |
| No-evidence claims passed as Full | 0.8% | 1.7% | 1.5% (2/131) | 2.3% (3/131) |
| Supported claims called contradicted | 5% | 7% | 7% (10/138) | 7% (10/138) |

Dev confusion after (label \ verdict, Full / Partial / Contradicts / Not supported): SUPPORT 39 / 62 / 10 / 27,
CONTRADICT 1 / 18 / 19 / 33, NEI 3 / 17 / 8 / 103.

The larger `nli-deberta-v3-small` (165 MB) was scored the same way and did worse on the held-out split (contradictions
flagged 17%, supported claims judged Full 12%), so the extra-small model is used. About 0.1 s per passage on one CPU
core; Verify Citations lets the model read for up to 3 minutes per manuscript, then the word matcher decides alone.
Every verdict names the model's reading in its notes and quotes the passage it judged on.
