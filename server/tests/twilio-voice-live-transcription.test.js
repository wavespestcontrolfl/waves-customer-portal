/**
 * GATE_LIVE_CALL_TRANSCRIPTION at the press-1 accept and the transcription webhook.
 *
 * Pins: the accept TwiML is byte-identical gate on or off; the start runs only after a press 1,
 * only with the gate on, only after the TwiML is sent, and a failing start never breaks the
 * connect. /live-transcription hands Twilio's event to the service and always answers 200.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(() => Promise.resolve()), isFailureStatus: jest.fn(() => false), maskSid: (s) => String(s || '').slice(-4) }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(), syncVoiceMessageForCall: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/voice-agent/relay-server', () => ({ isRelayAttached: jest.fn(() => false) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), gateEnvValue: jest.fn(() => false) }));
jest.mock('../services/call-recording-processor', () => ({ recoverRecordingForCall: jest.fn() }));
jest.mock('../services/live-call-transcription', () => ({
  startLiveTranscription: jest.fn(() => Promise.resolve({ started: true })),
  recordLiveTranscriptionEvent: jest.fn(() => Promise.resolve({ stored: true })),
}));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const live = require('../services/live-call-transcription');
const voiceRouter = require('../routes/twilio-voice-webhook');

const PARENT = 'CA' + 'a'.repeat(32);

function handlerFor(path) {
  const layer = voiceRouter.stack.find((l) => l.route && l.route.path === path);
  return layer.route.stack[0].handle;
}
function mockRes() {
  const res = { body: null };
  res.type = jest.fn(() => res);
  res.send = jest.fn((body) => { res.body = body; return res; });
  res.status = jest.fn(() => res);
  res.sendStatus = jest.fn(() => res);
  return res;
}
function primeDb(metadata = { screen_caller_name: 'Pat Q' }) {
  const chain = {};
  chain.where = jest.fn(() => chain);
  chain.whereRaw = jest.fn(() => chain);
  chain.select = jest.fn(() => chain);
  chain.first = jest.fn().mockResolvedValue({ metadata, from_phone: '+19415550123', call_outcome: null });
  chain.update = jest.fn().mockResolvedValue(1);
  db.mockImplementation(() => chain);
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
}
function gate(on) {
  isEnabled.mockImplementation((name) => (name === 'liveCallTranscription' ? on : false));
}
async function accept(digits = '1') {
  const res = mockRes();
  await handlerFor('/inbound-forward-accept')({
    body: { Digits: digits, ParentCallSid: PARENT, CallSid: 'CA' + 'b'.repeat(32), To: '+19415550001' },
    query: {},
  }, res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.WAVES_FALLBACK_FORWARD_NUMBERS = '+19415550001,+19415550002';
  primeDb();
});

describe('/inbound-forward-accept with GATE_LIVE_CALL_TRANSCRIPTION', () => {
  test('gate off: no start; the TwiML is the same as with the gate on', async () => {
    gate(false);
    const off = await accept();
    expect(live.startLiveTranscription).not.toHaveBeenCalled();
    gate(true);
    const on = await accept();
    expect(on.body).toBe(off.body);
    expect(on.body).toContain('Connecting your call from Pat Q.');
  });

  test('gate on: one start on the caller\'s call, after the TwiML is sent', async () => {
    gate(true);
    const res = await accept();
    expect(live.startLiveTranscription).toHaveBeenCalledTimes(1);
    expect(live.startLiveTranscription).toHaveBeenCalledWith({ parentCallSid: PARENT, language: null });
    expect(res.send.mock.invocationCallOrder[0]).toBeLessThan(live.startLiveTranscription.mock.invocationCallOrder[0]);
  });

  test('a Spanish caller starts in Spanish', async () => {
    gate(true);
    primeDb({ caller_language: 'es' });
    await accept();
    expect(live.startLiveTranscription).toHaveBeenCalledWith({ parentCallSid: PARENT, language: 'es' });
  });

  test('no press 1 (carrier voicemail, a wrong key): no start', async () => {
    gate(true);
    const res = await accept('');
    expect(res.body).toContain('Goodbye.');
    expect(live.startLiveTranscription).not.toHaveBeenCalled();
  });

  test('a failing start never breaks the connect', async () => {
    gate(true);
    live.startLiveTranscription.mockRejectedValueOnce(new Error('twilio down'));
    const res = await accept();
    await new Promise((resolve) => setImmediate(resolve));
    expect(res.send).toHaveBeenCalledTimes(1);
    expect(res.body).toContain('Connecting your call from Pat Q.');
  });
});

describe('/live-transcription', () => {
  test('hands the event to the service and answers 200', async () => {
    const res = mockRes();
    const body = { CallSid: PARENT, TranscriptionEvent: 'transcription-content' };
    await handlerFor('/live-transcription')({ body }, res);
    expect(live.recordLiveTranscriptionEvent).toHaveBeenCalledWith(body);
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  test('a failed write still answers 200 and logs the error code, never the message (knex puts the text in it)', async () => {
    const logger = require('../services/logger');
    live.recordLiveTranscriptionEvent.mockRejectedValueOnce(Object.assign(
      new Error("insert into call_live_utterances ... values ('my address is 12 Example St')"), { code: '23514' },
    ));
    const res = mockRes();
    await handlerFor('/live-transcription')({ body: { CallSid: PARENT } }, res);
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    const logged = logger.warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('23514');
    expect(logged).not.toMatch(/Example St|insert into/);
  });
});
