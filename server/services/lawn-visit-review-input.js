/** Validate partial technician review intent and retain stable finding identities. */
const { CONDITION_LABEL_VALUES } = require('./lawn-diagnostic-report');
const { PHOTO_ZONES, normalizePhotoZone } = require('./lawn-visit-input');

const REVIEW_FIELDS = ['reviewedFindings', 'addedDetails', 'appliedProducts'];
const TECH_TEXT_MAX = 500;
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const isText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
const optionalText = (value, max) => value == null || value === '' || isText(value, max);
const parseJsonArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
};
const parseJsonObject = (value) => {
  if (isObject(value)) return value;
  if (typeof value !== 'string') return null;
  try { const parsed = JSON.parse(value); return isObject(parsed) ? parsed : null; } catch { return null; }
};

function reviewList(source, field, limit, errors, parse) {
  if (source[field] == null) return [];
  if (!Array.isArray(source[field]) || source[field].length > limit) {
    errors.push(`${field} must be an array of at most ${limit} entries`);
    return [];
  }
  return source[field].map((entry, index) => {
    const path = `${field}[${index}]`;
    if (!isObject(entry)) { errors.push(`${path} must be an object`); return null; }
    return parse(entry, path);
  }).filter(Boolean);
}

function findingEdit(entry, path, known, seen, errors) {
  const id = entry.finding_id;
  if (typeof id !== 'string' || !known.has(id)) { errors.push(`${path}.finding_id is not a finding of this run`); return null; }
  if (seen.has(id)) { errors.push(`${path}.finding_id is duplicated`); return null; }
  seen.add(id);
  const edit = { finding_id: id };
  if (has(entry, 'keep')) {
    if (typeof entry.keep !== 'boolean') errors.push(`${path}.keep must be a boolean`);
    else edit.keep = entry.keep;
  }
  if (has(entry, 'name')) {
    if (entry.name !== null && !CONDITION_LABEL_VALUES.includes(entry.name)) errors.push(`${path}.name must be one of the allowlisted condition labels or null`);
    else edit.name = entry.name;
  }
  if (has(entry, 'tech_note')) {
    if (!optionalText(entry.tech_note, TECH_TEXT_MAX)) errors.push(`${path}.tech_note must be ${TECH_TEXT_MAX} characters or fewer`);
    else edit.tech_note = entry.tech_note ? entry.tech_note.trim() : null;
  }
  return edit;
}

function addedDetail(entry, path, errors) {
  if (!isText(entry.text, TECH_TEXT_MAX)) { errors.push(`${path}.text is required (${TECH_TEXT_MAX} characters or fewer)`); return null; }
  if (entry.zone != null && entry.zone !== '' && !normalizePhotoZone(entry.zone)) { errors.push(`${path}.zone must be one of: ${PHOTO_ZONES.join(', ')}`); return null; }
  return { text: entry.text.trim(), zone: normalizePhotoZone(entry.zone) };
}

function appliedProduct(entry, path, errors, issued) {
  if (!isText(entry.product_name, 180)) { errors.push(`${path}.product_name is required (180 characters or fewer)`); return null; }
  for (const [key, max] of [['product_id', 80], ['role', 40]]) {
    if (!optionalText(entry[key], max)) { errors.push(`${path}.${key} must be ${max} characters or fewer`); return null; }
  }
  const refs = entry.addresses_findings ?? [];
  if (!Array.isArray(refs) || refs.length > 20 || refs.some((ref) => !isText(ref, 40))) {
    errors.push(`${path}.addresses_findings must be an array of at most 20 finding ids`); return null;
  }
  // A product may only address IDs this review leaves behind: a model finding of
  // the run, or a technician detail ID the allocator assigns — including one
  // assigned to a detail sent in this same request. A typo or invented id would
  // otherwise be reported as unmapped treatment, and because it feeds
  // storedTechnicianHighWater it would push the mark past anything we issued.
  const addresses = [...new Set(refs.map((ref) => ref.trim()))];
  const unknown = addresses.filter((ref) => !issued.has(ref));
  if (unknown.length) {
    errors.push(`${path}.addresses_findings is not a finding of this run: ${unknown.join(', ')}`); return null;
  }
  return {
    product_id: entry.product_id ? entry.product_id.trim() : null,
    product_name: entry.product_name.trim(),
    addresses_findings: addresses,
    role: entry.role ? entry.role.trim() : null,
  };
}

