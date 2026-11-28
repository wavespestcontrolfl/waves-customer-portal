'use strict';

/**
 * Call-to-Truck Brief builder (`scheduled_services.customer_request` + `customer_request_source = 'call'`).
 *
 * Populates a clean, operational, technician-safe & customer-report-safe booking reason
 * for phone-booked visits strictly from allowlisted, structured catalog/pest fields:
 *   - Canonical `pest_type` tokens from V2 `service_request.pests_observed`.
 *   - Optional standard property zones from `ALLOWED_PROPERTY_LOCATIONS` (exact normalized match
 *     only, omitted when `GATE_CALL_ENRICH_CODES_REQUIRE_ANI` is on and caller ANI is unverified).
 *   - When final booked service is neither Assessment nor Re-Service and no structured pests
 *     exist: the server-resolved `catalogServiceName`.
 *
 * Privacy & compliance contract (`tech-visibility-ruling-2026-11-04` + report copy rules):
 * - NEVER copies free-text `pain_points`, `call_summary`, or arbitrary `location_on_property`
 *   prose into `customer_request` (which feeds forwardable customer service reports via
 *   `bookedReasonBlock`). Household medical/sensitivity notes and custom instructions stay
 *   strictly in technician-only `property_preferences` via `call-profile-enrichment.js`.
 * - Pure & synchronous (zero DB queries inside the booking transaction; callers pass the
 *   already-loaded `customerPrimaryPhone`).
 * - Screens every emitted fragment and the final brief through `customerCopyViolations`,
 *   `scrubPans`, and `redactAccessCodes`, and caps cleanly at 400 chars on a word boundary.
 */

const { scrubPans } = require('../utils/pan-scrub');
const { redactAccessCodes } = require('./context-aggregator');
const { customerCopyViolations } = require('./service-report/technician-report-copy');
const { callEnrichCodesRequireAniLive } = require('../config/feature-gates');

const MAX_BRIEF_CHARS = 400;
const JOIN_SEP = ' | ';

const MONEY_OR_BILLING_RE = /(?:\$\s*\d|\b\d+(?:\.\d{1,2})?\s*(?:dollars?|bucks?|per\s+(?:visit|month|quarter|year))\b|\b(?:price|pricing|quoted?|quote|invoice|billing|bill[- ]to|payer|payment|landlord|autopay|credit\s+card|debit\s+card|charge[ds]?|fee|cost|discount|coupon|comp(?:ed|limentary)?|free|prepay|refund|balance)\b)/i;
const EMAIL_PII_RE = /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i;
const PHONE_PII_RE = /(?<!\d)(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)/;
const CANONICAL_PEST_RE = /^[a-z][a-z0-9 -]{1,35}$/i;

// Exact-match allowlist of generic property zones safe to include on a customer-visible report.
// Free-text locations (e.g. "bedroom where our child uses oxygen") are rejected automatically.
const ALLOWED_PROPERTY_LOCATIONS = Object.freeze(new Set([
  'attic', 'back patio', 'back porch', 'back yard', 'backyard', 'baseboards', 'basement',
  'bathroom', 'bathrooms', 'bedroom', 'bedrooms', 'crawl space', 'crawlspace', 'dining room',
  'dock', 'doors', 'driveway', 'eaves', 'entryway', 'exterior', 'family room', 'fence',
  'flower beds', 'foundation', 'foyer', 'front patio', 'front porch', 'front yard', 'garage',
  'garage door', 'garden', 'guest bedroom', 'hallway', 'inside', 'interior', 'kitchen',
  'kitchen counter', 'lanai', 'laundry room', 'lawn', 'living room', 'master bedroom',
  'mulch beds', 'office', 'outside', 'pantry', 'patio', 'perimeter', 'pool area', 'pool cage',
  'pool deck', 'porch', 'roof', 'shed', 'shrubs', 'side yard', 'soffit', 'sunroom', 'trees',
  'utility room', 'window sills', 'windows', 'yard',
]));

const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);

function callerAniMatchesPrimaryPhone(callerAni, customerPrimaryPhone) {
  const ani = last10(callerAni);
  return ani.length === 10 && ani === last10(customerPrimaryPhone);
}

function normalizedKey(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isReportAndTechSafe(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length < 2) return false;
  if (EMAIL_PII_RE.test(clean) || PHONE_PII_RE.test(clean) || MONEY_OR_BILLING_RE.test(clean)) return false;
  if (scrubPans(clean) !== clean || redactAccessCodes(clean) !== clean) return false;
  return customerCopyViolations(clean).length === 0;
}

