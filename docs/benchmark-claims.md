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

## Limits

The matcher compares words, numbers, negation and direction of effect; it does not understand meaning. Most remaining
contradictions in SciFact are reversals that need understanding ("enhances p53 function" against "enhanced
suppression of p53"). A local natural-language-inference model would be the next step. Every verdict shows the
evidence passage, so the editor can check it.
