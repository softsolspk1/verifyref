# PJPS Data Integrity System

**by Softsols Pakistan** — five-module manuscript screening system for the *Pakistan Journal of Pharmaceutical Sciences*, as a web portal and as a Windows desktop application with the same five modules.

The feature set follows [ReferenceVerify](https://referenceverify.com/) (all tools except its integrations and pricing), adapted to PJPS. The proposal is in [`docs/PJPS-Reference-Checker-Proposal.docx`](docs/PJPS-Reference-Checker-Proposal.docx).

## PJPS modules (v4)

The portal is reduced to the five modules the PJPS Editor asked for, plus one Full Screening Report (spec: [`docs/PJPS-Final-4-Modules.txt`](docs/PJPS-Final-4-Modules.txt), proposal: [`docs/PJPS-4-Modules-Proposal.docx`](docs/PJPS-4-Modules-Proposal.docx)). The earlier tools remain in the code base but are switched off in `src/modules.js` (`LEGACY`): they are not shown, not granted, and their API routes refuse access.

| Module | Page | What it does |
|---|---|---|
| **Full Screening Report** (editor) | `#/manuscript` | One upload runs Modules 1, 2 (compliance), 3 (list matching, pattern) and 4, and attaches a Module 5 report if selected. Front-page summary per module and a desk-review recommendation (proceed / return / investigate). Word export: editor version (all modules) and author version (Modules 1–3). Editor decision record. |
| **1 · Check Bibliography** | `#/references` | 13 databases (incl. OpenAlex and CORE) + Retraction Watch; searched automatically for every reference not yet verified: PubMed (title search and the NCBI citation matcher, which finds a paper from journal, year, volume and page when the title is misspelled), Google Books, and — with `SERPAPI_KEY` on the platform (the desktop uses it through the platform) — Google Scholar and Google web search (a report or web page found by Google is verified; a journal article found only on the web is unverified, never “suspicious”); each reference shows what every search found instead of manual search links; Verified / Miscited / Unverified / Suspicious / Retracted with confidence; fabrication checks; link check; regional journals shown as *Not indexed*; reference-age chart against the PJPS rule (Super Admin setting); self-citation, PJPS citations, predatory / hijacked journals, duplicate references (`src/checks/indicators.js`); **Re-check** shows only what changed. **Reference quality (Nov 2026, as Proofig RefGuard):** Quality, Impact, Recency and Diversity scores (0–100) with the facts behind each, compared with the average of earlier PJPS submissions once 10 have been screened; references that are an erratum, editorial, letter, notice or meeting abstract rather than a research paper; the reference list can be sorted by number, seriousness, confidence, year or journal (`src/checks/refQuality.js`). |
| **2 · Reference Style & PJPS Converter** | `#/restyle` | Rule-by-rule PJPS compliance of every reference and in-text citation with the expected form (`src/checks/compliance.js`); conversion to PJPS (or any of 23 styles) with **Word Track Changes** (`Docx.trackChanges()` in `src/ooxml.js`); before/after view. **Journal styles (Nov 2026):** any journal's official Citation Style Language (CSL) style — found by journal name among about 10,900 styles in the Zotero Style Repository, or uploaded as a .csl file — formatted by citeproc-js, the reference CSL processor (`src/csl.js`; locales in `src/csl/`). |
| **3 · Citations** | `#/citations` | A. citations ↔ list (missing, uncited, year, ambiguous, wrong “et al.”, numbering, citation blocks); B. claim support from uploaded PDFs / open-access full text (Europe PMC, Unpaywall, OpenAlex locations, CORE) / abstracts; C. citation pattern; author letter EN/UR (`src/tools/citationsModule.js`). **Nov 2026:** more open full text (Semantic Scholar, arXiv; bioRxiv / medRxiv abstracts), the direction of the effect read next to the shared terms, shared links for claim-check reports; accuracy on SciFact expert-labelled claims in `docs/benchmark-claims.md` (`node scripts/benchmark-claims.js`). **4 Nov 2026:** a small language model runs on the server (DeBERTa-v3 natural-language inference, ONNX 8-bit, about 85 MB, downloaded once into `DATA_DIR/models`; `src/tools/nli.js`) and reads the matcher's three best passages for meaning: on the held-out SciFact split supported claims found rose from 60 % to 73 % and contradictions flagged from 14 % to 27 %, contradicted claims passed as Full fell from 13 % to 1 %. `PJPS_NLI=off` turns it off; without it the word matcher decides alone. `scripts/prune-onnx.js` (postinstall) keeps only this platform's runtime binary. **Nov 2026:** author-year citations with surname particles (*van der Berg*), multi-word surnames (*De Silva*), organisations as authors (*World Health Organization*) and a letter after a lettered year (*2020a, b*) are recognised; before, they were missed and their references reported as uncited (`test/citation-forms.js`). |
| **4 · Paper Mill Detection** (editor) | `#/papermill` | Tortured phrases (Problematic Paper Screener list + editor additions), AI-text leftovers, template wording, vague methods, fabricated and mill-retracted references, predatory journals and journals with many paper-mill retractions, citation stacking, author retractions (Retraction Watch by name, and by DOI from the authors' ORCID records), free-mail, ORCID checks, off-topic affiliations, authorship changes between versions, suggested reviewers, ICLAC misidentified cell lines, duplicate submissions (text fingerprints), hidden / look-alike characters used to defeat plagiarism software, a paper with the same title already published or posted (Crossref, OpenAlex, CORE — journals, preprints, repositories, theses), Module 5 findings by category. LOW / MEDIUM / HIGH with evidence; confidential Word export; decision record (`src/papermill/`). **STM Integrity Hub parity (Nov 2026):** an **editorial watchlist** of e-mail addresses, domains, names, ORCID iDs, institutions, phone numbers and phrases from earlier paper-mill submissions, kept by the editors on the Module 4 page (one by one or pasted in bulk) and matched against every manuscript (`src/papermill/watchlist.js`, signal `watchlist`); an **AI-written-text** indicator (`ai-writing`, low weight, not counted twice in the Integrity Suite); and a **traffic-light overview** of every check — red / amber / green / not checked — on screen and in the Word / PDF (`src/papermill/overview.js`). **Editor's assessment (Nov 2026)** (`src/papermill/assessment.js`): a written summary; how many of the four independent areas of evidence (text, references, authors & submission, data & figures) show moderate or strong signals, since mill products usually show several; screening completeness (checks run, and why the others could not be); the recommended action for the level (continue / clarify before peer review / hold and escalate following COPE's guidance on systematic manipulation); a checklist of what to verify, strongest first; and a neutral **query letter** to the authors that asks for the specific files and explanations without mentioning paper mills. On screen: area tiles and main reasons jump to the evidence, signals can be filtered by strength. |
| **5 · Image Integrity** (editor) | `#/images` | Runs **in the editor's browser** (no large upload — Vercel's 4.5 MB request limit). Four detection groups, as in ImageTwin / Proofig: **a) Duplication & reuse** — whole-panel duplicates in 8 orientations (perceptual hash + correlation), partial / resized / rotated / mirrored copies (ORB + RANSAC), comparison with all earlier PJPS manuscripts via stored fingerprints, and with the **PJPS image databases** (below); **b) Alteration & manipulation** — cloned areas (keypoints + DCT blocks), pasted patches (noise-level and JPEG-grid inconsistency), erased / retouched areas, joined blot lanes (sharp background step), stretched contrast, saturated bands; **c) AI-generated images** — file markers (C2PA, IPTC *trainedAlgorithmicMedia*, generator names, Stable-Diffusion parameters) and statistical traces (spectral peaks, missing or uniform sensor noise); markers are strong evidence, statistics alone are only *indicators*; **d) Graph & chart duplication** — bar heights and curves are read from the chart pixels and compared across charts (re-coloured, re-scaled, reversed) and with earlier manuscripts. Forensic viewer (filters: contrast, error level, noise, edges, false colour, invert; comparison: side by side, overlay and swipe sliders, difference, flicker; zoom; save view), editor marks per finding, query letter, confidential Word report (`public/js/images/engine.js`, `forensics.js`, `src/images.js`). **Match rule (Nov 2026):** two images or areas are reported as the same only when they are **at least 80 % similar** pixel by pixel once aligned (rotation, mirror, scale, crop) **and** share their fine noise pattern, measured at full resolution on flat pixels (edges, bands and clipped white left out). Images of the same kind - western blots with one band layout, micrographs of one stain - look alike but are different photographs: they share the picture (0.98) but not the noise (≈0.0), copies share both (0.6-1.0). Earlier PJPS manuscripts and the image databases follow the same 80 % rule on the aligned thumbnails; without pictures only near-identical fingerprints count. Every match shows its similarity, with the source paper's figure turned to line up with the manuscript panel (`MIN_SIMILARITY` in `public/js/images/engine.js`, `test/image-similarity.mjs`). By PJPS policy figures are checked inside the PJPS system only and are never sent to ImageTwin, Proofig or any other outside service; their commercial databases of published figures are therefore not searched, and the report says so. **ImageTwin / Proofig parity (Nov 2026):** a **confidence score** 0–100 % per finding and match in ImageTwin's bands (Low 0–32 %, hidden by default; Fair 33–65 %; High 66–100 %) with a threshold slider (`src/imageScore.js`); **Adjust panels** before the scan (see, delete, draw, move and resize sub-image boxes, `public/js/images/panelEditor.js`); manipulation findings in three views (original, enhanced, suspicious area close up); forensic viewer with **solarize, background, brightness / contrast, heatmap and matched-keypoint lines**; **AI generator attribution** when a file marker names the generator; **Include in report** per finding (false alarms are left out automatically); report page 1 with scan date and time, overall risk, confidence counts and analysis version, page 2 *External publication matches*; **TIFF, SVG and JFIF** figure files (`public/js/images/tiff.js`); **Shared link** — an expiring (1–30 days), revocable link to the report PDF for Modules 4 and 5, every opening audited. |

