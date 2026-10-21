/**
 * cancel_appointment confirm of a card proposed WITH effects (GATE_IB_CANCEL_WITH_EFFECTS, owner decision
 * 2026-10-12): tools.js cancelWithEffects recomputes the effects, refuses on any drift with preview_changed, refuses
 * what the Dispatch cancel must not do (fee due, refund or charge cases, make-up / grouped / follow-up visits), and
 * otherwise REPLAYS the Dispatch cancel handler (admin-dispatch.js cancelServiceFromBar, mocked here; its own suite
 * is admin-dispatch-cancel-from-bar.test.js) with the carded body only. Synthetic ids only.
 */
let mockApptRow = null;
// The customer row the round-5 P2 address-fallback recheck reads FOR SHARE
// under the SAME lock (only reached when mockApptRow has no
// service_address_line1 AND a customer_id — the default DEFAULT_APPT_ROW
// below has neither, so most tests never touch this).
let mockCustomerRow = { first_name: 'Synthia', last_name: 'Tester' };
// The visit's card-fee rail rows (Codex round 7 P1), read under the lock.
let mockCardRailRows = { estimate_card_holds: [], appointment_card_requests: [] };
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    if (table === 'scheduled_services') {
      // .forUpdate() is the round-3 P1a row lock (tools.js cancelAppointment,
      // inside the mutation trx) — chainable no-op here (this mock has no
      // real concurrency to enforce), returning the SAME reader so the
      // locked read sees whatever mockApptRow currently is, exactly like a
      // real SELECT ... FOR UPDATE would see the live row.
      const reader = {
        first: async () => mockApptRow,
        update: async () => 1,
      };
      return { where: () => ({ ...reader, forUpdate: () => reader }) };
    }
    if (table === 'job_status_history') {
      const chain = { where: () => chain, whereNot: () => chain, orderBy: () => chain, first: async () => ({ transitioned_at: new Date(Date.now() - 60 * 1000) }) };
      return chain;
    }
    if (table === 'customers') {
      // .forShare() is the round-5 P2 address recheck (tools.js
      // cancelAppointment, inside the SAME mutation trx) — chainable no-op
      // here, same shape as scheduled_services' .forUpdate() above.
      const reader = { first: async () => mockCustomerRow };
      return { where: () => ({ ...reader, forShare: () => reader }) };
    }
    if (table in mockCardRailRows) {
      return { where: () => ({ select: async () => mockCardRailRows[table] }) };
    }
    throw new Error(`unexpected table in this suite: ${table}`);
  });
  db.transaction = (cb) => cb(db);
  // Stand-in for Knex's trx.raw — real enough to prove the notes update is
  // SQL-side (concat_ws against the LIVE `notes` column), never a JS-side
  // read of a value captured before the transaction opened.
  db.raw = (sql, bindings) => ({ __raw: true, sql, bindings });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// The round-5 P1 under-lock existence rechecks (tools.js cancelAppointment)
// — bare-visits-only, so both default to "nothing found" here; individual
// tests override to prove the recheck actually refuses on what the
// pre-check (outside any lock) could have missed.
const mockAnyInvoiceLinked = jest.fn(() => ({ first: async () => null }));
jest.mock('../services/invoice', () => ({
  anyInvoiceLinkedToVisit: (...a) => mockAnyInvoiceLinked(...a),
}));
const mockAnyCreditOffer = jest.fn(() => ({ first: async () => null }));
jest.mock('../services/inspection-credit', () => ({
  anyInspectionCreditOfferForVisit: (...a) => mockAnyCreditOffer(...a),
}));

