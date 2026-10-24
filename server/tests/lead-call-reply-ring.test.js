/**
 * services/lead-call-reply-ring.js (GATE_LEAD_CALL_REPLY_RING): a lead's bare
 * CALL in answer to our lead text rings Adam's cell with the press-1 bridge,
 * 8 AM-8 PM ET, once per phone per 24 h; a ring that ends without press 1
 * raises one "Missed call request" bell. Synthetic db; the bridge and the
 * bell are mocked.
 */
const mockState = {};
function resetState() {
  Object.assign(mockState, {
    gate: true,
    leadText: { id: 'sms-1' },
    priorRing: null,
    recentCall: null,
    lead: { id: 'lead-1' },
    ringRow: null,
    claimed: 1,
    locks: [],
    updates: [],
  });
}
resetState();

function mockQuery(table) {
  const q = { filters: [] };
  for (const m of ['where', 'whereNull', 'orderBy']) q[m] = (...args) => { q.filters.push(args); return q; };
  q.whereRaw = (sql) => { q.filters.push([sql]); return q; };
  q.first = async () => {
    if (table === 'sms_log') return mockState.leadText;
    if (table === 'leads') return mockState.lead;
    if (table === 'call_log') {
      const bySource = q.filters.some(([f]) => f && f.source === 'lead-call-reply-ring');
      const bySid = q.filters.some(([f]) => f && f.twilio_call_sid);
      if (bySid) return mockState.ringRow;
      return bySource ? mockState.priorRing : mockState.recentCall;
    }
    return null;
  };
  q.update = async (patch) => { mockState.updates.push({ table, patch, filters: q.filters }); return mockState.claimed; };
  return q;
}
const mockDb = jest.fn((table) => mockQuery(table));
mockDb.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
mockDb.transaction = async (fn) => {
  const trx = (table) => mockQuery(table);
  trx.raw = async (sql, bindings) => { mockState.locks.push(bindings); return {}; };
  return fn(trx);
};
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: (key) => key === 'leadCallReplyRing' && mockState.gate }));
const mockBridge = jest.fn(async () => ({ callSid: 'CA-ring', callLogId: 'log-1' }));
jest.mock('../services/call-bridge', () => ({ placeBridgeCall: (...args) => mockBridge(...args) }));
jest.mock('../services/home-line', () => ({ homeLineCallerId: () => '+19415550111' }));
jest.mock('../config/twilio-numbers', () => ({ internalAlertCallerId: () => '+19415550122' }));
const mockBell = jest.fn(async () => ({ bellWritten: true }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: (...args) => mockBell(...args) }));

const { ringForCallReply, noteRingEnded, inRingHours, _test } = require('../services/lead-call-reply-ring');

const LEAD = { id: 'cust-1', first_name: 'Pat', last_name: 'Sample', pipeline_stage: 'new_lead' };
const PHONE = '+19415550100';
// 2:00 PM ET and 9:00 PM ET on a synthetic day (EDT, UTC-4).
const AFTERNOON = new Date('2026-10-20T18:00:00Z');
const NIGHT = new Date('2026-10-21T01:00:00Z');

function ring(overrides = {}) {
  return ringForCallReply({ customer: LEAD, body: 'Call', fromPhone: PHONE, smsLogId: 'in-1', now: AFTERNOON, ...overrides });
}

beforeEach(() => { jest.clearAllMocks(); resetState(); delete process.env.ADAM_PHONE; });

test('a CALL reply to our lead text in the day rings the cell with the press-1 bridge', async () => {
  const out = await ring();
  expect(out).toMatchObject({ rang: true, callLogId: 'log-1' });
  expect(mockState.locks).toEqual([['lead-call-reply-ring:9415550100']]);
  expect(mockBridge).toHaveBeenCalledTimes(1);
  expect(mockBridge.mock.calls[0][0]).toMatchObject({
    to: PHONE,
    bridgePhone: '+19415993489',
    from: '+19415550111',
    bridgeFrom: '+19415550122',
    customer: LEAD,
    source: 'lead-call-reply-ring',
    leadName: 'Pat',
    eventLabel: 'Pat asked for a call back',
    ringTimeoutSeconds: 20,
    metadata: { type: 'lead_call_reply_ring', leadId: 'lead-1', leadName: 'Pat S.', leadPhone: PHONE, smsLogId: 'in-1' },
  });
  expect(mockBell).not.toHaveBeenCalled();
});

