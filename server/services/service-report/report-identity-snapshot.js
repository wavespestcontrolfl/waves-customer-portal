/**
 * Report identity snapshot — the customer-facing service report's identity
 * facts, frozen on service_records.service_data at completion.
 *
 * Why: the public report (reports-public.js /:token and /:token/data,
 * email-delivery, pdf-queue, the portal's legacy documents.js download)
 * resolves the record by token and then LIVE-JOINS customers,
 * scheduled_services, technicians, and products_catalog on every view. A
 * customer rename or move, an update-details service_type edit on the
 * completed row, a technician rename, or a products_catalog edit (EPA
 * number, re-entry hours, precaution copy, report approval) therefore
 * rewrote the permanent document months after the visit — and the cached
 * PDF, whose key ignores those inputs, then disagreed with the web view
 * (integrity audit 2026-09-02).
 *
 * Contract: buildReportIdentitySnapshot() runs INSIDE the completion
 * transaction from rows read in that transaction (the locked
 * scheduled_services row, the customer and technician the record persists,
 * the submitted products' catalog rows); applyReportIdentitySnapshot() runs
 * at the top of buildReportV1Data AND right after every joined-row load
 * that uses the row before the builder (PDF filename, canonical lawn pin,
 * queue and email loaders), overlaying the frozen facts onto the join.
 * Records without a snapshot (every completion before this shipped) keep
 * today's live-join behavior unchanged — no backfill, no migration, no
 * gate: the snapshot is inert data until the renderer sees it.
 *
 * What is frozen here (identity facts, not presentation):
 *   customer first/last name; the visit's service address (stamped-address
 *   precedence identical to reports-public.js's COALESCE + stampedLine2Sql)
 *   together with the map-center coordinates that address resolved to at
 *   completion; the technician's display name; the linked service title;
 *   and the approved report facts of each applied product keyed by
 *   canonical (lower-case) product id.
 * Presentation (technician photo URL, formatting, copy config) and the
 * deliberately-live sections (next visit, review CTA, cross-sell) stay live.
 */

const { stampedAddressDiverges } = require('../stamped-address');

const REPORT_IDENTITY_SNAPSHOT_VERSION = 1;

