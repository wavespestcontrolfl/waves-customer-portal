/**
 * services/lead-call-reply-ring.js (owner 2026-10-24): a lead's bare
 * CALL in answer to our lead text rings Adam's cell with the press-1 bridge,
 * 8 AM-8 PM ET, once per phone per 24 h; a ring that ends without press 1
 * raises one "Missed call request" bell. Synthetic db; the bridge and the
 * bell are mocked.
 */
const mockState = {};
function resetState() {
  Object.assign(mockState, {
    quoteGate: false,
    quoteText: null,
    quoteReads: [],
    savepoints: 0,
    leadText: { id: 'sms-1' },
    priorRing: null,
    recentCall: null,
    lead: { id: 'lead-1' },
    ringRow: null,
    reservedRow: { id: 'log-1', customer_id: 'cust-1', to_phone: '+19415550100', bridged_at: null, metadata: { leadName: 'Pat Sample', leadFirstName: 'Pat', leadId: 'lead-1' } },
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
  q.modify = (fn) => { fn(q); return q; };
  q.orWhereRaw = (sql) => { q.filters.push([sql]); return q; };
  q.where = (...args) => {
    if (typeof args[0] === 'function') { args[0].call(q); return q; }
    q.filters.push(args); return q;
  };
  q.first = async () => {
    if (table === 'current_customer_quote_texts') { mockState.quoteReads.push(q.filters); return mockState.quoteText; }
    if (table === 'sms_log') return mockState.leadText;
    if (table === 'leads') return mockState.lead;
    if (table === 'call_log') {
      const bySource = q.filters.some(([f]) => f && f.source === 'lead-call-reply-ring');
      const bySid = q.filters.some(([f]) => f && f.twilio_call_sid);
      if (bySid) return mockState.ringRow;
      const byId = q.filters.some(([f]) => f && typeof f === 'object' && f.id);
      if (byId) return mockState.reservedRow;
      return bySource ? mockState.priorRing : mockState.recentCall;
    }
    return null;
  };
  q.whereNotIn = (...args) => { q.filters.push(args); return q; };
  q.update = async (patch) => { mockState.updates.push({ table, patch, filters: q.filters }); return mockState.claimed; };
  return q;
}
const mockDb = jest.fn((table) => mockQuery(table));
mockDb.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
mockDb.transaction = async (fn) => {
  const trx = (table) => mockQuery(table);
  trx.raw = async (sql, bindings) => { mockState.locks.push(bindings); return {}; };
  // A savepoint on the locked transaction runs on that same transaction.
  trx.isTransaction = true;
  trx.transaction = async (inner) => { mockState.savepoints += 1; return inner(trx); };
  return fn(trx);
};
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: (key) => key === 'currentCustomerQuoteText' && mockState.quoteGate,
}));
const mockBridge = jest.fn(async () => ({ callSid: 'CA-ring', callLogId: 'log-1' }));
const mockInsertRow = jest.fn(async () => 'log-1');
jest.mock('../services/call-bridge', () => ({
  placeBridgeCall: (...args) => mockBridge(...args),
  insertBridgeRow: (...args) => mockInsertRow(...args),
}));
jest.mock('../services/home-line', () => ({ homeLineCallerId: () => '+19415550111' }));
jest.mock('../config/twilio-numbers', () => ({ internalAlertCallerId: () => '+19415550122' }));
// The real composer runs (it throws on a rule break under NODE_ENV=test);
// only the row write is mocked.
const mockBell = jest.fn(async () => ({ id: 'notif-1', deduped: false }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...args) => mockBell(...args) }));

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
  // The row is claimed inside the locked transaction; Twilio is called after.
  expect(mockInsertRow).toHaveBeenCalledTimes(1);
  expect(mockInsertRow.mock.calls[0][0]).toMatchObject({ to: PHONE, from: '+19415550111', source: 'lead-call-reply-ring' });
  expect(typeof mockInsertRow.mock.calls[0][1]).toBe('function');
  expect(mockBridge).toHaveBeenCalledTimes(1);
  expect(mockBridge.mock.calls[0][0].reservedCallLogId).toBe('log-1');
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
    metadata: { type: 'lead_call_reply_ring', leadId: 'lead-1', leadName: 'Pat Sample', leadFirstName: 'Pat', leadPhone: PHONE, smsLogId: 'in-1' },
  });
  expect(mockBell).not.toHaveBeenCalled();
});

