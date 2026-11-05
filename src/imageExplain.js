// imageExplain.js - Module 5: a plain-language explanation of each image finding for the editor, on screen and in the
// Word / PDF report. Built from what the detectors measured (similarity, noise pattern, matching points or blocks,
// transformation, where the areas are in the panel) - so the report says what was found, where, how sure the
// measurement is, what harmless causes are possible and what to check or ask the authors. Derived on every read and
// export, so earlier reports get the same wording.

const pct = v => `${Math.round(v * 100)}%`;
const CHANNELS = /different colour channels/i;

// a similarity of two pictures (0-1) in words
function similarityWords(v) {
  if (!Number.isFinite(v)) return null;
  if (v >= 0.97) return `${pct(v)} - practically identical pixel for pixel`;
  if (v >= 0.9) return `${pct(v)} - very close; small differences of the kind left by resizing, compression or a light contrast change`;
  return `${pct(v)} - close (Module 5 reports a match only from 80%); differences may come from compression, contrast changes or partial editing`;
}
// agreement of the fine grain (camera / sensor noise, film grain) - the photographic "fingerprint" of a picture
function noiseWords(v) {
  if (!Number.isFinite(v)) return null;
  if (v >= 0.8) return `${v.toFixed(2)} - the same fine grain. Two separate photographs never share their grain, even of the same sample, so this is strong evidence that both come from one original picture`;
  if (v >= 0.5) return `${v.toFixed(2)} - largely the same fine grain: very likely one original picture, re-saved or compressed in between`;
  if (v >= 0.3) return `${v.toFixed(2)} - partly the same fine grain; consistent with one picture that was re-saved, compressed or resized, but weaker evidence than the picture match alone`;
  return `${v.toFixed(2)} - the fine grain differs; the areas look alike but may be two different pictures`;
}
function transformWords(t) {
  if (!t) return null;
  const deg = ((Math.round((t.rotation || 0) * 180 / Math.PI) % 360) + 360) % 360;
  const parts = [];
  if (t.flip) parts.push('mirrored (flipped left to right)');
  if (deg > 3 && deg < 357) parts.push(`rotated by ${deg > 180 ? deg - 360 : deg}°`);
  if (t.scale && Math.abs(t.scale - 1) > 0.08) parts.push(`${t.scale > 1 ? 'enlarged' : 'reduced'} to ${Math.round(t.scale * 100)}% of the size`);
  return parts.length ? parts.join(', ') : null;
}
// where a box lies in its panel: "upper left", "centre", ... and its size
function placeOf(box, panel) {
  if (!box || !panel || !panel.w || !panel.h) return null;
  const cx = (box.x + box.w / 2 - panel.x) / panel.w, cy = (box.y + box.h / 2 - panel.y) / panel.h;
  const v = cy < 0.34 ? 'upper' : cy > 0.66 ? 'lower' : '', h = cx < 0.34 ? 'left' : cx > 0.66 ? 'right' : '';
  const where = v && h ? `${v} ${h}` : v ? `${v} middle` : h ? `middle ${h}` : 'centre';
  const share = Math.round(100 * (box.w * box.h) / (panel.w * panel.h));
  return { where, size: `about ${Math.max(1, box.w)} × ${Math.max(1, box.h)} px${share >= 1 && share < 95 ? `, ${share}% of the panel` : ''}` };
}
const num = (re, s) => { const m = String(s || '').match(re); return m ? Number(m[1]) : null; };

