// client/src/lib/assessment-fast-complete.js
//
// The one rule for "this Waves Assessment visit opens the one-screen Fast
// Complete sheet" (GATE_ASSESSMENT_FAST_COMPLETE, owner 2026-10-09: 12 closed in
// 90 days, and the full form asks for far more than a talk note, photos and
// what is recommended).
//
// It builds on the canonical rules and writes none of its own:
//  - what an assessment is, and which statuses allow its outcome:
//    canRecordConsultationOutcome (lib/consultationVisit.js, built on
//    isConsultationVisit, the client mirror of
//    server/services/assessment-booking.js);
//  - whether the gate is on for this row: `assessmentFastCompleteEnabled`, which
//    the schedule payload sets only while the gate is live AND the visit's
//    completion profile is the assessment key (server/routes/admin-schedule.js);
//  - whether the visit completes on its own record: completesOnOwnRecord
//    (lib/pest-fast-complete.js: profile and linked-project reads answered, no
//    project, open).
// On top of those, the visits the sheet does not take stay on the full form: a
// service with companion sections (their sections are required at completion
// and the sheet has none) and a grouped stop (the server completes a grouped
// visit through its closeout, or after it is separated, and the sheet has
// neither). The page guards (a visit returning from the payment flow, a row
// with no `propertyId` key) live with the other sheets' in
// dispatchCompletionRouting.js. The sheet's own "Full form" button covers the
// incomplete and no-show outcomes, which the sheet does not record.
import { canRecordConsultationOutcome } from './consultationVisit';
import { completesOnOwnRecord } from './pest-fast-complete';
import { formatETDate } from './timezone';

export function isAssessmentFastCompleteEligible(service) {
  // An assessment whose outcome the server accepts: canRecordConsultationOutcome
  // is isConsultationVisit minus the statuses recordOutcome refuses (no_show,
  // cancelled, skipped, rescheduled: CONSULTATION_NOT_HELD). The sheet's read is
  // recorded inside the completion, so a visit that would refuse it keeps the
  // full form. (The arrival window is not a reason: the completion path skips it.)
  return canRecordConsultationOutcome(service)
    && service?.assessmentFastCompleteEnabled === true
    && completesOnOwnRecord(service)
    && !(service.completionProfile?.companions || []).length
    // The server refuses any grouped visit that is not a dissolved one, which
    // the row cannot tell apart (the lawn re-service sheet's rule).
    && !(service.visitCloseoutPacket || service.visitId || service.visit_id);
}

// The estimate line on the sheet (owner 2026-10-09: the estimate sets the price,
// the sheet only points to it). `summary` is the answer of
// GET /admin/consultations/:id/estimate (services/assessment-estimate-summary.js).
// Returns null where the sheet shows nothing: still loading, unreadable, or
// more than one live estimate (no canonical pick, so no guess).
//
// NO AMOUNT, on purpose. An estimate's stored monthly / annual / one-time totals
// are accounting figures: a $100-per-application plan is stored as $50, $75 or
// $100 "monthly" by visit count, and a one-time total can be an alternative
// (show_one_time_option), not an added charge. The price a person is quoted is
// stated by the estimate page from its own lines. So the line says whether the
// estimate went out and links to it; the price is read there.
//
// `sentAt` is the last real handoff to the customer (a delivery, or their own
// acceptance), so a suppressed send reads "not sent yet", like a draft.
const UNSENT_WORDS = {
  draft: 'Estimate draft, not sent yet',
  scheduled: 'Estimate scheduled to send',
  sending: 'Estimate sending',
  send_failed: 'Estimate send failed',
};

export function estimateStatusLabel(estimate) {
  if (estimate?.status === 'accepted') return 'Estimate accepted';
  if (estimate?.sentAt) return `Estimate sent ${formatETDate(estimate.sentAt, { month: 'short', day: 'numeric' })}`;
  return UNSENT_WORDS[estimate?.status] || 'Estimate not sent yet';
}

export function estimateLineOf(summary) {
  if (!summary) return null;
  if (summary.state === 'found' && summary.estimate) {
    return { kind: 'found', estimateId: summary.estimate.id, text: estimateStatusLabel(summary.estimate) };
  }
  if (summary.state === 'none') return { kind: 'none', text: 'No estimate yet' };
  if (summary.state === 'retired') {
    return { kind: 'none', text: `No current estimate · the last one was ${String(summary.status || 'closed').replace(/_/g, ' ')}` };
  }
  return null;
}
