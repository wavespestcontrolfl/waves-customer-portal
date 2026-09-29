/**
 * cancel_appointment's commit path (server/services/intelligence-bar/
 * tools.js) — the PR A refuse-on-drift guard: when a pending action was
 * proposed with a frozen cancellation-impact snapshot pinned on
 * `_frozen_cancellation_impact`, the commit MUST recompute the same
 * snapshot fresh and refuse — before anything is transitioned, charged,
 * voided, or reversed — if it no longer matches. No frozen pin (every
 * caller today, since the route refuses cancel_appointment before any
 * pending action can carry one) is a no-op: existing behavior is
 * untouched. Synthetic ids throughout — no real customer data.
 *
 * `computeCancelAppointmentImpact` is mocked; `cancelImpactsMatch` is the
 * REAL implementation (jest.requireActual), so this suite proves the
 * actual drift-comparison wired into tools.js, not a stand-in for it.
 */

let mockApptRow = null;
// Captures the ONE update() the reason-append branch issues against
// scheduled_services inside the transition trx (db === trx in this mock —
// see db.transaction below) — asserted by the notes-append-race tests.
let capturedNotesUpdate = null;
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
        update: async (fields) => { capturedNotesUpdate = fields; return 1; },
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
    prepaidCommitmentReason: (...a) => mockPrepaidCommitmentReason(...a),
  };
});
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

const { executeTool } = require('../services/intelligence-bar/tools');
// REAL implementation (not mocked) — the commit path's round-3/4 P1a lock
// recheck (tools.js cancelAppointment) computes this same whole-row
// fingerprint over whatever row its FOR UPDATE lock reads, so FROZEN's own
// fingerprint below must be the ACTUAL value for the default mockApptRow
// shape, or every "matches" test would spuriously drift-refuse against a
// fake string.
const { computeRowFingerprint } = jest.requireActual('../services/appointment-cancel-impact');

// The exact shape beforeEach assigns to mockApptRow — kept as its own
// constant (not read from the mutable `mockApptRow` let) so FROZEN's
// fingerprint is fixed and tests that mutate mockApptRow mid-test don't
// retroactively change what "matches" means.
const DEFAULT_APPT_ROW = {
  id: 'svc-synthetic-1',
  status: 'confirmed',
  scheduled_date: '2026-10-02',
  service_type: 'pest_control',
  notes: null,
  visit_id: null,
};

const FROZEN = {
  appointment: { id: 'svc-synthetic-1', status: 'confirmed', scheduled_date: '2026-10-02', service_type: 'pest_control', customer_name: 'Synthia Tester', window: null },
  fee: { applies: true, amount: 49, unresolved: false, rail: 'card_hold', hold_disposition: null },
  invoices: [{ id: 'inv-1', invoice_number: 'WPC-2026-9001', status: 'sent', total: 89, credit_applied: 0 }],
  inspection_credit_reversal: null,
  card_cancel_refusals: [],
  // Codex round-2 through round-4 P1s: the WHOLE row, hashed (bar the tiny
  // denylist — see appointment-cancel-impact.js's ROW_FINGERPRINT_DENYLIST).
  // The display facts above (status/scheduled_date/service_type/
  // customer_name) can read identical for a same-day window move or a
  // same-named repoint — this is what actually catches it. The REAL
  // fingerprint for DEFAULT_APPT_ROW, so it matches what the round-3/4 P1a
  // lock recheck (tools.js) actually computes when mockApptRow is unchanged.
  identity_fingerprint: computeRowFingerprint(DEFAULT_APPT_ROW),
  // sha256 of the empty rail list — no hold, no card request (bare visit).
  card_rail_fingerprint: require('crypto').createHash('sha256').update(JSON.stringify([])).digest('hex'),
};

