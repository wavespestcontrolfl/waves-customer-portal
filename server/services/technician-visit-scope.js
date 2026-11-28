/**
 * Technician job scoping — the ONE current-assignment predicate.
 *
 * requireTechOrAdmin admits both staff roles, but a technician token lives
 * on a phone in the field: every per-visit read or mutation scopes it to
 * the tech's OWN assigned jobs server-side. Assignment currency: a dead or
 * ancient row must not keep authorizing — the statuses below never
 * authorize; everything else (pending/confirmed/en_route/on_site/completed)
 * additionally has to sit inside the ET date window. Completed visits stay
 * readable for post-visit paperwork; a stale never-actioned pending row
 * from months ago grants nothing. Admin requests stay unscoped.
 *
 * Consumers include admin-schedule, admin-protocols and customer/profile
 * routes. Query columns are table-qualified, so the
 * builder must be on `scheduled_services` unaliased.
 */
const { addETDays, etDateString } = require('../utils/datetime-et');

const isTechnicianRequest = (req) => req.techRole === 'technician';

const TECH_DEAD_ASSIGNMENT_STATUSES = ['cancelled', 'canceled', 'rescheduled', 'skipped', 'no_show'];
const TECH_ACCESS_CODE_ENDED_STATUSES = ['completed', ...TECH_DEAD_ASSIGNMENT_STATUSES];
const TECH_ACCESS_WINDOW_DAYS = 7;
const techAccessCutoff = () => etDateString(addETDays(new Date(), -TECH_ACCESS_WINDOW_DAYS));

// Access codes and away-mode dates are only needed around the visit day
// (yesterday through tomorrow, ET) and only while the visit is still to be
// done — matching access-code-capture.js#listForVisit. Completed, terminal,
// or far-future visits never release raw door/gate/lockbox codes or
// away-mode dates to a technician.
function technicianMayReadVisitAccessCodes(req, visit, { now = new Date() } = {}) {
  if (!isTechnicianRequest(req)) return true;
  if (!visit || !req.technicianId) return false;
  if (String(visit.technician_id || '') !== String(req.technicianId)) return false;
  const status = String(visit.status || 'pending').toLowerCase();
  if (TECH_ACCESS_CODE_ENDED_STATUSES.includes(status)) return false;
  const { dateOnly } = require('./visit-groups');
  const visitDay = dateOnly(visit.scheduled_date);
  if (!visitDay) return false;
  return visitDay >= etDateString(addETDays(now, -1)) && visitDay <= etDateString(addETDays(now, 1));
}

function visitCustomerPrimaryAddress(visit) {
  if (!visit || !visit.customer_address_line1) return null;
  return {
    address_line1: visit.customer_address_line1,
    address_line2: visit.customer_address_line2 || null,
    city: visit.customer_city || null,
    zip: visit.customer_zip || null,
  };
}

// Unit-aware check: if the visit carries a stamped service address (line1 or
// line2), it MUST match the primary home's address before primary-home
// property_preferences codes can be released. Fails closed when a visit has a
// custom stamp but no primary address is available to compare against.
function visitStampMatchesHome(visit, home) {
  const hasStamp = Boolean(
    String(visit?.service_address_line1 || '').trim()
    || String(visit?.service_address_line2 || '').trim(),
  );
  if (!hasStamp) return true;
  if (!home || !String(home.address_line1 || '').trim()) return false;
  const { homesDiffer } = require('./customer-address-fanout');
  const stamped = {
    address_line1: visit.service_address_line1 || home.address_line1,
    address_line2: visit.service_address_line2 ?? null,
    city: visit.service_address_city || home.city || null,
    zip: visit.service_address_zip || home.zip || null,
  };
  return !homesDiffer(stamped, home);
}

// property_preferences stores one row per customer (the primary home). When a
// customer has multiple active homes, never serve primary-home access codes on
// a visit to a secondary or unstamped home (fail closed). Even with zero or one
// active home, a visit carrying a divergent service address or unit stamp fails
// closed. activeHomes === null indicates a lookup failure -> fail closed.
function propertyPrefsMatchVisitHome(visit, activeHomes, customerPrimaryAddress = null) {
  if (activeHomes === null) return false;
  const homes = Array.isArray(activeHomes) ? activeHomes : [];
  if (homes.length === 0) {
    if (visit?.property_id) return false;
    return visitStampMatchesHome(visit, customerPrimaryAddress || visitCustomerPrimaryAddress(visit));
  }
  if (homes.length === 1) {
    if (visit?.property_id && String(visit.property_id) !== String(homes[0].id)) return false;
    return visitStampMatchesHome(visit, homes[0]);
  }
  const primary = homes.find((h) => h.is_primary);
  if (!primary || !visit?.property_id || String(visit.property_id) !== String(primary.id)) return false;
  return visitStampMatchesHome(visit, primary);
}

