// Treated-point marks placed on a photo of the area actually treated.
// Scope + rulings: docs/design/treatment-animation-scope.md.
//
// Three owner rulings shape this module, and each one is enforced here rather
// than at a render site:
//
// 1. Marks are TYPED. Every mark carries a `kind` from a closed, per-lane
//    vocabulary, and a kind only exists when the completion form for that lane
//    can actually record it. No kind the technician had no way to enter.
// 2. Marks are OPTIONAL. A visit with no marks is a normal, complete visit —
//    absent marks produce no card, no empty state, and no error.
// 3. The card NEVER states a count. Foam is priced by drill-point count and
//    marks need not be exhaustive, so a total would invite a customer to tally
//    pins against billed points. This module therefore publishes no totals; it
//    deliberately does not expose a `summary` the way buildStationMapReportContext
//    does, because stations ARE an exhaustive registry and marks are not.
//
// Dark by construction: every read path returns "unavailable" unless
// GATE_PHOTO_MARKS is exactly 'true'.
const db = require('../../models/db');

const GATE_ENV = 'GATE_PHOTO_MARKS';

function photoMarksGateOn() {
  return process.env[GATE_ENV] === 'true';
}

// ── Vocabulary ───────────────────────────────────────────────────────────────
// Each kind maps to a value the lane's completion form can hold. `derivedFrom`
// is documentation with teeth: it names the recorded value the legend label is
// answerable to, so a future edit that invents a kind has to explain itself.
const MARK_KINDS = {
  foam_injection: {
    label: 'Drilled & foamed',
    derivedFrom: 'catalog key foam_drill / foam_recurring',
  },
  spot_treatment: {
    label: 'Spot treated',
    derivedFrom: "treatment_method: 'Spot treatment'",
  },
  wood_treatment: {
    label: 'Wood treated',
    derivedFrom: "treatment_method: 'Wood treatment'",
  },
};

// Lane → allowed kinds. Keyed on the catalog service key, because the typed
// findings type (termite_treatment) is SHARED with liquid perimeter and
// trenching — lanes that are not point-localized and must never offer marks.
const LANE_KINDS = {
  foam_drill: ['foam_injection', 'spot_treatment', 'wood_treatment'],
  foam_recurring: ['foam_injection', 'spot_treatment', 'wood_treatment'],
};

// The kind pre-selected in the tech UI for a lane — the job the visit exists
// to do. First entry is the default by construction.
function defaultKindForLane(serviceKey) {
  const kinds = LANE_KINDS[String(serviceKey || '')];
  return kinds ? kinds[0] : null;
}

function markKindsForLane(serviceKey) {
  const kinds = LANE_KINDS[String(serviceKey || '')];
  if (!kinds) return [];
  return kinds.map((kind) => ({ kind, label: MARK_KINDS[kind].label }));
}

function laneSupportsMarks(serviceKey) {
  return Array.isArray(LANE_KINDS[String(serviceKey || '')]);
}

function markKindLabel(kind) {
  return MARK_KINDS[kind]?.label || null;
}

// ── Validation ───────────────────────────────────────────────────────────────
function finiteNumber(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

const MAX_MARKS_PER_PHOTO = 60;

/**
 * Validate a posted mark set for one photo on one lane.
 * Returns { ok: true, marks } or { ok: false, error }.
 *
 * Rejects rather than clamps: a coordinate outside 0..1 means the client
 * measured against something other than the stored image, and silently
 * clamping it would pin a mark to an edge it was never placed on.
 */
function validateMarks(rawMarks, { serviceKey } = {}) {
  if (!laneSupportsMarks(serviceKey)) {
    return { ok: false, error: 'This service does not support treated-point marks' };
  }
  if (!Array.isArray(rawMarks)) {
    return { ok: false, error: 'marks must be an array' };
  }
  if (rawMarks.length > MAX_MARKS_PER_PHOTO) {
    return { ok: false, error: `A photo may carry at most ${MAX_MARKS_PER_PHOTO} marks` };
  }
  const allowed = new Set(LANE_KINDS[String(serviceKey)]);
  const marks = [];
  for (let i = 0; i < rawMarks.length; i += 1) {
    const raw = rawMarks[i] || {};
    const x = finiteNumber(raw.x);
    const y = finiteNumber(raw.y);
    if (x === null || y === null) {
      return { ok: false, error: `Mark ${i + 1}: x and y must be numbers` };
    }
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      return { ok: false, error: `Mark ${i + 1}: x and y must be between 0 and 1` };
    }
    const kind = String(raw.kind || '');
    if (!allowed.has(kind)) {
      return { ok: false, error: `Mark ${i + 1}: unsupported kind for this service` };
    }
    // Numbering is assigned server-side in placement order. Client-supplied
    // numbers are ignored so a duplicate or a gap can never reach the unique
    // index — or the customer's card.
    marks.push({ mark_number: marks.length + 1, x, y, kind });
  }
  return { ok: true, marks };
}

