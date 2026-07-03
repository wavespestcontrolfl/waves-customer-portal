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
 *  - Only the documented visit's own continuation: the explicit
 *    completion-booked link (scheduled_services.followup_source_service_id)
 *    or the customer's next visit of the SAME service (multi-visit plans are
 *    booked up front without the link — e.g. a two-visit cockroach plan).
 *    Anything else on the customer's calendar is unrelated to this report.
 */

const db = require('../models/db');
const { etDateString } = require('../utils/datetime-et');

const ACTIVE_APPOINTMENT_STATUSES = ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'];

async function findReportFollowupAppointment({ customerId, scheduledServiceId }, knex = db) {
  if (!scheduledServiceId || !customerId) return null;
  const sourceVisit = await knex('scheduled_services')
    .where({ id: scheduledServiceId })
    .first('id', 'service_type', 'customer_id');
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
        .orWhere('s.service_type', sourceVisit.service_type);
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