function canonicalPestLabel(raw) {
  const pest = String(raw || '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!pest || /^(?:other|unknown|general|unspecified|none)$/i.test(pest)) return '';
  if (!CANONICAL_PEST_RE.test(pest)) return '';
  return isReportAndTechSafe(pest) ? pest : '';
}

function allowlistedLocation(raw) {
  const loc = String(raw || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return ALLOWED_PROPERTY_LOCATIONS.has(loc) ? loc : '';
}

function formatObservedPest(entry, { includeLocation = true } = {}) {
  if (typeof entry === 'string') return canonicalPestLabel(entry);
  const pest = canonicalPestLabel(entry?.pest_type);
  if (!pest) return '';
  if (!includeLocation) return pest;
  const loc = allowlistedLocation(entry?.location_on_property ?? entry?.location);
  return loc ? `${pest} (${loc})` : pest;
}

function formatObservedPests(sr, opts = {}) {
  const list = Array.isArray(sr.pests_observed) ? sr.pests_observed : [];
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const label = formatObservedPest(entry, opts);
    const key = normalizedKey(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out.join(', ');
}

function formatCatalogFallback({ isReService = false, catalogServiceName = null } = {}) {
  if (isReService) return '';
  const label = String(catalogServiceName || '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!label || /^(?:other|unknown|general|unspecified)$/i.test(label)) return '';
  return isReportAndTechSafe(label) ? label : '';
}

function truncateBrief(text, maxChars) {
  const s = String(text || '').trim();
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const boundary = cut.lastIndexOf(' ');
  return (boundary > maxChars * 0.6 ? cut.slice(0, boundary) : cut).replace(/[\s|,;:-]+$/, '').trim();
}

function buildCallToTruckBrief(input) {
  const opts = Object(input);
  const v2 = Object(opts.v2Extraction);
  const sr = Object(v2.service_request);
  const includeLocation = opts.includeLocation !== false && opts.allowSafetyNotes !== false;

  const entries = [];
  const pests = formatObservedPests(sr, { includeLocation });
  if (pests) {
    const text = `Pests: ${pests}`;
    if (customerCopyViolations(text).length === 0) entries.push(text);
  }

  if (!opts.isAssessmentBooking && !entries.length) {
    const requested = formatCatalogFallback({
      isReService: opts.isReService,
      catalogServiceName: opts.catalogServiceName || null,
    });
    if (requested) {
      const text = `Requested: ${requested}`;
      if (customerCopyViolations(text).length === 0) entries.push(text);
    }
  }

  const finalText = truncateBrief(entries.join(JOIN_SEP), MAX_BRIEF_CHARS);
  if (!finalText) return null;
  return customerCopyViolations(finalText).length === 0 ? finalText : null;
}

// Pure synchronous wrapper enforcing GATE_CALL_ENRICH_CODES_REQUIRE_ANI using the
// caller's already-loaded customer primary phone (never queries inside a PG transaction).
function resolveCallToTruckBriefForBooking(input) {
  const opts = Object(input);
  const aniVerified = !callEnrichCodesRequireAniLive()
    || callerAniMatchesPrimaryPhone(opts.callerAni, opts.customerPrimaryPhone);
  return buildCallToTruckBrief({ ...opts, includeLocation: aniVerified });
}

function verifiedCatalogRowForVisit(row, catalogRows) {
  if (!row?.service_id || !Array.isArray(catalogRows)) return null;
  const targetId = String(row.service_id);
  return catalogRows.find((c) => c && String(c.id) === targetId) || null;
}

// Backfill an empty customer_request on a reused booking row created by this
// same call (e.g. live voice-agent booking before recording processing ran).
// Never overwrites an existing customer_request, never mutates attached manual
// bookings or rows owned by another call, and NEVER copies an editable
// row.service_type label (resolves fallback strictly from row.service_id in
// the server-loaded catalog, omitting fallback if unverified).
async function backfillCallToTruckBriefOnReusedRow(trx, row, opts = {}) {
  if (opts.skip || !row?.id || !opts.callId) return row;
  if (String(row.source_call_log_id || '') !== String(opts.callId)) return row;
  if (String(row.customer_request || '').trim()) return row;
  const verifiedCatalog = verifiedCatalogRowForVisit(row, opts.catalogRows);
  const verifiedName = verifiedCatalog?.name || null;
  const brief = resolveCallToTruckBriefForBooking({
    ...opts.briefInput,
    catalogServiceName: verifiedName,
    isAssessmentBooking: Boolean(
      opts.briefInput?.isAssessmentBooking
      || /assessment/i.test(String(verifiedName || row.service_type || '')),
    ),
  });
  if (!brief) return row;
  if (!(await trx.schema.hasColumn('scheduled_services', 'customer_request'))) return row;
  const updated = await trx('scheduled_services')
    .where({ id: row.id })
    .whereRaw("COALESCE(TRIM(customer_request), '') = ''")
    .update({ customer_request: brief, customer_request_source: 'call', updated_at: new Date() });
  return updated ? { ...row, customer_request: brief, customer_request_source: 'call' } : row;
}

module.exports = {
  buildCallToTruckBrief,
  resolveCallToTruckBriefForBooking,
  backfillCallToTruckBriefOnReusedRow,
  callerAniMatchesPrimaryPhone,
  ALLOWED_PROPERTY_LOCATIONS,
  MAX_BRIEF_CHARS,
  _test: { canonicalPestLabel, allowlistedLocation, formatObservedPests, truncateBrief },
};
