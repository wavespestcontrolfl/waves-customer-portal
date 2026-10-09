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

export function isAssessmentFastCompleteEligible(service) {
  // An assessment whose outcome the server accepts: canRecordConsultationOutcome
  // is isConsultationVisit minus the statuses recordOutcome refuses (no_show,
  // cancelled, skipped, rescheduled: CONSULTATION_NOT_HELD). The sheet's first
  // write is that outcome, so a visit it would always refuse keeps the full form.
  return canRecordConsultationOutcome(service)
    && service?.assessmentFastCompleteEnabled === true
    && completesOnOwnRecord(service)
    && !(service.completionProfile?.companions || []).length
    // The server refuses any grouped visit that is not a dissolved one, which
    // the row cannot tell apart (the lawn re-service sheet's rule).
    && !(service.visitCloseoutPacket || service.visitId || service.visit_id);
}