beforeEach(() => {
  jest.clearAllMocks();
  capturedNotesUpdate = null;
  mockApptRow = { ...DEFAULT_APPT_ROW };
  mockCustomerRow = { first_name: 'Synthia', last_name: 'Tester' };
  mockCardRailRows = { estimate_card_holds: [], appointment_card_requests: [] };
  mockPrepaidCommitmentReason.mockReset().mockResolvedValue(null);
  mockCancelMayReseedPlan.mockReturnValue(false);
  // Bare by default (owner ruling 2026-09-28) — clearAllMocks() only clears
  // call history, not a factory-provided implementation, but reset
  // explicitly anyway so a test that overrides one never leaks into the next.
  mockAnyInvoiceLinked.mockReturnValue({ first: async () => null });
  mockAnyCreditOffer.mockReturnValue({ first: async () => null });
  // transitionJobStatus is only reached once the drift check clears — throw
  // a distinctive sentinel so a passing-through test can assert we GOT
  // there without modeling the rest of the (pre-existing, unrelated) commit
  // flow that runs after it.
  mockTransitionJobStatus.mockRejectedValue(new Error('__reached_transition__'));
});

test('no frozen pin: the drift check is a no-op (today\'s only real caller)', async () => {
  await executeTool('cancel_appointment', { appointment_id: 'svc-synthetic-1' }, {});
  expect(mockComputeImpact).not.toHaveBeenCalled();
  // Still reaches the real commit path (proven by the sentinel throw
  // surfacing as the tool's error) — behavior is byte-identical to before
  // this lane when no frozen impact is supplied.
  expect(mockTransitionJobStatus).toHaveBeenCalledTimes(1);
});

test('frozen impact matches the freshly recomputed one: proceeds to commit, nothing refused', async () => {
  mockComputeImpact.mockResolvedValue(FROZEN);
  const result = await executeTool('cancel_appointment', {
    appointment_id: 'svc-synthetic-1',
    _frozen_cancellation_impact: FROZEN,
  }, {});

  // actorId threads the confirming operator (actionContext.technicianId) so
  // technician_notice reads consistently between proposal and confirm; {}
  // as actionContext here means null.
  expect(mockComputeImpact).toHaveBeenCalledWith('svc-synthetic-1', { actorId: null });
  expect(mockTransitionJobStatus).toHaveBeenCalledTimes(1);
  // The sentinel error from transitionJobStatus is a plain throw the tool
  // doesn't specially handle (unlike the "not in state" message) — surfaces
  // via executeTool's catch-all as a generic error, proving we got there.
  expect(result.error).toBe('__reached_transition__');
});

test('a changed late-cancel fee amount is drift: REFUSED, nothing transitioned/charged/voided/reversed', async () => {
  const drifted = { ...FROZEN, fee: { ...FROZEN.fee, amount: 99 } };
  mockComputeImpact.mockResolvedValue(drifted);
  const result = await executeTool('cancel_appointment', {
    appointment_id: 'svc-synthetic-1',
    _frozen_cancellation_impact: FROZEN,
  }, {});

  expect(result).toEqual({
    error: 'The cancellation effects (late-cancel fee, invoices, or inspection credit) changed since this was proposed — nothing was changed. Ask again for a fresh preview.',
  });
  expect(mockTransitionJobStatus).not.toHaveBeenCalled();
});

test('an invoice appearing that was not in the frozen preview is drift: REFUSED before commit', async () => {
  const drifted = { ...FROZEN, invoices: [...FROZEN.invoices, { id: 'inv-2', invoice_number: 'WPC-2026-9002', status: 'draft', total: 10, credit_applied: 0 }] };
  mockComputeImpact.mockResolvedValue(drifted);
  const result = await executeTool('cancel_appointment', {
    appointment_id: 'svc-synthetic-1',
    _frozen_cancellation_impact: FROZEN,
  }, {});

  expect(result.error).toMatch(/changed since this was proposed/);
  expect(mockTransitionJobStatus).not.toHaveBeenCalled();
});

// Codex round-2 P1: a same-day window move (keeping status/date/service_type/
// customer_name identical) or a repoint to a different customer_id that
// happens to share a display name would otherwise slip past drift — every
// OTHER field on the frozen impact still reads identical. Only the identity
// fingerprint catches it.
test('a window change or customer repoint between card and confirm is drift: REFUSED, even though every other field matches', async () => {
  const drifted = { ...FROZEN, identity_fingerprint: 'fp-repointed' };
  mockComputeImpact.mockResolvedValue(drifted);
  const result = await executeTool('cancel_appointment', {
    appointment_id: 'svc-synthetic-1',
    _frozen_cancellation_impact: FROZEN,
  }, {});

  expect(result.error).toMatch(/changed since this was proposed/);
  expect(mockTransitionJobStatus).not.toHaveBeenCalled();
});

