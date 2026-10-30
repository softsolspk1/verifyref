# PJPS Data Integrity System

**by Softsols Pakistan** — five-module manuscript screening system for the *Pakistan Journal of Pharmaceutical Sciences*, as a web portal and as a Windows desktop application with the same five modules.

The feature set follows [ReferenceVerify](https://referenceverify.com/) (all tools except its integrations and pricing), adapted to PJPS. The proposal is in [`docs/PJPS-Reference-Checker-Proposal.docx`](docs/PJPS-Reference-Checker-Proposal.docx).

## PJPS modules (v4)

The portal is reduced to the five modules the PJPS Editor asked for, plus one Full Screening Report (spec: [`docs/PJPS-Final-4-Modules.txt`](docs/PJPS-Final-4-Modules.txt), proposal: [`docs/PJPS-4-Modules-Proposal.docx`](docs/PJPS-4-Modules-Proposal.docx)). The earlier tools remain in the code base but are switched off in `src/modules.js` (`LEGACY`): they are not shown, not granted, and their API routes refuse access.

| Module | Page | What it does |
|---|---|---|
| **Full Screening Report** (editor) | `#/manuscript` | One upload runs Modules 1, 2 (compliance), 3 (list matching, pattern) and 4, and attaches a Module 5 report if selected. Front-page summary per module and a desk-review recommendation (proceed / return / investigate). Word export: editor version (all modules) and author version (Modules 1–3). Editor decision record. |
| **1 · Check Bibliography** | `#/references` | 13 databases (incl. OpenAlex and CORE) + Retraction Watch; Verified / Miscited / Unverified / Suspicious / Retracted with confidence; fabrication checks; link check; regional journals shown as *Not indexed*; reference-age chart against the PJPS rule (Super Admin setting); self-citation, PJPS citations, predatory / hijacked journals, duplicate references (`src/checks/indicators.js`); **Re-check** shows only what changed. |
| **2 · Reference Style & PJPS Converter** | `#/restyle` | Rule-by-rule PJPS compliance of every reference and in-text citation with the expected form (`src/checks/compliance.js`); conversion to PJPS (or any of 23 styles) with **Word Track Changes** (`Docx.trackChanges()` in `src/ooxml.js`); before/after view. |
| **3 · Citations** | `#/citations` | A. citations ↔ list (missing, uncited, year, ambiguous, wrong “et al.”, numbering, citation blocks); B. claim support from uploaded PDFs / open-access full text (Europe PMC, Unpaywall, OpenAlex locations, CORE) / abstracts; C. citation pattern; author letter EN/UR (`src/tools/citationsModule.js`). |
| **4 · Paper Mill Detection** (editor) | `#/papermill` | Tortured phrases (Problematic Paper Screener list + editor additions), AI-text leftovers, template wording, vague methods, fabricated and mill-retracted references, predatory journals and journals with many paper-mill retractions, citation stacking, author retractions (Retraction Watch by name, and by DOI from the authors' ORCID records), free-mail, ORCID checks, off-topic affiliations, authorship changes between versions, suggested reviewers, ICLAC misidentified cell lines, duplicate submissions (text fingerprints), hidden / look-alike characters used to defeat plagiarism software, a paper with the same title already published or posted (Crossref, OpenAlex, CORE — journals, preprints, repositories, theses), Module 5 findings by category. LOW / MEDIUM / HIGH with evidence; confidential Word export; decision record (`src/papermill/`). |
| **5 · Image Integrity** (editor) | `#/images` | Runs **in the editor's browser** (no large upload — Vercel's 4.5 MB request limit). Four detection groups, as in ImageTwin / Proofig: **a) Duplication & reuse** — whole-panel duplicates in 8 orientations (perceptual hash + correlation), partial / resized / rotated / mirrored copies (ORB + RANSAC), comparison with all earlier PJPS manuscripts via stored fingerprints, and with the **PJPS image databases** (below); **b) Alteration & manipulation** — cloned areas (keypoints + DCT blocks), pasted patches (noise-level and JPEG-grid inconsistency), erased / retouched areas, joined blot lanes (sharp background step), stretched contrast, saturated bands; **c) AI-generated images** — file markers (C2PA, IPTC *trainedAlgorithmicMedia*, generator names, Stable-Diffusion parameters) and statistical traces (spectral peaks, missing or uniform sensor noise); markers are strong evidence, statistics alone are only *indicators*; **d) Graph & chart duplication** — bar heights and curves are read from the chart pixels and compared across charts (re-coloured, re-scaled, reversed) and with earlier manuscripts. Forensic viewer (filters: contrast, error level, noise, edges, false colour, invert; comparison: side by side, overlay and swipe sliders, difference, flicker; zoom; save view), editor marks per finding, query letter, confidential Word report (`public/js/images/engine.js`, `forensics.js`, `src/images.js`). **ImageTwin (5.7, optional)**: with `IMAGETWIN_API_KEY` set on the platform, the editor can send a manuscript (PDF/Word under 30 MB, or up to 25 figure files) to the ImageTwin REST API per manuscript — off by default, confirmed each time, written to the audit log; its counts (matches with published figures, duplicates, alterations, AI images), risk from ImageTwin's confidence bands and links to its findings and PDF report appear in the result and the Word report (`src/vendors/imagetwin.js`; desktop through the platform; `IMAGETWIN_SANDBOX=1` for the free sandbox). Without the key the published-figure search is reported as “not checked”. Proofig publishes no API documentation and is not connected. |

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
