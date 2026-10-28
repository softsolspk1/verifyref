// scripts/scrape-image-integrity.js
// Scrapes ImageTwin and Proofig platform data for Image Integrity in Research,
// formats clean Markdown and structured JSON, and saves everything to data/new.

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const BASE_OUT = path.resolve(__dirname, '..', 'data', 'new');

// Ensure directory exists
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// Robust HTTP GET with redirects and retry
function fetchUrl(targetUrl, maxRedirects = 5, retryCount = 2) {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) return reject(new Error(`Too many redirects: ${targetUrl}`));
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'https:' ? https : http;

    const req = client.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache'
      },
      timeout: 25000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirected = new URL(res.headers.location, targetUrl).toString();
        return resolve(fetchUrl(redirected, maxRedirects - 1, retryCount));
      }
      if (res.statusCode !== 200) {
        if (retryCount > 0) {
          setTimeout(() => resolve(fetchUrl(targetUrl, maxRedirects, retryCount - 1)), 1500);
          return;
        }
        return reject(new Error(`HTTP ${res.statusCode} for ${targetUrl}`));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({
        url: targetUrl,
        statusCode: res.statusCode,
        headers: res.headers,
        html: Buffer.concat(chunks).toString('utf8'),
        fetchedAt: new Date().toISOString()
      }));
    });

    req.on('error', (err) => {
      if (retryCount > 0) {
        setTimeout(() => resolve(fetchUrl(targetUrl, maxRedirects, retryCount - 1)), 2000);
      } else {
        reject(err);
      }
    });

    req.on('timeout', () => {
      req.destroy();
      if (retryCount > 0) {
        setTimeout(() => resolve(fetchUrl(targetUrl, maxRedirects, retryCount - 1)), 2000);
      } else {
        reject(new Error(`Timeout for ${targetUrl}`));
      }
    });
  });
}

// Convert HTML to clean readable Markdown
function htmlToMarkdown(html, baseUrl = '') {
  let title = '';
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) title = titleMatch[1].replace(/[\r\n\t]+/g, ' ').trim();

  let desc = '';
  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
                    html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i);
  if (descMatch) desc = descMatch[1].trim();

  // Strip scripts, styles, iframes, svgs, header, footer, nav boilerplate
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Try to find the main content if possible
  const mainMatch = cleaned.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
                    cleaned.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
                    cleaned.match(/<div[^>]*class=["'][^"']*(?:elementor-widget-theme-post-content|entry-content|post-content|content-area)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);

  // If a distinct main article/content was found, we can focus on it or use cleaned body
  let target = mainMatch ? mainMatch[1] : cleaned;

  // Headings
  target = target.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n');
  target = target.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n');
  target = target.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n');
  target = target.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n\n#### $1\n\n');

  // Lists
  target = target.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n* $1');
  target = target.replace(/<\/(ul|ol)>/gi, '\n\n');

  // Paragraphs and breaks
  target = target.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n\n$1\n\n');
  target = target.replace(/<br\s*[\/]?>/gi, '\n');
  target = target.replace(/<hr\s*[\/]?>/gi, '\n\n---\n\n');

  // Blockquotes
  target = target.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n');

  // Bold & Italic
  target = target.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  target = target.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  target = target.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  target = target.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');

  // Links
  target = target.replace(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (match, href, linkText) => {
    const cleanLinkText = linkText.replace(/<[^>]+>/g, '').trim();
    if (!cleanLinkText || href.startsWith('javascript:') || href.startsWith('#')) return cleanLinkText || '';
    try {
      const fullUrl = new URL(href, baseUrl).toString();
      return `[${cleanLinkText}](${fullUrl})`;
    } catch {
      return cleanLinkText;
    }
  });

  // Strip all other HTML tags
  target = target.replace(/<[^>]+>/g, ' ');

  // Decode common HTML entities
  target = target
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&rsquo;/g, "’")
    .replace(/&lsquo;/g, "‘")
    .replace(/&rdquo;/g, "”")
    .replace(/&ldquo;/g, "“")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&hellip;/g, "…")
    .replace(/&nbsp;/g, ' ');

  // Clean lines and whitespace
  const lines = target.split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, idx, arr) => {
      if (!line) return idx > 0 && arr[idx - 1] !== '';
      // Filter common navigation junk
      if (line === 'Skip to content' || line.startsWith('Copyright ©') || line === 'Manage options') return false;
      return true;
    });

  const markdown = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, description: desc, markdown };
}