// Codex round-3 P1a: the pre-check above (computeCancelAppointmentImpact,
// mocked as mockComputeImpact) runs OUTSIDE any lock — this proves the
// SEPARATE, INSIDE-the-transaction lock+recheck catches a reschedule that
// commits in the gap between that pre-check and this transaction's own
// row lock, even when the pre-check itself was fooled (mocked here to
// report no drift, simulating a race the pre-check's own fresh read simply
// won BEFORE the concurrent reschedule landed).
describe('round-3 P1a: the FINAL identity recheck runs INSIDE the mutation transaction, under a row lock', () => {
  test('a reschedule that commits in the gap between the pre-check and the row lock is still caught', async () => {
    mockComputeImpact.mockResolvedValue(FROZEN); // pre-check sees no drift
    // Simulate the race: by the time this transaction's FOR UPDATE lock
    // reads the row, a DIFFERENT admin's reschedule already committed —
    // same status/date, so the pre-check's own impact fields still matched,
    // but the row's actual identity (window) has moved.
    mockApptRow = { ...mockApptRow, window_start: '13:00:00' };
    const result = await executeTool('cancel_appointment', {
      appointment_id: 'svc-synthetic-1',
      _frozen_cancellation_impact: FROZEN,
    }, {});

    expect(result.error).toMatch(/changed since this was proposed/);
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
  });

  test('an unchanged row (no race) passes the lock recheck and reaches the transition', async () => {
    mockComputeImpact.mockResolvedValue(FROZEN);
    mockTransitionJobStatus.mockResolvedValue(undefined);
    const result = await executeTool('cancel_appointment', {
      appointment_id: 'svc-synthetic-1',
      _frozen_cancellation_impact: FROZEN,
    }, {});
    expect(result.success).toBe(true);
    expect(mockTransitionJobStatus).toHaveBeenCalledTimes(1);
  });

  test('the appointment vanishing under the lock (deleted between proposal and commit) refuses cleanly, never throws raw', async () => {
    mockComputeImpact.mockResolvedValue(FROZEN);
    mockApptRow = null; // the locked read finds nothing
    const result = await executeTool('cancel_appointment', {
      appointment_id: 'svc-synthetic-1',
      _frozen_cancellation_impact: FROZEN,
    }, {});
    expect(result.error).toMatch(/not found/i);
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
  });

  // The mock can't simulate genuine lock BLOCKING (a second, concurrently-
  // starting reschedule waiting on this transaction's row lock until it
  // resolves) — that guarantee comes from .forUpdate() being a REAL
  // Postgres row lock, proven here at the source level rather than
  // re-implemented as a fake concurrency harness.
  test('the recheck actually takes a row lock (source contract — real blocking is a Postgres guarantee, not mockable)', () => {
    const source = require('fs').readFileSync(require.resolve('../services/intelligence-bar/tools.js'), 'utf8');
    const cancelFn = source.slice(source.indexOf('async function cancelAppointment('));
    // Codex round 6 P1: the lock is the shared scheduled-invoice chain
    // (mint advisory lock → customer KEY SHARE → visit row FOR UPDATE), so
    // an in-flight invoice mint serializes with the no-invoice recheck.
    expect(cancelFn).toContain("acquireScheduledMintLockChain(trx, { scheduledServiceId: appointment_id, visitColumns: ['*'] })");
    // The lock read happens BEFORE transitionJobStatus is called, both
    // inside the same db.transaction callback.
    const lockIdx = cancelFn.indexOf('acquireScheduledMintLockChain(trx,');
    const transitionIdx = cancelFn.indexOf('await transitionJobStatus({');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(transitionIdx).toBeGreaterThan(lockIdx);
  });
});