function duplicate(f) {
  const v = f.verification || {};
  // the external web search reports the figure itself, not two panels of the manuscript
  if (f.a.panel === f.b.panel) {
    return {
      headline: `${f.a.label} was found on the web: the same figure, or a modified copy of it, has been published elsewhere.`,
      how: 'The whole figure was searched on the web by image (reverse image search). "Exact" copies are the same picture; "modified" copies are cropped, resized or recoloured versions of it.',
      evidence: [f.description, ...(f.details || []).length ? ['The pages where the copies were found are listed under Details.'] : []],
      meaning: 'A figure that already exists elsewhere is either the authors\' own earlier publication (which must be cited, with the publisher\'s permission) or someone else\'s figure presented as new data.',
      innocent: ['The authors\' own earlier paper or preprint, cited in the manuscript', 'A standard reference image (structure, apparatus, map) reproduced with permission', 'The manuscript itself already posted online (preprint server, conference poster, thesis)'],
      check: ['Open the listed pages and compare the figure', 'Check whether the manuscript cites that source in the figure legend', 'If the source is not the authors\' own, treat it as possible image plagiarism'],
      ask: `Please state where ${f.a.label} was first published, cite the source in the legend and send the publisher's permission, or explain why the same figure appears elsewhere.`
    };
  }
  const tw = transformWords(f.transform);
  const channels = CHANNELS.test(f.description || '');
  const evidence = [];
  if (Number.isFinite(v.picture)) evidence.push(`Picture similarity at full resolution: ${similarityWords(v.picture)}.`);
  else if (Number.isFinite(f.score)) evidence.push(`Overall similarity of the two panels (thumbnail correlation): ${f.score}${f.score >= 0.97 ? ' - practically the same picture' : ''}.`);
  if (Number.isFinite(v.noise)) evidence.push(`Fine noise pattern: ${noiseWords(v.noise)}.`);
  evidence.push(tw ? `Transformation: the second panel is the first one ${tw}. Turning an image hides a duplicate from the eye, so this deserves particular attention.` : 'Transformation: none - same orientation and size.');
  if (!Number.isFinite(v.picture)) evidence.push('No full-resolution comparison was possible (for example a chart or graph without photographic grain), so the match rests on the overall picture only.');
  return {
    headline: `${f.a.label} and ${f.b.label} show the same image${tw ? `, ${tw}` : ''}. Panels presented as different experiments, samples or conditions should never be the same photograph.`,
    how: 'Every pair of panels in the manuscript is compared. A compact fingerprint of each panel is matched in all orientations (rotated, mirrored, resized, cropped); candidate pairs are then aligned and compared pixel by pixel at full resolution, including their fine grain (noise pattern), which is unique to each photograph.',
    evidence,
    meaning: channels
      ? 'The two panels show one picture in different colour channels. This is usually one microscopy field shown as a merged image and as its single channels - normal practice, and only a problem if the legend calls them different samples.'
      : 'If the two panels are described as different samples, treatments, time points or experiments, the same photograph cannot be correct: either an error in assembling the figure, or the same result presented as two.',
    innocent: ['The same control or reference image deliberately shown in two figures, and said so in the legend', 'One microscopy field shown as a merge and as single channels', 'An overview and an enlarged inset of the same field (the inset is a crop of the overview)', 'A figure placed twice in the file (in the text and again at the end) - such repeats are already removed automatically'],
    check: ['Read both figure legends: do they describe different samples or conditions?', 'Open the forensic viewer and compare distinctive details (dust, bubbles, cell shapes, band edges) in both panels', ...(tw ? ['In the viewer, compare with the stated rotation / mirroring applied'] : []), 'Mark the finding as Confirmed, False alarm or Ask the authors'],
    ask: `${f.a.label} and ${f.b.label} appear to show the same image${tw ? ` (${tw})` : ''}. Please explain, and send the original, unprocessed image files for both panels.`
  };
}