function validateReview(body = {}, run) {
  const errors = [];
  const source = isObject(body) ? body : {};
  if (!isObject(body)) errors.push('review must be an object');
  const known = new Set(parseJsonArray(run?.findings).map((finding) => finding?.finding_id).filter(Boolean));
  const seen = new Set();
  const sent = Object.fromEntries(REVIEW_FIELDS.map((field) => [field, source[field] != null]));
  const reviewedFindings = reviewList(source, 'reviewedFindings', 50, errors, (entry, path) => findingEdit(entry, path, known, seen, errors));
  const addedDetails = reviewList(source, 'addedDetails', 10, errors, (entry, path) => addedDetail(entry, path, errors));
  // The technician IDs this review will actually leave behind, from the same
  // allocator buildReview runs: unchanged details keep their stored ID, so an
  // upper bound (one new ID per detail sent) would accept a T2 that is never
  // assigned and report the product as an unsupported application.
  const { ids } = technicianFindingIds(
    mergedReviewInputs(run, { sent, reviewedFindings, addedDetails, appliedProducts: [] }).addedDetails,
    parseJsonArray(run?.added_details),
    storedTechnicianHighWater(parseJsonObject(run?.reconciliation)),
  );
  const issued = new Set([...known, ...ids]);
  const appliedProducts = reviewList(source, 'appliedProducts', 25, errors, (entry, path) => appliedProduct(entry, path, errors, issued));
  return { errors, review: { provided: Object.values(sent).some(Boolean), sent, reviewedFindings, addedDetails, appliedProducts } };
}

// Finding decisions merge by ID AND by supplied field. Details/products are
// complete lists when sent, including [] to clear them. An omitted list keeps
// the previous review. Stored labels alone never imply a technician rename.
function mergedReviewInputs(run, review = {}) {
  const stored = {
    reviewedFindings: parseJsonArray(run?.reviewed_findings).map((row) => ({ finding_id: String(row.finding_id), keep: row.keep !== false, name: row.renamed ? row.name || row.label || null : null, tech_note: row.tech_note || null })),
    addedDetails: parseJsonArray(run?.added_details).map((row) => ({ text: row.name, zone: row.zone ?? null, finding_id: row.finding_id })),
    appliedProducts: parseJsonObject(run?.reconciliation)?.products || [],
  };
  const sent = (field) => review.sent ? !!review.sent[field] : has(review, field);
  const decisions = new Map(stored.reviewedFindings.map((entry) => [entry.finding_id, entry]));
  if (sent('reviewedFindings')) {
    for (const entry of review.reviewedFindings || []) decisions.set(entry.finding_id, { ...decisions.get(entry.finding_id), ...entry });
  }
  return {
    reviewedFindings: [...decisions.values()],
    addedDetails: sent('addedDetails') ? review.addedDetails || [] : stored.addedDetails,
    appliedProducts: sent('appliedProducts') ? review.appliedProducts || [] : stored.appliedProducts,
  };
}

const technicianNumber = (id) => {
  const n = /^T[1-9]\d*$/.test(String(id || '')) ? Number(String(id).slice(1)) : 0;
  return Number.isSafeInteger(n) ? n : 0;
};
function storedTechnicianHighWater(reconciliation) {
  const stored = Number(reconciliation?.technician_finding_high_water);
  const addressed = (reconciliation?.products || []).flatMap((product) => (Array.isArray(product?.addresses_findings) ? product.addresses_findings : []).map(technicianNumber));
  return Math.max(Number.isSafeInteger(stored) ? stored : 0, 0, ...addressed);
}

// Match text+zone first, then unmatched text. Each stored ID can be claimed
// once; a duplicate/new detail takes a fresh ID above the persisted high-water
// mark, so removing all details never lets a future detail inherit treatment.
function technicianFindingIds(details, stored, highWater = 0) {
  const normalized = (text) => String(text || '').trim().toLowerCase();
  const storedRows = stored.filter((row) => technicianNumber(row.finding_id));
  let next = Math.max(Number.isSafeInteger(highWater) ? highWater : 0, 0, ...storedRows.map((row) => technicianNumber(row.finding_id)));
  const taken = new Set();
  const claim = (matches) => {
    const row = storedRows.find((candidate) => !taken.has(candidate.finding_id) && matches(candidate));
    if (row) taken.add(row.finding_id);
    return row?.finding_id || null;
  };
  const ids = details.map((detail) => claim((row) => normalized(row.name) === normalized(detail.text) && (row.zone ?? null) === (detail.zone ?? null)));
  details.forEach((detail, index) => { if (!ids[index]) ids[index] = claim((row) => normalized(row.name) === normalized(detail.text)); });
  const assigned = ids.map((id) => {
    if (id) return id;
    if (next === Number.MAX_SAFE_INTEGER) throw new RangeError('Technician finding IDs exhausted');
    next += 1;
    return `T${next}`;
  });
  return { ids: assigned, highWater: next };
}

module.exports = { validateReview, mergedReviewInputs, technicianFindingIds, storedTechnicianHighWater, parseJsonArray, parseJsonObject };
