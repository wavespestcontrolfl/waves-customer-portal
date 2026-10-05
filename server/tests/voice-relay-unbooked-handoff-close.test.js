// The close-time hook: end() hands the session's facts to the unbooked
// hand-off only after the ai_handled reconcile UPDATE matched a row, and never
// for a sandbox session.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn(async () => ({ leadId: null })) }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
jest.mock('../services/twilio-failure-alerts', () => ({ maskSid: (s) => String(s || '').slice(-4) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true), gateEnvValue: jest.fn(() => undefined) }));
jest.mock('../services/call-commitments', () => ({ recordRelayCommitments: jest.fn(async () => ({ found: true, written: 0 })) }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: true })) }));
const db = require('../models/db');
const handoff = require('../services/voice-agent/relay-unbooked-handoff');
const { RelayConversation } = require('../services/voice-agent/relay-conversation');

function primeDb(updated) {
  const guardQ = { where: jest.fn().mockReturnThis(), whereNull: jest.fn().mockReturnThis(), orWhereNotIn: jest.fn().mockReturnThis(), orWhereIn: jest.fn().mockReturnThis(), orWhere: jest.fn().mockReturnThis(), whereRaw: jest.fn().mockReturnThis() };
  const builder = {
    update: jest.fn(async () => updated),
    where: jest.fn((arg) => { if (typeof arg === 'function') arg(guardQ); return builder; }),
    whereIn: jest.fn(() => builder), whereRaw: jest.fn(() => builder), whereNull: jest.fn(() => builder),
    first: jest.fn(async () => null), select: jest.fn(() => builder),
  };
  db.transaction = jest.fn(async (fn) => fn(db));
  db.mockReturnValue(builder);
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
}

function convo(over = {}) {
  // from '' keeps the capture floor out of the way: this test is about the hook.
  const c = new RelayConversation({ callSid: 'CA-hook-1', sessionKey: 'nonce-1', from: '', send: jest.fn(), ...over });
  c._sessionSuperseded = jest.fn(async () => false);
  c._recordCommitments = jest.fn(async () => {});
  c._recordTurn('caller', 'I need a quote for quarterly service');
  c._recordTurn('agent', 'Happy to help with that.');
  c._userTurns.push('I need a quote for quarterly service');
  return c;
}

let run;
beforeEach(() => { jest.clearAllMocks(); run = jest.spyOn(handoff, 'runUnbookedHandoff').mockResolvedValue({ claimed: false }); });
afterEach(() => run.mockRestore());

test('a matched ai_handled reconcile passes the session facts to the hand-off', async () => {
  primeDb(1);
  const c = convo();
  await c.end('ws_close');
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0][0]).toMatchObject({
    callSid: 'CA-hook-1', sandbox: false, callerTurnCount: 1, pendingWrites: false,
    bookingRequested: false, reserviceFiled: false, transferRequested: false, leadCaptured: false, leadId: null,
  });
  expect(typeof run.mock.calls[0][0].fence).toBe('function');
});

test('a booking latched on the session is passed on as booked', async () => {
  primeDb(1);
  const c = convo();
  c._bookingRequested = true;
  await c.end('ws_close');
  expect(run.mock.calls[0][0].bookingRequested).toBe(true);
});

test('a write that outlives the close drain is passed on as pending (the hand-off stands down)', async () => {
  primeDb(1);
  const c = convo();
  c._captureFloorWrite = new Promise(() => {}); // the capture floor still writing past its bound
  await c.end('ws_close');
  expect(run.mock.calls[0][0].pendingWrites).toBe(true);
});

test('0 rows reconciled (a failure outcome already won): the hand-off is not run', async () => {
  primeDb(0);
  await convo().end('ws_close');
  expect(run).not.toHaveBeenCalled();
});

test('a sandbox session never reaches the hand-off', async () => {
  primeDb(1);
  await convo({ sandbox: true }).end('ws_close');
  expect(run).not.toHaveBeenCalled();
});