// Codex round-4 P1/P2: the plan-reseed eligibility verdict AND the
// grouped-visit refusal are recomputed EXPLICITLY from the locked row —
// not only inferred from the whole-row fingerprint matching (which, given
// the current fingerprint, would already refuse as identity drift the
// instant either column differs from the frozen proposal). This is
// deliberate defense-in-depth: the row the commit is about to transition
// decides its own eligibility, rather than the commit trusting that a
// fingerprint match implies it. Modeled here as a proposal-side impact
// that (hypothetically, via a bug or a future refactor) froze `[]`
// refusals despite the row already being reseed-eligible/grouped — the
// under-lock recheck must still catch it independently, on a row whose
// fingerprint DOES match the frozen one (so this exercises the explicit
// recheck itself, not the separate identity-drift path already covered
// above).
describe('round-4 P1/P2: reseed eligibility and grouped-visit membership are rechecked explicitly under the row lock, independent of the fingerprint match', () => {
  test('a reseed-eligible locked row is REFUSED before commit, even with a matching fingerprint and no frozen refusal', async () => {
    const row = { ...DEFAULT_APPT_ROW, recurring_parent_id: 'plan-1' };
    const frozen = { ...FROZEN, identity_fingerprint: computeRowFingerprint(row) };
    mockApptRow = row;
    mockComputeImpact.mockResolvedValue(frozen); // pre-check sees no drift, no refusal
    mockCancelMayReseedPlan.mockReturnValue(true);
    const result = await executeTool('cancel_appointment', {
      appointment_id: 'svc-synthetic-1',
      _frozen_cancellation_impact: frozen,
    }, {});

    expect(result.error).toMatch(/can only be cancelled from the Dispatch screen/);
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
    expect(mockFollowThrough).not.toHaveBeenCalled();
    // Decided on the LOCKED row, not the pre-transaction read.
    expect(mockCancelMayReseedPlan).toHaveBeenCalledWith(expect.objectContaining({ id: 'svc-synthetic-1' }));
  });

  test('a grouped locked row (visit_id set) is REFUSED before commit, even with a matching fingerprint and no frozen refusal', async () => {
    const row = { ...DEFAULT_APPT_ROW, visit_id: 'visit-grp-1' };
    const frozen = { ...FROZEN, identity_fingerprint: computeRowFingerprint(row) };
    mockApptRow = row;
    mockComputeImpact.mockResolvedValue(frozen);
    const result = await executeTool('cancel_appointment', {
      appointment_id: 'svc-synthetic-1',
      _frozen_cancellation_impact: frozen,
    }, {});

    expect(result.error).toMatch(/can only be cancelled from the Dispatch screen/);
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
    expect(mockFollowThrough).not.toHaveBeenCalled();
  });

  test('the locked row is neither reseed-eligible nor grouped: proceeds to commit, as before', async () => {
    mockComputeImpact.mockResolvedValue(FROZEN);
    mockCancelMayReseedPlan.mockReturnValue(false);
    mockTransitionJobStatus.mockResolvedValue(undefined);
    const result = await executeTool('cancel_appointment', {
      appointment_id: 'svc-synthetic-1',
      _frozen_cancellation_impact: FROZEN,
    }, {});

    expect(result.success).toBe(true);
    expect(mockTransitionJobStatus).toHaveBeenCalledTimes(1);
  });

  test('no frozen pin: the under-lock reseed/grouped recheck is a no-op (today\'s only real caller)', async () => {
    mockCancelMayReseedPlan.mockReturnValue(true);
    mockApptRow = { ...mockApptRow, visit_id: 'visit-grp-1' };
    mockTransitionJobStatus.mockRejectedValue(new Error('__reached_transition__'));
    const result = await executeTool('cancel_appointment', { appointment_id: 'svc-synthetic-1' }, {});
    expect(mockCancelMayReseedPlan).not.toHaveBeenCalled();
    expect(result.error).toBe('__reached_transition__');
  });
});

