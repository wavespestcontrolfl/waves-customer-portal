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
const { placeBridgeCall } = require('../services/call-bridge');

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

test('missing Twilio credentials fail before any row is written', async () => {
  jest.resetModules();
  jest.doMock('../config', () => ({ twilio: {} }));
  const { placeBridgeCall: fresh } = require('../services/call-bridge');
  const { inserted } = primeDb();
  await expect(fresh({ to: '+19415550100', bridgePhone: '+19415550101', from: '+19412975749', source: 'admin-click' }))
    .rejects.toMatchObject({ code: 'TWILIO_NOT_CONFIGURED' });
  expect(inserted).toHaveLength(0);
});