function resolvePrimaryHomeForTechVisit(visit, activeHomes, customerPrimaryAddress = null) {
  const homes = Array.isArray(activeHomes) ? activeHomes : [];
  if (homes.length === 1) return homes[0];
  if (homes.length > 1) return homes.find((h) => h.is_primary) || null;
  return customerPrimaryAddress || visitCustomerPrimaryAddress(visit);
}

function visitHasDirectPremiseStamp(visit) {
  return Boolean(
    visit?.property_id
    || String(visit?.service_address_line1 || '').trim()
    || String(visit?.service_address_line2 || '').trim(),
  );
}

// Resolves unstamped estimate-backed visits via resolveVisitPropertyScope so an
// estimate for a second home (or an unresolvable estimate) never releases
// primary-home access codes even when the customer has 0 or 1 active property.
async function visitMatchesPrimaryHomeForTechAccess(conn, visit, activeHomes, customerPrimaryAddress = null, caches = {}) {
  if (!propertyPrefsMatchVisitHome(visit, activeHomes, customerPrimaryAddress)) return false;
  if (visitHasDirectPremiseStamp(visit) || !visit?.source_estimate_id) return true;
  const { resolveVisitPropertyScope, sameResolvedProperty } = require('./service-report/visit-property-scope');
  const linkage = require('./estimate-property-linkage');
  const scope = await resolveVisitPropertyScope(visit, conn, caches).catch(() => ({ key: null, hasEvidence: true }));
  if (!scope || !scope.key) return false;
  const primaryHome = resolvePrimaryHomeForTechVisit(visit, activeHomes, customerPrimaryAddress);
  const primaryKey = primaryHome
    ? linkage.normalizedStampedStreet(primaryHome.address_line1, primaryHome.address_line2, primaryHome.city, primaryHome.zip)
    : null;
  if (!primaryKey || linkage.scopeKeyLacksLocality(primaryKey)) return false;
  return sameResolvedProperty(scope.key, primaryKey);
}

async function loadEstimateCacheForVisits(conn, visits) {
  const ids = [...new Set((visits || [])
    .filter((v) => !visitHasDirectPremiseStamp(v) && v?.source_estimate_id)
    .map((v) => v.source_estimate_id))];
  const estimateById = new Map();
  if (!ids.length) return estimateById;
  try {
    const rows = await conn('estimates').whereIn('id', ids).select('id', 'address');
    for (const id of ids) estimateById.set(id, null);
    for (const row of rows || []) estimateById.set(row.id, row);
  } catch {
    for (const id of ids) estimateById.set(id, null);
  }
  return estimateById;
}

async function loadTechPrimaryAccessIds(conn, req, visits, activeHomesByCustomer) {
  const allowed = new Set();
  if (!isTechnicianRequest(req)) return allowed;
  const estimateById = await loadEstimateCacheForVisits(conn, visits);
  for (const v of visits || []) {
    if (!technicianMayReadVisitAccessCodes(req, v)) continue;
    const homes = activeHomesByCustomer ? (activeHomesByCustomer.get(v.customer_id) || []) : null;
    if (await visitMatchesPrimaryHomeForTechAccess(conn, v, homes, null, { estimateById })) {
      allowed.add(v.id);
    }
  }
  return allowed;
}

