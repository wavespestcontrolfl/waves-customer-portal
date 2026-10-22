'use strict';

const db = require('../models/db');

// Contact session (GATE_CONTACT_LOGIN) response projections: what an
// on-location contact's OWN session may read off the account holder's row,
// applied by the routes CONTACT_SESSION_ROUTES admits (middleware/auth.js).
//
// Two rules (codex #6363 r2 P2, both):
//  1. The report rule for contacts (customer-contact.js
//     slotWithheldFromReports — a tenant, or an occupant on a
//     property-manager account) also decides whether the contact's session
//     may read report artifacts: the report links/tokens, the reviewed
//     notes, products and photos. Fail closed: a secondary profile whose
//     account role cannot be read counts as managed.
//  2. A contact is view-only (owner ruling): no schedule payload may carry an
//     action bearer — the per-visit /reschedule and /calendar.ics tokens, the
//     self-serve re-service page, the overlay handoff.

// Does the report rule withhold from this request's contact? A holder
// session is never withheld. Deny wins across EVERY slot that carries the
// session's number (the contact save does not reject a phone stored twice):
// an allowed slot before a tenant slot must not open the reports the
// delivery resolvers withhold (codex #6363 r4 P2), so the verdict is taken
// over all matching slots on the account-resolved row, not the first one
// the login matched.
async function contactSessionReportsWithheld(req) {
  if (!req.contactSession) return false;
  const { withAccountPrimaryContact, slotWithheldFromReports, getServiceContactSlots, phoneKeyOf } = require('./customer-contact');
  const row = await withAccountPrimaryContact(req.customer);
  const key = req.contactSession.phoneKey;
  const matching = getServiceContactSlots(row).filter((slot) => slot.phone && phoneKeyOf(slot.phone) === key);
  if (!matching.length) return slotWithheldFromReports(row, req.contactSession);
  return matching.some((slot) => slotWithheldFromReports(row, slot));
}

// A service-history row (portal-service-history.js) or service detail
// (routes/services.js) with every report artifact withheld. Only keys the
// payload already carries are rewritten, so the two shapes share one rule.
// The visit's measurements (soil temperature, thatch, pH, moisture) are
// findings the same verdict covers (codex #6363 r16 P2): the list carries
// them flat, the detail under `measurements`.
const WITHHELD_MEASUREMENTS = { soilTemp: null, thatchMeasurement: null, soilPh: null, soilMoisture: null };
const WITHHELD_REPORT_ARTIFACTS = {
  notes: null,
  products: [],
  photos: [],
  hasPhotos: false,
  photoCount: 0,
  reportUrl: null,
  reportPdfUrl: null,
  reportToken: null,
  reportGeneratedAt: null,
  reportViewedAt: null,
  reportAvailable: false,
  projectReportPortalAttached: false,
  ...WITHHELD_MEASUREMENTS,
  measurements: WITHHELD_MEASUREMENTS,
};
function withholdReportArtifacts(service) {
  if (!service) return service;
  const out = { ...service };
  for (const [key, value] of Object.entries(WITHHELD_REPORT_ARTIFACTS)) {
    if (!(key in out)) continue;
    out[key] = Array.isArray(value) ? [] : (value && typeof value === 'object' ? { ...value } : value);
  }
  return out;
}

// A contact's visit and report reads are scoped to the holder's PRIMARY
// property (codex #6363 r16 P1): the contact token carries no property
// claim and the app shows a contact one house, so the visits and reports
// stamped to the holder's OTHER saved properties are not theirs to list or
// open. The scope is built here from the customer_properties rows, NOT
// through the holder's saved-property resolver (codex r16 security P1):
// that resolver reads as unscoped while GATE_APP_PROPERTY_SCOPE — the
// holder app's picker rollout — is off, and the contact's boundary cannot
// depend on it. Same shape as resolveSessionScope so the shared predicates
// (applyPropertyPredicate, scopeRecordsToProperty) apply as they stand: the
// primary's stamped visits plus the unstamped ones; a profile whose rows
// were all retired has no house to show a contact anything under; one that
// never had a row keeps its one address's customer-wide reads. null for a
// holder session: the routes keep their own opt-in scoping.
// `dbh`: a caller already holding a transaction passes it (the contact
// preferences save under withCustomerCommsLock, codex #6363 r33 P2) so these
// reads ride that connection instead of reserving a second one from the pool.
async function contactRecordScope(req, dbh = db) {
  if (!req.contactSession) return null;
  return (await contactRecordScopes([req.customerId], dbh)).get(String(req.customerId));
}

