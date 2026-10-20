'use strict';

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
};
function withholdReportArtifacts(service) {
  if (!service) return service;
  const out = { ...service };
  for (const [key, value] of Object.entries(WITHHELD_REPORT_ARTIFACTS)) {
    if (key in out) out[key] = value;
  }
  return out;
}

// The customer row the service-report PDF (routes/documents.js
// generateServiceReportPDF) renders for a contact's own download: addressed
// to the contact, the serviced property's facts kept, the holder's name,
// phone, email and plan withheld (the same fields the contact's /auth/me
// projection leaves out).
function contactSafeReportCustomer(customer, contact) {
  const [first = '', ...rest] = String(contact?.name || '').trim().split(/\s+/).filter(Boolean);
  return {
    ...customer,
    first_name: first,
    last_name: rest.join(' '),
    phone: contact?.phone || '',
    email: contact?.email || '',
    waveguard_tier: null,
    monthly_rate: null,
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

// An upcoming-visit entry with its action bearers removed.
function withoutVisitBearers(visit) {
  if (!visit) return visit;
  return { ...visit, rescheduleUrl: null, calendarUrl: null, calendarExpiresAt: null };
}

// The GET /api/schedule payload for a contact: no re-service card, no
// overlay handoff, no per-visit bearer.
function contactSchedulePayload(payload) {
  return {
    ...payload,
    reservice: null,
    overlayHandoff: false,
    upcoming: (payload.upcoming || []).map(withoutVisitBearers),
  };
}

// The GET /api/schedule/next payload for a contact.
function contactNextPayload(payload) {
  return { ...payload, next: withoutVisitBearers(payload.next) };
}

module.exports = {
  contactSessionReportsWithheld,
  withholdReportArtifacts,
  contactSafeReportCustomer,
  withoutTrackBearers,
  contactSchedulePayload,
  contactNextPayload,
  _test: { WITHHELD_REPORT_ARTIFACTS },
};