// Owner ruling 2026-09-28 ("bare visits only"), Codex round-5 P1: neither an
// invoice nor an inspection-credit offer lives on scheduled_services, so
// the whole-row fingerprint match can never catch one created in the gap
// between the pre-check (outside any lock) and this lock — only an
// explicit re-query, under the SAME lock, can. followup_source_service_id
// IS a plain column (the fingerprint already implies it), rechecked
// explicitly anyway for the same defense-in-depth discipline as the
// reseed/grouped checks above.
describe('round-5 P1: invoice/credit-offer existence and follow-up-child membership are rechecked explicitly under the row lock', () => {
  test('an invoice appearing under the lock is REFUSED before commit, even with a matching fingerprint and no frozen refusal', async () => {
    mockComputeImpact.mockResolvedValue(FROZEN); // pre-check sees no drift, no refusal
    mockAnyInvoiceLinked.mockReturnValue({ first: async () => ({ id: 'inv-race-1' }) });
    const result = await executeTool('cancel_appointment', {
      appointment_id: 'svc-synthetic-1',
      _frozen_cancellation_impact: FROZEN,
    }, {});

    expect(result.error).toMatch(/can only be cancelled from the Dispatch screen/);
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
    expect(mockFollowThrough).not.toHaveBeenCalled();
  });

  test('an inspection-credit offer appearing under the lock is REFUSED before commit, even with a matching fingerprint and no frozen refusal', async () => {
    mockComputeImpact.mockResolvedValue(FROZEN);
    mockAnyCreditOffer.mockReturnValue({ first: async () => ({ id: 'offer-race-1' }) });
    const result = await executeTool('cancel_appointment', {
      appointment_id: 'svc-synthetic-1',
      _frozen_cancellation_impact: FROZEN,
    }, {});

    expect(result.error).toMatch(/can only be cancelled from the Dispatch screen/);
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
    expect(mockFollowThrough).not.toHaveBeenCalled();
  });

  test('a follow-up-child locked row is REFUSED before commit, even with a matching fingerprint and no frozen refusal', async () => {
    const row = { ...DEFAULT_APPT_ROW, followup_source_service_id: 'svc-source-1' };
    const frozen = { ...FROZEN, identity_fingerprint: computeRowFingerprint(row) };
    mockApptRow = row;
    mockComputeImpact.mockResolvedValue(frozen);
    const result = await executeTool('cancel_appointment', {
      appointment_id: 'svc-synthetic-1',
      _frozen_cancellation_impact: frozen,
    }, {});

    expect(result.error).toMatch(/can only be cancelled from the Dispatch screen/);
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
    expect(mockFollowThrough).not.toHaveBeenCalled();
  });

  test('a bare row (no invoice, no credit offer, no follow-up link) proceeds to commit, as before', async () => {
    mockComputeImpact.mockResolvedValue(FROZEN);
    mockTransitionJobStatus.mockResolvedValue(undefined);
    const result = await executeTool('cancel_appointment', {
      appointment_id: 'svc-synthetic-1',
      _frozen_cancellation_impact: FROZEN,
    }, {});
    expect(result.success).toBe(true);
    expect(mockTransitionJobStatus).toHaveBeenCalledTimes(1);
  });

  test('no frozen pin: the under-lock invoice/credit/follow-up recheck is a no-op (today\'s only real caller)', async () => {
    mockAnyInvoiceLinked.mockReturnValue({ first: async () => ({ id: 'inv-race-1' }) });
    mockTransitionJobStatus.mockRejectedValue(new Error('__reached_transition__'));
    const result = await executeTool('cancel_appointment', { appointment_id: 'svc-synthetic-1' }, {});
    expect(mockAnyInvoiceLinked).not.toHaveBeenCalled();
    expect(result.error).toBe('__reached_transition__');
  });
});

