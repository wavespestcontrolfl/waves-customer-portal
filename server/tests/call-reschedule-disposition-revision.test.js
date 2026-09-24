// Owner follow-up from #4708 r2 P2 (extended by Codex #4721 r1 P2 / r2 P1):
// an applied reschedule move must revise a callback_task_created (or
// cancellation_processed) disposition minted before the move landed —
// otherwise unworked-comms-watcher.js keeps selecting the call as an
// outstanding callback and pages someone to call a customer who is already
// handled. The revision must not, however, bury an INDEPENDENT callback
// obligation a multi-intent call also carries, must not race a newer
// reprocess generation, and must still land on a retry that only sees
// already_applied. Exercises the actual writer
// (CallRecordingProcessor._test.reviseDispositionAfterAppliedMove /
// applyRescheduleFollowUps / hasIndependentCallbackObligation) against a
// mocked call_log + call_commitments store.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  const enabled = new Set(['callDispositionV1', 'callCommitments']);
  return { ...actual, isEnabled: jest.fn((name) => enabled.has(name)) };
});
// call-commitments is required lazily inside applyRescheduleFollowUps for the
// fulfillment refresh — stub it so that unrelated pass never touches a real db.
jest.mock('../services/call-commitments', () => ({ refreshFulfillment: jest.fn().mockResolvedValue(undefined) }));

const db = require('../models/db');
const logger = require('../services/logger');
const { isEnabled } = require('../config/feature-gates');
const { refreshFulfillment } = require('../services/call-commitments');
const CallRecordingProcessor = require('../services/call-recording-processor');
const { reviseDispositionAfterAppliedMove, applyRescheduleFollowUps } = CallRecordingProcessor._test;

const CALL_ID = 'a0000000-0000-4000-8000-000000000001';

// Reaching reviseDispositionAfterAppliedMove at all already means the move
// applied — which requires agent_committed_booking === true and a
// confirmed_start_at on the SAME extraction, so the reschedule's timing was
// settled on the call itself. This is the "clean" extraction for that case:
// no scheduling.callback_window_* left standing (nothing left to call back
// and confirm about).
const resolvedRescheduleExtraction = { scheduling: { agent_committed_booking: true, confirmed_start_at: '2026-09-24T14:00:00-04:00' } };

// A minimal call_log + call_commitments store, and a compare-and-swap-aware
// knex mock: `first()`/`update()` only match (and `update()` only lands)
// when every `where()` condition this call chained still matches the
// store — exactly knex's semantics for `.where({ id, disposition: prior,
// processing_generation: gen }).update(...)`. `raceOnFirstUpdate` lets a
// test simulate another writer (e.g. a human's own PUT /calls/:id/disposition
// tag, or a newer reprocess pass) landing between the read this function did
// and the write it issues.
function mockStore({ callLog, commitments = [] }) {
  const store = { id: CALL_ID, ...callLog };
  let raceOnFirstUpdate = null;
  db.mockImplementation((table) => {
    if (table === 'call_commitments') {
      const where = {};
      const inFilters = {};
      const matching = () => commitments.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)
        && Object.entries(inFilters).every(([k, vals]) => vals.includes(r[k])));
      const project = (rows, cols) => rows.map((r) => {
        const wanted = cols.length ? cols : Object.keys(r);
        const out = {};
        wanted.forEach((c) => { out[c] = r[c]; });
        return out;
      });
      const builder = {
        where(cond) { Object.assign(where, cond); return builder; },
        whereIn(col, vals) { inFilters[col] = vals; return builder; },
        select(...cols) { return Promise.resolve(project(matching(), cols)); },
        first(...cols) { return Promise.resolve(project(matching(), cols)[0] || null); },
      };
      return builder;
    }
    if (table !== 'call_log') throw new Error(`unexpected table: ${table}`);
    const where = {};
    const matchesStore = () => Object.entries(where).every(([k, v]) => store[k] === v);
    const builder = {
      where(cond) { Object.assign(where, cond); return builder; },
      first(...cols) {
        if (!matchesStore()) return Promise.resolve(null);
        const wanted = cols.length ? cols : Object.keys(store);
        const row = {};
        wanted.forEach((c) => { row[c] = store[c]; });
        return Promise.resolve(row);
      },
      update(fields) {
        if (raceOnFirstUpdate) { const fn = raceOnFirstUpdate; raceOnFirstUpdate = null; fn(); }
        if (!matchesStore()) return Promise.resolve(0);
        Object.assign(store, fields);
        return Promise.resolve(1);
      },
    };
    return builder;
  });
  return { store, setRace: (fn) => { raceOnFirstUpdate = fn; } };
}

