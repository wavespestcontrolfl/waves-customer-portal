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
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    if (table === 'scheduled_services') {
      return {
        where: () => ({
          first: async () => mockApptRow,
          update: async (fields) => { capturedNotesUpdate = fields; return 1; },
        }),
      };
    }
    if (table === 'job_status_history') {
      const chain = { where: () => chain, whereNot: () => chain, orderBy: () => chain, first: async () => ({ transitioned_at: new Date(Date.now() - 60 * 1000) }) };
      return chain;
    }
    if (table === 'customers') {
      return { where: () => ({ first: async () => ({ first_name: 'Synthia', last_name: 'Tester' }) }) };
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

const mockComputeImpact = jest.fn();
jest.mock('../services/appointment-cancel-impact', () => {
  const actual = jest.requireActual('../services/appointment-cancel-impact');
  return { computeCancelAppointmentImpact: (...a) => mockComputeImpact(...a), cancelImpactsMatch: actual.cancelImpactsMatch };
});

const mockFollowThrough = jest.fn(async () => ({ settled: 1 }));
jest.mock('../services/visit-cancellation-followthrough', () => ({
  runVisitCancellationFollowThrough: (...a) => mockFollowThrough(...a),
}));
const mockReseed = jest.fn(async () => {});
jest.mock('../services/recurring-series-cancel-reseed', () => ({ runPostCancelSeriesReseed: (...a) => mockReseed(...a) }));
jest.mock('../services/typed-followup-obligation', () => ({ handleFollowupChildCancellation: jest.fn(async () => {}) }));

const mockTransitionJobStatus = jest.fn();
jest.mock('../services/job-status', () => ({
  transitionJobStatus: (...a) => mockTransitionJobStatus(...a),
  STATUS_ROUTE_ALLOWED_TARGETS: new Set(['cancelled']),
}));

const { executeTool } = require('../services/intelligence-bar/tools');

const FROZEN = {
  appointment: { id: 'svc-synthetic-1', status: 'confirmed', scheduled_date: '2026-10-02', service_type: 'pest_control', customer_name: 'Synthia Tester' },
  fee: { applies: true, amount: 49, unresolved: false, rail: 'card_hold', hold_disposition: null },
  invoices: [{ id: 'inv-1', invoice_number: 'WPC-2026-9001', status: 'sent', total: 89, credit_applied: 0 }],
  inspection_credit_reversal: null,
  card_cancel_refusals: [],
  // Codex round-2 P1: the full appointment identity (window/customer/tech —
  // see appointment-cancel-impact.js's loadAppointmentFacts), hashed. The
  // display facts above (status/scheduled_date/service_type/customer_name)
  // can read identical for a same-day window move or a same-named repoint —
  // this is what actually catches it.
  identity_fingerprint: 'fp-original',
};

beforeEach(() => {
  jest.clearAllMocks();
  capturedNotesUpdate = null;
  mockApptRow = {
    id: 'svc-synthetic-1',
    status: 'confirmed',
    scheduled_date: '2026-10-02',
    service_type: 'pest_control',
    notes: null,
  };
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

  expect(mockComputeImpact).toHaveBeenCalledWith('svc-synthetic-1');
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

const PINNED = { 'svc-synthetic-1': { invoices: FROZEN.invoices, fee: FROZEN.fee, creditReversalOfferIds: [] } };

test('a matched confirm carries the pin into the follow-through (only the listed invoices, the shown fee)', async () => {
  mockComputeImpact.mockResolvedValue(FROZEN);
  mockTransitionJobStatus.mockResolvedValue(undefined);
  const result = await executeTool('cancel_appointment', {
    appointment_id: 'svc-synthetic-1',
    _frozen_cancellation_impact: FROZEN,
  }, {});

  expect(result.success).toBe(true);
  expect(mockFollowThrough).toHaveBeenCalledWith(expect.objectContaining({
    targetIds: ['svc-synthetic-1'], pinnedEffects: PINNED,
  }));
});

// Codex round-1 P1: this tool ALWAYS runs its own pinned follow-through
// (runVisitCancellationFollowThrough, mocked as mockFollowThrough above)
// right after the transition commits — pinned or not (an unpinned run
// still voids every voidable invoice via the SAME invoice.js entry point).
// The shared status writer's own maybeReparkFollowupObligation hook also
// calls that entry point, UNPINNED, post-commit — racing it against this
// tool's pinned/scoped call could void an invoice the operator never
// approved. skipCancellationMoneySeam: true tells the writer to skip
// ONLY that seam (see job-status.js's own test coverage for the
// non-money re-park hook still running).
test('the commit always tells the status writer to skip its own unpinned invoice-void seam (pinned or not)', async () => {
  mockComputeImpact.mockResolvedValue(FROZEN);
  mockTransitionJobStatus.mockResolvedValue(undefined);
  await executeTool('cancel_appointment', {
    appointment_id: 'svc-synthetic-1',
    _frozen_cancellation_impact: FROZEN,
  }, {});
  expect(mockTransitionJobStatus).toHaveBeenCalledWith(expect.objectContaining({
    skipCancellationMoneySeam: true,
  }));

  mockTransitionJobStatus.mockClear();
  mockTransitionJobStatus.mockResolvedValue(undefined);
  await executeTool('cancel_appointment', { appointment_id: 'svc-synthetic-1' }, {});
  expect(mockTransitionJobStatus).toHaveBeenCalledWith(expect.objectContaining({
    skipCancellationMoneySeam: true,
  }));
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

test('a replay of a pinned confirm (visit already cancelled) keeps the pin', async () => {
  mockApptRow = { ...mockApptRow, status: 'cancelled' };
  const result = await executeTool('cancel_appointment', {
    appointment_id: 'svc-synthetic-1',
    _frozen_cancellation_impact: FROZEN,
  }, {});

  expect(result.already_cancelled).toBe(true);
  expect(mockFollowThrough).toHaveBeenCalledWith(expect.objectContaining({ pinnedEffects: PINNED }));
});

test('no frozen pin: the follow-through runs unpinned, as before', async () => {
  mockTransitionJobStatus.mockResolvedValue(undefined);
  await executeTool('cancel_appointment', { appointment_id: 'svc-synthetic-1' }, {});
  expect(mockFollowThrough).toHaveBeenCalledWith(expect.objectContaining({ pinnedEffects: null }));
});

test('a visit the bar may not cancel (owner ruling: simple visits only) is REFUSED even when nothing drifted', async () => {
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