// Scrape target configurations
const IMAGETWIN_TARGETS = [
  // Core Technology
  { id: 'it_home', category: 'core_technology', filename: 'product_overview.md', url: 'https://imagetwin.ai/' },
  { id: 'it_product', category: 'core_technology', filename: 'product_capabilities.md', url: 'https://imagetwin.ai/product/' },
  { id: 'it_duplication', category: 'core_technology', filename: 'duplication_detection.md', url: 'https://imagetwin.ai/image-duplication-detection/' },
  { id: 'it_plagiarism', category: 'core_technology', filename: 'plagiarism_detection.md', url: 'https://imagetwin.ai/image-plagiarism-detection/' },
  { id: 'it_manipulation', category: 'core_technology', filename: 'manipulation_detection.md', url: 'https://imagetwin.ai/image-manipulation-detection/' },
  { id: 'it_ai_image', category: 'core_technology', filename: 'ai_image_detection.md', url: 'https://imagetwin.ai/ai-image-detection/' },

  // Solutions
  { id: 'it_sol_publishers', category: 'solutions', filename: 'solutions_publishers.md', url: 'https://imagetwin.ai/solutions/publishers/' },
  { id: 'it_sol_researchers', category: 'solutions', filename: 'solutions_researchers.md', url: 'https://imagetwin.ai/solutions/researchers/' },
  { id: 'it_sol_institutions', category: 'solutions', filename: 'solutions_institutions.md', url: 'https://imagetwin.ai/solutions/institutions/' },
  { id: 'it_sol_universities', category: 'solutions', filename: 'solutions_universities.md', url: 'https://imagetwin.ai/solutions/universities/' },

  // User Manual & Guides
  { id: 'it_manual_home', category: 'user_manual', filename: 'manual_overview.md', url: 'https://user-manual.imagetwin.ai/' },
  { id: 'it_manual_how_to', category: 'user_manual', filename: 'how_to_use.md', url: 'https://user-manual.imagetwin.ai/how-to-use-imagetwin' },
  { id: 'it_manual_confidence', category: 'user_manual', filename: 'confidence_score_system.md', url: 'https://user-manual.imagetwin.ai/feature-tutorials/feature-tutorials/confidence-score' },
  { id: 'it_manual_detailed', category: 'user_manual', filename: 'detailed_image_analysis.md', url: 'https://user-manual.imagetwin.ai/detailed-image-analysis' },
  { id: 'it_manual_expert_tips', category: 'user_manual', filename: 'figure_screening_expert_tips.md', url: 'https://user-manual.imagetwin.ai/detailed-image-analysis/detailed-image-analysis-1/figure-screening-tips-from-an-image-integrity-expert' },
  { id: 'it_manual_xrd', category: 'user_manual', filename: 'xrd_plot_analysis.md', url: 'https://user-manual.imagetwin.ai/detailed-image-analysis/detailed-image-analysis-1/xrd-plot-analysis' },
  { id: 'it_manual_panel_adj', category: 'user_manual', filename: 'manual_panel_adjustment.md', url: 'https://user-manual.imagetwin.ai/feature-tutorials/feature-tutorials/manual-panel-adjustment' },
  { id: 'it_manual_private_repo', category: 'user_manual', filename: 'private_repository.md', url: 'https://user-manual.imagetwin.ai/feature-tutorials/feature-tutorials/private-repository' },
  { id: 'it_manual_faq', category: 'user_manual', filename: 'faq.md', url: 'https://user-manual.imagetwin.ai/frequently-asked-questions' },
  { id: 'it_manual_api', category: 'user_manual', filename: 'api_documentation.md', url: 'https://user-manual.imagetwin.ai/api-documentation' },
  { id: 'it_manual_pdf_report', category: 'user_manual', filename: 'pdf_reports.md', url: 'https://user-manual.imagetwin.ai/feature-tutorials/feature-tutorials/pdf-report' },

  // Technical Articles & Deep Dives
  { id: 'it_art_detect_manip', category: 'technical_articles', filename: 'how_imagetwin_detects_manipulation.md', url: 'https://imagetwin.ai/posts/how-imagetwin-detects-manipulation-in-western-blots-microscopy-facs-xrd-plots-graphs-and-more/' },
  { id: 'it_art_wb_manip', category: 'technical_articles', filename: 'stronger_western_blot_manipulation_detection.md', url: 'https://imagetwin.ai/posts/stronger-western-blot-manipulation-detection/' },
  { id: 'it_art_wb_ai_dup', category: 'technical_articles', filename: 'ai_powered_western_blot_duplicate_detection.md', url: 'https://imagetwin.ai/posts/new-ai-powered-duplicate-detection-for-western-blot-images/' },
  { id: 'it_art_facs', category: 'technical_articles', filename: 'facs_duplicate_detection.md', url: 'https://imagetwin.ai/posts/facs-duplicate-detection-higher-accuracy-now-also-within-images/' },
  { id: 'it_art_asm_case', category: 'technical_articles', filename: 'asm_case_study_screening.md', url: 'https://imagetwin.ai/posts/case-study-how-asm-strengthens-image-integrity-screening-with-imagetwin/' },
  { id: 'it_art_expert_review', category: 'technical_articles', filename: 'expert_image_integrity_review.md', url: 'https://imagetwin.ai/posts/behind-the-screen-how-a-20-year-image-integrity-expert-actually-reviews-a-paper/' },
  { id: 'it_art_compare_alt', category: 'technical_articles', filename: 'comparing_image_integrity_software.md', url: 'https://imagetwin.ai/posts/choose-your-image-integrity-software-how-imagetwin-compares-to-the-alternatives/' },
  { id: 'it_art_aries', category: 'technical_articles', filename: 'aries_editorial_workflow_integration.md', url: 'https://imagetwin.ai/posts/imagetwin-partners-with-aries-systems-to-enable-image-integrity-screening-in-the-editorial-workflow/' }
];

