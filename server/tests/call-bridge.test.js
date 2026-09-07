/**
 * services/call-bridge.js — the shared press-1 click-to-call: call_log row
 * first, then the Twilio call to the STAFF phone with the customer number
 * riding the prompt URL, then the SID backfill + touchpoint.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(async () => null) }));
const mockCallsCreate = jest.fn(async () => ({ sid: 'CA-bridge' }));
jest.mock('twilio', () => jest.fn(() => ({ calls: { create: mockCallsCreate } })));
jest.mock('../config', () => ({ twilio: { accountSid: 'AC-test', authToken: 'tok' } }));

const db = require('../models/db');
const { recordTouchpoint } = require('../services/conversations');
const { placeBridgeCall, activeBridgeCall } = require('../services/call-bridge');

function primeDb() {
  const inserted = [];
  const updates = [];
  const chain = {};
  chain.insert = jest.fn((row) => { inserted.push(row); return chain; });
  chain.returning = jest.fn(async () => [{ id: 'log-1' }]);
  chain.where = jest.fn(() => chain);
  chain.update = jest.fn(async (u) => { updates.push(u); return 1; });
  db.mockImplementation(() => chain);
  return { inserted, updates };
}

beforeEach(() => { jest.clearAllMocks(); process.env.SERVER_DOMAIN = 'portal.example.com'; });

test('rings the staff phone from the chosen line; the customer rides the prompt URL', async () => {
  const { inserted, updates } = primeDb();
  const out = await placeBridgeCall({
    to: '+19415550100', bridgePhone: '+19415550101', from: '+19413529161',
    customer: { id: 'c1' }, source: 'tech-click', adminUserId: 'tech-1', metadata: { scheduledServiceId: 'ss-1' }, leadName: 'Pat Sample',
  });
  expect(out).toEqual({ callSid: 'CA-bridge', callLogId: 'log-1' });
  expect(inserted[0]).toMatchObject({ customer_id: 'c1', direction: 'outbound', from_phone: '+19413529161', to_phone: '+19415550100', status: 'initiated', source: 'tech-click' });
  expect(JSON.parse(inserted[0].metadata)).toEqual({ scheduledServiceId: 'ss-1' });
  const args = mockCallsCreate.mock.calls[0][0];
  expect(args.to).toBe('+19415550101');
  expect(args.from).toBe('+19413529161');
  expect(args.url).toBe('https://portal.example.com/api/webhooks/twilio/outbound-admin-prompt?customerNumber=%2B19415550100&callerIdNumber=%2B19413529161&callLogId=log-1&leadName=Pat+Sample');
  expect(args.statusCallback).toBe('https://portal.example.com/api/webhooks/twilio/call-status');
  expect(updates[0]).toMatchObject({ twilio_call_sid: 'CA-bridge' });
  expect(recordTouchpoint).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'c1', channel: 'voice', ourEndpointId: '+19413529161', direction: 'outbound', adminUserId: 'tech-1', twilioSid: 'CA-bridge' }));
});

test('an unlinked number keeps the contact phone on the touchpoint', async () => {
  primeDb();
  await placeBridgeCall({ to: '+19415550100', bridgePhone: '+19415550101', from: '+19412975749', customer: null, source: 'admin-click' });
  expect(recordTouchpoint).toHaveBeenCalledWith(expect.objectContaining({ customerId: null, contactPhone: '+19415550100' }));
});

test('a rejected Twilio create closes the pre-inserted row as failed and rethrows', async () => {
  const { updates } = primeDb();
  mockCallsCreate.mockRejectedValueOnce(new Error('Unable to create record'));
  await expect(placeBridgeCall({ to: '+19415550100', bridgePhone: '+19415550101', from: '+19412975749', source: 'admin-click' }))
    .rejects.toThrow('Unable to create record');
  expect(updates[0]).toMatchObject({ status: 'failed' });
  expect(recordTouchpoint).not.toHaveBeenCalled();
});

// Last on purpose: resets the module registry with an empty config, which
// every later lazy require('../config') in the bridge would see.
test('missing Twilio credentials fail before any row is written', async () => {
  jest.resetModules();
  jest.doMock('../config', () => ({ twilio: {} }));
  const { placeBridgeCall: fresh } = require('../services/call-bridge');
  const { inserted } = primeDb();
  await expect(fresh({ to: '+19415550100', bridgePhone: '+19415550101', from: '+19412975749', source: 'admin-click' }))
    .rejects.toMatchObject({ code: 'TWILIO_NOT_CONFIGURED' });
  expect(inserted).toHaveLength(0);
});

describe('activeBridgeCall', () => {
  test('finds the newest non-terminal outbound row from the source to the customer inside the window', async () => {
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.whereNotIn = jest.fn(() => chain);
    chain.orderBy = jest.fn(() => chain);
    chain.first = jest.fn(async () => ({ id: 'log-9', status: 'ringing' }));
    db.mockImplementation((table) => { expect(table).toBe('call_log'); return chain; });
    const before = Date.now();
    const row = await activeBridgeCall({ source: 'tech-click', customerId: 'c1' });
    expect(row).toEqual({ id: 'log-9', status: 'ringing' });
    expect(chain.where).toHaveBeenCalledWith({ source: 'tech-click', customer_id: 'c1', direction: 'outbound' });
    // Twilio's terminal set: a completed / failed / unanswered bridge never blocks the next one.
    expect(chain.whereNotIn).toHaveBeenCalledWith('status', ['completed', 'busy', 'failed', 'no-answer', 'canceled']);
    const [col, op, since] = chain.where.mock.calls.find((c) => c[0] === 'created_at');
    expect([col, op]).toEqual(['created_at', '>']);
    // 15-minute window: a row Twilio never called back on ages out instead of locking the tech out.
    expect(before - since.getTime()).toBeGreaterThanOrEqual(15 * 60 * 1000 - 50);
    expect(before - since.getTime()).toBeLessThan(15 * 60 * 1000 + 5000);
  });

  test('no customer or source → null without a query', async () => {
    db.mockImplementation(() => { throw new Error('must not query'); });
    expect(await activeBridgeCall({ source: 'tech-click', customerId: null })).toBeNull();
    expect(await activeBridgeCall({ source: null, customerId: 'c1' })).toBeNull();
  });
});