function clone(f, panel) {
  const v = f.verification || {};
  const keypoints = f.code === 'keypoints' || (f.code !== 'blocks' && /matching points/.test(f.description || ''));
  const n = Number(f.score) || num(/(\d+) matching (?:points|blocks)/, f.description);
  const picture = Number.isFinite(v.picture) ? v.picture : num(/(\d+)% similar/, f.description) / 100 || num(/pixel match ([\d.]+)/, f.description);
  const noise = Number.isFinite(v.noise) ? v.noise : num(/noise pattern ([\d.]+)/, f.description);
  const A = placeOf(f.a.box, panel), B = placeOf(f.b.box, panel);
  const tw = transformWords(f.transform);
  const gap = f.a.box && f.b.box ? Math.round(Math.hypot((f.a.box.x + f.a.box.w / 2) - (f.b.box.x + f.b.box.w / 2), (f.a.box.y + f.a.box.h / 2) - (f.b.box.y + f.b.box.h / 2))) : null;
  const evidence = [];
  if (A && B) evidence.push(`Location: the original area (red outline) is in the ${A.where} of the panel and the copy (blue outline) in the ${B.where}${gap ? `, ${gap} px apart` : ''}; each is ${A.size}.`);
  evidence.push(keypoints
    ? `${n} distinctive points (corners, band edges, cell outlines) in one area reappear in the other with the same arrangement${n >= 15 ? ' - well above the 11 points at which clean images stop' : ''}.`
    : `${n} small 8 × 8-pixel blocks of one area reappear, in the same arrangement, in the other area${n >= 80 ? ' - a large copied region' : ''}.`);
  if (picture) evidence.push(`Pixel similarity of the two areas: ${similarityWords(picture)}.`);
  if (Number.isFinite(noise)) evidence.push(`Fine noise pattern of the two areas: ${noiseWords(noise)}.`);
  evidence.push(tw ? `The copy is ${tw} relative to the original area.` : 'The copy has the same orientation and size as the original area.');
  return {
    headline: `Inside ${f.a.label}, one area appears to have been copied and pasted onto another place of the same picture. In a genuine photograph no two areas are pixel-for-pixel alike.`,
    how: keypoints
      ? 'Distinctive points of the panel are matched against the rest of the same panel; a group of points that all move together by the same shift (and rotation / scale) marks a copied area. The two areas are then compared pixel by pixel, including their fine grain.'
      : 'The panel is cut into small overlapping blocks; blocks with the same content that repeat at the same offset mark a copied area (this survives JPEG re-saving). The two areas are then compared pixel by pixel, including their fine grain.',
    evidence,
    meaning: 'Copying part of an image onto itself is used to hide something (covering a band, a cell, a defect or background) or to add something that was not there (duplicating bands, cells or colonies). Both change what the figure shows.',
    innocent: ['Regular, repetitive structures: a ladder or marker lane, a grid, a mesh, crystals, evenly spaced wells', 'Plain or uniform background (blank membrane, empty slide, overexposed areas) that looks alike everywhere', 'Labels, arrows, scale bars or symbols repeated inside the panel'],
    check: ['Open the forensic viewer and look at both outlined areas: is it image content (bands, cells, tissue) or a label / repeated pattern?', 'Compare distinctive details (specks, edges, texture) inside the red and blue outlines', 'If it is real image content, mark it Confirmed or Ask the authors; if it is a regular pattern or a label, mark it False alarm'],
    ask: `In ${f.a.label}, the area in the ${B ? B.where : 'marked region'} appears to be a copy of the area in the ${A ? A.where : 'other marked region'} of the same image. Please explain, and send the original, unprocessed image file (for blots and gels, the full uncropped membrane / gel).`
  };
}

