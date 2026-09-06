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
 * Consumers: admin-schedule (board, per-visit money endpoints) and
 * admin-protocols (job card). Query columns are table-qualified, so the
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

// MUTATION access (prepaid, invoice mint, status): a LIVE visit only — a
// completed one is settled; corrections on it are office work.
function technicianLiveVisitFilter(req, q) {
  if (isTechnicianRequest(req)) {
    technicianCurrentVisitFilter(req, q)
      .whereNot('scheduled_services.status', 'completed');
  }
  return q;
}

module.exports = { isTechnicianRequest, TECH_DEAD_ASSIGNMENT_STATUSES, TECH_ACCESS_WINDOW_DAYS, techAccessCutoff, technicianCurrentVisitFilter, technicianLiveVisitFilter };
