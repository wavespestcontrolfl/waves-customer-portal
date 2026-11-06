/**
 * runLeadCallbackTick (every-minute cron, scheduler.js, GATE_LEAD_CALL_TEXT_FOLLOWUP).
 * Each step used to turn its failure into the value 'error' and the tick
 * returned normally, so job_health recorded success. Now every step still runs,
 * then the tick throws when any step failed. One request's failed ring is the
 * ring step's own per-request catch, not a failed step.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/lead-call-text-followup', () => ({
  _shared: { sendFollowup: jest.fn(), raiseLeadBell: jest.fn(async () => true) },
}));
jest.mock('../services/lead-call-reply-ring', () => ({
  LEAD_CALL_REPLY_RING_SOURCE: 'lead_call_reply_ring',
  inRingHours: jest.fn(() => true),
  customerBlocker: jest.fn(async () => null),
  placeRing: jest.fn(),
  settleUnstartedRing: jest.fn(),
}));
jest.mock('../services/voice-agent/relay-protocol', () => ({ whereNotSandboxCall: (q) => q }));

const db = require('../models/db');
const logger = require('../services/logger');
const { runLeadCallbackTick } = require('../services/lead-callback-scheduler');

const NOON_ET = new Date('2026-11-05T17:00:00Z');

// Chainable query stub. The four steps each end their first read with
// .limit(), in tick order (reminded, rang, stranded, noAnswer), so a step is
// failed by its position.
function stubDb({ failStep = [], rows = {}, customerReadFails = false } = {}) {
  const state = { limitCalls: 0, tablesAtLimit: [] };
  db.mockImplementation((table) => {
    const q = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return undefined;
        if (prop === 'limit') {
          return () => {
            state.limitCalls += 1;
            state.tablesAtLimit.push(table);
            const result = failStep.includes(state.limitCalls)
              ? Promise.reject(Object.assign(new Error('connection lost'), { code: '57P01' }))
              : Promise.resolve(rows[state.limitCalls] || []);
            // The stranded-ring read chains .select('id') after .limit().
            return Object.assign(result, { select: () => result });
          };
        }
        if (prop === 'first') return () => (customerReadFails ? Promise.reject(new Error('customer read failed')) : Promise.resolve(undefined));
        if (prop === 'update') return () => Promise.resolve(1);
        return () => q;
      },
    });
    return q;
  });
  return state;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runLeadCallbackTick', () => {
  test('a failed step does not stop the later steps, and the tick then rejects naming it', async () => {
    const state = stubDb({ failStep: [2] }); // the ring step's read
    await expect(runLeadCallbackTick({ now: NOON_ET })).rejects.toThrow('lead-callback-scheduler: 1 step(s) failed (rang)');
    // stranded (call_log) and noAnswer (lead_callback_requests) both still read.
    expect(state.limitCalls).toBe(4);
    expect(state.tablesAtLimit.slice(2)).toEqual(['call_log', 'lead_callback_requests']);
    expect(logger.error).toHaveBeenCalledWith('[lead-callback-scheduler] rang step failed (57P01)');
  });

  test('every failed step is named, in tick order, with no row data in the message', async () => {
    stubDb({ failStep: [1, 3, 4] });
    await expect(runLeadCallbackTick({ now: NOON_ET })).rejects.toThrow(/^lead-callback-scheduler: 3 step\(s\) failed \(reminded, stranded, noAnswer\)$/);
  });

  test('four clean steps resolve with their counts', async () => {
    stubDb();
    await expect(runLeadCallbackTick({ now: NOON_ET })).resolves.toEqual({ reminded: 0, rang: 0, stranded: 0, noAnswer: 0 });
  });

  test("one request's failed ring is released for the next tick and does not fail the tick", async () => {
    // A booking more than 30 minutes late is handed to the owner path; its customer read fails.
    stubDb({
      customerReadFails: true,
      rows: { 2: [{ id: 'req-1', customer_id: 'cust-1', phone: '9415550100', scheduled_for: new Date(NOON_ET.getTime() - 3600000) }] },
    });
    await expect(runLeadCallbackTick({ now: NOON_ET })).resolves.toMatchObject({ rang: 0 });
    expect(logger.error).toHaveBeenCalledWith('[lead-callback-scheduler] ring step failed for request req-1 (Error)');
  });

  test('gate off: no reads, no throw', async () => {
    require('../config/feature-gates').isEnabled.mockReturnValueOnce(false);
    const state = stubDb({ failStep: [1, 2, 3, 4] });
    await expect(runLeadCallbackTick({ now: NOON_ET })).resolves.toEqual({ skipped: 'gate_off' });
    expect(state.limitCalls).toBe(0);
  });
});