describe('reviseDispositionAfterAppliedMove', () => {
  beforeEach(() => jest.clearAllMocks());

  test('an applied move revises callback_task_created -> existing_customer_routed when nothing else grounds it', async () => {
    const { store } = mockStore({
      callLog: { disposition: 'callback_task_created', v2_extraction_status: 'valid', ai_extraction_enriched: resolvedRescheduleExtraction },
    });
    await reviseDispositionAfterAppliedMove({ call: { id: CALL_ID }, callSid: 'CA_cb' });
    expect(store.disposition).toBe('existing_customer_routed');
  });

  test('an applied move revises cancellation_processed -> existing_customer_routed', async () => {
    const { store } = mockStore({ callLog: { disposition: 'cancellation_processed' } });
    await reviseDispositionAfterAppliedMove({ call: { id: CALL_ID }, callSid: 'CA_cancel' });
    expect(store.disposition).toBe('existing_customer_routed');
  });

  test('a skipped move leaves the disposition untouched', async () => {
    const { store } = mockStore({ callLog: { disposition: 'callback_task_created', v2_extraction_status: 'valid', ai_extraction_enriched: resolvedRescheduleExtraction } });
    await applyRescheduleFollowUps({
      call: { id: CALL_ID },
      callSid: 'CA_skip',
      result: { outcome: 'skipped', reason: 'agent_did_not_commit' },
    });
    expect(store.disposition).toBe('callback_task_created');
  });

  test('a disposition that is not the pre-move automated value is left alone', async () => {
    // Stand-in for "a human already set this call's disposition": any value
    // outside the two the apply step is allowed to revise is never touched.
    const { store } = mockStore({ callLog: { disposition: 'existing_complaint' } });
    await reviseDispositionAfterAppliedMove({ call: { id: CALL_ID }, callSid: 'CA_human' });
    expect(store.disposition).toBe('existing_complaint');
  });

  test('a human retag landing between the read and the write wins (compare-and-swap)', async () => {
    const { store, setRace } = mockStore({ callLog: { disposition: 'callback_task_created', v2_extraction_status: 'valid', ai_extraction_enriched: resolvedRescheduleExtraction } });
    // Simulate PUT /calls/:id/disposition committing between this function's
    // read of the live value and its own conditional update.
    setRace(() => { store.disposition = 'existing_complaint'; });
    await reviseDispositionAfterAppliedMove({ call: { id: CALL_ID }, callSid: 'CA_race' });
    expect(store.disposition).toBe('existing_complaint');
  });

  test('applyRescheduleFollowUps revises disposition only on an applied outcome', async () => {
    const { store } = mockStore({ callLog: { disposition: 'callback_task_created', v2_extraction_status: 'valid', ai_extraction_enriched: resolvedRescheduleExtraction } });
    await applyRescheduleFollowUps({
      call: { id: CALL_ID },
      callSid: 'CA_applied',
      result: { outcome: 'applied', visitId: 'visit-1' },
    });
    expect(store.disposition).toBe('existing_customer_routed');
  });

  describe('independent callback obligations (Codex #4721 r1 P2 / r2 P1)', () => {
    test('scheduling.callback_window_start still set alongside the committed booking preserves the disposition', async () => {
      const { store } = mockStore({
        callLog: {
          disposition: 'callback_task_created',
          v2_extraction_status: 'valid',
          // agent_committed_booking + confirmed_start_at settled the move,
          // but a callback window is STILL set — a scheduling field path or
          // callback window alone does not prove it was superseded by this
          // move (Codex r2 P1); a standing window names something else.
          ai_extraction_enriched: { scheduling: { ...resolvedRescheduleExtraction.scheduling, callback_window_start: '14:00' } },
        },
      });
      await reviseDispositionAfterAppliedMove({ call: { id: CALL_ID }, callSid: 'CA_window' });
      expect(store.disposition).toBe('callback_task_created');
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Leaving callback_task_created standing'));
    });

    test('scheduling.callback_window_end alone also preserves the disposition', async () => {
      const { store } = mockStore({
        callLog: {
          disposition: 'callback_task_created',
          v2_extraction_status: 'valid',
          ai_extraction_enriched: { scheduling: { ...resolvedRescheduleExtraction.scheduling, callback_window_end: '16:00' } },
        },
      });
      await reviseDispositionAfterAppliedMove({ call: { id: CALL_ID }, callSid: 'CA_window_end' });
      expect(store.disposition).toBe('callback_task_created');
    });

    test('an open waves:callback commitment preserves the disposition even with no callback window', async () => {
      const { store } = mockStore({
        callLog: { disposition: 'callback_task_created', v2_extraction_status: 'valid', ai_extraction_enriched: resolvedRescheduleExtraction },
        commitments: [{ id: 'commit-billing-1', call_log_id: CALL_ID, party: 'waves', kind: 'callback', status: 'open' }],
      });
      await reviseDispositionAfterAppliedMove({ call: { id: CALL_ID }, callSid: 'CA_multi_intent' });
      expect(store.disposition).toBe('callback_task_created');
    });

    test('an open customer call_back commitment also preserves the disposition', async () => {
      const { store } = mockStore({
        callLog: { disposition: 'callback_task_created', v2_extraction_status: 'valid', ai_extraction_enriched: resolvedRescheduleExtraction },
        commitments: [{ id: 'commit-customer-1', call_log_id: CALL_ID, party: 'customer', kind: 'call_back', status: 'open' }],
      });
      await reviseDispositionAfterAppliedMove({ call: { id: CALL_ID }, callSid: 'CA_call_back' });
      expect(store.disposition).toBe('callback_task_created');
    });

    test('a dismissed/fulfilled commitment (not open) does not block the revision', async () => {
      const { store } = mockStore({
        callLog: { disposition: 'callback_task_created', v2_extraction_status: 'valid', ai_extraction_enriched: resolvedRescheduleExtraction },
        commitments: [{ id: 'commit-old-1', call_log_id: CALL_ID, party: 'waves', kind: 'callback', status: 'fulfilled' }],
      });
      await reviseDispositionAfterAppliedMove({ call: { id: CALL_ID }, callSid: 'CA_fulfilled' });
      expect(store.disposition).toBe('existing_customer_routed');
    });

    test('a commitment for a DIFFERENT call is never consulted', async () => {
      const { store } = mockStore({
        callLog: { disposition: 'callback_task_created', v2_extraction_status: 'valid', ai_extraction_enriched: resolvedRescheduleExtraction },
        commitments: [{ id: 'commit-other-call', call_log_id: 'a0000000-0000-4000-8000-000000000099', party: 'waves', kind: 'callback', status: 'open' }],
      });
      await reviseDispositionAfterAppliedMove({ call: { id: CALL_ID }, callSid: 'CA_other_call' });
      expect(store.disposition).toBe('existing_customer_routed');
    });

    test('callCommitments dark preserves the disposition even with no window and no visible commitment (Codex #4721 r3 P1)', async () => {
      // recordCommitmentsStep bails outright when the gate is off, so an
      // absent commitment row proves nothing about whether an independent
      // obligation exists — there was never a chance to detect one.
      isEnabled.mockImplementationOnce((name) => name !== 'callCommitments');
      const { store } = mockStore({
        callLog: { disposition: 'callback_task_created', v2_extraction_status: 'valid', ai_extraction_enriched: resolvedRescheduleExtraction },
      });
      await reviseDispositionAfterAppliedMove({ call: { id: CALL_ID }, callSid: 'CA_gate_dark' });
      expect(store.disposition).toBe('callback_task_created');
    });
  });

  describe('processing-generation fence (Codex #4721 r1 P2)', () => {
    test('a stale pass never touches a newer generation\'s value', async () => {
      const { store } = mockStore({
        callLog: {
          disposition: 'complaint_escalated', // whatever the NEWER pass decided for itself
          processing_generation: 5,
          v2_extraction_status: 'valid',
          ai_extraction_enriched: resolvedRescheduleExtraction,
        },
      });
      await reviseDispositionAfterAppliedMove({ call: { id: CALL_ID }, callSid: 'CA_stale', procGeneration: 3 });
      expect(store.disposition).toBe('complaint_escalated');
    });

    test('a matching generation still revises', async () => {
      const { store } = mockStore({
        callLog: {
          disposition: 'callback_task_created',
          processing_generation: 5,
          v2_extraction_status: 'valid',
          ai_extraction_enriched: resolvedRescheduleExtraction,
        },
      });
      await reviseDispositionAfterAppliedMove({ call: { id: CALL_ID }, callSid: 'CA_current', procGeneration: 5 });
      expect(store.disposition).toBe('existing_customer_routed');
    });
  });

  describe('already_applied retry durability (Codex #4721 r1 P2)', () => {
    test('a retry that only sees already_applied still revises the disposition', async () => {
      const { store } = mockStore({ callLog: { disposition: 'callback_task_created', v2_extraction_status: 'valid', ai_extraction_enriched: resolvedRescheduleExtraction } });
      await applyRescheduleFollowUps({
        call: { id: CALL_ID },
        callSid: 'CA_retry',
        result: { outcome: 'skipped', reason: 'already_applied', cardsResolved: 1 },
      });
      expect(store.disposition).toBe('existing_customer_routed');
    });

    test('an already_applied retry does not re-run the fulfillment refresh', async () => {
      const { store } = mockStore({ callLog: { disposition: 'callback_task_created', v2_extraction_status: 'valid', ai_extraction_enriched: resolvedRescheduleExtraction } });
      await applyRescheduleFollowUps({
        call: { id: CALL_ID },
        callSid: 'CA_retry_no_refresh',
        result: { outcome: 'skipped', reason: 'already_applied', cardsResolved: 1 },
      });
      expect(store.disposition).toBe('existing_customer_routed');
      expect(refreshFulfillment).not.toHaveBeenCalled();
    });

    test('a skip for any other reason still does not revise', async () => {
      const { store } = mockStore({ callLog: { disposition: 'callback_task_created', v2_extraction_status: 'valid', ai_extraction_enriched: resolvedRescheduleExtraction } });
      await applyRescheduleFollowUps({
        call: { id: CALL_ID },
        callSid: 'CA_other_skip',
        result: { outcome: 'skipped', reason: 'prior_application_requires_review' },
      });
      expect(store.disposition).toBe('callback_task_created');
    });
  });
});
