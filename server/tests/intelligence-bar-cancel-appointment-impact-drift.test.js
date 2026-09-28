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
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    if (table === 'scheduled_services') {
      return { where: () => ({ first: async () => mockApptRow }) };
    }
    throw new Error(`unexpected table in this suite: ${table}`);
  });
  db.transaction = (cb) => cb(db);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockComputeImpact = jest.fn();
jest.mock('../services/appointment-cancel-impact', () => {
  const actual = jest.requireActual('../services/appointment-cancel-impact');
  return { computeCancelAppointmentImpact: (...a) => mockComputeImpact(...a), cancelImpactsMatch: actual.cancelImpactsMatch };
});

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
};

beforeEach(() => {
  jest.clearAllMocks();
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