### Module 5 image databases

Every figure panel of these papers is fingerprinted the same way as in the browser (64-bit DCT hash; five 75 % crop windows; chart data) with a thumbnail on Cloudflare R2 (`src/imageRefs.js`, tables `image_ref_docs` / `image_refs`). Each Module 5 analysis is compared with all of them — in 8 orientations, as a crop and as an enlargement — and every candidate is verified by correlating the aligned thumbnails (results tab *Published & reference figures*, Word report, Module 4 / Integrity Suite signals).

| Database | Source | Filled by |
|---|---|---|
| Published PJPS papers | article PDFs on pjps.pk (`citation_pdf_url`); figures read straight from the PDF (`src/figureFiles.js`: JPEG / Flate / Indexed / CMYK, strip-stitching) | daily cron (new articles), Admin › Data, `npm run images:index -- --source pjps --from 1` for the whole archive |
| Retracted / corrected for image problems | Retraction Watch reasons naming images + PubMed Central figures (4,055 open-access papers) | Admin › Data, `--source retracted` |
| PubMed Central open access | pharmacy / pharmacology / medicinal-plant papers (≈105,000), newest first, resumes where it stopped | Admin › Data, `--source pmc` |
| RSIID (Recod.ai, CC-BY; incl. BBBC microscopy) | ≈2,300 pristine scientific figures and figure templates from the Zenodo archives in `data/public-images/rsiid` | Admin › Data, `--source rsiid` |
| BioFors (ICCV 2021) | 47,805 panels of 1,031 biomedical papers from `data/benchmark/biofors/biofors.tar`; panels the experts annotated (duplication, cut transitions) are labelled | Admin › Data, `--source biofors` |
| BINDER (Harvard Dataverse, CC0) | near-duplicate patches; the zip needs the Dataverse guestbook, so it is downloaded by hand into `data/public-images/binder/` | Admin › Data, `--source binder` |
| Reference library | PDF / Word / image files uploaded by the Super Admin | Admin › Data, `--file <path> --title …` |

