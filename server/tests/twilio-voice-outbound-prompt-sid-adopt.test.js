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

describe('/call-status adopts the sid onto the row named on the callback URL (terminal-without-answer path)', () => {
  const statusHandler = voiceRouter.stack.find((l) => l.route && l.route.path === '/call-status').route.stack[0].handle;
  function primeStatusDb({ adopted = 1 } = {}) {
    const calls = [];
    const chain = {};
    chain.where = jest.fn((...a) => { calls.push(['where', ...a]); return chain; });
    chain.whereNull = jest.fn((...a) => { calls.push(['whereNull', ...a]); return chain; });
    let sidBound = false;
    chain.first = jest.fn(async () => (sidBound ? { id: LOG_ID, status: 'initiated', duration_seconds: 0 } : null));
    chain.update = jest.fn(async (u) => { calls.push(['update', u]); if (u.twilio_call_sid) { sidBound = adopted > 0; return adopted; } return 1; });
    chain.insert = jest.fn(async () => { throw new Error('must not insert'); });
    const trx = Object.assign(jest.fn(() => chain), { raw: jest.fn(async () => ({})) });
    db.transaction = jest.fn(async (fn) => fn(trx));
    db.mockImplementation(() => chain);
    return { chain, calls };
  }
  const res2 = () => ({ type: jest.fn(function t() { return this; }), send: jest.fn(), sendStatus: jest.fn(), status: jest.fn(function s() { return this; }), json: jest.fn(), end: jest.fn() });

  test('a busy parent leg binds its CallSid onto the sidless row, then records the terminal status on it', async () => {
    const { calls } = primeStatusDb();
    await statusHandler({ query: { callLogId: LOG_ID }, body: { CallSid: 'CA-parent', CallStatus: 'busy', CallDuration: '0', Direction: 'outbound-api', From: '+19413529161', To: '+19415550101' } }, res2());
    const adopt = calls.find((c) => c[0] === 'update' && c[1].twilio_call_sid);
    expect(adopt[1]).toMatchObject({ twilio_call_sid: 'CA-parent' });
    expect(calls.some((c) => c[0] === 'whereNull' && c[1] === 'twilio_call_sid')).toBe(true);
    const terminal = calls.find((c) => c[0] === 'update' && c[1].status);
    expect(terminal[1]).toMatchObject({ status: 'busy' });
  });

  test('a row already carrying a sid, or no row id, is left alone — the unmatched-outbound skip stays', async () => {
    const { calls } = primeStatusDb({ adopted: 0 });
    await statusHandler({ query: { callLogId: LOG_ID }, body: { CallSid: 'CA-other', CallStatus: 'no-answer', Direction: 'outbound-api' } }, res2());
    expect(calls.filter((c) => c[0] === 'update' && c[1].status)).toHaveLength(0);
    const { calls: calls2 } = primeStatusDb();
    await statusHandler({ query: {}, body: { CallSid: 'CA-none', CallStatus: 'no-answer', Direction: 'outbound-api' } }, res2());
    expect(calls2.filter((c) => c[0] === 'update')).toHaveLength(0);
  });
});