test.each([
  ['gate off', () => { mockState.gate = false; }, {}, 'gate_off'],
  ['a TEXT reply', () => {}, { body: 'text' }, 'not_call'],
  ['a longer message', () => {}, { body: 'call me tomorrow about ants' }, 'not_call'],
  ['after 8 PM', () => {}, { now: NIGHT }, 'after_hours'],
  ['no customer row', () => {}, { customer: null }, 'no_customer'],
  ['an existing customer', () => {}, { customer: { ...LEAD, pipeline_stage: 'active_customer' } }, 'existing_customer'],
  ['no lead text in 7 days', () => { mockState.leadText = null; }, {}, 'no_lead_text'],
  ['a ring already today', () => { mockState.priorRing = { id: 'old' }; }, {}, 'rang_today'],
  ['a call already going to the phone', () => { mockState.recentCall = { id: 'live' }; }, {}, 'call_in_progress'],
])('%s: no ring', async (_label, arrange, overrides, reason) => {
  arrange();
  const out = await ring(overrides);
  expect(out).toEqual({ rang: false, reason });
  expect(mockBridge).not.toHaveBeenCalled();
  expect(mockBell).not.toHaveBeenCalled();
});

test('a definite ring failure raises the missed bell at once', async () => {
  mockBridge.mockRejectedValueOnce(Object.assign(new Error('rejected'), { bridgeAmbiguous: false }));
  const out = await ring();
  expect(out).toEqual({ rang: false, reason: 'ring_failed' });
  expect(mockBell).toHaveBeenCalledTimes(1);
  expect(mockBell.mock.calls[0][0]).toBe('new_lead');
  expect(mockBell.mock.calls[0][1]).toMatchObject({ title: 'Missed call request: Pat S.', leadId: 'lead-1', customerId: 'cust-1', phone: PHONE });
});

test('an ambiguous ring failure leaves the miss to the status callback', async () => {
  mockBridge.mockRejectedValueOnce(Object.assign(new Error('timeout'), { bridgeAmbiguous: true }));
  const out = await ring();
  expect(out).toEqual({ rang: false, reason: 'ring_failed' });
  expect(mockBell).not.toHaveBeenCalled();
});

test('ring hours are 8 AM to 8 PM Eastern', () => {
  expect(inRingHours(new Date('2026-10-20T11:59:00Z'))).toBe(false); // 7:59 AM EDT
  expect(inRingHours(new Date('2026-10-20T12:00:00Z'))).toBe(true); // 8:00 AM EDT
  expect(inRingHours(new Date('2026-10-20T23:59:00Z'))).toBe(true); // 7:59 PM EDT
  expect(inRingHours(new Date('2026-10-21T00:00:00Z'))).toBe(false); // 8:00 PM EDT
  expect(inRingHours(new Date('2026-12-01T13:00:00Z'))).toBe(true); // 8:00 AM EST
});

test('the bell name is first name and last initial', () => {
  expect(_test.displayName({ first_name: 'Pat', last_name: 'Sample' })).toBe('Pat S.');
  expect(_test.displayName({ first_name: 'Pat' })).toBe('Pat');
  expect(_test.displayName({})).toBe('a lead');
});

describe('noteRingEnded', () => {
  const ROW = { id: 'log-1', customer_id: 'cust-1', to_phone: PHONE, bridged_at: null, metadata: { leadName: 'Pat S.', leadPhone: PHONE, leadId: 'lead-1' } };

  test('a ring that ended without press 1 raises one missed bell', async () => {
    mockState.ringRow = { ...ROW };
    await expect(noteRingEnded({ callSid: 'CA-ring', callStatus: 'no-answer' })).resolves.toBe(true);
    expect(mockState.updates).toHaveLength(1);
    expect(mockBell).toHaveBeenCalledTimes(1);
    expect(mockBell.mock.calls[0][1]).toMatchObject({ title: 'Missed call request: Pat S.', leadId: 'lead-1' });
    expect(mockBell.mock.calls[0][2]).toEqual({ dedupeKey: 'lead-call-reply-missed:log-1' });
  });

  test('a completed ring nobody connected (voicemail took it) is a miss too', async () => {
    mockState.ringRow = { ...ROW, metadata: JSON.stringify(ROW.metadata) };
    await noteRingEnded({ callSid: 'CA-ring', callStatus: 'completed' });
    expect(mockBell).toHaveBeenCalledTimes(1);
  });

  test('a connected ring raises nothing', async () => {
    mockState.ringRow = { ...ROW, bridged_at: new Date() };
    await expect(noteRingEnded({ callSid: 'CA-ring', callStatus: 'completed' })).resolves.toBe(true);
    expect(mockState.updates).toHaveLength(0);
    expect(mockBell).not.toHaveBeenCalled();
  });

  test('a retried callback after the claim raises nothing', async () => {
    mockState.ringRow = { ...ROW };
    mockState.claimed = 0;
    await noteRingEnded({ callSid: 'CA-ring', callStatus: 'no-answer' });
    expect(mockBell).not.toHaveBeenCalled();
  });

  test('a non-terminal status or another call is ignored', async () => {
    mockState.ringRow = { ...ROW };
    await expect(noteRingEnded({ callSid: 'CA-ring', callStatus: 'ringing' })).resolves.toBe(false);
    mockState.ringRow = null;
    await expect(noteRingEnded({ callSid: 'CA-other', callStatus: 'completed' })).resolves.toBe(false);
    expect(mockBell).not.toHaveBeenCalled();
  });
});
