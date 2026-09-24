// Owner follow-up from #4708 r2 P2 (extended by Codex #4721 r1 P2): an
// applied reschedule move must revise a callback_task_created (or
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
const { refreshFulfillment } = require('../services/call-commitments');
const CallRecordingProcessor = require('../services/call-recording-processor');
const { reviseDispositionAfterAppliedMove, applyRescheduleFollowUps } = CallRecordingProcessor._test;

const CALL_ID = 'a0000000-0000-4000-8000-000000000001';

// scheduling.callback_window_* present is the model's own signal that a
// callback_task_created disposition WAS keyed to the reschedule ask itself
// ("call me back to confirm a time") — exactly what the applied move just
// resolved.
const schedulingCallbackExtraction = { scheduling: { callback_window_start: '14:00', callback_window_end: null } };

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
      const builder = {
        where(cond) { Object.assign(where, cond); return builder; },
        whereIn(col, vals) { inFilters[col] = vals; return builder; },
        select(...cols) {
          const rows = commitments.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)
            && Object.entries(inFilters).every(([k, vals]) => vals.includes(r[k])));
          return Promise.resolve(rows.map((r) => {
            const wanted = cols.length ? cols : Object.keys(r);
            const out = {};
            wanted.forEach((c) => { out[c] = r[c]; });
            return out;
          }));
        },
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

  test('an applied move revises callback_task_created -> existing_customer_routed when the callback was the reschedule ask', async () => {
    const { store } = mockStore({
      callLog: { disposition: 'callback_task_created', v2_extraction_status: 'valid', ai_extraction_enriched: schedulingCallbackExtraction },
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
    const { store } = mockStore({ callLog: { disposition: 'callback_task_created', v2_extraction_status: 'valid', ai_extraction_enriched: schedulingCallbackExtraction } });
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
    const { store, setRace } = mockStore({ callLog: { disposition: 'callback_task_created', v2_extraction_status: 'valid', ai_extraction_enriched: schedulingCallbackExtraction } });
    // Simulate PUT /calls/:id/disposition committing between this function's
    // read of the live value and its own conditional update.
    setRace(() => { store.disposition = 'existing_complaint'; });
    await reviseDispositionAfterAppliedMove({ call: { id: CALL_ID }, callSid: 'CA_race' });
    expect(store.disposition).toBe('existing_complaint');
  });

  test('applyRescheduleFollowUps revises disposition only on an applied outcome', async () => {
    const { store } = mockStore({ callLog: { disposition: 'callback_task_created', v2_extraction_status: 'valid', ai_extraction_enriched: schedulingCallbackExtraction } });
    await applyRescheduleFollowUps({
      call: { id: CALL_ID },
      callSid: 'CA_applied',
      result: { outcome: 'applied', visitId: 'visit-1' },
    });
    expect(store.disposition).toBe('existing_customer_routed');
  });

  describe('independent callback obligations (Codex #4721 r1 P2)', () => {
    test('an open commitment grounded outside /scheduling/ preserves callback_task_created', async () => {
      const { store } = mockStore({
        callLog: { disposition: 'callback_task_created', v2_extraction_status: 'valid', ai_extraction_enriched: schedulingCallbackExtraction },
        commitments: [{
          id: 'commit-billing-1',
          call_log_id: CALL_ID,
          kind: 'callback',
          status: 'open',
          // A free-form model-pass row about the billing question, not the
          // scheduling ask the move just resolved.
          evidence: [{ quote: 'someone will call you about your last invoice', speaker: 'agent' }],
        }],
      });
      await reviseDispositionAfterAppliedMove({ call: { id: CALL_ID }, callSid: 'CA_multi_intent' });
      expect(store.disposition).toBe('callback_task_created');
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Leaving callback_task_created standing'));
    });

    test('a call_back commitment grounded outside /scheduling/ also preserves the disposition', async () => {
      const { store } = mockStore({
        callLog: { disposition: 'callback_task_created', v2_extraction_status: 'valid', ai_extraction_enriched: schedulingCallbackExtraction },
        commitments: [{
          id: 'commit-customer-1',
          call_log_id: CALL_ID,
          kind: 'call_back',
          status: 'open',
          evidence: [{ quote: 'I will call you back with my insurance info', speaker: 'caller' }],
        }],
      });
      await reviseDispositionAfterAppliedMove({ call: { id: CALL_ID }, callSid: 'CA_call_back' });
      expect(store.disposition).toBe('callback_task_created');
    });

    test('a dismissed/fulfilled commitment (not open) does not block the revision', async () => {
      const { store } = mockStore({
        callLog: { disposition: 'callback_task_created', v2_extraction_status: 'valid', ai_extraction_enriched: schedulingCallbackExtraction },
        commitments: [{
          id: 'commit-old-1',
          call_log_id: CALL_ID,
          kind: 'callback',
          status: 'fulfilled',
          evidence: [{ quote: 'call about the billing question', speaker: 'agent' }],
        }],
      });
      await reviseDispositionAfterAppliedMove({ call: { id: CALL_ID }, callSid: 'CA_fulfilled' });
      expect(store.disposition).toBe('existing_customer_routed');
    });

    test('an open commitment grounded in /scheduling/ evidence does not block the revision', async () => {
      const { store } = mockStore({
        callLog: { disposition: 'callback_task_created', v2_extraction_status: 'valid', ai_extraction_enriched: schedulingCallbackExtraction },
        commitments: [{
          id: 'commit-sched-1',
          call_log_id: CALL_ID,
          kind: 'callback',
          status: 'open',
          evidence: [{ quote: 'call me back at two', speaker: 'caller', field_path: '/scheduling/callback_window_start' }],
        }],
      });
      await reviseDispositionAfterAppliedMove({ call: { id: CALL_ID }, callSid: 'CA_sched_grounded' });
      expect(store.disposition).toBe('existing_customer_routed');
    });

    test('no commitment row and no scheduling.callback_window_* on the live extraction preserves the disposition', async () => {
      const { store } = mockStore({
        callLog: { disposition: 'callback_task_created', v2_extraction_status: 'valid', ai_extraction_enriched: { scheduling: {} } },
      });
      await reviseDispositionAfterAppliedMove({ call: { id: CALL_ID }, callSid: 'CA_no_window' });
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
          ai_extraction_enriched: schedulingCallbackExtraction,
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
          ai_extraction_enriched: schedulingCallbackExtraction,
        },
      });
      await reviseDispositionAfterAppliedMove({ call: { id: CALL_ID }, callSid: 'CA_current', procGeneration: 5 });
      expect(store.disposition).toBe('existing_customer_routed');
    });
  });

  describe('already_applied retry durability (Codex #4721 r1 P2)', () => {
    test('a retry that only sees already_applied still revises the disposition', async () => {
      const { store } = mockStore({ callLog: { disposition: 'callback_task_created', v2_extraction_status: 'valid', ai_extraction_enriched: schedulingCallbackExtraction } });
      await applyRescheduleFollowUps({
        call: { id: CALL_ID },
        callSid: 'CA_retry',
        result: { outcome: 'skipped', reason: 'already_applied', cardsResolved: 1 },
      });
      expect(store.disposition).toBe('existing_customer_routed');
    });

    test('an already_applied retry does not re-run the fulfillment refresh', async () => {
      const { store } = mockStore({ callLog: { disposition: 'callback_task_created', v2_extraction_status: 'valid', ai_extraction_enriched: schedulingCallbackExtraction } });
      await applyRescheduleFollowUps({
        call: { id: CALL_ID },
        callSid: 'CA_retry_no_refresh',
        result: { outcome: 'skipped', reason: 'already_applied', cardsResolved: 1 },
      });
      expect(store.disposition).toBe('existing_customer_routed');
      expect(refreshFulfillment).not.toHaveBeenCalled();
    });

    test('a skip for any other reason still does not revise', async () => {
      const { store } = mockStore({ callLog: { disposition: 'callback_task_created', v2_extraction_status: 'valid', ai_extraction_enriched: schedulingCallbackExtraction } });
      await applyRescheduleFollowUps({
        call: { id: CALL_ID },
        callSid: 'CA_other_skip',
        result: { outcome: 'skipped', reason: 'prior_application_requires_review' },
      });
      expect(store.disposition).toBe('callback_task_created');
    });
  });
});
