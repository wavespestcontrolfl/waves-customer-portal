/**
 * Technician capabilities — the per-category "may this tech take this kind of
 * work" ledger auto-dispatch reads (Field Team Program, Phase 0 item 4).
 *
 * Storage: technician_capabilities (tech × service_category, unique). The
 * editor speaks in three STATES, which map onto the two columns auto-dispatch
 * already understands:
 *
 *   qualified        → capability_level 'qualified',       active true   (score 1.0)
 *   review_required  → capability_level 'review_required', active true   (score 0.65)
 *   off              → active false                                      (hard drop)
 *
 * A category with no row reads as 'unset' (auto-dispatch scores it 0.5 and
 * never drops it). New hires are seeded at review_required on every category
 * — owner ruling 2026-09-05: every hire may treat every service, and a
 * category becomes Qualified only when someone marks it so. verified_by /
 * verified_at record who made that call.
 */
const { CAPABILITY_CATEGORIES } = require('./auto-dispatch/service-category');

const CAPABILITY_LEVELS = ['qualified', 'review_required'];
const CAPABILITY_STATES = ['qualified', 'review_required', 'off'];
const NEW_HIRE_LEVEL = 'review_required';
const MAX_NOTES_LENGTH = 500;

const CATEGORY_LABELS = {
  general: 'General pest',
  mosquito: 'Mosquito',
  lawn: 'Lawn, tree & shrub',
  rodent: 'Rodent',
  termite: 'Termite / WDO',
};

function stateOf(row) {
  if (!row) return 'unset';
  if (row.active === false) return 'off';
  return row.capability_level === 'qualified' ? 'qualified' : 'review_required';
}

/**
 * Validate a PUT body's `capabilities` array. Returns { error } or { entries }
 * where entries are normalized { service_category, state, notes, expected_updated_at }:
 *   - notes: undefined when omitted (the stored note is preserved); null when
 *     the caller sends null or '' (an explicit clear); else the trimmed text.
 *   - expected_updated_at: undefined when omitted (no concurrency check); null
 *     = "I saw no row"; an ISO timestamp = the row's updated_at the caller
 *     edited from. A mismatch at write time is a stale save (409).
 */
function normalizeCapabilityEntries(input) {
  if (!Array.isArray(input) || !input.length) {
    return { error: 'capabilities must be a non-empty array' };
  }
  const seen = new Set();
  const entries = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return { error: 'Each capability must be an object' };
    const category = raw.service_category;
    if (!CAPABILITY_CATEGORIES.includes(category)) {
      return { error: `service_category must be one of ${CAPABILITY_CATEGORIES.join(', ')}` };
    }
    if (seen.has(category)) return { error: `service_category '${category}' appears more than once` };
    seen.add(category);
    if (!CAPABILITY_STATES.includes(raw.state)) {
      return { error: `state must be one of ${CAPABILITY_STATES.join(', ')}` };
    }
    let notes;
    if (raw.notes === null) {
      notes = null;
    } else if (raw.notes !== undefined) {
      if (typeof raw.notes !== 'string') return { error: 'notes must be a string' };
      notes = raw.notes.trim() || null;
      if (notes && notes.length > MAX_NOTES_LENGTH) {
        return { error: `notes must be ${MAX_NOTES_LENGTH} characters or fewer` };
      }
    }
    let expectedUpdatedAt;
    if (raw.expected_updated_at === null) {
      expectedUpdatedAt = null;
    } else if (raw.expected_updated_at !== undefined) {
      const ts = new Date(raw.expected_updated_at);
      if (typeof raw.expected_updated_at !== 'string' || Number.isNaN(ts.getTime())) {
        return { error: 'expected_updated_at must be an ISO timestamp or null' };
      }
      expectedUpdatedAt = ts.toISOString();
    }
    entries.push({ service_category: category, state: raw.state, notes, expected_updated_at: expectedUpdatedAt });
  }
  return { entries };
}

function staleError(category) {
  return Object.assign(
    new Error(`The ${CATEGORY_LABELS[category] || category} capability changed since you opened it — reload and try again`),
    { statusCode: 409, code: 'CAPABILITY_STALE', service_category: category, isOperational: true },
  );
}