Archives are read file by file (`src/archiveReader.js`), so the 2 GB BioFors tar never has to fit in memory. PubPeer has no bulk download: every match and every retracted case links to the paper's PubPeer page.

### Journal lists (4 Nov 2026)

Admin > Data takes three more uploaded lists: the **Clarivate Web of Science Master Journal List** (SCIE / SSCI / AHCI / ESCI, collection from a column or the file name), **Index Copernicus** (ICV) and **Google Scholar Metrics** (h5-index, h5-median); the journal check shows them under Indexing. The major publisher journal lists add **The Lancet** journals (within Elsevier, by title) and **JAMA Network** (American Medical Association, from the Crossref title list) next to **ACS**: run `npm run datasets:publishers` (needs OpenAlex) to load them.

### PJPS text repository (similarity report)

The in-house counterpart of Turnitin's own database (`src/corpus.js`). Full texts are kept on Cloudflare R2 (`corpus/<kind>/<id>.txt.gz`); the database holds a catalogue (`corpus_docs`) and a fingerprint index (`corpus_hashes`: one in four 5-word sequences), so the documents sharing text with a manuscript are found in one indexed query and only those texts are read from R2. It holds published texts only: every source text the similarity check downloads is kept. Manuscripts are never stored (no repository, as Turnitin's setting for unpublished work); `node scripts/repository-remove-submissions.js [--apply]` removes manuscripts stored before 2 Nov 2026. Fill it in bulk with open-access full texts: `npm run corpus:load -- --limit 2000` (Europe PMC, pharmacy / pharmacology by default, `--query` for another subject; resumes where it stopped). The desktop asks the platform's repository through `/api/sync/corpus/candidates`.

