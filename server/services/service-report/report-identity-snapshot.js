/**
 * Report identity snapshot — the customer-facing service report's identity
 * facts, frozen on service_records.service_data at completion.
 *
 * Why: the public report (reports-public.js /:token and /:token/data,
 * email-delivery, pdf-queue) resolves the record by token and then LIVE-JOINS
 * customers, scheduled_services, technicians, and products_catalog on every
 * view. A customer rename or move, an update-details service_type edit on
 * the completed row, a technician rename, or a products_catalog edit (EPA
 * number, re-entry hours, precaution copy, report approval) therefore
 * rewrote the permanent document months after the visit — and the cached
 * PDF, whose key ignores those inputs, then disagreed with the web view
 * (integrity audit 2026-09-02).
 *
 * Contract: buildReportIdentitySnapshot() runs INSIDE the completion
 * transaction from the same rows the completion already holds (the locked
 * scheduled_services row, the customer join, the technician join, the
 * submitted products' catalog rows); applyReportIdentitySnapshot() runs at
 * the top of buildReportV1Data and overlays the frozen facts onto the
 * joined row. Records without a snapshot (every completion before this
 * shipped) keep today's live-join behavior unchanged — no backfill, no
 * migration, no gate: the snapshot is inert data until the renderer sees it.
 *
 * What is frozen here (identity facts, not presentation):
 *   customer first/last name, the visit's service address (stamped-address
 *   precedence identical to reports-public.js's COALESCE + stampedLine2Sql),
 *   the technician's display name, the linked service title, and the
 *   approved report facts of each applied product keyed by product id.
 * Presentation (technician photo URL, formatting, copy config) and the
 * deliberately-live sections (next visit, review CTA, cross-sell) stay live.
 */

const { stampedAddressDiverges } = require('../stamped-address');

const REPORT_IDENTITY_SNAPSHOT_VERSION = 1;

function textOrNull(value) {
  const text = String(value == null ? '' : value).trim();
  return text || null;
}

// Mirrors the inline-unit regex in stampedLine2Sql: a stamp that already
// carries "Apt 4" in line1 must not inherit the primary's unit line.
const INLINE_UNIT_RE = /\s(apt|apartment|unit|ste|suite|#)\.?\s*[a-z0-9-]+\s*$/i;

// JS twin of the report routes' address selection: stamped visit address
// wins per field; line2 follows stampedLine2Sql (divergent stamp keeps only
// its own unit; inline unit keeps its own; otherwise inherit the primary's).
function resolveVisitAddress({ visit = {}, customer = {} } = {}) {
  const v = visit || {};
  const c = customer || {};
  const diverges = stampedAddressDiverges({
    service_address_line1: v.service_address_line1,
    service_address_zip: v.service_address_zip,
    service_address_city: v.service_address_city,
    customer_address_line1: c.address_line1,
    customer_zip: c.zip,
    customer_city: c.city,
  });
  let line2;
  if (diverges) line2 = v.service_address_line2;
  else if (textOrNull(v.service_address_line1) && INLINE_UNIT_RE.test(String(v.service_address_line1))) line2 = v.service_address_line2;
  else line2 = v.service_address_line2 || c.address_line2;
  return {
    line1: textOrNull(v.service_address_line1) || textOrNull(c.address_line1),
    line2: textOrNull(line2),
    city: textOrNull(v.service_address_city) || textOrNull(c.city),
    state: textOrNull(v.service_address_state) || textOrNull(c.state),
    zip: textOrNull(v.service_address_zip) || textOrNull(c.zip),
  };
}

/**
 * @param {object} args
 * @param {object} args.visit          locked scheduled_services row (service_address_*, service_type)
 * @param {object|null} args.customer  { first_name, last_name, address_line1, address_line2, city, state, zip }
 *                                      — null when the row is missing: customer AND address are then
 *                                      omitted together (never a partial freeze) and the renderer keeps them live
 * @param {string|null} args.technicianName  technicians.name at completion; null = omitted, stays live
 * @param {object|undefined} args.productFacts  { [productId]: approvedReportProductFacts|null }
 * @param {Date} [args.frozenAt]
 *
 * Every leg is independently optional so a missing row degrades THAT leg
 * to today's live behavior instead of freezing a blank value.
 */
function buildReportIdentitySnapshot({
  visit = {},
  customer = null,
  technicianName = null,
  productFacts,
  frozenAt = new Date(),
} = {}) {
  const snapshot = {
    version: REPORT_IDENTITY_SNAPSHOT_VERSION,
    frozenAt: frozenAt instanceof Date ? frozenAt.toISOString() : String(frozenAt),
    serviceTitle: textOrNull(visit?.service_type),
  };
  if (customer && typeof customer === 'object') {
    snapshot.customer = {
      firstName: textOrNull(customer.first_name),
      lastName: textOrNull(customer.last_name),
    };
    snapshot.address = resolveVisitAddress({ visit, customer });
  }
  const frozenTechnicianName = textOrNull(technicianName);
  if (frozenTechnicianName) snapshot.technicianName = frozenTechnicianName;
  if (productFacts && typeof productFacts === 'object') {
    snapshot.productFacts = productFacts;
  }
  return snapshot;
}

function parseServiceData(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readReportIdentitySnapshot(service = {}) {
  const snapshot = parseServiceData(service?.service_data)?.reportIdentitySnapshot;
  return snapshot && typeof snapshot === 'object' && Number(snapshot.version) >= 1 ? snapshot : null;
}

/**
 * Overlay the frozen identity onto a joined report row. Returns the row
 * unchanged (same reference) when the record carries no snapshot, so
 * pre-snapshot records render exactly as before.
 */
function applyReportIdentitySnapshot(service) {
  const snapshot = readReportIdentitySnapshot(service);
  if (!snapshot) return service;
  const out = { ...service, report_identity_snapshot: snapshot };
  if (snapshot.customer && typeof snapshot.customer === 'object') {
    out.first_name = snapshot.customer.firstName ?? null;
    out.last_name = snapshot.customer.lastName ?? null;
  }
  if (snapshot.address && typeof snapshot.address === 'object') {
    out.address_line1 = snapshot.address.line1 ?? null;
    out.address_line2 = snapshot.address.line2 ?? null;
    out.city = snapshot.address.city ?? null;
    out.state = snapshot.address.state ?? null;
    out.zip = snapshot.address.zip ?? null;
  }
  if (snapshot.technicianName) {
    out.technician_name = snapshot.technicianName;
    // formatTechnicianForCustomer prefers first/last over name — a caller
    // that joined those must not out-vote the frozen name.
    out.technician_first_name = null;
    out.technician_last_name = null;
  }
  return out;
}

module.exports = {
  REPORT_IDENTITY_SNAPSHOT_VERSION,
  buildReportIdentitySnapshot,
  applyReportIdentitySnapshot,
  readReportIdentitySnapshot,
  resolveVisitAddress,
};
