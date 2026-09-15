# SOFTSOLS VERIFYREF

**Academic Reference Verifier & DOI Integrity Portal**  
Inspired by editorial tools like Scribe Science's Reference Verifier. Built for researchers, academic editors, journal reviewers, and publishing organizations.

---

## Key Features

1. **Real-Time DOI Resolution**:
   - Queries CrossRef and the global DOI Handle Foundation (`doi.org/api/handles/`).
   - Identifies non-existent / unresolvable DOIs (hallucinated AI citations).

2. **Scientific Integrity & Retraction Auditing**:
   - Checks cited works against Retraction Watch and CrossRef `update-to` retraction notices and expressions of concern.

3. **Metadata Discrepancy Matching**:
   - Compares cited publication year, author surname, and title against authoritative records to catch typos, citation swaps, and incorrect citations.

4. **Missing DOI Auto-Discovery**:
   - For references written without a DOI, automatically searches CrossRef's bibliographic catalog to discover and suggest the verified DOI.

5. **Multi-Format Input & Extraction**:
   - Paste reference lists or upload documents (`.pdf`, `.docx`, `.txt`, `.bib`).
   - Smart bibliography section extraction and auto-splitting heuristics.

6. **Interactive Export & Audit Reporting**:
   - One-click copy of executive audit summary.
   - Download CSV audit reports.
   - Export cleaned / corrected bibliographies.

---

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Run the Portal
```bash
npm start
```
By default, the server runs on `http://localhost:3005` (with automatic port fallback if port is occupied).

---

## Tech Stack
- **Backend**: Node.js & Express
- **Integrations**: CrossRef API, Global Handle System (`doi.org`), DataCite API
- **Document Extractors**: `pdf-parse`, `mammoth`
- **Frontend**: Vanilla CSS Editorial Design System, HTML5, Modular JavaScript (Zero build step required)
