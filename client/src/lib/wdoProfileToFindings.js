// Map a resolved property profile (from the WDO Intelligence lookup —
// construction, foundation, roof, year built, sq ft, stories) onto WDO
// inspection findings fields. Suggestions only: the tech reviews and applies,
// and everything stays editable for on-site verification.

function clean(v) {
  return String(v ?? '').trim();
}
function has(v) {
  return clean(v) !== '';
}

const WDO_CONSTRUCTION_OPTIONS = [
  'CMU / Concrete Masonry Unit',
  'Wood Frame',
  'Metal Frame',
  'Manufactured / Mobile Home',
];

export function describeStructure(profile = {}) {
  const parts = [];
  if (profile.stories) parts.push(`${profile.stories}-story`);
  const cm = clean(profile.constructionMaterial || profile.construction_material).toLowerCase();
  if (/(block|masonry|concrete|\bcb\b|cbs|cmu)/.test(cm)) parts.push('concrete block / masonry');
  else if (/(manufactured|mobile|modular)/.test(cm)) parts.push('manufactured / mobile');
  else if (/(metal|steel|aluminum)/.test(cm)) parts.push('metal frame');
  else if (/(^|[\W_])wood(?:en)?([\W_]|$)|(^|[\W_])wood[_\s-]*frame([\W_]|$)|^frame$/.test(cm)) parts.push('wood frame');
  const s = `${parts.join(' ')} single-family residential structure`.replace(/\s+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function describeConstructionType(profile = {}) {
  const candidates = [
    profile.constructionMaterial,
    profile.construction_material,
    profile.structureType,
    profile.structure_type,
    profile.propertyType,
    profile.property_type,
  ].map((item) => clean(item)).filter(Boolean);
  for (const candidate of candidates) {
    if (WDO_CONSTRUCTION_OPTIONS.includes(candidate)) return candidate;
    const lower = candidate.toLowerCase();
    if (/\b(cmu|cbs|cb|concrete\s+masonry|masonry\s+unit|masonry|block|concrete\s+block)\b/.test(lower)) {
      return 'CMU / Concrete Masonry Unit';
    }
    if (/\b(manufactured|mobile|modular)\b/.test(lower)) return 'Manufactured / Mobile Home';
    if (/\b(metal|steel|aluminum)\b/.test(lower)) return 'Metal Frame';
    if (/(^|[\W_])wood(?:en)?([\W_]|$)|(^|[\W_])wood[_\s-]*frame([\W_]|$)|^frame$/.test(lower)) return 'Wood Frame';
  }
  return '';
}

export function applyProfileToWdoFindings(prev, profile, { overwrite = false } = {}) {
  if (!profile) return prev;
  const next = { ...prev };
  const set = (k, v) => {
    if (has(v) && (overwrite || !has(next[k]))) next[k] = String(v);
  };
  const append = (k, line) => {
    if (!has(line)) return;
    const cur = clean(next[k]);
    if (cur.includes(line)) return;
    next[k] = cur ? `${cur}\n${line}` : line;
  };

  if (profile.squareFootage) set('structure_sqft', String(profile.squareFootage));
  if (profile.stories || has(profile.constructionMaterial) || has(profile.construction_material)) {
    set('structures_inspected', describeStructure(profile));
  }
  set('structure_type', describeConstructionType(profile));

  const ft = clean(profile.foundationType).toLowerCase();
  if (ft.includes('slab')) append('inaccessible_areas', 'Crawlspace: N/A — slab-on-grade foundation.');
  else if (ft.includes('crawl')) append('inaccessible_areas', 'Crawlspace present — verify access and clearance on site.');

  const ctx = [];
  if (profile.yearBuilt) ctx.push(`Year built ${profile.yearBuilt}.`);
  if (has(profile.constructionMaterial)) ctx.push(`Construction: ${clean(profile.constructionMaterial)}.`);
  if (has(profile.roofType)) ctx.push(`Roof: ${clean(profile.roofType)}.`);
  if (ctx.length) append('comments', `Property record: ${ctx.join(' ')} (verify on site).`);

  return next;
}

export function summarizeFumigation(f) {
  if (!f) return '';
  return [
    has(f.fumigant) ? clean(f.fumigant) : '',
    has(f.date) ? `treated ${clean(f.date)}` : '',
    has(f.company) ? `by ${clean(f.company)}` : '',
    has(f.notes) ? clean(f.notes) : '',
  ].filter(Boolean).join(', ');
}

// Map a resolved WDO treatment/permit history onto FDACS Section 4 findings.
export function applyHistoryToWdoFindings(prev, history, { overwrite = false } = {}) {
  if (!history) return prev;
  const next = { ...prev };
  const set = (k, v) => {
    if (has(v) && (overwrite || !has(next[k]))) next[k] = String(v);
  };
  const append = (k, line) => {
    if (!has(line)) return;
    const cur = clean(next[k]);
    if (cur.includes(line)) return;
    next[k] = cur ? `${cur}\n${line}` : line;
  };

  if (history.previousTreatment === 'yes') set('previous_treatment_evidence', 'Yes');
  else if (history.previousTreatment === 'no') set('previous_treatment_evidence', 'No');

  const notes = [];
  if (has(history.treatmentNotes)) notes.push(clean(history.treatmentNotes));
  const fum = summarizeFumigation(history.fumigation);
  if (fum) notes.push(fum);
  if (notes.length) set('previous_treatment_notes', notes.join(' '));

  const ctx = [];
  if (history.roofPermitYear) ctx.push(`Re-roof permit ${history.roofPermitYear}.`);
  if (Array.isArray(history.permits) && history.permits.length) {
    const list = history.permits
      .map((p) => [clean(p.type), clean(p.date)].filter(Boolean).join(' '))
      .filter(Boolean).slice(0, 5).join('; ');
    if (list) ctx.push(`Permits: ${list}.`);
  }
  if (ctx.length) append('comments', `Permit record: ${ctx.join(' ')} (verify on site).`);

  return next;
}