async function loadActiveHomesByCustomerIds(conn, customerIds) {
  const ids = [...new Set((customerIds || []).filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;
  try {
    const rows = await conn('customer_properties')
      .whereIn('customer_id', ids)
      .where({ active: true })
      .select('id', 'customer_id', 'is_primary', 'address_line1', 'address_line2', 'city', 'zip');
    for (const row of rows || []) {
      if (!map.has(row.customer_id)) map.set(row.customer_id, []);
      map.get(row.customer_id).push(row);
    }
    return map;
  } catch {
    return null;
  }
}

// Batch-loads active homes ONLY for technician requests (admins stay null/unscoped).
async function loadTechHomesByCustomerIds(conn, req, customerIds) {
  if (!isTechnicianRequest(req)) return null;
  return loadActiveHomesByCustomerIds(conn, customerIds);
}

// Single predicate combining role, visit-day window, non-ended status, and
// primary-home match for property_preferences access codes.
function visitAllowsAccessCodes(req, visit, homesMap, customerPrimaryAddress = null) {
  if (!isTechnicianRequest(req)) return true;
  if (!technicianMayReadVisitAccessCodes(req, visit)) return false;
  const homes = homesMap ? (homesMap.get(visit.customer_id) || []) : null;
  return propertyPrefsMatchVisitHome(visit, homes, customerPrimaryAddress);
}

const VISIT_PREMISE_COLS = [
  'property_id', 'service_address_line1', 'service_address_line2',
  'service_address_city', 'service_address_zip', 'source_estimate_id',
];

function sameVisitPremisesAndDate(a, b) {
  const { dateOnly } = require('./visit-groups');
  if (dateOnly(a?.scheduled_date) !== dateOnly(b?.scheduled_date)) return false;
  if (String(a?.customer_id || '') !== String(b?.customer_id || '')) return false;
  return VISIT_PREMISE_COLS.every((col) => (a?.[col] ?? null) === (b?.[col] ?? null));
}

async function loadFreshTechFeedState(conn, req, candidates) {
  const ids = candidates.map((c) => c.visit.id);
  try {
    const freshRows = await conn('scheduled_services')
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .whereIn('scheduled_services.id', ids)
      .where('scheduled_services.technician_id', req.technicianId)
      .whereNotIn('scheduled_services.status', TECH_DEAD_ASSIGNMENT_STATUSES)
      .select(
        'scheduled_services.id', 'scheduled_services.customer_id', 'scheduled_services.technician_id',
        'scheduled_services.status', 'scheduled_services.scheduled_date',
        ...VISIT_PREMISE_COLS.map((c) => `scheduled_services.${c}`),
        'customers.address_line1 as customer_address_line1',
        'customers.address_line2 as customer_address_line2',
        'customers.city as customer_city',
        'customers.zip as customer_zip',
      );
    const freshById = new Map((freshRows || []).map((r) => [r.id, r]));
    const freshHomes = await loadActiveHomesByCustomerIds(conn, candidates.map((c) => c.visit.customer_id));
    const estimateById = await loadEstimateCacheForVisits(conn, [...freshById.values()]);
    return { freshById, freshHomes, estimateById };
  } catch {
    return { freshById: null, freshHomes: null, estimateById: new Map() };
  }
}

async function evaluateTechFeedCandidate(conn, req, candidate, { freshById, freshHomes, estimateById }) {
  const fresh = freshById?.get(candidate.visit.id) || null;
  const sameCustomer = fresh && String(fresh.customer_id) === String(candidate.visit.customer_id);
  if (!sameCustomer || !technicianVisitRowInScope(req, fresh)) {
    return { lostAssignment: true, lostWindow: true, lostPrimary: true };
  }
  const stillWindow = technicianMayReadVisitAccessCodes(req, fresh)
    && sameVisitPremisesAndDate(candidate.visit, fresh);
  let stillPrimary = false;
  if (stillWindow && candidate.hadPrimary) {
    const homes = freshHomes ? (freshHomes.get(fresh.customer_id) || []) : null;
    stillPrimary = await visitMatchesPrimaryHomeForTechAccess(conn, fresh, homes, null, { estimateById });
  }
  const lostWindow = candidate.hadWindow && !stillWindow;
  const lostPrimary = candidate.hadPrimary && !stillPrimary;
  if (!lostWindow && !lostPrimary) return null;
  return { lostAssignment: false, lostWindow: !stillWindow, lostPrimary };
}

async function recheckTechFeedAccessRows(conn, req, candidates, onRevoked) {
  const droppedIds = new Set();
  if (!isTechnicianRequest(req) || !candidates.length) return droppedIds;
  const state = await loadFreshTechFeedState(conn, req, candidates);
  for (const candidate of candidates) {
    const flags = await evaluateTechFeedCandidate(conn, req, candidate, state);
    if (!flags) continue;
    if (flags.lostAssignment) droppedIds.add(candidate.visit.id);
    onRevoked(candidate, flags);
  }
  return droppedIds;
}

async function isVisitLiveForTechAccess(conn, { visitId, techId, customerId, today, visit = null }) {
  if (!techId) return true;
  const q = conn('scheduled_services')
    .where({ id: visitId, technician_id: techId, customer_id: customerId, scheduled_date: today })
    .whereNotIn('status', TECH_ACCESS_CODE_ENDED_STATUSES);
  if (visit) {
    for (const col of VISIT_PREMISE_COLS) {
      if (!(col in visit)) continue;
      if (visit[col] == null) q.whereNull(col);
      else q.where(col, visit[col]);
    }
  }
  const row = await q.first('id');
  return !!row;
}

async function sameHomeForTechVisitPrefs(conn, techId, customerId, visit, customerPrimaryAddress = null) {
  if (!techId) return true;
  const homesMap = await loadActiveHomesByCustomerIds(conn, [customerId]);
  return visitMatchesPrimaryHomeForTechAccess(
    conn,
    visit,
    homesMap ? (homesMap.get(customerId) || []) : null,
    customerPrimaryAddress,
  );
}

function redactFreeTextAccessCodes(text) {
  if (text == null || text === '') return text;
  const { redactAccessCodes } = require('./context-aggregator');
  return redactAccessCodes(String(text));
}

const ACCESS_CODE_PREF_FIELDS = [
  'neighborhood_gate_code', 'property_gate_code', 'garage_code', 'lockbox_code',
  'access_notes', 'side_gate_access', 'parking_notes', 'special_instructions', 'away_mode_until',
];

function stripAccessCodePrefs(prefs) {
  if (!prefs || typeof prefs !== 'object') return prefs;
  const copy = { ...prefs };
  for (const field of ACCESS_CODE_PREF_FIELDS) delete copy[field];
  return copy;
}

function stripAccessCodesFromBriefBlock(access) {
  if (!access || typeof access !== 'object') return access;
  const nextAlerts = Array.isArray(access.alerts)
    ? access.alerts
      .filter((a) => {
        const type = typeof a === 'object' ? a?.type : null;
        const text = typeof a === 'string' ? a : (a?.text || '');
        if (type === 'gate' || type === 'access' || type === 'special') return false;
        if (type === 'service_pref' && /AWAY MODE/i.test(text)) return false;
        return true;
      })
      .map((a) => {
        if (typeof a === 'string') return redactFreeTextAccessCodes(a);
        if (a && typeof a === 'object' && a.type === 'note' && typeof a.text === 'string') {
          return { ...a, text: redactFreeTextAccessCodes(a.text) };
        }
        return a;
      })
    : access.alerts;
  return {
    ...access,
    codes: { neighborhoodGate: null, propertyGate: null, garage: null, lockbox: null },
    accessNotes: null,
    parkingNotes: null,
    specialInstructions: null,
    alerts: nextAlerts,
  };
}

// READ access: a current-or-recent assignment (completed allowed in window).
function technicianCurrentVisitFilter(req, q) {
  if (isTechnicianRequest(req)) {
    q.where('scheduled_services.technician_id', req.technicianId)
      .whereNotIn('scheduled_services.status', TECH_DEAD_ASSIGNMENT_STATUSES)
      .where('scheduled_services.scheduled_date', '>=', techAccessCutoff());
  }
  return q;
}

// Customer-level field access follows the same current/recent assignment
// window, including post-visit paperwork. Call only after staff authentication.
async function technicianServicesCustomer(req, customerId) {
  if (!isTechnicianRequest(req)) return true;
  const db = require('../models/db');
  const assigned = await technicianCurrentVisitFilter(
    req,
    db('scheduled_services').where({ customer_id: customerId }),
  ).first('id');
  return !!assigned;
}

// The set of customers a technician currently services, as a subquery over
// scheduled_services (same current/recent predicate as above). For readers
// that list across customers — the SMS inbox — a technician's query adds
// whereIn(<customer column>, technicianCustomerIdsSubquery(req, db)).
// whereNotNull: a NULL customer_id in the set would make a caller's
// `NOT IN (subquery)` evaluate to NULL for every row and silently pass
// foreign threads (pre-push Codex P1).
function technicianCustomerIdsSubquery(req, db) {
  return technicianCurrentVisitFilter(req, db('scheduled_services'))
    .whereNotNull('scheduled_services.customer_id')
    .select('scheduled_services.customer_id');
}

// MUTATION access (prepaid, invoice mint, status): a LIVE visit only — a
// completed one is settled; corrections on it are office work.
function technicianLiveVisitFilter(req, q) {
  if (isTechnicianRequest(req)) {
    technicianCurrentVisitFilter(req, q)
      .whereNot('scheduled_services.status', 'completed');
  }
  return q;
}

// MUTATION helper (codex-review, PR #4673): locks the row FOR UPDATE
// inside the caller's OWN transaction and re-verifies the CURRENT-LIVE-
// assignment predicate (technicianLiveVisitFilter — dead statuses,
// completed rows, and anything outside the 7-day access window all fail
// it, not a bare technician_id compare) under that lock. Every technician-
// reachable per-visit write in admin-dispatch.js (status, note, reorder,
// reschedule's pre-check, rain-out's pre-check) calls this INSIDE its
// transaction so a reassignment landing between an earlier unlocked read
// and the write can never let the former technician's write land — the
// lock is held for the rest of the transaction, unlike a second unlocked
// SELECT, which only narrows the race window instead of closing it.
// Admin requests are unscoped (the filter is a no-op for them) and get the
// row unconditionally as long as it exists. Throws an Error with
// .status/.code set (403 service_not_assigned for a technician whose
// token no longer authorizes this row, 404 not_found for a row that
// genuinely doesn't exist) — callers let it propagate to the route's
// catch/next(err), or catch it themselves for a custom response shape.
// allowTerminal: a same-status retry of an already-terminal transition
// (cancelled/skipped/no_show, re-run to recover an interrupted invoice/
// reminder/tracker effect) is explicitly permitted by the status route's
// OWN terminal-transition logic even though the row now fails
// technicianLiveVisitFilter (dead statuses never authorize a NEW
// transition) — codex-review P1 (PR #4673 round 3): rejecting that retry
// outright regressed a legitimate, already-supported recovery path. Pass
// true only when the caller has ALREADY confirmed this is a same-status
// resend; it drops to a bare (but still row-locked) technician_id match,
// never staleness/dead-status, and stays admin-unscoped either way.
// allowCompleted: a NON-lifecycle write (the appointment note) on a visit
// the technician can still READ — codex round 4 P2 (PR #4673): the
// technician feed keeps a completed visit for the 7-day post-visit window
// and both note editors stay open on it, so gating the note save on the
// LIVE predicate made every such save 403. This swaps in the read-window
// predicate (technicianCurrentVisitFilter: own row, not dead, inside the
// window — completed allowed) under the same row lock; it never widens
// past what the technician can already see, and lifecycle writes keep the
// live predicate.
async function lockOwnedLiveVisit(trx, req, visitId, columns = ['*'], { allowTerminal = false, allowCompleted = false } = {}) {
  const q = trx('scheduled_services').where('scheduled_services.id', visitId).forUpdate();
  if (allowTerminal) {
    if (isTechnicianRequest(req)) q.where('scheduled_services.technician_id', req.technicianId);
  } else if (allowCompleted) {
    technicianCurrentVisitFilter(req, q);
  } else {
    technicianLiveVisitFilter(req, q);
  }
  const row = await q.first(...columns);
  if (row) return row;
  if (!isTechnicianRequest(req)) {
    throw Object.assign(new Error('Service not found'), { status: 404, code: 'not_found' });
  }
  throw Object.assign(new Error('Not assigned to this service'), { status: 403, code: 'service_not_assigned' });
}

// The same predicate as technicianCurrentVisitFilter, judged on a row already
// in hand (a locked member row at a save or resume boundary); administrators
// are unscoped. Every scope change lands here and in the SQL filter together.
function technicianVisitRowInScope(actor, row) {
  if (!isTechnicianRequest(actor)) return true;
  const { dateOnly } = require('./visit-groups');
  return String(row.technician_id || '') === String(actor.technicianId || '')
    && !TECH_DEAD_ASSIGNMENT_STATUSES.includes(String(row.status || ''))
    && dateOnly(row.scheduled_date) >= techAccessCutoff();
}

// Card on file at the visit (GATE_TECH_CARD_ON_FILE, owner 2026-11-04 D4 A): the visit an invoice is
// bound to must be the technician's own, scheduled today (ET), and completed. Tighter than the read
// window on purpose: a saved-card charge needs no customer at the door, so a past visit, or one not yet
// done, never qualifies. Completed, not On Site: the owner's 2026-09-26 rule is never to charge before
// the visit, and an after-visit card consent authorizes the charge only once the visit is completed
// (Codex security #7587 r3). Judged on a row in hand; the charge judges it again on the visit row it
// holds locked. Administrators are unscoped.
const TECH_CARD_ON_FILE_STATUSES = ['completed'];
function technicianCardOnFileVisitOk(actor, row) {
  if (!isTechnicianRequest(actor)) return true;
  const { dateOnly } = require('./visit-groups');
  return !!row && !!actor.technicianId
    && String(row.technician_id || '') === String(actor.technicianId)
    && TECH_CARD_ON_FILE_STATUSES.includes(String(row.status || ''))
    && dateOnly(row.scheduled_date) === etDateString();
}

// Card on file charges the booked visit only (Codex security #7587): every positive line must be one
// the server built from the visit (its primary line, its booked add-ons, its price top-up). A line
// added at checkout (extraLineItems: free description and price) needs the customer at the door, so
// it is Tap to Pay or manual card. Discount lines (negative) are fine.
function invoiceChargesBookedVisitOnly(invoice) {
  const visitId = String(invoice?.scheduled_service_id || '');
  if (!visitId) return false;
  const booked = (clientId) => clientId === `scheduled_${visitId}_primary`
    || clientId.startsWith(`scheduled_${visitId}_addon_`)
    || clientId === `scheduled_price_topup_${visitId}`;
  const lines = invoiceLines(invoice.line_items);
  return !!lines && lines.every((line) => !(Number(line?.amount) > 0) || booked(String(line?.client_id || '')));
}

// invoices.line_items is jsonb (an array) or, on old rows, JSON text. Missing or unreadable = null,
// which refuses (fail closed).
function invoiceLines(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// The unlocked check the card-on-file routes run first: the invoice is bound to a visit of its own
// customer, that visit passes technicianCardOnFileVisitOk and its closeout was a performed visit, the
// invoice bills the booked visit only, no active payment plan owns it, and the customer has not turned
// Auto Pay off.
async function technicianMayChargeCardOnFile(req, invoice, conn = null) {
  if (!isTechnicianRequest(req)) return true;
  if (!invoice?.id || !invoice.scheduled_service_id || !invoiceChargesBookedVisitOnly(invoice)) return false;
  const database = conn || require('../models/db');
  const row = await database('scheduled_services').where({ id: invoice.scheduled_service_id })
    .first('customer_id', 'technician_id', 'status', 'scheduled_date');
  if (!row || String(row.customer_id) !== String(invoice.customer_id) || !technicianCardOnFileVisitOk(req, row)) return false;
  // A completed visit is chargeable only after a performed closeout: inspection only, customer declined and
  // incomplete also end completed (the charge's requirePerformedVisit reads the same latest record under its lock).
  const record = await database('service_records').where({ scheduled_service_id: invoice.scheduled_service_id })
    .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).first('status', 'structured_notes');
  if (!require('./visit-outcomes').closeoutPerformedForCharge(record)) return false;
  // An active payment plan owns the invoice's collection: the office collects it.
  if (await database('payment_plans').where({ invoice_id: invoice.id, status: 'active' }).first('id')) return false;
  // A customer who turned Auto Pay off is not charged off-session from the visit.
  return !(await require('./payment-method-consents').autopayOptedOut(invoice.customer_id, { dbh: database }));
}

module.exports = { isTechnicianRequest, technicianCustomerIdsSubquery, TECH_DEAD_ASSIGNMENT_STATUSES, TECH_ACCESS_CODE_ENDED_STATUSES, TECH_ACCESS_WINDOW_DAYS, techAccessCutoff, technicianCurrentVisitFilter, technicianServicesCustomer, technicianLiveVisitFilter, technicianVisitRowInScope, lockOwnedLiveVisit, technicianCardOnFileVisitOk, technicianMayChargeCardOnFile, invoiceChargesBookedVisitOnly, technicianMayReadVisitAccessCodes, propertyPrefsMatchVisitHome, visitHasDirectPremiseStamp, visitMatchesPrimaryHomeForTechAccess, loadActiveHomesByCustomerIds, loadTechHomesByCustomerIds, loadTechPrimaryAccessIds, recheckTechFeedAccessRows, visitAllowsAccessCodes, isVisitLiveForTechAccess, sameHomeForTechVisitPrefs, redactFreeTextAccessCodes, stripAccessCodePrefs, stripAccessCodesFromBriefBlock };