// ── Persistence ──────────────────────────────────────────────────────────────
/**
 * Replace the mark set for one photo. Whole-set replace (not incremental
 * patch) so the stored set always equals what the technician last saw —
 * a partial failure can never leave a half-edited set on a customer report.
 * An empty array clears the marks, which is how "Skip" is honoured after
 * marks were previously saved.
 */
async function saveMarksForPhoto({
  scheduledServiceId, s3Key, marks, technicianId = null, knex = db,
}) {
  if (!scheduledServiceId || !s3Key) return [];
  return knex.transaction(async (trx) => {
    await trx('service_photo_marks')
      .where({ scheduled_service_id: scheduledServiceId, s3_key: s3Key })
      .del();
    if (!marks.length) return [];
    const rows = marks.map((mark) => ({
      scheduled_service_id: scheduledServiceId,
      s3_key: s3Key,
      mark_number: mark.mark_number,
      x: mark.x,
      y: mark.y,
      kind: mark.kind,
      technician_id: technicianId,
    }));
    await trx('service_photo_marks').insert(rows);
    return rows;
  });
}

function normalizeRow(row) {
  return {
    n: Number(row.mark_number),
    x: Number(row.x),
    y: Number(row.y),
    kind: row.kind,
    label: markKindLabel(row.kind),
  };
}

/**
 * All marks for a visit, grouped by the photo's S3 key.
 * Returns a Map<s3Key, mark[]>. Fail-soft: a missing table (environment that
 * has not run the migration) yields an empty map rather than throwing into
 * the report path.
 */
async function loadMarksByS3Key({ scheduledServiceId, knex = db }) {
  const empty = new Map();
  if (!photoMarksGateOn() || !scheduledServiceId) return empty;
  let rows;
  try {
    rows = await knex('service_photo_marks')
      .where({ scheduled_service_id: scheduledServiceId })
      .orderBy('mark_number', 'asc');
  } catch (err) {
    // 42P01 undefined_table / 42703 undefined_column — same fail-soft posture
    // the station map and recap queue take.
    if (err?.code === '42P01' || err?.code === '42703') return empty;
    throw err;
  }
  const byKey = new Map();
  for (const row of rows) {
    const key = row.s3_key;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(normalizeRow(row));
  }
  return byKey;
}

/**
 * The report-side card context for ONE photo's marks.
 *
 * Mirrors buildStationMapReportContext's `{ available, reason }` contract with
 * one deliberate difference: there is no `summary`. See ruling 3 at the top of
 * this file — the station card states counts because stations are an
 * exhaustive registry; marks are not, so this context cannot supply a total
 * even to a caller that asks for one.
 *
 * ALL-OR-NOTHING: if any stored mark fails to normalize, the whole card is
 * suppressed rather than rendering a subset. A partial render would silently
 * understate what the technician recorded, leaving the tech's record and the
 * customer's view disagreeing.
 */
function buildMarkedPhotoContext({ marks = [], eligibility = null } = {}) {
  if (!photoMarksGateOn()) return { available: false, reason: 'disabled' };
  if (!eligibility?.eligible || eligibility.variant !== 'photo') {
    return { available: false, reason: 'lane_not_eligible' };
  }
  if (!Array.isArray(marks) || !marks.length) {
    // Optional by ruling — no marks is a complete visit, not a failure.
    return { available: false, reason: 'no_marks' };
  }
  const usable = marks.filter((mark) => Number.isFinite(mark.x)
    && Number.isFinite(mark.y)
    && mark.x >= 0 && mark.x <= 1
    && mark.y >= 0 && mark.y <= 1
    && Number.isFinite(mark.n)
    && markKindLabel(mark.kind));
  if (usable.length !== marks.length) {
    return { available: false, reason: 'marks_unresolvable' };
  }
  // Legend carries only the kinds actually present, in vocabulary order, so a
  // customer never sees a swatch for work that was not done on their visit.
  const present = Object.keys(MARK_KINDS).filter(
    (kind) => usable.some((mark) => mark.kind === kind)
  );
  return {
    available: true,
    marks: usable,
    legend: present.map((kind) => ({ kind, label: MARK_KINDS[kind].label })),
    captionKey: eligibility.captionKey || 'foamPoints',
  };
}

module.exports = {
  photoMarksGateOn,
  markKindsForLane,
  defaultKindForLane,
  laneSupportsMarks,
  markKindLabel,
  validateMarks,
  saveMarksForPhoto,
  loadMarksByS3Key,
  buildMarkedPhotoContext,
  MAX_MARKS_PER_PHOTO,
  _test: { MARK_KINDS, LANE_KINDS },
};
