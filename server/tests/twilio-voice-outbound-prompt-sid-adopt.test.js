/**
 * /outbound-admin-prompt adopts the parent leg's CallSid onto the bridge's
 * call_log row when the row has none (an ambiguous calls.create — the local
 * request timed out after reaching Twilio — leaves it sidless; codex #4072
 * r17 P2). Without the sid no callback can ever find the row.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(), isFailureStatus: jest.fn(() => false) }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(), syncVoiceMessageForCall: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const voiceRouter = require('../routes/twilio-voice-webhook');

const LOG_ID = '11111111-1111-4111-8111-111111111111';
const handler = voiceRouter.stack.find((l) => l.route && l.route.path === '/outbound-admin-prompt').route.stack[0].handle;

function primeDb({ throwOnUpdate = false } = {}) {
  const chain = {};
  chain.where = jest.fn(() => chain);
  chain.whereNull = jest.fn(() => chain);
  chain.update = jest.fn(() => (throwOnUpdate ? Promise.reject(new Error('connection reset')) : Promise.resolve(1)));
  db.mockImplementation((table) => { expect(table).toBe('call_log'); return chain; });
  return chain;
}
function res() {
  const r = { sent: null };
  r.type = jest.fn(() => r);
  r.send = jest.fn((x) => { r.sent = x; return r; });
  return r;
}

beforeEach(() => jest.clearAllMocks());

test('binds the parent CallSid onto the sidless row, then prompts as before', async () => {
  const chain = primeDb();
  const r = res();
  await handler({ query: { callLogId: LOG_ID, customerNumber: '+19415550100', callerIdNumber: '+19413529161', leadName: 'Pat Sample' }, body: { CallSid: 'CA-parent' } }, r);
  expect(chain.where).toHaveBeenCalledWith({ id: LOG_ID });
  expect(chain.whereNull).toHaveBeenCalledWith('twilio_call_sid'); // iff still unset — a backfilled sid is never overwritten
  expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ twilio_call_sid: 'CA-parent' }));
  expect(r.sent).toContain('Press 1 to connect');
  expect(r.sent).toContain(`callLogId=${LOG_ID}`);
});

test('no row id, a malformed id, or no CallSid → no write; a failed write never blocks the TwiML', async () => {
  primeDb();
  await handler({ query: { customerNumber: '+19415550100' }, body: { CallSid: 'CA-parent' } }, res());
  await handler({ query: { callLogId: 'undefined', customerNumber: '+19415550100' }, body: { CallSid: 'CA-parent' } }, res());
  await handler({ query: { callLogId: LOG_ID, customerNumber: '+19415550100' }, body: {} }, res());
  expect(db).not.toHaveBeenCalled();
  primeDb({ throwOnUpdate: true });
  const r = res();
  await handler({ query: { callLogId: LOG_ID, customerNumber: '+19415550100' }, body: { CallSid: 'CA-parent' } }, r);
  expect(r.sent).toContain('Press 1 to connect');
});