// The scope above for SEVERAL rows at once, keyed by String(customer id):
// one customer_properties read for all of them. A contact listed on many
// rows (a property manager's number) has every row's address named in one
// /auth/properties or login response, and a read per row would hold a pool
// connection each, concurrently (codex #6364 r2 P2).
async function contactRecordScopes(customerIds, dbh = db) {
  const scopes = new Map();
  const ids = [...new Map(customerIds.map((id) => [String(id), id])).entries()];
  if (!ids.length) return scopes;
  // The same columns the saved-property resolver selects: the tracking
  // projection (scopedLocationCustomer) reads a non-primary fallback
  // property's address and geocode off the scope (codex #6363 r19 P2).
  // Retired rows are read too: a profile whose rows were ALL retired is
  // closed, one that never had a row keeps its customer-wide reads.
  const rows = await dbh('customer_properties')
    .whereIn('customer_id', ids.map(([, id]) => id))
    .orderBy([{ column: 'is_primary', order: 'desc' }, { column: 'created_at', order: 'asc' }])
    .select('id', 'customer_id', 'active', 'is_primary', 'label', 'relationship', 'occupancy_type', 'address_line1', 'address_line2', 'city', 'state', 'zip', 'latitude', 'longitude');
  for (const [key, customerId] of ids) {
    const mine = rows.filter((r) => String(r.customer_id) === key);
    const live = mine.filter((r) => r.active === true);
    if (!live.length) {
      const everHadRow = mine.length > 0;
      scopes.set(key, { customerId, enabled: true, multi: false, scoped: everHadRow, closed: everHadRow, property: null });
      continue;
    }
    const property = live.find((r) => r.is_primary === true) || live[0];
    scopes.set(key, { customerId, enabled: true, multi: live.length > 1, scoped: true, closed: false, property });
  }
  return scopes;
}

// The scope a session's record reads resolve under: a contact's, above; a
// holder's saved-property selection (GATE_APP_PROPERTY_SCOPE) otherwise —
// the one decision every scoped route (schedule, tracking) makes.
function sessionRecordScope(req) {
  return req.contactSession ? contactRecordScope(req) : require('./account-properties').resolveSessionScope(req);
}

// The address a contact's identity payloads (/auth/me, /auth/properties, the
// login response) name: the house the contact's record reads are scoped to
// (codex #6363 r20 P2) — the active primary, or the active row standing in
// for a retired primary — never the customer row's address when that row's
// saved primary has been retired. A profile that never had a saved-property
// row keeps its one address; one whose rows were all retired has no house
// to name.
function contactAddress(customer, scope) {
  if (scope && scope.property) {
    const p = scope.property;
    return { line1: p.address_line1 ?? null, line2: p.address_line2 ?? null, city: p.city ?? null, state: p.state ?? null, zip: p.zip ?? null };
  }
  if (scope && scope.closed) return { line1: null, line2: null, city: null, state: null, zip: null };
  return { line1: customer.address_line1, line2: customer.address_line2, city: customer.city, state: customer.state, zip: customer.zip };
}

// What a contact's payloads say about the property scope: the contact app
// has no picker and /auth/me reports the scope off, so every scoped read
// echoes the same — never the resolved primary's id, which the holder
// client would compare against a selection the contact never made.
const CONTACT_PROPERTY_SCOPE_ECHO = Object.freeze({ enabled: false, propertyId: null, closed: false });

// That scope on a service_records query that LEFT JOINs scheduled_services
// (the detail, the documents list, the report PDF) — the same rule the
// history list applies through listPortalServiceHistory.
function scopeContactRecords(query, scope) {
  return scope ? require('./portal-service-history').scopeRecordsToProperty(query, scope) : query;
}