const mockComputeImpact = jest.fn();
// computeRowFingerprint is NOT mocked (jest.requireActual) — the round-3/4
// P1a lock recheck (tools.js cancelAppointment) computes this same whole-row
// fingerprint over whatever row its FOR UPDATE lock reads, so this suite
// proves the REAL fingerprint function, not a stand-in for it.
jest.mock('../services/appointment-cancel-impact', () => {
  const actual = jest.requireActual('../services/appointment-cancel-impact');
  return {
    computeCancelAppointmentImpact: (...a) => mockComputeImpact(...a),
    cancelImpactsMatch: actual.cancelImpactsMatch,
    computeRowFingerprint: actual.computeRowFingerprint,
    legacyAddressFingerprint: actual.legacyAddressFingerprint,
    cardRailFingerprint: actual.cardRailFingerprint,
    cardRailRows: actual.cardRailRows,
    cancelWithEffectsRefusal: actual.cancelWithEffectsRefusal,
    lockLinkedFollowUps: (...a) => mockLockLinked(...a),
    prepaidCommitmentReason: (...a) => mockPrepaidCommitmentReason(...a),
    linkedFollowUpRows: (...a) => mockLinkedFollowUpRows(...a),
  };
});
// A linked follow-up (call-booked child or package visit 2) re-read under
// the lock. None by default.
const mockLinkedFollowUpRows = jest.fn(async () => []);
// Codex round 9 P1: the canonical prepaid/estimate-commitment readers,
// re-run under the lock. Bare (null) by default.
const mockPrepaidCommitmentReason = jest.fn(async () => null);

const mockFollowThrough = jest.fn(async () => ({ settled: 1 }));
jest.mock('../services/visit-cancellation-followthrough', () => ({
  runVisitCancellationFollowThrough: (...a) => mockFollowThrough(...a),
}));
const mockReseed = jest.fn(async () => {});
// cancelMayReseedPlan defaults to false (the plain-visit case every
// pre-existing test in this suite assumes) — the round-4 P1 explicit
// under-lock recheck (tools.js cancelAppointment) calls this directly, so
// the mock must export it alongside runPostCancelSeriesReseed or that call
// throws (a bare object replacement would otherwise leave it undefined).
const mockCancelMayReseedPlan = jest.fn(() => false);
jest.mock('../services/recurring-series-cancel-reseed', () => ({
  runPostCancelSeriesReseed: (...a) => mockReseed(...a),
  cancelMayReseedPlan: (...a) => mockCancelMayReseedPlan(...a),
}));
jest.mock('../services/typed-followup-obligation', () => ({ handleFollowupChildCancellation: jest.fn(async () => {}) }));

const mockTransitionJobStatus = jest.fn();
jest.mock('../services/job-status', () => ({
  transitionJobStatus: (...a) => mockTransitionJobStatus(...a),
  STATUS_ROUTE_ALLOWED_TARGETS: new Set(['cancelled']),
}));


const mockLockLinked = jest.fn(async () => []);
const mockCancelFromBar = jest.fn();
jest.mock('../routes/admin-dispatch', () => ({ cancelServiceFromBar: (...a) => mockCancelFromBar(...a) }));

const { executeTool } = require('../services/intelligence-bar/tools');
const { cancelImpactsMatch } = jest.requireActual('../services/appointment-cancel-impact');

const FROZEN = {
  appointment: { id: 'svc-synthetic-1', status: 'confirmed', scheduled_date: '2026-10-02', service_type: 'pest_control', customer_name: 'Synthia Tester', window: null },
  fee: { applies: false, amount: null, unresolved: false, rail: 'none', blocked_by_invoice: false },
  invoices: [{ id: 'inv-1', invoice_number: 'WPC-2026-9001', status: 'sent', total: 89, credit_applied: 10, deposit_credit: 0, payment_intent: false }],
  inspection_credit_reversal: null,
  card_cancel_refusals: [],
  customer_notice: 'none',
  technician_notice: 'none',
  with_effects: true,
  notify_customer: true,
  customer_text: {
    would_send: true, body: 'Hi Synthia, your visit is cancelled.', template_body: null, reason: null,
    recipients: [{ recipient_key: 'abc123abc123abc1', phone_last4: '0101', role: 'primary', first_name: 'Synthia', body: 'Hi Synthia, your visit is cancelled.' }],
  },
  linked_invoices: [{ id: 'inv-1', invoice_number: 'WPC-2026-9001', status: 'sent', total: 89 }],
  linked_visits: [{ id: 'svc-visit-2', status: 'confirmed', scheduled_date: '2026-11-02', service_type: 'pest_control' }],
  identity_fingerprint: 'fp-1',
  card_rail_fingerprint: 'rail-1',
};
const ADMIN = { isAdmin: true, technicianId: 'admin-1', confirmed: true };
const input = (extra = {}) => ({ appointment_id: 'svc-synthetic-1', reason: 'rain', _frozen_cancellation_impact: FROZEN, ...extra });