function textOrNull(value) {
  const text = String(value == null ? '' : value).trim();
  return text || null;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Postgres returns uuid columns in canonical lower-case; a request may spell
// the same id in upper-case hex. Every map key and lookup uses this form.
function canonicalProductId(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

// Mirrors the inline-unit regex in stampedLine2Sql: a stamp that already
// carries "Apt 4" in line1 must not inherit the primary's unit line.
const INLINE_UNIT_RE = /\s(apt|apartment|unit|ste|suite|#)\.?\s*[a-z0-9-]+\s*$/i;

function visitDiverges(visit = {}, customer = {}) {
  return stampedAddressDiverges({
    service_address_line1: visit?.service_address_line1,
    service_address_zip: visit?.service_address_zip,
    service_address_city: visit?.service_address_city,
    customer_address_line1: customer?.address_line1,
    customer_zip: customer?.zip,
    customer_city: customer?.city,
  });
}

// JS twin of the report routes' address selection: stamped visit address
// wins per field; line2 follows stampedLine2Sql (divergent stamp keeps only
// its own unit; inline unit keeps its own; otherwise inherit the primary's).
function resolveVisitAddress({ visit = {}, customer = {} } = {}) {
  const v = visit || {};
  const c = customer || {};
  const diverges = visitDiverges(v, c);
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

// JS twin of the routes' coordinate COALESCE: stamped visit coords first,
// the primary home's only when the stamp does not diverge from it.
function resolveVisitCoordinates({ visit = {}, customer = {} } = {}) {
  const v = visit || {};
  const c = customer || {};
  let lat = numberOrNull(v.lat);
  let lng = numberOrNull(v.lng);
  if ((lat == null || lng == null) && c && !visitDiverges(v, c)) {
    lat = numberOrNull(c.latitude);
    lng = numberOrNull(c.longitude);
  }
  return lat != null && lng != null ? { lat, lng } : null;
}

/**
 * @param {object} args
 * @param {object} args.visit          locked scheduled_services row (service_address_*, lat, lng, service_type)
 * @param {object|null} args.customer  { first_name, last_name, address_line1, address_line2, city, state, zip,
 *                                       latitude, longitude } — null when the row is missing: customer,
 *                                       address AND mapCenter are then omitted together (never a partial
 *                                       freeze) and the renderer keeps them live
 * @param {string|null} args.technicianName  technicians.name at completion; null = omitted, stays live
 * @param {object|undefined} args.productFacts  { [canonical productId]: approvedReportProductFacts|null }
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
    // Frozen WITH the address: a customer who moves must not leave the old
    // serviced address labelling a map centred on the new home.
    snapshot.mapCenter = resolveVisitCoordinates({ visit, customer });
  }
  const frozenTechnicianName = textOrNull(technicianName);
  if (frozenTechnicianName) snapshot.technicianName = frozenTechnicianName;
  if (productFacts && typeof productFacts === 'object') {
    snapshot.productFacts = Object.fromEntries(
      Object.entries(productFacts).map(([id, facts]) => [canonicalProductId(id), facts]),
    );
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
 * pre-snapshot records render exactly as before. Idempotent: applying it
 * to an already-overlaid row yields the same values.
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
  if (Object.prototype.hasOwnProperty.call(snapshot, 'mapCenter')) {
    // The coordinates the frozen address resolved to — or none, so a live
    // geocode of the customer's NEW home never centres an old report.
    out.customer_latitude = snapshot.mapCenter?.lat ?? null;
    out.customer_longitude = snapshot.mapCenter?.lng ?? null;
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

/**
 * The portal's legacy pdfkit generator (documents.js generateServiceReportPDF)
 * takes separate customer / service / products inputs instead of the joined
 * row. Same facts, same precedence, applied to that shape. Returns the
 * inputs unchanged when the record carries no snapshot.
 */
function applyReportIdentitySnapshotToLegacyPdf({ customer, service, products = [] } = {}) {
  const snapshot = readReportIdentitySnapshot(service);
  if (!snapshot) return { customer, service, products };
  const outCustomer = { ...(customer || {}) };
  if (snapshot.customer && typeof snapshot.customer === 'object') {
    outCustomer.first_name = snapshot.customer.firstName ?? null;
    outCustomer.last_name = snapshot.customer.lastName ?? null;
  }
  if (snapshot.address && typeof snapshot.address === 'object') {
    outCustomer.address_line1 = snapshot.address.line1 ?? null;
    outCustomer.address_line2 = snapshot.address.line2 ?? null;
    outCustomer.city = snapshot.address.city ?? null;
    outCustomer.state = snapshot.address.state ?? null;
    outCustomer.zip = snapshot.address.zip ?? null;
  }
  const outService = { ...service };
  if (snapshot.technicianName) outService.technician_name = snapshot.technicianName;
  // The generator's heading, callback classification, and aftercare copy
  // key on service.service_type — same frozen title the V1 report uses.
  if (snapshot.serviceTitle) outService.service_type = snapshot.serviceTitle;
  const facts = snapshot.productFacts && typeof snapshot.productFacts === 'object' ? snapshot.productFacts : null;
  const outProducts = (products || []).map((product) => {
    const frozen = facts ? facts[canonicalProductId(product?.product_id)] : null;
    if (!frozen || typeof frozen !== 'object') return product;
    return {
      ...product,
      product_name: product.product_name || frozen.name,
      epa_reg_number: product.epa_reg_number || frozen.epaRegNumber,
    };
  });
  return { customer: outCustomer, service: outService, products: outProducts };
}

module.exports = {
  REPORT_IDENTITY_SNAPSHOT_VERSION,
  buildReportIdentitySnapshot,
  applyReportIdentitySnapshot,
  applyReportIdentitySnapshotToLegacyPdf,
  readReportIdentitySnapshot,
  resolveVisitAddress,
  resolveVisitCoordinates,
  canonicalProductId,
};
