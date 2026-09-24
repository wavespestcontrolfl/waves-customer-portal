// Owner follow-up from #4708 r2 P2: an applied reschedule move must revise a
// callback_task_created (or cancellation_processed) disposition minted before
// the move landed — otherwise unworked-comms-watcher.js keeps selecting the
// call as an outstanding callback and pages someone to call a customer who
// is already handled. Exercises the actual writer
// (CallRecordingProcessor._test.reviseDispositionAfterAppliedMove /
// applyRescheduleFollowUps) against a mocked call_log row.
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
jest.mock('../services/call-commitments', () => ({ refreshFulfillment: jest.fn().mockResolvedValue(undefined) }), { virtual: true });

const db = require('../models/db');
const CallRecordingProcessor = require('../services/call-recording-processor');
const { reviseDispositionAfterAppliedMove, applyRescheduleFollowUps } = CallRecordingProcessor._test;

const CALL_ID = 'a0000000-0000-4000-8000-000000000001';

// A minimal call_log row + a compare-and-swap-aware knex mock: `first()`
// reads the live store, `update()` only applies (and returns 1) when every
// `where()` condition this call chained still matches the store — exactly
// knex's semantics for `.where({ id, disposition: prior }).update(...)`.
// `raceOnFirstUpdate` lets a test simulate another writer (e.g. a human's
// own PUT /calls/:id/disposition tag) landing between the read this
// function did and the write it issues.
function mockCallLogStore(initialDisposition) {
  const store = { id: CALL_ID, disposition: initialDisposition };
  let raceOnFirstUpdate = null;
  db.mockImplementation((table) => {
    if (table !== 'call_log') throw new Error(`unexpected table: ${table}`);
    const where = {};
    const builder = {
      where(cond) { Object.assign(where, cond); return builder; },
      first(...cols) {
        if (where.id !== undefined && where.id !== store.id) return Promise.resolve(null);
        const wanted = cols.length ? cols : Object.keys(store);
        const row = {};
        wanted.forEach((c) => { row[c] = store[c]; });
        return Promise.resolve(row);
      },
      update(fields) {
        if (raceOnFirstUpdate) { const fn = raceOnFirstUpdate; raceOnFirstUpdate = null; fn(); }
        const matches = Object.entries(where).every(([k, v]) => store[k] === v);
        if (!matches) return Promise.resolve(0);
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

  test('an applied move revises callback_task_created -> existing_customer_routed', async () => {
    const { store } = mockCallLogStore('callback_task_created');
    await reviseDispositionAfterAppliedMove({ call: { id: CALL_ID }, callSid: 'CA_cb' });
    expect(store.disposition).toBe('existing_customer_routed');
  });

  test('an applied move revises cancellation_processed -> existing_customer_routed', async () => {
    const { store } = mockCallLogStore('cancellation_processed');
    await reviseDispositionAfterAppliedMove({ call: { id: CALL_ID }, callSid: 'CA_cancel' });
    expect(store.disposition).toBe('existing_customer_routed');
  });

  test('a skipped move leaves the disposition untouched', async () => {
    const { store } = mockCallLogStore('callback_task_created');
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
    const { store } = mockCallLogStore('existing_complaint');
    await reviseDispositionAfterAppliedMove({ call: { id: CALL_ID }, callSid: 'CA_human' });
    expect(store.disposition).toBe('existing_complaint');
  });

  test('a human retag landing between the read and the write wins (compare-and-swap)', async () => {
    const { store, setRace } = mockCallLogStore('callback_task_created');
    // Simulate PUT /calls/:id/disposition committing between this function's
    // read of the live value and its own conditional update.
    setRace(() => { store.disposition = 'existing_complaint'; });
    await reviseDispositionAfterAppliedMove({ call: { id: CALL_ID }, callSid: 'CA_race' });
    expect(store.disposition).toBe('existing_complaint');
  });

  test('applyRescheduleFollowUps revises disposition only on an applied outcome', async () => {
    const { store } = mockCallLogStore('callback_task_created');
    await applyRescheduleFollowUps({
      call: { id: CALL_ID },
      callSid: 'CA_applied',
      result: { outcome: 'applied', visitId: 'visit-1' },
    });
    expect(store.disposition).toBe('existing_customer_routed');
  });
});
