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
 *    the completion-booked follow-up link (followup_source_service_id), or
 *    a chained visit (recurring_parent_id) of a FINITE plan —
 *    recurring_ongoing=false, a fixed visit count booked up front (e.g. a
 *    two-visit cockroach plan). Ordinary open-ended recurring series
 *    (recurring_ongoing=true) use the very same recurring_parent_id
 *    chaining, so bare chain linkage is NOT enough — their occurrences are
 *    the customer's routine schedule and must not print on a shareable
 *    report token. Rows with an unknown ongoing flag fail closed.
 *  - Never a 'rescheduled' row: those are phantom placeholders holding the
 *    OLD date/window until the office rebooks (the scheduling surfaces
 *    exclude them the same way) — publishing one would present a stale
 *    time as if it were still real.
 */

const db = require('../models/db');
const { etDateString } = require('../utils/datetime-et');

const DISCLOSABLE_APPOINTMENT_STATUSES = ['pending', 'confirmed', 'en_route', 'on_site'];

async function findReportFollowupAppointment({ customerId, scheduledServiceId }, knex = db) {
  if (!scheduledServiceId || !customerId) return null;
  const sourceVisit = await knex('scheduled_services')
    .where({ id: scheduledServiceId })
    .first('id', 'customer_id', 'recurring_parent_id', 'recurring_ongoing');
  // A linked visit belonging to a different customer means the link itself
  // is bad — disclose nothing rather than another customer's schedule.
  if (!sourceVisit || String(sourceVisit.customer_id) !== String(customerId)) return null;
  // Chain-based matching requires the DOCUMENTED visit itself to be part of
  // a finite plan (strictly false — null/unknown fails closed). Prod has
  // chains with inconsistent ongoing flags across members; when the
  // documented visit claims an open-ended series, only an explicit
  // completion-booked follow-up may disclose.
  const sourceIsFinitePlan = sourceVisit.recurring_ongoing === false;

  return knex('scheduled_services as s')
    .where('s.customer_id', customerId)
    .where('s.scheduled_date', '>=', etDateString())
    .whereIn('s.status', DISCLOSABLE_APPOINTMENT_STATUSES)
    .whereNot('s.id', sourceVisit.id)
    .where(function scopeToFollowup() {
      this.where('s.followup_source_service_id', sourceVisit.id);
      if (sourceIsFinitePlan) {
        this.orWhere(function finitePlanChain() {
          // Chained rows count only when BOTH ends of the link are marked
          // finite; an open-ended series child inherits
          // recurring_ongoing=true at creation (admin-schedule recurring
          // children) and never matches.
          this.where('s.recurring_ongoing', false)
            .andWhere(function chainedToSourcePlan() {
              this.where('s.recurring_parent_id', sourceVisit.id);
              // The documented visit may itself be a chained child (visit
              // 2 of 3): its later siblings share the same parent.
              if (sourceVisit.recurring_parent_id) {
                this.orWhere('s.recurring_parent_id', sourceVisit.recurring_parent_id);
              }
            });
        });
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

module.exports = { findReportFollowupAppointment };
