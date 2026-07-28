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
      // id tiebreaker keeps the page boundaries deterministic — same-date
      // rows (routine for multi-service customers) may otherwise reorder
      // between OFFSET queries and skip a same-line visit.
      .orderBy('service_date', 'desc')
      .orderBy('id', 'desc')
      .offset(offset)
      .limit(PAGE_SIZE)
      .select('service_type', 'service_date', 'technician_notes');
    if (offset === 0) lastService = rows[0] || null;
    lastLineService = rows.find((r) => detectServiceLine(r.service_type) === visitLine) || null;
    if (lastLineService || rows.length < PAGE_SIZE) break;
  }
  return { lastService, lastLineService, visitLine };
}

module.exports = { loadLastServices, _test: { PAGE_SIZE, MAX_ROWS } };
