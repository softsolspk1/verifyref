// app.js - Client application for Academic Reference Verifier Portal

document.addEventListener('DOMContentLoaded', () => {
  // State
  let currentStrategy = 'auto';
  let verificationResults = [];
  let currentFilter = 'all';
  let parseDebounceTimer = null;

  // DOM Elements
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  const themeIcon = document.getElementById('theme-icon');
  const referencesInput = document.getElementById('references-input');
  const detectedText = document.getElementById('detected-text');
  const splitToggleGroup = document.getElementById('split-toggle-group');
  const verifyActionBtn = document.getElementById('verify-action-btn');
  const progressCard = document.getElementById('progress-card');
  const progressBarFill = document.getElementById('progress-bar-fill');
  const progressPct = document.getElementById('progress-pct');
  const progressStatusText = document.getElementById('progress-status-text');
  const progressSubtext = document.getElementById('progress-subtext');
  const resultsSection = document.getElementById('results-section');
  const resultsList = document.getElementById('results-list');
  const filterTabs = document.getElementById('filter-tabs');
  const toast = document.getElementById('toast');

  // Mode Tabs
  const inputTabs = document.querySelectorAll('.input-tabs-bar .tab-btn');
  const tabPanes = {
    paste: document.getElementById('pane-paste'),
    upload: document.getElementById('pane-upload'),
    doi: document.getElementById('pane-doi')
  };

  // Samples
  const sampleIntegrityBtn = document.getElementById('sample-integrity');
  const sampleCleanBtn = document.getElementById('sample-clean');
  const sampleHallucinationsBtn = document.getElementById('sample-hallucinations');
  const sampleClearBtn = document.getElementById('sample-clear');

  // File Upload
  const uploadDropzone = document.getElementById('upload-dropzone');
  const fileInput = document.getElementById('file-input');
  const browseBtn = document.getElementById('browse-btn');
  const uploadStatus = document.getElementById('upload-status');

  // Single DOI
  const singleDoiInput = document.getElementById('single-doi-input');
  const lookupDoiBtn = document.getElementById('lookup-doi-btn');

  // Export Buttons
  const btnCopyReport = document.getElementById('btn-copy-report');
  const btnExportCleaned = document.getElementById('btn-export-cleaned');
  const btnExportCsv = document.getElementById('btn-export-csv');

  // KPI Elements
  const kpiTotal = document.getElementById('kpi-total');
  const kpiVerified = document.getElementById('kpi-verified');
  const kpiDiscrepancies = document.getElementById('kpi-discrepancies');
  const kpiRetracted = document.getElementById('kpi-retracted');
  const kpiUnregistered = document.getElementById('kpi-unregistered');
  const kpiMatches = document.getElementById('kpi-matches');

  // Filter Count Elements
  const countAll = document.getElementById('count-all');
  const countVerified = document.getElementById('count-verified');
  const countDiscrepancy = document.getElementById('count-discrepancy');
  const countRetracted = document.getElementById('count-retracted');
  const countUnregistered = document.getElementById('count-unregistered');
  const countProbableMatch = document.getElementById('count-probable-match');

  // --------------------------------------------------------------------------
  // Theme Management
  // --------------------------------------------------------------------------
  function initTheme() {
    const saved = localStorage.getItem('verifyref_theme') || 'dark';
    if (saved === 'light') {
      document.body.classList.remove('theme-dark');
      document.body.classList.add('theme-light');
      themeIcon.textContent = '🌙';
    } else {
      document.body.classList.remove('theme-light');
      document.body.classList.add('theme-dark');
      themeIcon.textContent = '☀️';
    }
  }

  themeToggleBtn.addEventListener('click', () => {
    const isDark = document.body.classList.contains('theme-dark');
    if (isDark) {
      document.body.classList.remove('theme-dark');
      document.body.classList.add('theme-light');
      themeIcon.textContent = '🌙';
      localStorage.setItem('verifyref_theme', 'light');
    } else {
      document.body.classList.remove('theme-light');
      document.body.classList.add('theme-dark');
      themeIcon.textContent = '☀️';
      localStorage.setItem('verifyref_theme', 'dark');
    }
  });

  // --------------------------------------------------------------------------
  // Toast Helper
  // --------------------------------------------------------------------------
  function showToast(msg, duration = 3000) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, duration);
  }

  // --------------------------------------------------------------------------
  // Tab Switching
  // --------------------------------------------------------------------------
  inputTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      inputTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const mode = tab.dataset.mode;
      Object.keys(tabPanes).forEach(k => {
        tabPanes[k].classList.toggle('active', k === mode);
      });
    });
  });

  // --------------------------------------------------------------------------
  // Real-time Text Parsing Preview
  // --------------------------------------------------------------------------
  function triggerParsePreview() {
    clearTimeout(parseDebounceTimer);
    parseDebounceTimer = setTimeout(async () => {
      const text = referencesInput.value.trim();
      if (!text) {
        detectedText.textContent = '0 references detected';
        return;
      }

      try {
        const res = await fetch('/api/parse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, strategy: currentStrategy })
        });
        const data = await res.json();
        if (data.success) {
          const stratLabel = {
            numbered: 'split at numbering',
            'blank-line': 'split at blank lines',
            'one-per-line': 'split line by line',
            'line-with-continuation': 'smart continuation'
          }[data.strategy] || data.strategy;

          detectedText.textContent = `${data.total} reference${data.total === 1 ? '' : 's'} detected (${stratLabel}) · ${data.withDoiCount} with DOI`;
        }
      } catch (e) {
        console.error('Parse preview error:', e);
      }
    }, 250);
  }

  referencesInput.addEventListener('input', triggerParsePreview);

  // Splitting Strategy Toggle
  splitToggleGroup.querySelectorAll('.toggle-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      splitToggleGroup.querySelectorAll('.toggle-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentStrategy = btn.dataset.strategy;
      triggerParsePreview();
    });
  });

  // --------------------------------------------------------------------------
  // Sample Presets Loader
  // --------------------------------------------------------------------------
  let cachedSamples = null;

  async function loadSample(sampleId) {
    if (!cachedSamples) {
      try {
        const res = await fetch('/api/samples');
        const data = await res.json();
        if (data.success) cachedSamples = data.samples;
      } catch (e) {
        console.error('Failed to fetch samples:', e);
      }
    }

    const found = (cachedSamples || []).find(s => s.id === sampleId);
    if (found) {
      // Switch to paste tab
      inputTabs[0].click();
      referencesInput.value = found.text;
      triggerParsePreview();
      showToast(`Loaded "${found.name}" sample! Click 'Audit References Now'`);
    }
  }

  sampleIntegrityBtn.addEventListener('click', () => loadSample('integrity-audit'));
  sampleCleanBtn.addEventListener('click', () => loadSample('clean-bibliography'));
  sampleHallucinationsBtn.addEventListener('click', () => loadSample('ai-hallucinations'));
  sampleClearBtn.addEventListener('click', () => {
    referencesInput.value = '';
    triggerParsePreview();
    resultsSection.style.display = 'none';
    verificationResults = [];
    showToast('Cleared input & results.');
  });

  // --------------------------------------------------------------------------
  // File Upload Handling
  // --------------------------------------------------------------------------
  browseBtn.addEventListener('click', () => fileInput.click());
  uploadDropzone.addEventListener('click', (e) => {
    if (e.target !== browseBtn) fileInput.click();
  });

  uploadDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadDropzone.classList.add('dragover');
  });

  uploadDropzone.addEventListener('dragleave', () => {
    uploadDropzone.classList.remove('dragover');
  });

  uploadDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadDropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileUpload(e.target.files[0]);
    }
  });

  async function handleFileUpload(file) {
    const formData = new FormData();
    formData.append('file', file);

    uploadStatus.style.display = 'block';
    uploadStatus.textContent = `Extracting text from ${file.name}...`;

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (data.success) {
        // Switch to paste tab and put extracted text
        inputTabs[0].click();
        referencesInput.value = data.text;
        triggerParsePreview();
        uploadStatus.style.display = 'none';
        showToast(`Successfully extracted ${data.extractedReferenceCount} references from ${file.name}`);
      } else {
        uploadStatus.textContent = `Error: ${data.message}`;
      }
    } catch (e) {
      uploadStatus.textContent = `Upload failed: ${e.message}`;
    }
  }

  // --------------------------------------------------------------------------
  // Single DOI Lookup
  // --------------------------------------------------------------------------
  lookupDoiBtn.addEventListener('click', async () => {
    const input = singleDoiInput.value.trim();
    if (!input) {
      showToast('Please enter a DOI or URL.');
      return;
    }

    // Switch to paste tab with this single DOI as an entry
    inputTabs[0].click();
    referencesInput.value = input;
    triggerParsePreview();
    verifyActionBtn.click();
  });

  // --------------------------------------------------------------------------
  // Verification Execution
  // --------------------------------------------------------------------------
  verifyActionBtn.addEventListener('click', async () => {
    const text = referencesInput.value.trim();
    if (!text) {
      showToast('Please paste references or upload a file first.');
      return;
    }

    // UI Loading state
    verifyActionBtn.disabled = true;
    progressCard.style.display = 'block';
    resultsSection.style.display = 'none';
    progressBarFill.style.width = '10%';
    progressPct.textContent = '10%';
    progressStatusText.textContent = 'Extracting and structuring references...';
    progressSubtext.textContent = 'Preparing batch queries for CrossRef and Handle registries';

    // Simulate animated progress increments while server performs real batch verification
    let currentPct = 10;
    const progressInterval = setInterval(() => {
      if (currentPct < 90) {
        currentPct += 15;
        progressBarFill.style.width = `${currentPct}%`;
        progressPct.textContent = `${currentPct}%`;
        if (currentPct > 40) {
          progressStatusText.textContent = 'Cross-referencing DOIs with official metadata & Retraction Watch...';
          progressSubtext.textContent = 'Comparing author surnames, publication years, and article titles';
        }
      }
    }, 400);

    try {
      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, strategy: currentStrategy })
      });

      clearInterval(progressInterval);
      progressBarFill.style.width = '100%';
      progressPct.textContent = '100%';

      const data = await res.json();
      if (!data.success) {
        showToast(`Verification failed: ${data.message || 'Server error'}`);
        return;
      }

      verificationResults = data.results || [];
      renderResults(data.summary, verificationResults);

      setTimeout(() => {
        progressCard.style.display = 'none';
        resultsSection.style.display = 'block';
        resultsSection.scrollIntoView({ behavior: 'smooth' });
      }, 400);
    } catch (err) {
      clearInterval(progressInterval);
      showToast(`Network error: ${err.message}`);
    } finally {
      verifyActionBtn.disabled = false;
    }
  });

  // --------------------------------------------------------------------------
  // Rendering Results & KPI Metrics
  // --------------------------------------------------------------------------
  function renderResults(summary, results) {
    // Populate KPIs
    kpiTotal.textContent = summary.total || 0;
    kpiVerified.textContent = summary.verified || 0;
    kpiDiscrepancies.textContent = summary.discrepancies || 0;
    kpiRetracted.textContent = summary.retracted || 0;
    kpiUnregistered.textContent = summary.unregistered || 0;
    kpiMatches.textContent = summary.probableMatch || 0;

    // Populate Filter Tab Counts
    countAll.textContent = summary.total || 0;
    countVerified.textContent = summary.verified || 0;
    countDiscrepancy.textContent = summary.discrepancies || 0;
    countRetracted.textContent = summary.retracted || 0;
    countUnregistered.textContent = summary.unregistered || 0;
    countProbableMatch.textContent = summary.probableMatch || 0;

    renderCards();
  }

  function renderCards() {
    resultsList.innerHTML = '';

    const filtered = verificationResults.filter(r => {
      if (currentFilter === 'all') return true;
      if (currentFilter === 'verified') return r.status === 'verified';
      if (currentFilter === 'discrepancy') return r.status === 'discrepancy';
      if (currentFilter === 'retracted') return r.status === 'retracted';
      if (currentFilter === 'unregistered') return r.status === 'unregistered';
      if (currentFilter === 'probable-match') return r.status === 'probable-match';
      return true;
    });

    if (filtered.length === 0) {
      resultsList.innerHTML = `
        <div class="card" style="padding: 32px; text-align: center; color: var(--text-muted);">
          No references found matching filter "${currentFilter}".
        </div>
      `;
      return;
    }

    filtered.forEach(item => {
      const card = document.createElement('div');
      card.className = `ref-card tone-${item.tone || 'neutral'}`;

      // Status Pill config
      let pillClass = item.tone || 'neutral';
      let pillText = item.statusLabel || item.status;

      // Card Header
      let html = `
        <div class="ref-card-header">
          <span class="ref-index-badge">#${item.index}</span>
          <span class="status-pill ${pillClass}">${pillText}</span>
        </div>
      `;

      // Raw Citation
      html += `<div class="ref-raw-citation"><strong>Citation:</strong> ${escapeHtml(item.raw)}</div>`;

      // Registered Metadata Box (if found)
      if (item.work) {
        html += `
          <div class="registry-metadata-box">
            <div class="meta-title">${escapeHtml(item.work.title)}</div>
            <div class="meta-details">
              ${item.work.authors ? `<span>👤 <strong>${escapeHtml(item.work.authors)}</strong></span>` : ''}
              ${item.work.containerTitle ? `<span>📖 <em>${escapeHtml(item.work.containerTitle)}</em></span>` : ''}
              ${item.work.year ? `<span>📅 (${item.work.year})</span>` : ''}
              ${item.work.volume ? `<span>Vol. ${escapeHtml(item.work.volume)}</span>` : ''}
            </div>
            ${item.work.doi ? `
              <a href="https://doi.org/${encodeURIComponent(item.work.doi)}" target="_blank" rel="noopener noreferrer" class="meta-doi-link">
                🔗 https://doi.org/${escapeHtml(item.work.doi)}
              </a>
            ` : ''}
          </div>
        `;
      }

      // Retraction Alert Box
      if (item.status === 'retracted' || item.notices.length > 0) {
        const retNotice = item.notices.find(n => n.type === 'Retraction') || item.notices[0] || { label: 'Article Retracted' };
        html += `
          <div class="alert-callout retraction">
            <span class="alert-icon">🚨</span>
            <div class="alert-content">
              <strong>PUBLICATION INTEGRITY ALERT: RETRACTED PAPER</strong>
              <p>${escapeHtml(retNotice.label)} ${retNotice.source ? `· Source: ${escapeHtml(retNotice.source)}` : ''}</p>
              ${retNotice.doi ? `<p><small>Notice DOI: <a href="https://doi.org/${encodeURIComponent(retNotice.doi)}" target="_blank" style="color:inherit; text-decoration:underline;">https://doi.org/${escapeHtml(retNotice.doi)}</a></small></p>` : ''}
            </div>
          </div>
        `;
      }

      // Unresolvable / Fake DOI Alert Box
      if (item.status === 'unregistered') {
        html += `
          <div class="alert-callout unresolvable">
            <span class="alert-icon">✕</span>
            <div class="alert-content">
              <strong>DOI DOES NOT RESOLVE (POSSIBLE AI HALLUCINATION)</strong>
              <p>The DOI <code>${escapeHtml(item.doi || item.doiAsWritten)}</code> is not registered in CrossRef, DataCite, or the global DOI Handle registry. This is a primary hallmark of hallucinated citations generated by LLMs.</p>
            </div>
          </div>
        `;
      }

      // Metadata Discrepancy Alert Box
      if (item.discrepancies && item.discrepancies.length > 0) {
        html += `
          <div class="alert-callout discrepancy">
            <span class="alert-icon">⚠️</span>
            <div class="alert-content">
              <strong>METADATA DISCREPANCIES DETECTED</strong>
              <table class="discrepancy-diff-table">
                <tbody>
                  ${item.discrepancies.map(d => `
                    <tr>
                      <td class="diff-field">${escapeHtml(d.field)}:</td>
                      <td class="diff-cited">Cited: ${escapeHtml(d.cited)}</td>
                      <td class="diff-registered">Registry: ${escapeHtml(d.registered)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        `;
      }

      // Suggested DOI Match Box (for citations missing DOI)
      if (item.suggestedDoi) {
        html += `
          <div class="alert-callout discovery">
            <span class="alert-icon">🔍</span>
            <div class="alert-content">
              <strong>MATCHING PUBLICATION FOUND IN CROSSREF</strong>
              <p>This reference was written without a DOI, but an authoritative record was discovered:</p>
              <p><code>https://doi.org/${escapeHtml(item.suggestedDoi)}</code></p>
            </div>
          </div>
        `;
      }

      card.innerHTML = html;
      resultsList.appendChild(card);
    });
  }

  // --------------------------------------------------------------------------
  // Filter Tabs Interaction
  // --------------------------------------------------------------------------
  filterTabs.querySelectorAll('.filter-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      filterTabs.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderCards();
    });
  });

  // --------------------------------------------------------------------------
  // Export & Action Handlers
  // --------------------------------------------------------------------------
  btnCopyReport.addEventListener('click', async () => {
    if (verificationResults.length === 0) return;

    let text = `========================================================\n`;
    text += `REFERENCE AUDIT REPORT - SOFTSOLS VERIFYREF INTEGRITY PORTAL\n`;
    text += `Generated: ${new Date().toLocaleString()}\n`;
    text += `Total References: ${verificationResults.length}\n`;
    text += `========================================================\n\n`;

    verificationResults.forEach(r => {
      text += `[#${r.index}] [${(r.statusLabel || r.status).toUpperCase()}]\n`;
      text += `Citation: ${r.raw}\n`;
      if (r.work) {
        text += `Registered Title: ${r.work.title || ''}\n`;
        text += `Authors: ${r.work.authors || ''}\n`;
        text += `Publication: ${r.work.containerTitle || ''} (${r.work.year || 'N/A'})\n`;
        text += `DOI: https://doi.org/${r.work.doi || ''}\n`;
      }
      if (r.notices && r.notices.length > 0) {
        r.notices.forEach(n => { text += `ALERT: ${n.type} - ${n.label}\n`; });
      }
      if (r.discrepancies && r.discrepancies.length > 0) {
        r.discrepancies.forEach(d => { text += `DISCREPANCY: ${d.message}\n`; });
      }
      text += `\n--------------------------------------------------------\n\n`;
    });

    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied audit report summary to clipboard!');
    } catch (e) {
      showToast('Clipboard access denied. Please allow clipboard permissions.');
    }
  });

  btnExportCleaned.addEventListener('click', async () => {
    if (verificationResults.length === 0) return;

    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ results: verificationResults, format: 'cleaned' })
      });
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'cleaned_references.txt';
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast('Downloaded cleaned references file!');
    } catch (e) {
      showToast('Export failed: ' + e.message);
    }
  });

  btnExportCsv.addEventListener('click', async () => {
    if (verificationResults.length === 0) return;

    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ results: verificationResults, format: 'csv' })
      });
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'reference_audit_report.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast('Downloaded CSV audit report!');
    } catch (e) {
      showToast('Export failed: ' + e.message);
    }
  });

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Initialize
  initTheme();
  // Auto-load sample 1 by default so client demo is ready on page load!
  loadSample('integrity-audit');
});