const PROOFIG_TARGETS = [
  // Core Technology
  { id: 'pf_home', category: 'core_technology', filename: 'proofig_overview.md', url: 'https://www.proofig.com/' },
  { id: 'pf_manipulation', category: 'core_technology', filename: 'alteration_and_manipulation_detection.md', url: 'https://www.proofig.com/image-manipulation-detection/' },
  { id: 'pf_duplication', category: 'core_technology', filename: 'duplication_and_reuse_detection.md', url: 'https://www.proofig.com/image-duplication-detection/' },
  { id: 'pf_plagiarism', category: 'core_technology', filename: 'pubmed_source_plagiarism_detection.md', url: 'https://www.proofig.com/image-plagiarism-detection/' },
  { id: 'pf_ai_image', category: 'core_technology', filename: 'ai_generated_image_detection.md', url: 'https://www.proofig.com/ai-generated-image-detection/' },
  { id: 'pf_self_plagiarism', category: 'core_technology', filename: 'self_plagiarism_prevention_my_database.md', url: 'https://www.proofig.com/image-self-plagiarism-prevention-my-database/' },
  { id: 'pf_pubshield', category: 'core_technology', filename: 'pubshield_compliance_hub.md', url: 'https://www.proofig.com/pubshield/' },
  { id: 'pf_refguard', category: 'core_technology', filename: 'refguard_reference_checker.md', url: 'https://www.proofig.com/refguard/' },

  // Workflows & Stakeholders
  { id: 'pf_publishers', category: 'workflows_and_ethics', filename: 'proofig_for_publishers.md', url: 'https://www.proofig.com/proofig-for-publishers/' },
  { id: 'pf_ethics', category: 'workflows_and_ethics', filename: 'proofig_for_scientific_ethics.md', url: 'https://www.proofig.com/proofig-for-scientific-ethics/' },
  { id: 'pf_researchers', category: 'workflows_and_ethics', filename: 'proofig_for_researchers.md', url: 'https://www.proofig.com/proofig-for-researchers/' },
  { id: 'pf_institutions', category: 'workflows_and_ethics', filename: 'proofig_for_research_institutions.md', url: 'https://www.proofig.com/proofig-for-research-institutions/' },
  { id: 'pf_faq', category: 'workflows_and_ethics', filename: 'faq_scientific_images.md', url: 'https://www.proofig.com/faq-proofig-scientific-images/' },

  // Technical & Editorial Articles
  { id: 'pf_art_avoid_issues', category: 'technical_articles', filename: 'avoiding_common_image_issues.md', url: 'https://www.proofig.com/scientific-publication-process/avoiding-common-image-issues-in-scientific-research-best-practices-for-academic-images/' },
  { id: 'pf_art_overview', category: 'technical_articles', filename: 'overview_image_integrity_life_science.md', url: 'https://www.proofig.com/scientific-publication-process/overview-of-image-integrity-in-life-science-publications/' },
  { id: 'pf_art_diversity', category: 'technical_articles', filename: 'life_science_image_diversity.md', url: 'https://www.proofig.com/life-science-images/life-science-image-type-diversity-exploring-the-spectrum-of-life-science-images/' },
  { id: 'pf_art_ai_leap', category: 'technical_articles', filename: 'ai_generated_image_detection_leap.md', url: 'https://www.proofig.com/ai-technology/ai-generated-image-detection-a-leap-in-scientific-integrity/' },
  { id: 'pf_art_cope_guide', category: 'technical_articles', filename: 'cope_aligned_editorial_workflow_guide.md', url: 'https://www.proofig.com/image-integrity-in-life-science/integrating-ai-tools-with-editorial-workflows-a-cope-aligned-guide-for-image-int/' },
  { id: 'pf_art_retraction_risk', category: 'technical_articles', filename: 'reducing_retraction_risks_presubmission.md', url: 'https://www.proofig.com/image-integrity-in-life-science/reducing-retraction-risks-the-role-of-proofig-ai-in-pre-submission-checks/' },
  { id: 'pf_art_desk_reject', category: 'technical_articles', filename: 'reducing_desk_rejections_prescreening.md', url: 'https://www.proofig.com/image-integrity-in-life-science/using-image-analysis-to-reduce-desk-rejections-a-pre-screening-strategy-for-edit/' },
  { id: 'pf_art_ensure_integ', category: 'technical_articles', filename: 'ensuring_image_integrity_before_submission.md', url: 'https://www.proofig.com/image-integrity-in-life-science/ensuring-image-integrity-before-submission-for-publication/' },
  { id: 'pf_art_high_stakes', category: 'technical_articles', filename: 'high_stakes_image_integrity_risks.md', url: 'https://www.proofig.com/life-science-images/high-stakes-image-integrity-risks-in-life-science/' },
  { id: 'pf_art_pre_pub_tools', category: 'technical_articles', filename: 'pre_publication_tools_life_science.md', url: 'https://www.proofig.com/ai-technology/pre-publication-tools-for-image-integrity-in-life-science/' },
  { id: 'pf_art_post_pub_tools', category: 'technical_articles', filename: 'post_publication_tools_detection.md', url: 'https://www.proofig.com/ai-technology/post-publication-tools-for-image-integrity-issue-detection/' },
  { id: 'pf_art_importance', category: 'technical_articles', filename: 'unveiling_importance_image_integrity.md', url: 'https://www.proofig.com/ai-technology/unveiling-the-importance-of-image-integrity-in-academic-publications-why-image-verification-matters/' }
];

