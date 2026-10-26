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
 * LOOKBACK_DAYS before the callback. The category is the name classifier the
 * night run uses (auto-dispatch/service-category.js classifyServiceCategory),
 * so a lawn re-service never lands on the last pest visit. No source found:
 * the callback stays with its own technician, as today.
 *
 * Reads only. Jobs, revenue and margins stay with the technician who did the
 * work; only the callback count moves.
 */
const { classifyServiceCategory } = require('./auto-dispatch/service-category');

const LOOKBACK_DAYS = 60;

/**
 * Callback counts by credited technician for callbacks dated start..endDate
 * (YYYY-MM-DD, inclusive). Returns a Map: technician id (string) or null
 * (no technician anywhere) -> count.
 */
async function callbackCreditByTechnician(conn, { start, endDate }) {
  const result = await conn.raw(`
    SELECT cb.id AS callback_id,
           cb.service_type AS callback_type,
           cb.technician_id AS callback_tech_id,
           sr.technician_id AS source_tech_id,
           sr.service_type AS source_type
      FROM service_records cb
      LEFT JOIN service_records sr
        ON sr.customer_id = cb.customer_id
       AND sr.id <> cb.id
       AND sr.is_callback IS NOT TRUE
       AND sr.technician_id IS NOT NULL
       AND sr.service_date <= cb.service_date
       AND sr.service_date >= cb.service_date - CAST(? AS integer)
     WHERE cb.is_callback = true
       AND cb.service_date >= ?
       AND cb.service_date <= ?
     ORDER BY cb.id, sr.service_date DESC NULLS LAST, sr.created_at DESC NULLS LAST
  `, [LOOKBACK_DAYS, start, endDate]);
  const rows = result?.rows || [];

  // Rows arrive grouped by callback, newest candidate first: the first
  // candidate in the callback's category is its source.
  const credited = new Map();
  for (const row of rows) {
    const id = String(row.callback_id);
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

module.exports = { callbackCreditByTechnician, LOOKBACK_DAYS };
