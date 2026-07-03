/**
 * The follow-up appointment a project report may disclose.
 *
 * Shared by the public report data endpoint (reports-public.js) and the
 * admin project detail endpoint (admin-projects.js) so the staff preview and
 * the customer page can never disagree about which visit prints as
 * "Follow-up".
 *
 * Scope rules (Codex #2299 rounds 1–2):
 *  - Only reports tied to a documented visit get one. A standalone/ad hoc
 *    report has no visit this would follow, and its token may be shared with
 *    third parties (e.g. a WDO report in a real-estate transaction) —
 *    surfacing the customer's routine schedule there would be both wrong and
 *    a disclosure.
 *  - Never the documented visit itself: on the service day the linked
 *    appointment is the just-treated visit (still en_route/on_site), which
 *    is how a report printed today's service as its own follow-up.
 *  - Only appointments EXPLICITLY linked to the documented visit's plan:
 *    the completion-booked follow-up link (followup_source_service_id), a
 *    visit chained off the documented one (recurring_parent_id → source —
 *    how a multi-visit plan booked up front is stored, e.g. a two-visit
 *    cockroach plan), or a later visit of the same chain (shared
 *    recurring_parent_id). Matching by service_type alone is NOT enough:
 *    an ordinary recurring series shares the type, and its occurrences
 *    must not print on a shareable report token as this report's
 *    follow-up.
 */

const db = require('../models/db');
const { etDateString } = require('../utils/datetime-et');

const ACTIVE_APPOINTMENT_STATUSES = ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'];

async function findReportFollowupAppointment({ customerId, scheduledServiceId }, knex = db) {
  if (!scheduledServiceId || !customerId) return null;
  const sourceVisit = await knex('scheduled_services')
    .where({ id: scheduledServiceId })
    .first('id', 'customer_id', 'recurring_parent_id');
  // A linked visit belonging to a different customer means the link itself
  // is bad — disclose nothing rather than another customer's schedule.
  if (!sourceVisit || String(sourceVisit.customer_id) !== String(customerId)) return null;

  return knex('scheduled_services as s')
    .where('s.customer_id', customerId)
    .where('s.scheduled_date', '>=', etDateString())
    .whereIn('s.status', ACTIVE_APPOINTMENT_STATUSES)
    .whereNot('s.id', sourceVisit.id)
    .where(function scopeToFollowup() {
      this.where('s.followup_source_service_id', sourceVisit.id)
        .orWhere('s.recurring_parent_id', sourceVisit.id);
      // The documented visit may itself be a chained child (visit 2 of 3):
      // its later siblings share the same parent.
      if (sourceVisit.recurring_parent_id) {
        this.orWhere('s.recurring_parent_id', sourceVisit.recurring_parent_id);
      }
    })
    .leftJoin('technicians as st', 's.technician_id', 'st.id')
    .orderBy('s.scheduled_date', 'asc')
    .orderBy('s.window_start', 'asc')
    .select(
      's.id',
      's.service_type',
      's.scheduled_date',
      's.window_start',
      's.window_end',
      's.status',
      'st.name as technician_name',
    )
    .first()
    .then((row) => row || null);
}

module.exports = { findReportFollowupAppointment, ACTIVE_APPOINTMENT_STATUSES };
