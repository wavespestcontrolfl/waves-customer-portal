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

// "2-story concrete block / masonry single-family residential structure"
export function describeStructure(profile = {}) {
  const parts = [];
  if (profile.stories) parts.push(`${profile.stories}-story`);
  const cm = clean(profile.constructionMaterial).toLowerCase();
  if (/(block|masonry|concrete|\bcb\b|cbs|cmu|stucco)/.test(cm)) parts.push('concrete block / masonry');
  else if (/(wood|frame)/.test(cm)) parts.push('wood frame');
  const s = `${parts.join(' ')} single-family residential structure`.replace(/\s+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
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
  if (profile.stories || has(profile.constructionMaterial)) set('structures_inspected', describeStructure(profile));

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