test.each([
  ['a TEXT reply', () => {}, { body: 'text' }, 'not_call'],
  ['a longer message', () => {}, { body: 'call me tomorrow about ants' }, 'not_call'],
  ['after 8 PM', () => {}, { now: NIGHT }, 'after_hours'],
  ['no customer row', () => {}, { customer: null }, 'no_customer'],
  ['a foreign number sharing the last 10 digits', () => {}, { fromPhone: '+449415550100' }, 'bad_phone'],
  ['a number without the +1', () => {}, { fromPhone: '9415550100' }, 'bad_phone'],
  ['an existing customer', () => {}, { customer: { ...LEAD, pipeline_stage: 'active_customer' } }, 'existing_customer'],
  ['no lead text in 7 days', () => { mockState.leadText = null; }, {}, 'no_lead_text'],
  ['a ring already today', () => { mockState.priorRing = { id: 'old' }; }, {}, 'rang_today'],
  ['a call already going to the phone', () => { mockState.recentCall = { id: 'live' }; }, {}, 'call_in_progress'],
])('%s: no ring', async (_label, arrange, overrides, reason) => {
  arrange();
  const out = await ring(overrides);
  expect(out).toEqual({ rang: false, reason });
  expect(mockInsertRow).not.toHaveBeenCalled();
  expect(mockBridge).not.toHaveBeenCalled();
  expect(mockBell).not.toHaveBeenCalled();
});

test('a current customer our quote text reached rings like a lead (GATE_CURRENT_CUSTOMER_QUOTE_TEXT)', async () => {
  mockState.quoteGate = true;
  mockState.quoteText = { phone_digits: '9415550100' };
  const out = await ring({ customer: { ...LEAD, pipeline_stage: 'active_customer' } });
  expect(out).toMatchObject({ rang: true });
  expect(mockBridge).toHaveBeenCalledTimes(1);
  // The witness is read for this customer and phone, under the ring's lock, in a savepoint.
  expect(mockState.quoteReads[0]).toEqual(expect.arrayContaining([[{ phone_digits: '9415550100', customer_id: 'cust-1' }]]));
  expect(mockState.savepoints).toBe(1);
});

test.each([
  ['switch on, no quote text', () => { mockState.quoteGate = true; }],
  ['a quote text, switch off', () => { mockState.quoteText = { phone_digits: '9415550100' }; }],
])('%s: a current customer does not ring', async (_label, arrange) => {
  arrange();
  const out = await ring({ customer: { ...LEAD, pipeline_stage: 'won' } });
  expect(out).toEqual({ rang: false, reason: 'existing_customer' });
  expect(mockBridge).not.toHaveBeenCalled();
});

test('a definite ring failure raises the missed bell at once', async () => {
  mockBridge.mockRejectedValueOnce(Object.assign(new Error('rejected'), { bridgeAmbiguous: false }));
  const out = await ring();
  expect(out).toEqual({ rang: false, reason: 'ring_failed' });
  // The claimed row closes as failed so it never reads as ringing.
  expect(mockState.updates[0]).toEqual(expect.objectContaining({ table: 'call_log', patch: expect.objectContaining({ status: 'failed' }) }));
  expect(mockState.updates[1].patch.metadata.sql).toContain('missed_bell_at');
  expect(mockBell).toHaveBeenCalledTimes(1);
  const [category, headline, why, opts] = mockBell.mock.calls[0];
  expect(category).toBe('lead');
  expect(headline).toBe('Leads — call Pat Sample back');
  expect(why).toBe('Missed call request: Pat replied CALL to our lead text and nobody pressed 1.');
  expect(opts).toMatchObject({
    bell: true,
    link: '/admin/leads?lead=lead-1',
    dedupeKey: 'lead-call-reply-missed:log-1',
    metadata: { area: 'Leads', severity: 'needs-you', subject: { type: 'lead', id: 'lead-1' }, doneWhen: 'lead_contacted', who: 'person' },
  });
});

test('a 429 refusal is definite: the row closes and the bell goes now', async () => {
  mockBridge.mockRejectedValueOnce(Object.assign(new Error('Too Many Requests'), { status: 429, bridgeAmbiguous: true }));
  const out = await ring();
  expect(out).toEqual({ rang: false, reason: 'ring_failed' });
  expect(mockBell).toHaveBeenCalledTimes(1);
});

