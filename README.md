# PJPS Reference Checker

**by Softsols Pakistan** — editor-only reference integrity tools for the *Pakistan Journal of Pharmaceutical Sciences*.

Fabricated references, irrelevant self-citations and finding a suitable reviewer take up much of an editor's time. These tools are open to approved editor accounts only.

## Editor tools

| Tool | What it does |
|---|---|
| **Citation pattern** | Self-citation rate (matched by ORCID or name), self-citations that are weakly related to the topic, references piled on one author or one journal, citation stacking toward PJPS (incl. the two-year impact-factor window) and off-topic sources — with guidance on when a pattern can be legitimate. |
| **Reviewer Finder** | Candidates who published on the manuscript's topic in the last 3–8 years (OpenAlex), with ORCID, institution, h-index, current-year workload, retractions and conflict-of-interest flags (co-authorship with the manuscript authors, shared institution). Filters: ORCID only, hide conflicts, Pakistan-based / international. Word & CSV export; no contact details. |
| **Reviewer report check** | Extracts citation requests (full references, DOIs, author–year mentions, generic requests) from a reviewer report, verifies them and flags the reviewer's own work, single-journal or single-author groups, weakly related or unverifiable sources and coercive wording ("must cite… for acceptance"). Produces a note to the author. |
| **Editor report** | One-page desk-review decision summary (proceed / revise / consider rejection), author correction letter in **English and Urdu** with suggested corrections, and a **revision comparison** (fixed, removed, still problematic, new problems, % of requested fixes made). Word, text and print/PDF. |
| **Issue report** | Summary table of every manuscript checked in an issue (or the last 1/3/6/12 months): references, suspicious, retracted, miscited, citation mismatches, self-citation and most frequent problems. Word & CSV. Checks can be saved as *counts only* so no manuscript content is stored. |

## Also included

- **Reference Check** — every reference is checked against 12 academic databases: Crossref, DOI Foundation (Handle registry), DataCite, OpenAlex, PubMed, Europe PMC, Semantic Scholar, arXiv, DBLP, Open Library, Google Books and ERIC; plus the Retraction Watch dataset. Statuses: Verified / Miscited / Unverified / Suspicious / Retracted with a 0–100 confidence score. Detects non-existent DOIs, PMIDs and arXiv IDs, identifiers pointing to a different paper, real articles attributed to the wrong journal, wrong year/volume/pages, articles claimed in well-indexed journals that appear nowhere, preprint-vs-published versions, broken links (with archive.org copies) and reference age distribution. Suggests corrected references and missing DOIs. Exports: CSV, Word, BibTeX, RIS, corrected list.
- **Citation Check** — matches in-text citations with the reference list for numbered (Vancouver) and author–year (APA/Harvard/PJPS) styles: citations missing from the list, references never cited, ambiguous same-author/same-year citations, year mismatches, numbering order and alphabetical order.
- **Journal Check** — Scopus (uploaded Scopus/SJR list or Wikidata), SJR quartile, Web of Science collections (SCIE/SSCI/AHCI/ESCI) and JCR quartile from uploaded lists, **HEC HJRS** category (W/X/Y), MEDLINE (NLM Catalog), DOAJ (seal, APC, review type), ISSN registry and check digit, Retraction Watch retraction rate, Beall's list predatory publishers/journals, hijacked-journal clones and output-growth warnings. Runs for every journal cited in a manuscript or as a single lookup.

Input: Word (.docx), PDF, plain text, BibTeX, RIS, or pasted text. Title, authors, affiliations, abstract and keywords are detected automatically.

## Setup

Requirements: Node.js 18+ and a PostgreSQL database.

```bash
npm install
cp .env.example .env      # set DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, CONTACT_EMAIL
npm start                 # http://localhost:3005
```

On first start the schema is created, the administrator account is seeded, and the Retraction Watch (~64,000 records) and Beall's list datasets are downloaded in the background (a few minutes; refreshed weekly).

### First steps for the administrator

1. Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` and change the password (Account).
2. **Users & data → Journal index lists** — upload the current CSVs PJPS has access to: SJR (scimagojr.com download), Scopus source list, WoS Master Journal List per collection, JCR, HEC HJRS. Without them Scopus coverage comes from Wikidata and WoS/JCR/HJRS columns stay empty.
3. Editors request access from the sign-in page; approve them under **Users & data**. Co-editors listed by an approved editor are approved automatically when they register.
4. Add a free `OPENALEX_API_KEY` to `.env` — without it all users share OpenAlex's small anonymous daily budget, which Reviewer Finder exhausts quickly.

## Deploying on Vercel

The repository deploys with Vercel's Express preset (`server.js` exports the app; `public/` is served by the CDN).

1. Add the environment variables from `.env.example` in **Project → Settings → Environment Variables** (at least `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `CONTACT_EMAIL`, and `CRON_SECRET` for the daily job). Session cookies are marked `Secure` automatically on Vercel.
2. Push to `main` for production (other branches get preview deployments).

How it works there: checks run as background jobs stored in the `jobs` table. Work continues after the response (`waitUntil`); if Vercel stops an instance at its time limit, the browser's next progress poll resumes the job, and the resumed run is quick because every database lookup is cached in PostgreSQL. A Vercel Cron (`vercel.json`) calls `/api/cron/daily` to refresh Retraction Watch and Beall's list weekly and clear old jobs. Uploads are limited to about 4.5 MB by Vercel — paste the text for larger manuscripts.

## Project layout

```
server.js                 Express app and API routes
src/config.js, db.js      Configuration and PostgreSQL schema/helpers
src/http.js               Polite HTTP client (per-host concurrency, retries, two-tier cache)
src/sources.js            Adapters for the 12 databases
src/parse.js              Document extraction, reference splitting/parsing, manuscript metadata, in-text citations
src/datasets.js           Retraction Watch, Beall's list, uploaded journal lists
src/checks/               reference.js · citation.js · journal.js
src/editor/               pattern.js · reviewers.js · reviewerReport.js · reports.js
src/pipeline.js           Full manuscript check and persistence
src/docx.js, format.js    Word exports; APA / Vancouver / PJPS formatting; CSV/BibTeX/RIS
src/auth.js, jobs.js      Editor accounts and sessions; resumable background jobs (PostgreSQL)
public/                   Landing page and editor workspace (vanilla JS modules, no build step)
```