// A service-history row for a contact the report rule ALLOWS: the visit's
// notes, products and photos stay, but the public report bearers go — the
// /report/:token page and /api/reports/:token PDF render the holder's
// identity (and a project report its billing links), the same exposure
// /api/documents and /api/tracking already remove (codex #6363 r7 P1). The
// report reaches the contact through the authenticated, contact-safe PDF
// route only; a project completion's report has no such route, so it is
// not offered.
function contactSafeReportLinks(service) {
  if (!service) return service;
  const out = { ...service };
  const project = service.isProjectCompletion === true;
  if ('reportUrl' in out) out.reportUrl = null;
  if ('reportToken' in out) out.reportToken = null;
  if ('projectReportPortalAttached' in out) out.projectReportPortalAttached = false;
  if ('reportPdfUrl' in out) out.reportPdfUrl = !project && service.reportAvailable !== false ? `/api/documents/service-report/${service.id}` : null;
  if ('reportAvailable' in out) out.reportAvailable = !project && service.reportAvailable !== false;
  return out;
}

// The customer row the service-report PDF (routes/documents.js
// generateServiceReportPDF) renders for a contact's own download: addressed
// to the contact, the serviced property's facts kept, the holder's name,
// phone, email and plan withheld (the same fields the contact's /auth/me
// projection leaves out).
// `address` (contactAddress's shape): the house the PDF is labeled with when
// the record carries no frozen address of its own — the house the contact's
// reads are scoped to, never the customer row's retired primary (codex #6363
// r33 P2). null keeps the row's (or the snapshot's) address fields.
function contactSafeReportCustomer(customer, contact, { address = null } = {}) {
  const [first = '', ...rest] = String(contact?.name || '').trim().split(/\s+/).filter(Boolean);
  return {
    ...customer,
    first_name: first,
    last_name: rest.join(' '),
    phone: contact?.phone || '',
    email: contact?.email || '',
    waveguard_tier: null,
    monthly_rate: null,
    ...(address ? {
      address_line1: address.line1, address_line2: address.line2, city: address.city, state: address.state, zip: address.zip,
    } : {}),
  };
}

// The /api/tracking tracker for a contact: the live steps, ETA and map stay;
// the public /track/:token bearer goes (codex #6363 r3 P1) — a completed
// visit's tracker summary carries the invoice token, the report token and
// the review link, none of which a contact session may reach.
function withoutTrackBearers(tracker) {
  if (!tracker) return tracker;
  return { ...tracker, trackToken: null, trackUrl: null };
}

// The holder's plan-coverage facts a visit entry carries for the portal's
// plan cards (recurring / callback / WaveGuard family). A contact's view
// withholds the holder's plan everywhere else (/auth/me, the report PDF,
// the refused coverage-only payload), so the ordinary /api/schedule and
// /api/schedule/next entries drop them too (codex #6363 r15 P2): the
// visit's date, window, service type, status and technician stay.
const PLAN_SIGNAL_KEYS = ['isRecurring', 'isCallback', 'waveguardQualifying', 'serviceFamily'];

// A visit entry for a contact: no action bearer, no plan signal.
function contactVisit(visit) {
  if (!visit) return visit;
  const out = { ...visit, rescheduleUrl: null, calendarUrl: null, calendarExpiresAt: null };
  for (const key of PLAN_SIGNAL_KEYS) delete out[key];
  return out;
}

// The GET /api/schedule payload for a contact: no re-service card, no
// overlay handoff, no cancellable-work flag (a holder's action signal), no
// per-visit bearer or plan signal.
function contactSchedulePayload(payload) {
  return {
    ...payload,
    propertyScope: CONTACT_PROPERTY_SCOPE_ECHO,
    hasCancellableWork: false,
    reservice: null,
    overlayHandoff: false,
    upcoming: (payload.upcoming || []).map(contactVisit),
  };
}

// The GET /api/schedule/next payload for a contact.
function contactNextPayload(payload) {
  return { ...payload, propertyScope: CONTACT_PROPERTY_SCOPE_ECHO, next: contactVisit(payload.next) };
}

module.exports = {
  contactSessionReportsWithheld,
  contactRecordScope,
  contactRecordScopes,
  sessionRecordScope,
  contactAddress,
  scopeContactRecords,
  CONTACT_PROPERTY_SCOPE_ECHO,
  withholdReportArtifacts,
  contactSafeReportLinks,
  contactSafeReportCustomer,
  withoutTrackBearers,
  contactSchedulePayload,
  contactNextPayload,
  _test: { WITHHELD_REPORT_ARTIFACTS, WITHHELD_MEASUREMENTS, PLAN_SIGNAL_KEYS },
};
