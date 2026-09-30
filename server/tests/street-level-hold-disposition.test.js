// Owner ruling 2026-09-30: a street-level address hold counts as booked only
// once the office confirms. Until then the call is lead_response_flow_triggered
// (the enum has no pending state; that value is its "automated follow-up owns it"
// home); the office confirm stamps 'booked'. Synthetic data only.
process.env.GATE_CALL_DISPOSITION_V1 = 'true';
const fs = require('fs');
const { decideDisposition } = require('../services/call-disposition');
const { stampBookedDispositionForStreetLevelHold } = require('../services/outbound-review-confirm');

const heldCard = (extra = {}) => ({ payload: { origin: 'voice_agent', street_level_address: true, scheduled_service_id: 'visit-1', ...extra } });

describe('decideDisposition', () => {
  const outcome = (extra) => ({ appointmentCreated: true, customerId: 'c1', isKnownCustomer: false, ...extra });
  test('a booking awaiting the office is not booked yet', () => {
    expect(decideDisposition({ outcome: outcome({ appointmentPendingReview: true }) }))
      .toEqual({ disposition: 'lead_response_flow_triggered', reason: 'appointment_pending_office_review' });
  });
  test('every other booking is unchanged: booked', () => {
    expect(decideDisposition({ outcome: outcome({ appointmentPendingReview: false }) })).toEqual({ disposition: 'booked', reason: 'appointment_created' });
    expect(decideDisposition({ outcome: outcome({}) })).toEqual({ disposition: 'booked', reason: 'appointment_created' });
  });
  test('no appointment: the pending flag alone changes nothing', () => {
    expect(decideDisposition({ outcome: { appointmentCreated: false, appointmentPendingReview: true } }).reason).not.toBe('appointment_pending_office_review');
  });
});

describe('the processor passes the pending-review state', () => {
  const src = fs.readFileSync(require.resolve('../services/call-recording-processor.js'), 'utf8');
  test('applyZeroTriageLayers hands appointmentPendingReview to the decision, set only on the street-level pending branch', () => {
    expect(src).toContain("appointmentPendingReview: appointmentResult?.pendingOfficeReview === true,");
    const at = src.indexOf("smsBlockedReason: 'outbound_booking_review', pendingOfficeReview: true");
    expect(at).toBeGreaterThan(src.lastIndexOf('if (scheduledServiceId && pendingOfficeReview) {') - 1);
  });
});

describe('office confirm stamps booked', () => {
  const make = ({ card, stamped = 1 }) => {
    const updates = [];
    const trx = (table) => {
      const q = {
        where(arg) { q._where = arg; return q; }, whereIn() { return q; }, orderBy() { return q; },
        first: async () => card,
        update: async (u) => { updates.push({ table, where: q._where, u }); return stamped; },
      };
      return q;
    };
    return { trx, updates };
  };
  const svc = { id: 'visit-1', source_call_log_id: 'call-1' };

  test('a confirmed street-level hold flips lead_response_flow_triggered to booked (compare-and-swap on that value)', async () => {
    const { trx, updates } = make({ card: heldCard() });
    expect(await stampBookedDispositionForStreetLevelHold(trx, svc)).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].where).toEqual({ id: 'call-1', disposition: 'lead_response_flow_triggered' });
    expect(updates[0].u).toMatchObject({ disposition: 'booked' });
  });
  test('scoped: nothing for a plain voice-agent card, another visit, or a card that is gone', async () => {
    for (const card of [heldCard({ street_level_address: undefined }), heldCard({ scheduled_service_id: 'other' }), undefined]) {
      const { trx, updates } = make({ card });
      expect(await stampBookedDispositionForStreetLevelHold(trx, svc)).toBe(false);
      expect(updates).toHaveLength(0);
    }
  });
  test('a call whose disposition is something else (a human tag, a reprocess) is left alone', async () => {
    const { trx } = make({ card: heldCard(), stamped: 0 });
    expect(await stampBookedDispositionForStreetLevelHold(trx, svc)).toBe(false);
  });
  test('runs inside the card-resolve transaction, before the review card is resolved; gate off is a no-op', () => {
    const s = fs.readFileSync(require.resolve('../services/outbound-review-confirm.js'), 'utf8');
    const stamp = s.indexOf('await stampBookedDispositionForStreetLevelHold(trx, svc);');
    expect(stamp).toBeGreaterThan(0);
    expect(stamp).toBeLessThan(s.indexOf("status: 'resolved', updated_at: trx.fn.now()", stamp));
    expect(s).toContain("if (!isEnabled('callDispositionV1')) return false;");
  });
});
