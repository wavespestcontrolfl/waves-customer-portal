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
const TECH_ACCESS_WINDOW_DAYS = 7;
const techAccessCutoff = () => etDateString(addETDays(new Date(), -TECH_ACCESS_WINDOW_DAYS));

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
async function lockOwnedLiveVisit(trx, req, visitId, columns = ['*'], { allowTerminal = false } = {}) {
  const q = trx('scheduled_services').where('scheduled_services.id', visitId).forUpdate();
  if (allowTerminal) {
    if (isTechnicianRequest(req)) q.where('scheduled_services.technician_id', req.technicianId);
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

module.exports = { isTechnicianRequest, TECH_DEAD_ASSIGNMENT_STATUSES, TECH_ACCESS_WINDOW_DAYS, techAccessCutoff, technicianCurrentVisitFilter, technicianServicesCustomer, technicianLiveVisitFilter, technicianVisitRowInScope, lockOwnedLiveVisit };