The similarity report itself (`src/checks/plagiarism.js`) follows Turnitin's pattern: Similarity Index with Internet sources / Publications, numbered primary sources adding up to the index, highlighted manuscript text, and Turnitin's filters (bibliography, quotes, matches under 8 words). Like Turnitin it compares every part of the text: the open full texts of papers on the same subject are compared in full, then every remaining 8-word stretch — aligned on the sentences, so a copied sentence always fills a searched stretch — is searched as an exact phrase in Europe PMC (open-access full texts, all PubMed abstracts), in OpenAlex's index of publisher full texts (`OPENALEX_PHRASES` searches per report, default 150, $0.001 each beyond OpenAlex's free daily allowance) and on the web (`WEB_PHRASES`, default 60) with `SERPAPI_KEY`, `BRAVE_API_KEY` (Brave Search, 2,000 free searches a month) or `GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX`. In-text citation markers (`[12]`, `(Smith et al., 2020)`) are ignored on both sides, so a copied sentence whose citation was changed is still one match; a passage found in more than 25 papers (stock wording) is credited to one paper only. A 7,000-word manuscript takes about 4-7 minutes. `test/plagiarism-accuracy.js` measures it against planted copies from a real paper (48.3% planted, 47.9% reported; original text 0%); `test/similarity-engine.js` covers the matching and attribution offline.

**Report view (Nov 2026, `public/js/views/similarity.js`):** the manuscript on the left with every match in its source's colour; the Similarity Index ring, the type breakdown and the primary sources on the right. A source opens to show each match next to the source's own wording (open full texts) with a link to its place in the text; previous / next match; highlight one source only; **All sources** also lists sources whose words were all credited to a larger one. As in Turnitin's viewer the editor can **exclude a source** and **raise the minimum match length** (8-50 words): the index is recomputed in the browser with the same code as the server (`public/js/shared/similarity.js`), and **Save with report** keeps the filters for the report's own **Word / PDF** (`GET /api/checks/:id/similarity?format=docx|pdf`; filters `PATCH /api/checks/:id/similarity`).

**4 Nov 2026, closer to Turnitin's numbers:** the reference list is compared too, as a *Bibliography* section, and quotations are included, as in Turnitin's default filters; the editor excludes either in Filters (*Exclude bibliography*, *Exclude quotes*). Report version 4. The external full-text comparison had been refused by the service on every report (searching its database of submitted documents is only allowed when the manuscript is added to it); it now searches the web and publications only, so the no-storage policy holds, and up to 60 matched sources are read. When OpenAlex's daily search budget is used up, its passage searches stop for the rest of the report and the report says so (add funds at openalex.org/pricing).

**5 Nov 2026, Turnitin's filters and flags (report version 5):** *Exclude bibliography*, *Exclude quotes* and *Exclude small matches* sit in the report toolbar; small matches are not excluded by default, as in Turnitin (matches from 5 words are kept; on 30 open-access pharmacy papers compared with each other, text matched without copying is 6.3% at 5 words against 3.3% at 8). Filters also exclude the abstract, the methods and small sources by word count or percentage. **Flags:** replaced characters (Cyrillic or Greek look-alike letters in Latin words) and hidden zero-width characters are listed, and the comparison reads through them. Each source shows its number of matches; the Word / PDF report adds document details and Turnitin's exclusion settings (On / Off). `test/similarity-turnitin.js`.

**5 Nov 2026, Similarity Report Word / PDF in Turnitin's layout; source reference lists compared:** the downloads follow Turnitin's similarity report page for page - a cover page with the document details, the *Integrity Overview* (overall similarity, *Filtered from the Report*, the four match groups, internet / publications / submitted works, integrity flags), the numbered *Top Sources*, then the manuscript with each match tinted in its source's colour and tagged with its number; every page reads "Page x of n - part" (`src/similarityExport.js`). Turnitin's name, logo and identifiers are not used. Open-access full texts are now compared with their reference lists, tables and figure captions (they were cut off), so the manuscript's bibliography matches the reference lists of papers citing the same works, as in Turnitin; repository copies kept without them are read again. The external full-text comparison runs at its highest sensitivity and reads up to 100 matched sources. **The reference list is matched entry by entry**, as Turnitin matches a bibliography: word sequences matched only each entry's title, because citation styles order authors, year, volume and pages differently (APA in the manuscript, JATS in the sources). An entry is now matched whole to every compared source that lists the same work (its title and first author), else to the cited work's own record (Crossref; books in Open Library or Google Books). On a 29-reference pharmacognosy manuscript the bibliography went from 30% to 98% matched (28 of 29 entries; one university-press manual is in no catalogue) and the in-house Similarity Index from 14.4% to 25.8%, before the external comparison.