async function runScraper() {
  console.log('================================================================');
  console.log('   IMAGE INTEGRITY DATA SCRAPER: IMAGETWIN & PROOFIG');
  console.log('   Target Directory: ' + BASE_OUT);
  console.log('================================================================');

  ensureDir(BASE_OUT);
  ensureDir(path.join(BASE_OUT, 'imagetwin', 'raw'));
  ensureDir(path.join(BASE_OUT, 'proofig', 'raw'));
  ensureDir(path.join(BASE_OUT, 'taxonomy'));
  ensureDir(path.join(BASE_OUT, 'editorial_guidelines'));
  ensureDir(path.join(BASE_OUT, 'benchmarks'));

  const manifest = {
    generatedAt: new Date().toISOString(),
    purpose: 'Image Integrity in Research dataset and specifications extracted from ImageTwin and Proofig for PJPS Data Integrity System / Image Screening Platform',
    sourcePlatforms: {
      ImageTwin: {
        baseUrl: 'https://imagetwin.ai',
        manualUrl: 'https://user-manual.imagetwin.ai',
        description: 'AI-based scientific image integrity software detecting duplication, manipulation, plagiarism across 160M+ figures, and AI-generated images.'
      },
      Proofig: {
        baseUrl: 'https://www.proofig.com',
        description: 'AI computer-vision image integrity platform detecting duplication (rotate, flip, scale), alteration (cloning, splicing), PubMed plagiarism (155M+ open-access figures), and generative AI visuals.'
      }
    },
    items: []
  };

  // Helper to process a list of targets
  async function processTargets(vendor, targets) {
    console.log(`\n--- Starting scraping for ${vendor.toUpperCase()} (${targets.length} pages) ---`);
    for (const t of targets) {
      const outCategoryDir = path.join(BASE_OUT, vendor, t.category);
      ensureDir(outCategoryDir);
      const outMdPath = path.join(outCategoryDir, t.filename);
      const rawJsonPath = path.join(BASE_OUT, vendor, 'raw', `${t.id}.json`);

      console.log(`Fetching: [${t.category}] ${t.filename} from ${t.url}`);
      try {
        const fetched = await fetchUrl(t.url);
        const parsed = htmlToMarkdown(fetched.html, t.url);

        // Save raw JSON
        fs.writeFileSync(rawJsonPath, JSON.stringify({
          id: t.id,
          vendor,
          category: t.category,
          filename: t.filename,
          url: t.url,
          title: parsed.title,
          description: parsed.description,
          fetchedAt: fetched.fetchedAt,
          statusCode: fetched.statusCode,
          headers: fetched.headers,
          htmlLength: fetched.html.length,
          html: fetched.html
        }, null, 2), 'utf8');

        // Formatted Markdown header
        const mdHeader = [
          `# ${parsed.title || t.filename.replace(/\.md$/, '').replace(/_/g, ' ').toUpperCase()}`,
          '',
          `> **Platform**: ${vendor === 'imagetwin' ? 'ImageTwin' : 'Proofig'}`,
          `> **Category**: ${t.category}`,
          `> **Source URL**: [${t.url}](${t.url})`,
          `> **Scraped Date**: ${fetched.fetchedAt}`,
          parsed.description ? `> **Summary**: ${parsed.description}` : '',
          '',
          '---',
          '',
          parsed.markdown
        ].filter(Boolean).join('\n');

        fs.writeFileSync(outMdPath, mdHeader, 'utf8');

        manifest.items.push({
          id: t.id,
          vendor,
          category: t.category,
          title: parsed.title,
          url: t.url,
          markdownFile: path.relative(BASE_OUT, outMdPath).replace(/\\/g, '/'),
          rawFile: path.relative(BASE_OUT, rawJsonPath).replace(/\\/g, '/'),
          length: parsed.markdown.length,
          timestamp: fetched.fetchedAt
        });

        console.log(`  ✓ Saved: ${t.filename} (${parsed.markdown.length} chars)`);
      } catch (err) {
        console.error(`  ✗ Error scraping ${t.url}: ${err.message}`);
      }

      // Small pause to be polite
      await new Promise(r => setTimeout(r, 600));
    }
  }

  // 1. Scrape ImageTwin targets
  await processTargets('imagetwin', IMAGETWIN_TARGETS);

  // 2. Scrape Proofig targets
  await processTargets('proofig', PROOFIG_TARGETS);

  // 3. Save Summary Manifest
  fs.writeFileSync(path.join(BASE_OUT, 'summary_manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\n✓ Manifest saved to: ${path.join(BASE_OUT, 'summary_manifest.json')}`);

  console.log('\nScraping phase complete! Total items processed:', manifest.items.length);
}

runScraper().catch(err => {
  console.error('Fatal error in scraper:', err);
  process.exit(1);
});