let savedEnv;
beforeEach(() => {
  jest.clearAllMocks();
  savedEnv = { a: process.env.GATE_IB_CANCEL_APPOINTMENT, b: process.env.GATE_IB_CANCEL_WITH_EFFECTS };
  process.env.GATE_IB_CANCEL_APPOINTMENT = 'true';
  process.env.GATE_IB_CANCEL_WITH_EFFECTS = 'true';
  mockApptRow = { id: 'svc-synthetic-1', status: 'confirmed', scheduled_date: '2026-10-02', service_type: 'pest_control', customer_id: 'cust-1' };
  mockCustomerRow = { first_name: 'Synthia', last_name: 'Tester' };
  mockComputeImpact.mockResolvedValue(FROZEN);
  mockCancelFromBar.mockResolvedValue({ status: 200, json: { success: true, notificationSent: true } });
});
afterEach(() => {
  for (const [k, v] of [['GATE_IB_CANCEL_APPOINTMENT', savedEnv.a], ['GATE_IB_CANCEL_WITH_EFFECTS', savedEnv.b]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe('cancel_appointment confirm WITH effects replays the Dispatch cancel', () => {
  test('a matching card replays the handler once with the carded body: this visit, the reason, the text choice, the operator', async () => {
    const result = await executeTool('cancel_appointment', input(), ADMIN);
    expect(mockComputeImpact).toHaveBeenCalledWith('svc-synthetic-1', expect.objectContaining({
      actorId: 'admin-1', withEffects: true, notifyCustomer: true, approvedText: FROZEN.customer_text, piCache: expect.any(Map),
    }));
    expect(mockCancelFromBar).toHaveBeenCalledTimes(1);
    expect(mockCancelFromBar.mock.calls[0][0]).toMatchObject({
      serviceId: 'svc-synthetic-1', notifyCustomer: true, notes: 'Cancelled via Intelligence Bar: rain', actor: { technicianId: 'admin-1' },
      // The exact approved text per recipient and the approved linked visits go to the handler.
      approvedNotice: [{ recipient_key: 'abc123abc123abc1', body: 'Hi Synthia, your visit is cancelled.' }],
      linkedChildren: FROZEN.linked_visits,
    });
    expect(result).toMatchObject({ success: true, appointment_id: 'svc-synthetic-1', customer_name: 'Synthia Tester', ran_dispatch_cancel: true, customer_text_sent: true });
    expect(result.warning).toBeUndefined();
    // The bar's own transition, follow-through and reseed do NOT run: the Dispatch handler owns them.
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
    expect(mockFollowThrough).not.toHaveBeenCalled();
    expect(mockReseed).not.toHaveBeenCalled();
  });

  test('"cancel without a text" is carried as notifyCustomer false, and nothing is reported sent', async () => {
    const silent = { ...FROZEN, notify_customer: false, customer_text: { would_send: false, body: null, template_body: null, recipients: [], reason: 'cancelled_without_text' } };
    mockComputeImpact.mockResolvedValue(silent);
    mockCancelFromBar.mockResolvedValue({ status: 200, json: { success: true } });
    const result = await executeTool('cancel_appointment', input({ _frozen_cancellation_impact: silent }), ADMIN);
    expect(mockComputeImpact).toHaveBeenCalledWith('svc-synthetic-1', expect.objectContaining({ withEffects: true, notifyCustomer: false }));
    expect(mockCancelFromBar.mock.calls[0][0].notifyCustomer).toBe(false);
    expect(mockCancelFromBar.mock.calls[0][0].approvedNotice).toBeNull();
    expect(result.customer_text_sent).toBe(false);
    expect(result.warning).toBeUndefined();
  });

  test('a text that the handler could not send is reported as a warning, not hidden', async () => {
    mockCancelFromBar.mockResolvedValue({ status: 200, json: { success: true, notificationSent: false, notificationError: 'customer opted out' } });
    const result = await executeTool('cancel_appointment', input(), ADMIN);
    expect(result.success).toBe(true);
    expect(result.customer_text_sent).toBe(false);
    expect(result.warning).toMatch(/cancelled, but the customer text did not go out \(customer opted out\) and will not be retried automatically — send it by hand/);
  });

  test('drift between the card and Confirm (an invoice changed) -> preview_changed, nothing replayed', async () => {
    mockComputeImpact.mockResolvedValue({ ...FROZEN, invoices: [{ ...FROZEN.invoices[0], total: 99 }] });
    const result = await executeTool('cancel_appointment', input(), ADMIN);
    expect(result.preview_changed).toBe(true);
    expect(mockCancelFromBar).not.toHaveBeenCalled();
  });

  test('drift found INSIDE the handler lock (beforeCommit) throws preview_changed so the handler cancels nothing', async () => {
    mockCancelFromBar.mockImplementation(async ({ beforeCommit }) => {
      mockComputeImpact.mockResolvedValue({ ...FROZEN, linked_visits: [] });
      try { await beforeCommit({}); } catch (err) { return { status: err.status, json: { error: err.message, code: err.code } }; }
      return { status: 200, json: { success: true } };
    });
    const result = await executeTool('cancel_appointment', input(), ADMIN);
    expect(result.preview_changed).toBe(true);
    expect(result.success).toBeUndefined();
  });

  test('the beforeCommit hook locks the linked visits, then re-checks with the cached PaymentIntents only (no Stripe call under the lock)', async () => {
    let hookError = null;
    const trx = { id: 'trx' };
    mockCancelFromBar.mockImplementation(async ({ beforeCommit }) => {
      try { await beforeCommit(trx); } catch (err) { hookError = err; }
      return { status: 200, json: { success: true, notificationSent: true } };
    });
    await executeTool('cancel_appointment', input(), ADMIN);
    expect(hookError).toBeNull();
    expect(mockLockLinked).toHaveBeenCalledWith(trx, 'svc-synthetic-1');
    expect(mockComputeImpact).toHaveBeenCalledTimes(2);
    const [before, inLock] = mockComputeImpact.mock.calls.map((c) => c[1]);
    expect(before.piCacheOnly).toBeUndefined();
    expect(inLock.piCacheOnly).toBe(true);
    expect(inLock.piCache).toBe(before.piCache);
    expect(inLock.approvedText).toBe(FROZEN.customer_text);
  });

  test('a lock-time check that cannot be completed (a payment attempt appeared) is a change: preview_changed, never a raw error', async () => {
    mockCancelFromBar.mockImplementation(async ({ beforeCommit }) => {
      mockComputeImpact.mockRejectedValue(new Error('PaymentIntent pi_x was not checked before the lock'));
      try { await beforeCommit({}); } catch (err) { return { status: err.status, json: { error: err.message, code: err.code } }; }
      return { status: 200, json: { success: true } };
    });
    const result = await executeTool('cancel_appointment', input(), ADMIN);
    expect(result.preview_changed).toBe(true);
    expect(result.error).not.toMatch(/PaymentIntent/);
  });

  test('a text the card could not compose is never sent, even with notify_customer true', async () => {
    const noText = { ...FROZEN, customer_text: { would_send: false, body: null, template_body: null, recipients: [], reason: 'no_recipient' } };
    mockComputeImpact.mockResolvedValue(noText);
    mockCancelFromBar.mockResolvedValue({ status: 200, json: { success: true } });
    const result = await executeTool('cancel_appointment', input({ _frozen_cancellation_impact: noText }), ADMIN);
    expect(mockCancelFromBar.mock.calls[0][0]).toMatchObject({ notifyCustomer: false, approvedNotice: null });
    expect(result.customer_text_sent).toBe(false);
    expect(result.warning).toBeUndefined();
  });

  test('a linked visit the cascade left alone (it changed after the card) is reported, not hidden', async () => {
    mockCancelFromBar.mockResolvedValue({ status: 200, json: { success: true, notificationSent: true, linkedVisitsSkipped: [{ id: 'svc-visit-2', reason: 'date_changed' }] } });
    const result = await executeTool('cancel_appointment', input(), ADMIN);
    expect(result.success).toBe(true);
    expect(result.linked_visits_skipped).toEqual([{ id: 'svc-visit-2', reason: 'date_changed' }]);
    expect(result.warning).toMatch(/1 linked visit\(s\) were NOT cancelled because they changed since the card \(svc-visit-2: date_changed\)/);
  });

  test.each([
    ['a fee due', { card_cancel_refusals: ['card_fee_agreement'], fee: { ...FROZEN.fee, applies: true, amount: 49, rail: 'card_hold' } }, 'cancel_fee_due_unsupported'],
    ['a saved card with no fee', { card_cancel_refusals: ['card_rail_present'] }, 'by_owner_rule'],
    ['a paid invoice (money held)', { card_cancel_refusals: ['invoice_holds_money'] }, 'by_owner_rule'],
    ['a prepayment', { card_cancel_refusals: ['prepaid_coverage'] }, 'by_owner_rule'],
    ['a plan make-up visit', { card_cancel_refusals: ['plan_makeup_visit'] }, 'cancel_with_effects_unsupported'],
    ['a grouped visit', { card_cancel_refusals: ['grouped_visit'] }, 'cancel_with_effects_unsupported'],
  ])('%s that appeared since the card is refused with %s and nothing is replayed', async (_label, patch, code) => {
    const frozenSame = { ...FROZEN, ...patch };
    mockComputeImpact.mockResolvedValue(frozenSame);
    const result = await executeTool('cancel_appointment', input({ _frozen_cancellation_impact: frozenSame }), ADMIN);
    expect(result.code).toBe(code);
    expect(mockCancelFromBar).not.toHaveBeenCalled();
  });

  test('the gate switched off after the card was shown: today\'s refusal, nothing replayed', async () => {
    delete process.env.GATE_IB_CANCEL_WITH_EFFECTS;
    const result = await executeTool('cancel_appointment', input(), ADMIN);
    expect(result.code).toBe('cancel_with_effects_unsupported');
    expect(mockCancelFromBar).not.toHaveBeenCalled();
  });

  test('a non-admin confirm is refused', async () => {
    const result = await executeTool('cancel_appointment', input(), { ...ADMIN, isAdmin: false });
    expect(result.code).toBe('permission_denied');
    expect(mockCancelFromBar).not.toHaveBeenCalled();
  });

  test('an already-cancelled visit is stale (preview_changed), never replayed', async () => {
    mockApptRow = { ...mockApptRow, status: 'cancelled' };
    const result = await executeTool('cancel_appointment', input(), ADMIN);
    expect(result.preview_changed).toBe(true);
    expect(mockCancelFromBar).not.toHaveBeenCalled();
  });

  test('an unreadable impact refuses and replays nothing', async () => {
    mockComputeImpact.mockRejectedValue(new Error('rail read failed'));
    const result = await executeTool('cancel_appointment', input(), ADMIN);
    expect(result.error).toMatch(/could not be verified/);
    expect(mockCancelFromBar).not.toHaveBeenCalled();
  });

  test('a Dispatch refusal (409) is passed through as a stale card', async () => {
    mockCancelFromBar.mockResolvedValue({ status: 409, json: { error: 'This visit is already completed. Refresh and try again.', code: 'already_terminal' } });
    const result = await executeTool('cancel_appointment', input(), ADMIN);
    expect(result).toMatchObject({ code: 'already_terminal', preview_changed: true });
  });

  test('a card without with_effects still takes the bare-visit path, byte-identical to before', async () => {
    const bare = { ...FROZEN };
    delete bare.with_effects;
    mockComputeImpact.mockResolvedValue(bare);
    await executeTool('cancel_appointment', input({ _frozen_cancellation_impact: bare }), ADMIN);
    expect(mockCancelFromBar).not.toHaveBeenCalled();
    expect(cancelImpactsMatch(bare, bare)).toBe(true);
  });
});