/** All five categories for one tech, missing rows reported as state 'unset'. */
async function listCapabilities(conn, technicianId) {
  const rows = await conn('technician_capabilities as tc')
    .leftJoin('technicians as v', 'tc.verified_by', 'v.id')
    .where('tc.technician_id', technicianId)
    .select(
      'tc.service_category', 'tc.capability_level', 'tc.active', 'tc.source', 'tc.notes',
      'tc.verified_by', 'tc.verified_at', 'tc.updated_at', 'v.name as verified_by_name',
    );
  const byCategory = new Map(rows.map((r) => [r.service_category, r]));
  return CAPABILITY_CATEGORIES.map((category) => {
    const row = byCategory.get(category) || null;
    return {
      service_category: category,
      label: CATEGORY_LABELS[category],
      state: stateOf(row),
      notes: row ? row.notes : null,
      source: row ? row.source : null,
      verified_by: row ? row.verified_by : null,
      verified_by_name: row ? row.verified_by_name : null,
      verified_at: row ? row.verified_at : null,
      updated_at: row ? row.updated_at : null,
    };
  });
}

/**
 * Per-tech counts for the roster: { qualified, review_required, off, unset }.
 * One query for every tech; techs with no rows are all 'unset'.
 */
async function summarizeCapabilities(conn, technicianIds) {
  const ids = (technicianIds || []).filter(Boolean);
  const empty = () => ({ qualified: 0, review_required: 0, off: 0, unset: CAPABILITY_CATEGORIES.length });
  const summaries = new Map(ids.map((id) => [id, empty()]));
  if (!ids.length) return summaries;
  const rows = await conn('technician_capabilities')
    .whereIn('technician_id', ids)
    .whereIn('service_category', CAPABILITY_CATEGORIES)
    .select('technician_id', 'service_category', 'capability_level', 'active');
  for (const r of rows) {
    const s = summaries.get(r.technician_id);
    if (!s) continue;
    s[stateOf(r)] += 1;
    s.unset -= 1;
  }
  return summaries;
}

/**
 * Seed the five categories for a newly created technician at the new-hire
 * level. Runs on the creator's transaction; existing rows are left alone.
 */
async function seedNewHireCapabilities(conn, technicianId) {
  const rows = CAPABILITY_CATEGORIES.map((category) => ({
    technician_id: technicianId,
    service_category: category,
    capability_level: NEW_HIRE_LEVEL,
    source: 'system_default',
    active: true,
    notes: null,
    updated_at: conn.fn.now(),
  }));
  await conn('technician_capabilities')
    .insert(rows)
    .onConflict(['technician_id', 'service_category'])
    .ignore();
}

/**
 * Upsert the given entries for one tech, stamping who verified them. `off`
 * keeps the row's level (so turning a category back on restores it) and only
 * flips `active`; a brand-new `off` row lands at the new-hire level. An
 * omitted note is preserved; an entry carrying expected_updated_at is checked
 * against the current row first and refused as CAPABILITY_STALE on a mismatch
 * (the caller holds the technician row FOR UPDATE, so the check and the write
 * are one serialized unit).
 */
async function writeCapabilities(conn, technicianId, entries, actorId) {
  const now = conn.fn.now();
  for (const entry of entries) {
    if (entry.expected_updated_at !== undefined) {
      const current = await conn('technician_capabilities')
        .where({ technician_id: technicianId, service_category: entry.service_category })
        .first('updated_at');
      const currentTs = current && current.updated_at ? new Date(current.updated_at).toISOString() : null;
      if (currentTs !== entry.expected_updated_at) throw staleError(entry.service_category);
    }
    const row = {
      technician_id: technicianId,
      service_category: entry.service_category,
      source: 'admin',
      active: entry.state !== 'off',
      verified_by: actorId || null,
      verified_at: now,
      updated_at: now,
    };
    const mergeColumns = ['source', 'active', 'verified_by', 'verified_at', 'updated_at'];
    if (entry.notes !== undefined) {
      row.notes = entry.notes;
      mergeColumns.push('notes');
    } else {
      row.notes = null; // only used when the row is new
    }
    if (entry.state !== 'off') {
      row.capability_level = entry.state;
      mergeColumns.push('capability_level');
    } else {
      row.capability_level = NEW_HIRE_LEVEL;
    }
    await conn('technician_capabilities')
      .insert(row)
      .onConflict(['technician_id', 'service_category'])
      .merge(mergeColumns);
  }
}

module.exports = {
  CAPABILITY_CATEGORIES,
  CAPABILITY_LEVELS,
  CAPABILITY_STATES,
  CATEGORY_LABELS,
  NEW_HIRE_LEVEL,
  MAX_NOTES_LENGTH,
  stateOf,
  normalizeCapabilityEntries,
  listCapabilities,
  summarizeCapabilities,
  seedNewHireCapabilities,
  writeCapabilities,
};
