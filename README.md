# PJPS Reference Checker

**by Softsols Pakistan** — five-module manuscript screening portal for the *Pakistan Journal of Pharmaceutical Sciences* (web platform). The earlier Windows desktop edition is still in the repository but is not developed further for the v4 modules.

The feature set follows [ReferenceVerify](https://referenceverify.com/) (all tools except its integrations and pricing), adapted to PJPS. The proposal is in [`docs/PJPS-Reference-Checker-Proposal.docx`](docs/PJPS-Reference-Checker-Proposal.docx).

## PJPS modules (v4)

The portal is reduced to the five modules the PJPS Editor asked for, plus one Full Screening Report (spec: [`docs/PJPS-Final-4-Modules.txt`](docs/PJPS-Final-4-Modules.txt), proposal: [`docs/PJPS-4-Modules-Proposal.docx`](docs/PJPS-4-Modules-Proposal.docx)). The earlier tools remain in the code base but are switched off in `src/modules.js` (`LEGACY`): they are not shown, not granted, and their API routes refuse access.

| Module | Page | What it does |
|---|---|---|
| **Full Screening Report** (editor) | `#/manuscript` | One upload runs Modules 1, 2 (compliance), 3 (list matching, pattern) and 4, and attaches a Module 5 report if selected. Front-page summary per module and a desk-review recommendation (proceed / return / investigate). Word export: editor version (all modules) and author version (Modules 1–3). Editor decision record. |
| **1 · Check Bibliography** | `#/references` | 12 databases + Retraction Watch; Verified / Miscited / Unverified / Suspicious / Retracted with confidence; fabrication checks; link check; regional journals shown as *Not indexed*; reference-age chart against the PJPS rule (Super Admin setting); self-citation, PJPS citations, predatory / hijacked journals, duplicate references (`src/checks/indicators.js`); **Re-check** shows only what changed. |
| **2 · Reference Style & PJPS Converter** | `#/restyle` | Rule-by-rule PJPS compliance of every reference and in-text citation with the expected form (`src/checks/compliance.js`); conversion to PJPS (or any of 23 styles) with **Word Track Changes** (`Docx.trackChanges()` in `src/ooxml.js`); before/after view. |
| **3 · Citations** | `#/citations` | A. citations ↔ list (missing, uncited, year, ambiguous, wrong “et al.”, numbering, citation blocks); B. claim support from uploaded PDFs / open access / abstracts; C. citation pattern; author letter EN/UR (`src/tools/citationsModule.js`). |
| **4 · Paper Mill Detection** (editor) | `#/papermill` | Tortured phrases (Problematic Paper Screener list + editor additions), AI-text leftovers, template wording, vague methods, fabricated and mill-retracted references, predatory journals, citation stacking, author retractions (Retraction Watch by name), free-mail, ORCID checks, off-topic affiliations, authorship changes between versions, suggested reviewers, ICLAC misidentified cell lines, duplicate submissions (text fingerprints), hidden / look-alike characters used to defeat plagiarism software, a paper with the same title already published (Crossref), Module 5 findings by category. LOW / MEDIUM / HIGH with evidence; confidential Word export; decision record (`src/papermill/`). |
| **5 · Image Integrity** (editor) | `#/images` | Runs **in the editor's browser** (no large upload — Vercel's 4.5 MB request limit). Four detection groups, as in ImageTwin / Proofig: **a) Duplication & reuse** — whole-panel duplicates in 8 orientations (perceptual hash + correlation), partial / resized / rotated / mirrored copies (ORB + RANSAC), comparison with all earlier PJPS manuscripts via stored fingerprints; **b) Alteration & manipulation** — cloned areas (keypoints + DCT blocks), pasted patches (noise-level and JPEG-grid inconsistency), erased / retouched areas, joined blot lanes (sharp background step), stretched contrast, saturated bands; **c) AI-generated images** — file markers (C2PA, IPTC *trainedAlgorithmicMedia*, generator names, Stable-Diffusion parameters) and statistical traces (spectral peaks, missing or uniform sensor noise); markers are strong evidence, statistics alone are only *indicators*; **d) Graph & chart duplication** — bar heights and curves are read from the chart pixels and compared across charts (re-coloured, re-scaled, reversed) and with earlier manuscripts. Forensic viewer, editor marks per finding, query letter, confidential Word report (`public/js/images/engine.js`, `forensics.js`, `src/images.js`). The 155–160 M published-figure search needs an ImageTwin / Proofig contract and is reported as “not checked”. |

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

Deploys to Vercel as before (`server.js` exports the app; the daily cron at `/api/cron/daily` now also runs alerts and retraction monitoring). Uploads are limited to about 4.5 MB on Vercel; a VPS has no such limit.

## Windows desktop application

`desktop/` packages the same engine with [Electron](https://www.electronjs.org/) and an embedded PostgreSQL-compatible database ([PGlite](https://pglite.dev/)) stored in `%APPDATA%\PJPS Reference Checker\data`. The local server listens on 127.0.0.1 only.

```bash
cd desktop
npm install               # if npm skips Electron's download step: node node_modules/electron/install.js
npm start                 # run from source
npm run dist              # installer + portable exe in desktop/dist/
```

Set the web platform address in `desktop/desktop-config.json` before building (`"remoteUrl": "https://…"`), or enter it on the sign-in screen at first launch.

**How it works**

- First sign-in is online, against the web platform (only accounts with desktop access). Afterwards the user can sign in offline until the offline period ends.
- **Sync** (automatic every 30 minutes and on reconnection, or *Sync & offline queue → Sync now*): account and permissions, Retraction Watch, Beall's list, hijacked journals, uploaded journal index lists, saved reports (both directions) and notifications.
- **Offline**: document reading, Citation Check, retraction / predatory / journal-list checks, Reference Style and Manuscript Format, citation pattern, editor reports and letters, issue reports, saved reports and all exports. References already looked up are verified from the cache; others are marked *Pending — online verification* (never "suspicious") and re-checked automatically when the connection returns. Online-only tools (Find Evidence, Find a Journal, conferences, the Thesis Assistant) are queued.
- Suspending a user or revoking a device on the web platform locks the desktop at its next connection.

`node test/smoke-desktop.js` (with `REMOTE_URL`, `DESK_EMAIL`, `DESK_PASSWORD`) runs the online → offline → reconnect cycle against a running web platform; `SIMULATE_OFFLINE=1` makes the desktop engine behave as if the network were down.

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