test('an uncertain ring that never became a call is settled as a miss after 3 minutes', async () => {
  jest.useFakeTimers();
  try {
    mockBridge.mockRejectedValueOnce(Object.assign(new Error('timeout'), { bridgeAmbiguous: true }));
    const out = await ring();
    expect(out).toEqual({ rang: false, reason: 'ring_uncertain' });
    expect(mockBell).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(_test.UNCERTAIN_RING_CHECK_MS);
    expect(mockBell).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

test('an uncertain ring Twilio did create (a sid was adopted) is left to its callbacks', async () => {
  mockState.reservedRow = null; // whereNull(twilio_call_sid) finds nothing
  await expect(_test.settleUnstartedRing('log-1')).resolves.toBe(false);
  expect(mockState.updates).toHaveLength(0);
  expect(mockBell).not.toHaveBeenCalled();
});

test('the recent-call guard also finds a web-form auto-bridge by its leadPhone', async () => {
  const seen = [];
  const conn = (table) => {
    const q = mockQuery(table);
    const raw = q.orWhereRaw;
    q.orWhereRaw = (sql) => { seen.push(sql); return raw(sql); };
    return q;
  };
  await _test.ringBlocker({ customer: LEAD, digits: '9415550100', now: AFTERNOON }, conn);
  expect(seen.some((sql) => sql.includes("metadata->>'leadPhone'"))).toBe(true);
});

test('a failed lead text never counts', async () => {
  const seen = [];
  const conn = (table) => {
    const q = mockQuery(table);
    const raw = q.whereRaw;
    q.whereRaw = (sql) => { seen.push(sql); return raw(sql); };
    return q;
  };
  await _test.ringBlocker({ customer: LEAD, digits: '9415550100', now: AFTERNOON }, conn);
  expect(seen.some((sql) => /NOT IN \('failed', 'undelivered', 'canceled'\)/.test(sql))).toBe(true);
});

test('ring hours are 8 AM to 8 PM Eastern', () => {
  expect(inRingHours(new Date('2026-10-20T11:59:00Z'))).toBe(false); // 7:59 AM EDT
  expect(inRingHours(new Date('2026-10-20T12:00:00Z'))).toBe(true); // 8:00 AM EDT
  expect(inRingHours(new Date('2026-10-20T23:59:00Z'))).toBe(true); // 7:59 PM EDT
  expect(inRingHours(new Date('2026-10-21T00:00:00Z'))).toBe(false); // 8:00 PM EDT
  expect(inRingHours(new Date('2026-12-01T13:00:00Z'))).toBe(true); // 8:00 AM EST
});

test('the bell name is the full name', () => {
  expect(_test.displayName({ first_name: 'Pat', last_name: 'Sample' })).toBe('Pat Sample');
  expect(_test.displayName({ first_name: 'Pat' })).toBe('Pat');
  expect(_test.displayName({})).toBe('a lead');
});

describe('noteRingEnded', () => {
  const ROW = { id: 'log-1', customer_id: 'cust-1', to_phone: PHONE, bridged_at: null, metadata: { leadName: 'Pat Sample', leadFirstName: 'Pat', leadPhone: PHONE, leadId: 'lead-1' } };

  test('a ring that ended without press 1 raises one missed bell', async () => {
    mockState.ringRow = { ...ROW };
    await expect(noteRingEnded({ callSid: 'CA-ring', callStatus: 'no-answer' })).resolves.toBe(true);
    expect(mockState.updates).toHaveLength(1);
    expect(mockBell).toHaveBeenCalledTimes(1);
    expect(mockBell.mock.calls[0][1]).toBe('Leads — call Pat Sample back');
    expect(mockBell.mock.calls[0][3]).toMatchObject({ dedupeKey: 'lead-call-reply-missed:log-1' });
  });

  test('a bell that never lands releases the claim for a later callback', async () => {
    jest.useFakeTimers();
    try {
      mockState.ringRow = { ...ROW };
      mockBell.mockResolvedValue(null);
      const done = noteRingEnded({ callSid: 'CA-ring', callStatus: 'no-answer' });
      await jest.runAllTimersAsync();
      await done;
      expect(mockBell).toHaveBeenCalledTimes(3);
      expect(mockState.updates).toHaveLength(2);
      expect(mockState.updates[1].patch.metadata.sql).toContain("- 'missed_bell_at'");
    } finally {
      jest.useRealTimers();
      mockBell.mockResolvedValue({ id: 'notif-1', deduped: false });
    }
  });

  test('a deduped bell counts as delivered', async () => {
    mockState.ringRow = { ...ROW };
    mockBell.mockResolvedValueOnce({ id: 'notif-0', deduped: true });
    await noteRingEnded({ callSid: 'CA-ring', callStatus: 'no-answer' });
    expect(mockBell).toHaveBeenCalledTimes(1);
    expect(mockState.updates).toHaveLength(1);
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

// The Call button (alert-call-button.js, GATE_ALERT_CALL_BUTTON): a lead's call-back bells carry Call, naming the
// lead's customer row, which the tap reads again.
describe('Call on the lead call-back bells', () => {
  const LEAD_CUSTOMER = '00000000-0000-4000-8000-0000000000b1';
  const CALL = { kind: 'call_back', items: [{ id: 'call', label: 'Call', prompt: 'Waves rings your phone first, then you press 1 to connect.', args: { customerId: LEAD_CUSTOMER } }] };

  test('the missed call request bell', async () => {
    mockBell.mockClear();
    await _test.raiseMissedBell({ customerId: LEAD_CUSTOMER, name: 'Pat Sample', firstName: 'Pat', leadId: 'lead-1', callLogId: 'log-1' }, [0]);
    expect(mockBell.mock.calls[0][3].metadata.buttons).toEqual(CALL);
  });

  test('the after-hours follow-up and booked-call bells', async () => {
    mockBell.mockClear();
    const { _shared: { raiseLeadBell } } = require('../services/lead-call-text-followup');
    await raiseLeadBell({ customer: { id: LEAD_CUSTOMER, first_name: 'Pat', last_name: 'Sample' }, leadId: 'lead-1', requestId: 'req-1', why: 'Asked for a call after hours and never sent a time.' }, [0]);
    expect(mockBell.mock.calls[0][3].metadata.buttons).toEqual(CALL);
  });
});