// alteration types: what the detector measured, what it means, and its harmless explanations
const ALTERATIONS = {
  noise: d => {
    const noisier = /noisier/.test(d);
    return {
      title: `Area with ${noisier ? 'more' : 'less'} image noise than the rest of the picture`,
      how: 'Every camera or scanner leaves a fine, even grain over the whole picture, stronger in brighter parts. The panel is divided into small blocks and the grain of each block is compared with blocks of the same brightness; a group of blocks whose grain is clearly different (more than 2.6 times higher or lower) is flagged.',
      evidence: `This area is clearly ${noisier ? 'noisier' : 'smoother'} than parts of the image with the same brightness.`,
      meaning: `A patch with a different grain usually ${noisier ? 'came from another picture (pasted in)' : 'was pasted from another, cleaner picture, or was smoothed / painted over'}.`,
      innocent: ['Areas that were out of focus or over-/under-exposed', 'Very different structures within one image (dense tissue next to empty background)', 'Local noise reduction applied by the camera software']
    };
  },
  smooth: () => ({
    title: 'Unnaturally smooth area with no image noise',
    how: 'Each small block of the panel is checked for the fine grain every camera leaves; a group of blocks that has practically none, in a picture that is otherwise grainy, is flagged.',
    evidence: 'In this area the fine grain is missing completely, although the rest of the picture has it.',
    meaning: 'An area without any noise is typical of something being erased, painted over or covered with a flat patch (for example to remove a band, a spot or a background artefact).',
    innocent: ['Fully saturated (pure white or pure black) areas, which are flat by nature', 'A flat area added by the figure software (label background, inset frame)', 'Strong denoising of the whole picture by the acquisition software']
  }),
  grid: () => ({
    title: 'Area with a different JPEG compression grid',
    how: 'A JPEG picture is stored in 8 × 8-pixel blocks, which leave a faint regular grid. All blocks of one photograph share the same grid position; an area whose grid is shifted relative to the rest is flagged.',
    evidence: 'This area\'s compression grid does not line up with the grid of the rest of the picture.',
    meaning: 'A shifted grid shows that this area was compressed separately - the classic sign of content cut from one JPEG and pasted into another.',
    innocent: ['A label, arrow or inset added to the figure after the photo was taken', 'A figure assembled from several JPEG files where the panel boundary was not detected']
  }),
  'splice-edge': d => {
    const dir = /vertical/.test(d) ? 'vertical' : 'horizontal', grey = num(/\((\d+) grey levels\)/, d);
    return {
      title: `Straight ${dir} seam in the background of the blot / gel`,
      how: `The background brightness of the blot is followed across the image; a sharp, straight step in it that runs along the whole ${dir === 'vertical' ? 'height' : 'width'} is flagged (clean blots stayed below about 11 grey levels).`,
      evidence: `The background jumps by ${grey ? `${grey} grey levels` : 'a clear step'} along a straight ${dir} line across the whole blot.`,
      meaning: 'A straight seam usually means that lanes were cut from different blots or gels (or different exposures) and joined. Splicing is acceptable only if the junction is clearly shown (a gap or a line) and stated in the legend.',
      innocent: ['A splice that is marked in the figure and explained in the legend', 'The edge of a membrane, the gel well or the comb', 'Uneven transfer or exposure that happens to be straight']
    };
  },
  histogram: d => {
    const missing = num(/\((\d+)% of grey levels missing\)/, d);
    return {
      title: 'Brightness or contrast stretched after capture',
      how: 'The brightness levels of the panel are counted. A picture straight from the camera uses all neighbouring grey levels; after the contrast is stretched, some levels are skipped, giving a comb-shaped histogram.',
      evidence: `${missing ? `${missing}% of` : 'Many of'} the grey levels within the used range are missing.`,
      meaning: 'The contrast or levels were adjusted. Moderate, global adjustment applied to the whole image is acceptable; strong adjustment can make faint bands disappear or appear and change how intensities compare.',
      innocent: ['Normal global brightness / contrast adjustment applied to the whole picture (acceptable when the original is available)', 'An 8-bit export of a 16-bit scientific image', 'Images converted between colour and greyscale']
    };
  },
  saturated: d => {
    const share = num(/^(\d+)% of the pixels/, d);
    return {
      title: 'Saturated (over-exposed) bands',
      how: 'The panel\'s pixels are counted by brightness; in a blot, a large share of pure black pixels means the signal hit the limit of the detector or of the adjustment.',
      evidence: `${share ? `${share}%` : 'A large share'} of the pixels are pure black.`,
      meaning: 'Saturated bands cannot be compared or quantified: their true intensity is lost. If the figure supports a quantification (densitometry), the numbers cannot come from this image.',
      innocent: ['A deliberately long exposure to show faint bands, with quantification done on a shorter exposure', 'A strong loading control band']
    };
  }
};
function alterationCode(f) {
  if (ALTERATIONS[f.code]) return f.code;
  const d = (f.description || '').toLowerCase();
  if (/compression grid/.test(d)) return 'grid';
  if (/step in the background|lanes cut/.test(d)) return 'splice-edge';
  if (/histogram/.test(d)) return 'histogram';
  if (/pure black|saturated/.test(d)) return 'saturated';
  if (/unnaturally smooth|erasure/.test(d)) return 'smooth';
  return 'noise';
}
function alteration(f, panel) {
  const k = alterationCode(f), x = ALTERATIONS[k](f.description || '');
  let P = placeOf(f.a.box, panel);
  const local = P && f.a.box && panel && f.a.box.w * f.a.box.h < 0.8 * panel.w * panel.h;
  // a seam is a line across the panel: give its position, not a region
  if (P && k === 'splice-edge') {
    const vertical = f.a.box.h > f.a.box.w, at = vertical ? (f.a.box.x + f.a.box.w / 2 - panel.x) / panel.w : (f.a.box.y + f.a.box.h / 2 - panel.y) / panel.h;
    P = { where: `${Math.round(at * 100)}% of the way ${vertical ? 'across from the left' : 'down from the top'}`, size: `a ${vertical ? 'vertical' : 'horizontal'} line across the whole ${vertical ? 'height' : 'width'}` };
  }
  return {
    headline: `${f.a.label}: ${x.title.toLowerCase()}${local ? `, ${k === 'splice-edge' ? 'along a line' : 'in the'} ${P.where}${k === 'splice-edge' ? '' : ' of the panel'}` : ''}. This is a sign that the picture may have been edited after it was taken.`,
    how: x.how,
    evidence: [x.evidence, ...(local ? [k === 'splice-edge' ? `Location: ${P.size}, ${P.where}, outlined in the pictures below.` : `Location: the ${P.where} of the panel (${P.size}), outlined in the pictures below.`] : ['The measurement concerns the whole panel.']), ...(f.level === 'high' ? ['Two independent checks flagged the same area, which makes it a strong finding.'] : [])],
    meaning: x.meaning,
    innocent: x.innocent,
    check: ['Compare the original and the enhanced view below: erased, pasted or retouched areas often stand out once the contrast is raised', 'Open the forensic viewer and inspect the outlined area at full size', 'Ask for the original, unprocessed image when the edit would change what the figure shows'],
    ask: `Our screening flagged ${f.a.label}: ${x.title.toLowerCase()}${local ? ` (${k === 'splice-edge' ? `seam ${P.where}` : `${P.where} of the panel`})` : ''}. Please send the original, unprocessed image file${/splice|saturat/.test(k) ? ' (the full, uncropped blot / gel and, for quantified bands, a non-saturated exposure)' : ''} and describe any processing applied.`
  };
}

/** The explanation of one finding, or null for kinds explained by their own description (overlap, AI, charts) */
function explainFinding(f, panel = null) {
  try {
    if (f.kind === 'duplicate') return duplicate(f);
    if (f.kind === 'clone') return clone(f, panel);
    if (f.kind === 'alteration') return alteration(f, panel);
  } catch { /* an unusual saved finding: shown with its description only */ }
  return null;
}

/** Adds `explanation` to every finding of a Module 5 result in place; returns the result */
function explainReport(r) {
  if (!r || !Array.isArray(r.findings)) return r;
  const boxes = new Map((r.panels || []).map(p => [p.id, p.box]));
  for (const f of r.findings) {
    if (!f?.a) continue;
    const e = explainFinding(f, boxes.get(f.a.panel) || null);
    if (e) f.explanation = e; else delete f.explanation;
  }
  return r;
}

module.exports = { explainFinding, explainReport };