**Privacy — the manuscript is never stored or made public.** No repository: the manuscript is not added to the text repository and earlier unpublished PJPS submissions are not compared (Module 4 keeps only irreversible hashes to recognise a resubmission). Only separate 8-word phrases are sent to the search services, never the manuscript, and their answers are cached under a SHA-256 of the query with the public records found — never the phrase or the URL (`private` option of `src/http.js`; before Nov 2026 the phrase searches were cached by URL, so the cache held the manuscript in 8-word pieces for 30 days). The uploaded file is deleted from R2 once read, the job tables drop the manuscript text as soon as a run ends (`src/jobs.js`, desktop `src/queue.js`), and the highlighted text exists only inside the editor's own confidential report, which cannot be opened by a shared link.

### Running from Cloudflare R2

With the `R2_*` variables set, the web platform keeps its working data on R2:

| What | On R2 | In the database |
|---|---|---|
| Uploaded files | every upload goes from the browser straight to R2 (`uploads/…`), whatever its size; the modules read it from there | — |
| Saved reports | full result of every saved check (`reports/<id>.json.gz`, `src/reportStore.js`) | a small stub (kind, meta, summary, risk level, R2 key, reference DOIs for the retraction monitor) |
| Text repository | full texts of submissions and source papers (`corpus/…`) | catalogue and fingerprint index |
| Datasets | the last good source download (`datasets/raw/…`) and a snapshot of every finished lookup table (`datasets/tables/<table>.ndjson.gz`) | the indexed lookup tables, filled from R2 |
| Module 5 image index | fingerprints and chart data of every indexed panel in segment files (`imgindex/seg-….bin`, `…-charts.json.gz`), written after every indexing run; more than 40 segments are merged | one small row per panel (paper, figure label, thumbnail key) and the list of segments (`image_index_segments`) |
| Cached web responses | responses of 2 KB or more, gzipped (`cache/…json.gz`), removed with their row when they expire | the cache row with a pointer; small responses stay in the row |

Existing data is moved with `npm run storage:to-r2` (`-- --dry-run` first; `-- --vacuum` reclaims the space afterwards). Matching against the image index uses multi-index hashing: the same matches as comparing with every panel, but the search time hardly grows with the database.

A new database or server is filled from R2 without contacting any source website: `npm run datasets:rebuild`; the daily refresh also restores a table that was never loaded from its snapshot, and saves a new snapshot after every dataset it reloads (`npm run datasets:snapshot` saves all tables once). Reports saved before this change are moved with `npm run reports:to-r2` (`-- --dry-run` to see what would move). The desktop has no R2: it keeps everything in its local database and reaches the platform's R2 data through the device API.

### Added datasets (Modules 1–5)

All five download automatically through the daily dataset refresh. Each one is saved to R2, synced to the desktop app, and shown on Admin › Data.

