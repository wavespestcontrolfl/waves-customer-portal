// Review-gated outbound-callback bookings (2026-07-11). A confirmed booking on
// an OUTBOUND call creates the appointment PENDING/needs-review with a distinct
// source_action so the customer can't self-confirm it, and an
// outbound_booking_review triage item for the office. These verify the shared
// markers + the triage lane; the insert-side / route filters are integration.
const { buildTriageItem } = require('../services/call-routing-gates');
const {
  CALL_OUTBOUND_REVIEW_SOURCE_ACTION,
  CALL_FOLLOWUP_SOURCE_ACTION,
  DISPATCH_OWNED_PENDING_SOURCE_ACTIONS,
} = require('../services/call-booking-source-actions');

describe('outbound review booking — shared source-action markers', () => {
  test('the outbound-review marker is a distinct, stable string', () => {
    expect(CALL_OUTBOUND_REVIEW_SOURCE_ACTION).toBe('ai_call_pipeline_outbound_review');
    expect(CALL_OUTBOUND_REVIEW_SOURCE_ACTION).not.toBe(CALL_FOLLOWUP_SOURCE_ACTION);
  });

  test('dispatch-owned pending set covers BOTH the follow-up and outbound-review markers', () => {
    // The customer self-service routes (schedule.js) hide/refuse every marker in
    // this set until the office confirms — so both must be present.
    expect(DISPATCH_OWNED_PENDING_SOURCE_ACTIONS).toEqual(
      expect.arrayContaining([CALL_FOLLOWUP_SOURCE_ACTION, CALL_OUTBOUND_REVIEW_SOURCE_ACTION]),
    );
  });
});

describe('outbound review booking — triage lane', () => {
  test('outbound_booking_review maps to the time_ambiguous review lane', () => {
    const item = buildTriageItem({
      callLogId: 'c1',
      flag: 'outbound_booking_review',
      extraction: { meta: {} },
      severity: 'advisory',
    });
    expect(item.category).toBe('time_ambiguous');
    expect(item.reason_code).toBe('outbound_booking_review');
  });
});
