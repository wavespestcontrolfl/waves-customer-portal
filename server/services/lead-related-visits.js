/**
 * Visits linked to ONE lead by exact record evidence (appointment activity,
 * ad self-booking attribution, or the lead's estimate). Shared by the admin
 * lead card (routes/admin-leads.js) and the nightly lead-why filler, so both
 * read "this lead booked" the same way. A customer or phone match is never a
 * link: one customer can have several inquiries.
 */

const RELATED_VISITS_LIMIT = 25;

// Outcome evidence must name the record, not merely the person. A customer or
// phone match can span multiple inquiries and is therefore never a visit link.
// All visits linked to the lead, unordered and unlimited (callers add filters).
function leadLinkedVisits(conn, lead) {
  const leadId = String(lead.id);
  return conn('scheduled_services as ss')
    .where(function confirmedLeadIdentity() {
      this.whereExists(
        conn('lead_activities as la')
          .select(conn.raw('1'))
          .where('la.lead_id', lead.id)
          .where('la.activity_type', 'appointment_scheduled')
          .whereRaw("la.metadata->>'appointmentId' = ss.id::text"),
      ).orWhereExists(
        conn('ad_service_attribution as asa')
          .select(conn.raw('1'))
          .where('asa.lead_id', lead.id)
          .whereRaw('asa.self_booked_appointment_id = ss.self_booking_id'),
      ).orWhereExists(
        conn('estimates as e')
          .select(conn.raw('1'))
          .whereRaw('e.id = ss.source_estimate_id')
          // The estimate's lead mirror wins over a stale leads.estimate_id.
          .where(function exactEstimateOwner() {
            this.whereRaw("e.estimate_data->>'lead_id' = ?", [leadId]);
            if (lead.estimate_id) {
              this.orWhere(function unmirroredLeadEstimate() {
                this.whereRaw("e.estimate_data->>'lead_id' IS NULL")
                  .where('e.id', lead.estimate_id);
              });
            }
          })
          // Nullable ownership is not disagreement. Two populated owners must
          // agree, and a populated lead customer vetoes either dissenting row.
          .whereRaw('(e.customer_id IS NULL OR ss.customer_id IS NULL OR e.customer_id = ss.customer_id)')
          .modify((estimate) => {
            if (!lead.customer_id) return;
            estimate.where((owner) => owner.whereNull('e.customer_id').orWhere('e.customer_id', lead.customer_id));
          }),
      );
    })
    // Exact record linkage does not override a known owner conflict: showing
    // another customer's invoice is worse than omitting a stale association.
    // An unknown visit owner remains eligible for every exact linkage arm.
    .modify((visits) => {
      if (lead.customer_id) {
        visits.where((owner) => owner.whereNull('ss.customer_id').orWhere('ss.customer_id', lead.customer_id));
      }
    })
    ;
}

function leadRelatedVisitQuery(conn, lead) {
  return leadLinkedVisits(conn, lead)
    .orderByRaw('ss.scheduled_date DESC NULLS LAST, ss.id DESC')
    .limit(RELATED_VISITS_LIMIT + 1)
    .select('ss.id', 'ss.status', 'ss.scheduled_date');
}

module.exports = { leadLinkedVisits, leadRelatedVisitQuery, RELATED_VISITS_LIMIT };