| Dataset | Rows | Used by |
|---|---|---|
| Stop Predatory Journals (archived 2018; stored with Beall's list). Acronyms and one-word names are skipped. Not reported for a journal that is active in PMC. | ≈2,500 | Module 1 Journal Check, Module 4 predatory references |
| Problematic Paper Screener **Mathgen** fingerprints (computer-generated mathematics papers) | ≈5,700 | Module 4 SCIgen / Mathgen signal. On the 150 + 126 benchmark it caused no new false alarms. |
| JabRef journal abbreviation lists (CC0). Dotted ISO form only. | ≈26,500 | Module 2 expected abbreviation (after the NLM Catalog, before the LTWA) |
| PubMed Central journal list (NCBI `jlist.csv`, list type `pmc`) | ≈4,500 | Module 1 "PMC" in the indexing line, plus a note for journals that left PMC |
| Papers flagged in integrity audits (Bioengineered paper-mill audit, Zenodo 15671466) | 226 | Module 1 reference notice, Module 3 claims resting on flagged work, Module 4 `flagged-refs` signal (weak weight, not benchmarked). The 188 open-access papers with image problems are added to the Module 5 *retracted / flagged* figure source (`node scripts/fetch-public-image-data.js --flagged-only`). |
| Journals withdrawn from DOAJ (DOAJ change logs, CC BY-SA, list type `doaj_removed`) | ≈7,400 | Module 1 Journal Check. Withdrawal for misconduct or not following best practice is a caution; ceasing or a dead website is noted only; a journal back in DOAJ is not flagged. Not used in Module 4: on the benchmark, ordinary papers cite these journals as often as mill papers do (35/126 vs 35/150). |
| miRBase mature microRNAs | ≈12,500 names | Module 4 `mirna-species`: a microRNA not known in the species studied, such as a human microRNA measured in rats (low weight). `mirna-unknown`: a name not in miRBase (shown, not scored). Neither occurred in the 126 benchmark controls. |

**PJPS subject areas** (`src/subjects.js`): Drug Delivery Systems, Drug Design & Synthesis, Clinical Pharmacology, Pharmacokinetics, Natural Products, Pharmaceutical Analysis, Toxicology, Microbiology, Biotechnology, Pharmacognosy, Immunology, Neuroscience, Pharmacotherapeutics, Nanotechnology, Biopharmaceutics, Pharmacogenomics, Biochemistry, Materials Science and Molecular Modeling. One list drives three datasets:
- **Module 5, PubMed Central figures:** one search band per subject, taking turns with the pharmacy and biomedical bands (`npm run images:index -- --source pmc --band <subject id>`).
- **Module 5, retracted / flagged figures:** papers retracted for paper-mill reasons in these subjects (Retraction Watch "Subject"), even when the notice does not mention images. Mill papers reuse the same blots, micrographs and plots across papers. This adds 7,593 cases, 3,735 of them with PubMed Central figures (`node scripts/fetch-public-image-data.js`).
- **Similarity text repository:** `npm run corpus:load -- --subjects --limit 2000` loads open-access full texts across all subject areas (`--subject <id>` for one).

Stop Predatory Journals is no longer counted in the Module 4 predatory-reference signal. On the benchmark, ordinary papers cited its journals more often (10/126) than mill papers did (5/150). Journal Check still shows it.

### Datasets on Cloudflare R2

`data/` is not deployed; it is mirrored on R2 (`src/datasetStore.js`, catalogue table `dataset_files`): `datasets/files/…` (the data folder: journal lists, ImageTwin / Proofig knowledge base, public image data, RSIID, BioFors, ICLAC, benchmarks), `datasets/raw/…` (the last good download of every refreshable dataset — Retraction Watch, DOAJ, NLM Catalog, Crossref titles, LTWA, Beall, PPS, FDA Orange Book, e-mail domains — used automatically when a source is down) and `datasets/lists/…` (uploaded journal lists). On Vercel the files a module needs are copied from R2 into `/tmp` on first use.

```bash
npm run datasets:push     # upload new / changed files of data/ (streams large archives; skips unpacked copies of stored archives)
npm run datasets:pull     # download data/ from R2 on a new computer or server
node scripts/sync-datasets-r2.js --list
```

## Integrity Suite (v5)

Sixteen research-integrity capabilities. Ten were already covered by the five modules; the rest are new (`src/integrity/`, `src/cases.js`, `src/routes/integrity.js`, `src/routes/apiV1.js`).

| Capability | Where | Status |
|---|---|---|
| Plagiarism & text similarity | Integrity Screening → *Text similarity* (`similarity.js`) | **New**: sentence-level overlap with every earlier submission (only hashes stored), repeated text, tortured phrases / hidden characters, OpenAlex comparison for duplicate publication, salami slicing and copied abstracts. Full-text comparison with published literature needs a Crossref Similarity Check (iThenticate) account and is reported as *not checked*. |
| AI-written content screening | *AI-written content* (`aiWriting.js`) | **New**: chatbot leftovers (definite) plus a 0-100 writing-pattern indicator (LLM-favoured vocabulary, sentence-length variation, stock transitions, per section). Indicators only. |
| Scientific image forensics | Module 5 | Existing; linked into the score by manuscript ID. |
| Research data integrity | *Research data* (`dataIntegrity.js`) | **Extended**: GRIM test, identical mean ± SD values, repeated SDs, duplicated table rows, terminal-digit test, on top of the Module 4 p-value / percentage / primer / cell-line checks. |
| Reference & DOI verification | Module 1 | Existing; linked into the score (or run with *Verify every reference online*). |
| Paper-mill pattern detection | Module 4 + *Submission network* (`network.js`) | **Extended**: shared e-mail addresses across author teams, reviewer rings, prolific authors with changing co-authors, templated titles, institution bursts, citation rings. |
| Pharmaceutical research validation | *Pharmaceutical validation* (`pharmaValidation.js`) | **New UI + checks**: OECD dose limits, abstract vs methods doses, administration volumes, CAS check digits, formula vs molecular weight, group-size arithmetic, species consistency, impossible percentages, PubChem and FDA Orange Book. |
| Research ethics verification | *Research ethics* (`ethics.js`) | **New**: ethics approval + number, consent, Helsinki / animal guidelines, trial registration in 16 registries (ClinicalTrials.gov existence, retrospective registration, mismatch), declarations. |
| Author & affiliation verification | *Authors & affiliations* (`authors.js`) | **Extended**: ORCID owner name vs author list, CRediT statement naming every author, ROR affiliation matching, e-mail domains. |
| Peer-review integrity | `#/peer-review` (`peerReview.js`) | **New**: reviewer identity (ORCID, free-mail), conflicts (same domain/institution, OpenAlex co-authorship, surname), generic / recycled / AI / coercive-citation reviews, fast returns, reviewer rings. |
| Cross-paper & citation analysis | Similarity + network + Module 3 pattern | **Extended** as above. |
| Published article monitoring | `#/monitoring` (`monitoring.js`) | **New**: DOIs added or imported by ISSN from Crossref; weekly checks of Crossref update notices and Retraction Watch; references rescreened for later retractions; notifications; *Rescreen the archive*. |
| Integrity risk scoring engine | `scoring.js` | **New**: 11 dimensions, capped points, 0-100 score, LOW / MODERATE / HIGH / CRITICAL, escalation rules, every point explained. |
| Editorial dashboard & case management | `#/cases` (`cases.js`) | **New**: dashboard, cases with status / priority / assignee / due date, linked reports, drafted author queries and logged responses, outcomes, full history. |
| Automated integrity reports | `integrity/reports.js` | **New**: Word / PDF integrity, peer-review and case reports with evidence links and audit trail. |
| Research Integrity API | `/api/v1` (`apiV1.js`), *Administration → Integrity API* | **New**: hashed API keys with scopes, screening and peer-review jobs, results, PDF reports, monitoring status, signed webhooks, rate limit. |

New permissions (editor tools, granted to existing editors automatically): `integrity`, `peer-review`, `monitoring`, `cases`. `node test/integrity-suite.js` tests the whole suite end to end without external lookups.

Tests: `npm test` runs the web smoke test (in-memory database; Modules 2, 4, 5, permissions), the image-engine test (planted duplicates, crops, mirrored copies, clones, false-alarm check), the forensics test (alterations, AI-image markers, chart duplication) and the demo check (every problem planted in the demonstration figures is found). `node test/demo-e2e.js` runs the demonstration manuscript through the Full Screening Report (needs internet).

**Demonstration data**: `npm run demo` rebuilds `public/demo/` (served at `#/demo`, nav item *Demo data*): an earlier submission, a demonstration manuscript with planted reference, citation, paper-mill and figure problems, the five figures and a reference list — plus a step-by-step presentation script per module. All content is fictional.

**Limits**: no image or paper-mill detector can be 100% accurate. Results are screening aids that point the editor to what to check; AI-image statistics in particular can be fooled in both directions, and a clean result does not prove authenticity.

## Users — Super Admin only

There is no self-registration. The Super Admin (seeded from `ADMIN_EMAIL`/`ADMIN_PASSWORD`) creates every account under **Administration → Users** and sets:

- **Role**: Super Admin, Editor or Reviewer/Researcher (editor-only tools are off for researchers by default).
- **Tools**: per-user module permissions (or the role defaults).
- **Access**: web platform, desktop application, or both; the **offline period** (days) a desktop may work without reconnecting.
- Temporary passwords (must be changed at first sign-in), password resets, suspension (signs the user out everywhere and blocks their desktops), desktop device revocation.

The **audit log** records sign-ins and every account, permission and list change; **usage** shows runs per tool and per user.

Upgrading from v2: on first start the schema migrates automatically — `admin` becomes `super_admin`, approved editors become active, pending/rejected requests become suspended.

## Web platform

Requirements: Node.js 18+ and PostgreSQL.

```bash
npm install
cp .env.example .env      # DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, CONTACT_EMAIL (+ SMTP_* for e-mail alerts)
npm start                 # http://localhost:3005
npm test                  # auth / Super Admin / permission smoke test (in-memory database)
```

Deploys to Vercel as before (`server.js` exports the app; the daily cron at `/api/cron/daily` also runs alerts, retraction monitoring and the indexing of new PJPS articles into the image database). Set the `R2_*` variables so the platform reads its datasets from Cloudflare R2, and optionally `CORE_API_KEY` (free, core.ac.uk) — without it CORE allows about 10 requests a minute and is skipped while the limit is reached. Set `OPENALEX_API_KEY` (free, openalex.org/settings/api) for the OpenAlex journal list on Admin > Data: run `npm run datasets:openalex` once (about 10 minutes, against the database in `.env`); afterwards the daily cron refreshes it monthly, a few minutes per run. Uploads are limited to about 4.5 MB on Vercel; a VPS has no such limit.

## Windows desktop application

`desktop/` packages the same engine with [Electron](https://www.electronjs.org/) and an embedded PostgreSQL-compatible database ([PGlite](https://pglite.dev/)) stored in `%APPDATA%\PJPS Reference Checker\data`. The local server listens on 127.0.0.1 only.

```bash
cd desktop
npm install               # if npm skips Electron's download step: node node_modules/electron/install.js
npm start                 # run from source
npm run dist              # installer + portable exe in desktop/dist/
```

From the project root: `REMOTE_URL=https://your-platform npm run desktop:dist` builds with the platform address pre-set (otherwise it is entered on the sign-in screen at first launch), and `npm run desktop:publish -- --notes "…"` uploads the installer and portable version to Cloudflare R2. Every installed and portable desktop then **updates itself**: it checks the platform at start and every 4 hours (`/api/desktop-app/update/latest.yml` for installed copies, `/api/desktop-app/latest` + SHA-512 for portable ones), downloads the new version in the background and installs it when the app closes (or at once with *Restart now*); the database and datasets in the user profile are kept. Bump the version in `desktop/package.json` before each build. Signed-in users download it from **Desktop application** in the web portal's menu (each download is written to the audit log).

**How it works**

- First sign-in is online, against the web platform (only accounts with desktop access). Afterwards the user can sign in offline until the offline period ends.
- **Sync** (automatic every 30 minutes and on reconnection, or *Sync & offline queue → Sync now*): account and permissions, every dataset table (Retraction Watch, Beall's list, Problematic Paper Screener, FDA Orange Book, NLM Catalog, DOAJ, LTWA, Crossref journal list, e-mail domains, journal index lists), the data-folder files on R2 up to 60 MB each (ImageTwin / Proofig knowledge base, public image data, ICLAC, PPS exports; the multi-gigabyte benchmark archives stay online), saved reports (both directions) and notifications.
- **Module 5** runs its forensic analysis on the computer; the comparison with earlier PJPS manuscripts and the image reference databases (published PJPS, retracted, PubMed Central, RSIID, BioFors, BINDER figures) is done by the web platform through the device API, and offline the report says these were not searched.
- **Offline**: document reading, Citation Check, retraction / predatory / journal-list checks, Reference Style and Manuscript Format, citation pattern, editor reports and letters, issue reports, saved reports and all exports. References already looked up are verified from the cache; others are marked *Pending — online verification* (never "suspicious") and re-checked automatically when the connection returns. Online-only tools (Find Evidence, Find a Journal, conferences, the Thesis Assistant) are queued.
- Suspending a user or revoking a device on the web platform locks the desktop at its next connection.

`node test/desktop-sync.js` (part of `npm test`) runs a platform and a desktop in-process: sign-in, dataset sync and Module 5 matching. `node test/smoke-desktop.js` (with `REMOTE_URL`, `DESK_EMAIL`, `DESK_PASSWORD`) runs the online → offline → reconnect cycle against a running web platform; `SIMULATE_OFFLINE=1` makes the desktop engine behave as if the network were down.

## Project layout

```
server.js                   Express app: web platform and desktop engine
src/config.js, db.js        Configuration; PostgreSQL (pg) or embedded PGlite, schema and migrations
src/auth.js, modules.js     Accounts, sessions, roles, per-module permissions, audit log
src/http.js, sources.js     HTTP client (cache, offline detection) and the 12 database adapters
src/parse.js, datasets.js   Document extraction and reference parsing; Retraction Watch, Beall's list, journal lists
src/checks/, editor/        Reference / Citation / Journal checks; citation pattern, reviewers, reports
src/styles.js, ooxml.js     Citation style engine (23 styles); in-place Word (.docx) editing
src/tools/                  restyle, msformat, verify, match, fulltext, evidence, journalFinder, conferences, assistant, authors
src/alerts.js, queue.js     Notifications and scheduled alerts; desktop offline queue
src/desktop.js              Desktop sign-in and synchronisation
src/routes/                 core, tools, activity, admin, sync (device API used by the desktop)
public/                     Sign-in page and workspace (vanilla JS modules)
desktop/                    Electron shell, icon, packaging (stage.js → app/, electron-builder → dist/)
docs/                       Proposal (Word) and its generator
test/                       Smoke tests
```