// Owner ruling 2026-09-28, Codex round-5 P2: a legacy row with no stamped
// service_address_* shows the CUSTOMER's primary address on the card — a
// `customers` column the whole-row fingerprint (deliberately
// scheduled_services-only) can never cover. Re-verified under the SAME lock
// via a SEPARATE narrow fingerprint (legacy_address_fingerprint).
describe('round-5 P2: the legacy unstamped-address fallback is rechecked under the row lock, via a customers FOR SHARE read', () => {
  const { legacyAddressFingerprint } = jest.requireActual('../services/appointment-cancel-impact');
  const LEGACY_ROW = { ...DEFAULT_APPT_ROW, customer_id: 'cust-1', service_address_line1: null };
  const FROZEN_LEGACY = {
    ...FROZEN,
    identity_fingerprint: computeRowFingerprint(LEGACY_ROW),
    legacy_address_fingerprint: legacyAddressFingerprint({
      line1: '999 Other Rd', line2: null, city: 'Sarasota', state: 'FL', zip: '34231',
    }),
  };

  test('an unchanged customer address passes the recheck and reaches the transition', async () => {
    mockApptRow = LEGACY_ROW;
    mockCustomerRow = { address_line1: '999 Other Rd', address_line2: null, city: 'Sarasota', state: 'FL', zip: '34231' };
    mockComputeImpact.mockResolvedValue(FROZEN_LEGACY);
    mockTransitionJobStatus.mockResolvedValue(undefined);
    const result = await executeTool('cancel_appointment', {
      appointment_id: 'svc-synthetic-1',
      _frozen_cancellation_impact: FROZEN_LEGACY,
    }, {});
    expect(result.success).toBe(true);
    expect(mockTransitionJobStatus).toHaveBeenCalledTimes(1);
  });

  test('a customer address that moved since the frozen proposal is REFUSED before commit, even with a matching row fingerprint', async () => {
    mockApptRow = LEGACY_ROW;
    // The customer moved between the pre-check and this lock — same row
    // identity, different address.
    mockCustomerRow = { address_line1: '1 New Address Way', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34209' };
    mockComputeImpact.mockResolvedValue(FROZEN_LEGACY);
    const result = await executeTool('cancel_appointment', {
      appointment_id: 'svc-synthetic-1',
      _frozen_cancellation_impact: FROZEN_LEGACY,
    }, {});
    expect(result.error).toMatch(/changed since this was proposed/);
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
  });

  test('a stamped row (service_address_line1 set) never triggers the customer re-read at all', async () => {
    const stampedRow = { ...DEFAULT_APPT_ROW, customer_id: 'cust-1', service_address_line1: '123 Main St' };
    const frozenStamped = { ...FROZEN, identity_fingerprint: computeRowFingerprint(stampedRow), legacy_address_fingerprint: null };
    mockApptRow = stampedRow;
    // A customer address change must NOT matter for a stamped row — if the
    // recheck wrongly ran anyway, this mismatched mock would refuse it.
    mockCustomerRow = { address_line1: 'irrelevant', city: 'irrelevant', state: 'FL', zip: '00000' };
    mockComputeImpact.mockResolvedValue(frozenStamped);
    mockTransitionJobStatus.mockResolvedValue(undefined);
    const result = await executeTool('cancel_appointment', {
      appointment_id: 'svc-synthetic-1',
      _frozen_cancellation_impact: frozenStamped,
    }, {});
    expect(result.success).toBe(true);
  });
});

test('an inspection-credit reversal appearing where the frozen preview had none is drift: REFUSED', async () => {
  const drifted = { ...FROZEN, inspection_credit_reversal: [{ id: 'offer-1', amount: 75, would_reverse: true, deferred: false }] };
  mockComputeImpact.mockResolvedValue(drifted);
  const result = await executeTool('cancel_appointment', {
    appointment_id: 'svc-synthetic-1',
    _frozen_cancellation_impact: FROZEN,
  }, {});

  expect(result.error).toMatch(/changed since this was proposed/);
  expect(mockTransitionJobStatus).not.toHaveBeenCalled();
});

test('an impact that cannot be read is REFUSED, never treated as "no effect"', async () => {
  mockComputeImpact.mockRejectedValue(new Error('credit lookup unavailable'));
  const result = await executeTool('cancel_appointment', {
    appointment_id: 'svc-synthetic-1',
    _frozen_cancellation_impact: FROZEN,
  }, {});

  expect(result).toEqual({
    error: 'The cancellation effects (late-cancel fee, invoices, or inspection credit) could not be verified right now — nothing was changed. Try again in a moment.',
  });
  expect(mockTransitionJobStatus).not.toHaveBeenCalled();
  expect(mockFollowThrough).not.toHaveBeenCalled();
});

test('a matched confirm reaches the follow-through UNPINNED — bare visits have nothing to void or reverse', async () => {
  mockComputeImpact.mockResolvedValue(FROZEN);
  mockTransitionJobStatus.mockResolvedValue(undefined);
  const result = await executeTool('cancel_appointment', {
    appointment_id: 'svc-synthetic-1',
    _frozen_cancellation_impact: FROZEN,
  }, {});

  expect(result.success).toBe(true);
  expect(mockFollowThrough).toHaveBeenCalledWith(expect.objectContaining({
    targetIds: ['svc-synthetic-1'],
  }));
  // No pinnedEffects key at all — owner ruling 2026-09-28 ("bare visits
  // only") removed the bar-owned pinned follow-through entirely; this call
  // is now identical in shape to an unpinned Dispatch cancel's.
  expect(mockFollowThrough.mock.calls[0][0]).not.toHaveProperty('pinnedEffects');
});

// Codex round-1 P1: the reason append must read the CURRENT `notes` column
// at UPDATE time, not a value captured before the transaction opened — a
// note a concurrent writer appended in between must survive.
test('the reason append is a SQL-side concat against the live notes column, never the pre-transaction JS read', async () => {
  mockComputeImpact.mockResolvedValue(FROZEN);
  mockTransitionJobStatus.mockResolvedValue(undefined);
  // The row read before the transaction opened carries a note this update
  // must NOT embed — a real concurrent writer's note (added after this
  // read, before the UPDATE runs) would otherwise be silently discarded.
  mockApptRow = { ...mockApptRow, notes: 'stale pre-transaction note' };

  await executeTool('cancel_appointment', {
    appointment_id: 'svc-synthetic-1',
    reason: 'rain',
    _frozen_cancellation_impact: FROZEN,
  }, {});

  expect(capturedNotesUpdate).not.toBeNull();
  expect(capturedNotesUpdate.notes).toEqual({
    __raw: true,
    sql: expect.stringContaining('concat_ws'),
    bindings: ['Cancelled: rain'],
  });
  // The stale JS-side value never rides into the update payload — only a
  // reference to the live column.
  expect(JSON.stringify(capturedNotesUpdate)).not.toContain('stale pre-transaction note');
});

test('no reason: no notes update at all (unchanged from before)', async () => {
  mockComputeImpact.mockResolvedValue(FROZEN);
  mockTransitionJobStatus.mockResolvedValue(undefined);
  await executeTool('cancel_appointment', {
    appointment_id: 'svc-synthetic-1',
    _frozen_cancellation_impact: FROZEN,
  }, {});
  expect(capturedNotesUpdate).toBeNull();
});

// Codex round 6 P1: a card confirm whose visit was cancelled ELSEWHERE since
// the card is stale — refused, never replayed (the replay would run
// follow-through for effects the card never approved).
test('a card confirm on a visit already cancelled elsewhere is refused as stale — no replay, no follow-through', async () => {
  mockApptRow = { ...mockApptRow, status: 'cancelled' };
  const result = await executeTool('cancel_appointment', {
    appointment_id: 'svc-synthetic-1',
    _frozen_cancellation_impact: FROZEN,
  }, {});

  expect(result.preview_changed).toBe(true);
  expect(result.error).toMatch(/already cancelled since the card was shown/);
  expect(result.already_cancelled).toBeUndefined();
  expect(mockFollowThrough).not.toHaveBeenCalled();
  expect(mockTransitionJobStatus).not.toHaveBeenCalled();
});

test('an unpinned (non-card) call on an already-cancelled visit still replays the follow-through, as before', async () => {
  mockApptRow = { ...mockApptRow, status: 'cancelled' };
  const result = await executeTool('cancel_appointment', { appointment_id: 'svc-synthetic-1' }, {});
  expect(result.already_cancelled).toBe(true);
  expect(mockFollowThrough).toHaveBeenCalledWith(expect.objectContaining({ targetIds: ['svc-synthetic-1'] }));
});

test('no frozen pin: the follow-through runs unpinned, as before', async () => {
  mockTransitionJobStatus.mockResolvedValue(undefined);
  await executeTool('cancel_appointment', { appointment_id: 'svc-synthetic-1' }, {});
  expect(mockFollowThrough.mock.calls[0][0]).not.toHaveProperty('pinnedEffects');
});

test('a visit the bar may not cancel (owner ruling: bare visits only) is REFUSED even when nothing drifted', async () => {
  const refused = { ...FROZEN, card_cancel_refusals: ['card_fee_agreement'] };
  mockComputeImpact.mockResolvedValue(refused);
  const result = await executeTool('cancel_appointment', {
    appointment_id: 'svc-synthetic-1',
    _frozen_cancellation_impact: refused,
  }, {});

  expect(result.error).toMatch(/can only be cancelled from the Dispatch screen/);
  expect(mockTransitionJobStatus).not.toHaveBeenCalled();
  expect(mockFollowThrough).not.toHaveBeenCalled();
});

test('a pinned cancel never runs the plan reseed (commit and replay); an unpinned one still does', async () => {
  mockComputeImpact.mockResolvedValue(FROZEN);
  mockTransitionJobStatus.mockResolvedValue(undefined);
  await executeTool('cancel_appointment', { appointment_id: 'svc-synthetic-1', _frozen_cancellation_impact: FROZEN }, {});
  expect(mockReseed).not.toHaveBeenCalled();

  mockApptRow = { ...mockApptRow, status: 'cancelled' };
  await executeTool('cancel_appointment', { appointment_id: 'svc-synthetic-1', _frozen_cancellation_impact: FROZEN }, {});
  expect(mockReseed).not.toHaveBeenCalled();

  await executeTool('cancel_appointment', { appointment_id: 'svc-synthetic-1' }, {});
  expect(mockReseed).toHaveBeenCalledTimes(1);
});

// Codex round 7 on #5244, P1: a card-fee agreement committed after the
// proposal (a /secure capture, an accepted estimate card hold) lives outside
// scheduled_services — the under-lock rail recheck refuses it.
test('a card request secured between the card and Confirm refuses as drift — nothing transitions', async () => {
  mockComputeImpact.mockResolvedValue(FROZEN);
  mockCardRailRows = { estimate_card_holds: [], appointment_card_requests: [{ id: 'req-1', status: 'secured' }] };
  const result = await executeTool('cancel_appointment', {
    appointment_id: 'svc-synthetic-1',
    _frozen_cancellation_impact: FROZEN,
  }, {});
  expect(result.success).not.toBe(true);
  expect(mockTransitionJobStatus).not.toHaveBeenCalled();
  expect(mockFollowThrough).not.toHaveBeenCalled();
});

// Codex round 9 on #5244, P1: an estimate deposit or prepay commitment that
// appears after the proposal (it lives outside scheduled_services) is caught
// by re-running the canonical readers on the cancel trx under the lock.
test('a prepaid commitment that appears between the card and Confirm refuses under the lock — nothing transitions', async () => {
  mockComputeImpact.mockResolvedValue(FROZEN);
  mockPrepaidCommitmentReason.mockResolvedValue('carrying an estimate deposit that has not been applied yet');
  const result = await executeTool('cancel_appointment', {
    appointment_id: 'svc-synthetic-1',
    _frozen_cancellation_impact: FROZEN,
  }, {});
  expect(result.success).not.toBe(true);
  expect(result.error).toMatch(/prepayment or prepaid plan coverage/);
  expect(mockTransitionJobStatus).not.toHaveBeenCalled();
});

// Codex round 10 on #5244, P2: a visit that went terminal between the initial
// read and the lock chain (which refuses a never-ran visit) is a stale card.
test('a visit closed just before the lock chain returns preview_changed, not an invoice error', async () => {
  mockComputeImpact.mockResolvedValue(FROZEN);
  const chain = require('../services/scheduled-invoice-mint');
  const spy = jest.spyOn(chain, 'acquireScheduledMintLockChain').mockImplementation(async () => {
    const e = new Error('Scheduled visit is cancelled'); e.status = 409; e.code = 'SCHEDULED_VISIT_NOT_LIVE'; throw e;
  });
  try {
    const result = await executeTool('cancel_appointment', {
      appointment_id: 'svc-synthetic-1',
      _frozen_cancellation_impact: FROZEN,
    }, {});
    expect(result.preview_changed).toBe(true);
    expect(result.error).toMatch(/cancelled or closed since the card was shown/);
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
