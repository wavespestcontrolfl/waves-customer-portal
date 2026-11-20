/**
 * CALLBACK CREDIT — which technician a callback counts against on the admin
 * dashboard leaderboard (routes/admin-dashboard.js). GATE_CALLBACK_SOURCE_TECH
 * (census M9, second technician, 2026-10-25); off, nothing here runs.
 *
 * Today a callback counts against the technician who DOES it: the owner who
 * fixes the hire's pest visit shows the callback, the hire shows none. A
 * re-service row stores no link to the visit it corrects, so the source is
 * read: the latest earlier regular record (not itself a callback) for the
 * same customer, in the same service category, with a technician, within
 * LOOKBACK_DAYS before the callback. On the callback's own date only a record
 * created before the callback's record counts: a regular visit recorded later
 * that day cannot be the visit the callback corrects. The category is the
 * name classifier the night run uses (auto-dispatch/service-category.js
 * classifyServiceCategory), so a lawn re-service never lands on the last pest
 * visit. No source found: the callback stays with its own technician, as
 * today.
 *
 * Reads only. Jobs, revenue and margins stay with the technician who did the
 * work; only the callback count moves.
 */
const { classifyServiceCategory } = require('./auto-dispatch/service-category');
const { NON_PERFORMED_VISIT_OUTCOMES } = require('./visit-outcomes');

const LOOKBACK_DAYS = 60;

// SQL for 'this record's visit outcome performed no application' - the shared list (visit-outcomes.js).
const PERFORMED_OUTCOME_SQL = (alias) => `COALESCE(${alias}.structured_notes->>'visitOutcome', '') NOT IN (${NON_PERFORMED_VISIT_OUTCOMES.map((o) => `'${o}'`).join(', ')})`;
// SQL for 'some sibling record of this visit is flagged a callback' (a visit is a callback if any sibling is).
const VISIT_IS_CALLBACK_SQL = (alias) => `(${alias}.is_callback IS TRUE OR (${alias}.scheduled_service_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM service_records vcb WHERE vcb.scheduled_service_id = ${alias}.scheduled_service_id AND vcb.is_callback IS TRUE)))`;

const visitKey = (alias) => `COALESCE(${alias}.scheduled_service_id::text, ${alias}.id::text)`;
const performedCompleted = (alias) => `
           AND ${alias}.status = 'completed'
           AND ${PERFORMED_OUTCOME_SQL(alias)}`;

// The callback side of the query. Distinct-visit mode resolves the visit first: a visit is a callback when ANY
// sibling record is flagged, it counts when some sibling is completed with a performed outcome, and ONE canonical
// record (the newest such sibling, id as the tie break) supplies its date, category and technician before any
// source is looked up.
function callbackSide({ distinctVisits, performedSourcesOnly }) {
  if (!distinctVisits) {
    return { from: 'service_records', where: `cb.is_callback = true${performedSourcesOnly ? performedCompleted('cb') : ''}`, visit: 'NULL' };
  }
  return {
    from: `(SELECT DISTINCT ON (${visitKey('x')}) x.id, x.customer_id, x.service_type, x.technician_id, x.service_date, x.created_at, x.scheduled_service_id
          FROM service_records x
         WHERE ${VISIT_IS_CALLBACK_SQL('x')}${performedSourcesOnly ? performedCompleted('x') : ''}
         ORDER BY ${visitKey('x')}, x.created_at DESC, x.id DESC)`,
    where: 'TRUE',
    visit: visitKey('cb'),
  };
}

/**
 * Callback counts by credited technician for callbacks dated start..endDate
 * (YYYY-MM-DD, inclusive). Two opt-in options for the Tech Rewards score, off for every other reader:
 * distinctVisits resolves each scheduled service as ONE visit (a callback when any sibling record is flagged;
 * one canonical record, the newest performed sibling, gives its date, category and technician before any source
 * is chosen; a callback visit is never a source), and performedSourcesOnly requires completed records with a
 * performed outcome (the shared non-performed list in visit-outcomes.js) for callbacks and sources. Returns a
 * Map: technician id (string) or null
 * (no technician anywhere) -> count.
 */
async function callbackCreditByTechnician(conn, { start, endDate, distinctVisits = false, performedSourcesOnly = false }) {
  const side = callbackSide({ distinctVisits, performedSourcesOnly });
  const result = await conn.raw(`
    SELECT cb.id AS callback_id,
           cb.service_type AS callback_type,
           cb.technician_id AS callback_tech_id,
           ${side.visit} AS callback_visit,
           sr.technician_id AS source_tech_id,
           sr.service_type AS source_type
      FROM ${side.from} cb
      LEFT JOIN service_records sr
        ON sr.customer_id = cb.customer_id
       AND sr.id <> cb.id
       AND sr.is_callback IS NOT TRUE${distinctVisits ? `
       AND NOT ${VISIT_IS_CALLBACK_SQL('sr')}` : ''}
       AND sr.technician_id IS NOT NULL${performedSourcesOnly ? performedCompleted('sr') : ''}
       AND (sr.service_date < cb.service_date
            OR (sr.service_date = cb.service_date AND sr.created_at < cb.created_at))
       AND sr.service_date >= cb.service_date - CAST(? AS integer)
     WHERE ${side.where}
       AND cb.service_date >= ?
       AND cb.service_date <= ?
     ORDER BY cb.id, sr.service_date DESC NULLS LAST, sr.created_at DESC NULLS LAST
  `, [LOOKBACK_DAYS, start, endDate]);
  const rows = result?.rows || [];

  // Rows arrive grouped by callback, newest candidate first: the first
  // candidate in the callback's category is its source.
  const credited = new Map();
  for (const row of rows) {
    const id = distinctVisits ? String(row.callback_visit) : String(row.callback_id);
    let entry = credited.get(id);
    if (!entry) {
      entry = { techId: row.callback_tech_id ?? null, category: classifyServiceCategory(row.callback_type), found: false };
      credited.set(id, entry);
    }
    if (entry.found || row.source_tech_id == null) continue;
    if (classifyServiceCategory(row.source_type) === entry.category) {
      entry.techId = row.source_tech_id;
      entry.found = true;
    }
  }

  const counts = new Map();
  for (const { techId } of credited.values()) {
    const key = techId == null ? null : String(techId);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

module.exports = { callbackCreditByTechnician, LOOKBACK_DAYS, PERFORMED_OUTCOME_SQL, VISIT_IS_CALLBACK_SQL };
