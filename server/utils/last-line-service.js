/**
 * Last-visit lookup for the schedule/dispatch day views: the customer's most
 * recent completed visit (any line) plus the most recent completed visit on
 * the SAME service line as the appointment being enriched.
 *
 * detectServiceLine is JS, so the line filter can't run in SQL — instead the
 * history is paged newest-first and classified in memory until the line
 * match is found. The page walk is capped at MAX_ROWS: past that depth
 * (≈5 years of twice-weekly visits between same-line visits) the panel
 * shows no line-scoped notes rather than paying an unbounded scan.
 */

const { detectServiceLine } = require('../services/service-report/service-line-configs');

const PAGE_SIZE = 100;
const MAX_ROWS = 500;

async function loadLastServices(db, customerId, serviceType) {
  const visitLine = detectServiceLine(serviceType);
  let lastService = null;
  let lastLineService = null;
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const rows = await db('service_records')
      .where({ customer_id: customerId, status: 'completed' })
      // created_at picks the LATEST same-day visit (a morning service plus
      // an afternoon callback share service_date); the UUID id tiebreaker is
      // purely for deterministic page boundaries, not recency.
      .orderBy('service_date', 'desc')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .offset(offset)
      .limit(PAGE_SIZE)
      .select('service_type', 'service_line', 'service_date', 'technician_notes');
    if (offset === 0) lastService = rows[0] || null;
    // The persisted service_line (typed reports) is canonical; the
    // classifier is the fallback for legacy rows where the column is null.
    lastLineService = rows.find(
      (r) => (String(r.service_line || '').trim() || detectServiceLine(r.service_type)) === visitLine,
    ) || null;
    if (lastLineService || rows.length < PAGE_SIZE) break;
  }
  return { lastService, lastLineService, visitLine };
}

// Same paged same-line walk, but returns the matching RECORDS (with ids
// and raw technician_notes — callers own the customer-safe parse) — the
// pre-visit brief loads product and note history strictly line-scoped (a
// pest visit must never surface lawn or termite products). Also returns the any-line newest record (`last`) so
// callers can answer "has this customer had ANY completed visit" (the
// new-customer check) without a second query. Collects up to `limit`
// same-line records within the MAX_ROWS walk; past that depth the caller
// gets what was found — never a cross-line fallback. Throws on a query
// failure so callers can distinguish an outage from empty history.
// opts.line overrides the label-derived verdict — combined-visit briefs
// walk a COMPANION line (tree_shrub/termite/rodent) that no single label
// on the appointment classifies to.
async function loadRecentLineServices(db, customerId, serviceType, { limit = 5, line = null } = {}) {
  const visitLine = line || detectServiceLine(serviceType);
  const lineRecords = [];
  let last = null;
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const rows = await db('service_records')
      .where({ customer_id: customerId, status: 'completed' })
      .orderBy('service_date', 'desc')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .offset(offset)
      .limit(PAGE_SIZE)
      .select('id', 'customer_id', 'service_type', 'service_line', 'service_date', 'started_at', 'pressure_index', 'technician_notes');
    if (offset === 0) last = rows[0] || null;
    for (const r of rows) {
      if ((String(r.service_line || '').trim() || detectServiceLine(r.service_type)) === visitLine) {
        lineRecords.push(r);
        if (lineRecords.length >= limit) return { last, lineRecords, visitLine };
      }
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return { last, lineRecords, visitLine };
}

module.exports = { loadLastServices, loadRecentLineServices, _test: { PAGE_SIZE, MAX_ROWS } };
