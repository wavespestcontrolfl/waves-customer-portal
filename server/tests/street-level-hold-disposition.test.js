// Owner ruling 2026-09-30: a street-level address hold counts as booked only
// once the office confirms. Until then the call is lead_response_flow_triggered
// (the enum has no pending state; that value is its "automated follow-up owns it"
// home); the office confirm stamps 'booked'. Synthetic data only.
process.env.GATE_CALL_DISPOSITION_V1 = 'true';
const fs = require('fs');
const { decideDisposition } = require('../services/call-disposition');
const { stampBookedDispositionForStreetLevelHold, reconcileStreetLevelHoldAfterStamp } = require('../services/outbound-review-confirm');

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
    expect(src).toContain('          appointmentPendingReview,\n');
    const at = src.indexOf("smsBlockedReason: 'outbound_booking_review', pendingOfficeReview: true");
    expect(at).toBeGreaterThan(src.lastIndexOf('if (scheduledServiceId && pendingOfficeReview) {') - 1);
  });
  test('fast office confirm: the final writer re-reads the visit (confirmed -> booked) before AND after it writes the pending value', () => {
    const start = src.indexOf('let appointmentPendingReview = appointmentResult?.pendingOfficeReview === true;');
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, start + 2600);
    // Before: a visit already confirmed is decided as booked, not pending.
    expect(block).toMatch(/if \(visit\?\.customer_confirmed === true\) appointmentPendingReview = false;/);
    expect(block.indexOf('customer_confirmed === true) appointmentPendingReview = false')).toBeLessThan(block.indexOf('decideDisposition({'));
    // After: a confirm that landed between the read and the write is flipped by compare-and-swap.
    const write = block.indexOf('await writeCallDisposition({ callId: call.id, disposition, reason, callSid });');
    expect(write).toBeGreaterThan(0);
    const after = block.indexOf("if (after?.customer_confirmed === true) {", write);
    expect(after).toBeGreaterThan(write);
    expect(block.slice(after, after + 300)).toContain("priorDisposition: disposition, disposition: 'booked'");
  });
});

describe('office confirm stamps booked', () => {
  const heldCard = (status, extra = {}) => ({ id: 't1', status, payload: { origin: 'voice_agent', street_level_address: true, scheduled_service_id: 'visit-1', ...extra } });
  const make = ({ card, stamped = 1 }) => {
    const updates = [];
    const trx = (table) => {
      const q = {
        where(arg) { q._where = arg; return q; }, whereIn() { return q; }, whereRaw() { return q; }, orderBy() { return q; },
        first: async () => card,
        update: async (u) => { updates.push({ table, where: q._where, u }); return stamped; },
      };
      return q;
    };
    return { trx, updates };
  };
  const svc = { id: 'visit-1', source_call_log_id: 'call-1' };

  test('a confirmed street-level hold flips lead_response_flow_triggered to booked (compare-and-swap on that value)', async () => {
    const { trx, updates } = make({ card: heldCard('open') });
    expect(await stampBookedDispositionForStreetLevelHold(trx, svc)).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].where).toEqual({ id: 'call-1', disposition: 'lead_response_flow_triggered' });
    expect(updates[0].u).toMatchObject({ disposition: 'booked' });
  });
  test('recording replacement: a superseded (resolved) card still identifies the hold', async () => {
    const { trx, updates } = make({ card: heldCard('resolved') });
    expect(await stampBookedDispositionForStreetLevelHold(trx, svc)).toBe(true);
    expect(updates).toHaveLength(1);
  });
  test('scoped: nothing when the visit has no street-level card', async () => {
    const { trx, updates } = make({ card: undefined });
    expect(await stampBookedDispositionForStreetLevelHold(trx, svc)).toBe(false);
    expect(updates).toHaveLength(0);
  });
  test('a call whose disposition is something else (a human tag, a reprocess) is left alone', async () => {
    const { trx } = make({ card: heldCard('open'), stamped: 0 });
    expect(await stampBookedDispositionForStreetLevelHold(trx, svc)).toBe(false);
  });
  test('runs inside the card-resolve transaction, before the review card is resolved; gate off is a no-op', () => {
    const s = fs.readFileSync(require.resolve('../services/outbound-review-confirm.js'), 'utf8');
    const stamp = s.indexOf('await stampBookedDispositionForStreetLevelHold(trx, svc, hold);');
    expect(stamp).toBeGreaterThan(0);
    expect(stamp).toBeLessThan(s.indexOf("status: 'resolved', updated_at: trx.fn.now()", stamp));
    expect(s).toContain("if (!isEnabled('callDispositionV1')) return false;");
  });
});

describe('interleaving: the processor wrote AFTER the hook but BEFORE the stamp', () => {
  const svc = { id: 'visit-1', source_call_log_id: 'call-1' };
  // A stateful fake of the call row and its cards: the processor already
  // overwrote disposition with the pending value and reopened review_status.
  const makeDb = ({ hasCard = true } = {}) => {
    const state = { disposition: 'lead_response_flow_triggered', review_status: 'open', openCards: 0, locked: false };
    const dbh = (table) => {
      const q = {
        where(arg) { q._where = arg; return q; }, whereIn() { return q; }, whereRaw() { return q; }, orderBy() { return q; }, count() { return q; },
        first: async () => {
          if (table === 'triage_items' && q._count) return { n: state.openCards };
          if (table === 'triage_items') return hasCard ? { id: 't1', status: 'resolved', payload: { street_level_address: true, scheduled_service_id: 'visit-1' } } : undefined;
          return { n: state.openCards };
        },
        update: async (u) => {
          if (table === 'call_log' && u.disposition) {
            if (q._where?.disposition === state.disposition) { state.disposition = u.disposition; return 1; }
            return 0;
          }
          if (table === 'call_log' && u.review_status) { state.review_status = u.review_status; return 1; }
          return 0;
        },
      };
      const c = q.count; q.count = () => { q._count = true; return q; };
      void c;
      return q;
    };
    dbh.raw = async () => { state.locked = true; return { rows: [{}] }; };
    dbh.transaction = async (fn) => fn(dbh);
    return { dbh, state };
  };

  test('after the stamp lands, the call is booked and review_status closed (no open card left)', async () => {
    const { dbh, state } = makeDb();
    expect(await reconcileStreetLevelHoldAfterStamp(dbh, svc)).toBe(true);
    expect(state.locked).toBe(true);
    expect(state.disposition).toBe('booked');
    expect(state.review_status).toBe('resolved');
  });
  test('an open card keeps the review open; a non street-level visit is untouched', async () => {
    const withOpen = makeDb();
    withOpen.state.openCards = 1;
    await reconcileStreetLevelHoldAfterStamp(withOpen.dbh, svc);
    expect(withOpen.state.review_status).toBe('open');
    const plain = makeDb({ hasCard: false });
    expect(await reconcileStreetLevelHoldAfterStamp(plain.dbh, svc)).toBe(false);
    expect(plain.state.disposition).toBe('lead_response_flow_triggered');
    expect(plain.state.review_status).toBe('open');
  });
  test('both stamp sites (the office-confirm route and the lazy activation) reconcile after a successful stamp', () => {
    const s = fs.readFileSync(require.resolve('../services/outbound-review-confirm.js'), 'utf8');
    expect(s.split('if (stamped > 0) await reconcileStreetLevelHoldAfterStamp(').length - 1).toBe(2);
  });
});
