/**
 * The "Waves Tech" voice line on the voice webhook (GATE_TECH_VOICE_LINE):
 * /tech-voice answers only an admitted call and rejects every other one before
 * Twilio answers; /voice refuses the line if its voice URL is ever wrong; and
 * /call-status keeps a tech-line call internal — its own source on a fallback
 * row, its minutes settled, no recording recovery, no failure bell.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio-failure-alerts', () => ({
  alertTwilioFailure: jest.fn(() => Promise.resolve()),
  isFailureStatus: jest.fn(() => false),
  maskSid: (s) => String(s || '').slice(0, 6),
}));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(() => Promise.resolve()), syncVoiceMessageForCall: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/voice-agent/relay-server', () => ({ isRelayAttached: jest.fn(() => true) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/call-recording-processor', () => ({ recoverRecordingForCall: jest.fn() }));
jest.mock('../services/tech-voice-line', () => ({ admitTechVoiceCall: jest.fn() }));
jest.mock('../services/tech-voice-usage', () => ({ settleTechVoiceCall: jest.fn(async () => true) }));
jest.mock('../services/messaging/inbound-dedupe', () => ({
  tryClaimInboundWebhook: jest.fn(async () => ({ processable: true, owned: true })),
  releaseInboundWebhook: jest.fn(async () => undefined),
}));
jest.mock('../middleware/spam-block', () => ({ checkInboundBlock: jest.fn(async () => ({ blocked: false })) }));

const LINE = '+19415550188';
process.env.TECH_VOICE_NUMBER = LINE;

const db = require('../models/db');
const voiceRouter = require('../routes/twilio-voice-webhook');
const { admitTechVoiceCall } = require('../services/tech-voice-line');
const { settleTechVoiceCall } = require('../services/tech-voice-usage');
const { alertTwilioFailure, isFailureStatus } = require('../services/twilio-failure-alerts');
const { recoverRecordingForCall } = require('../services/call-recording-processor');
const { TECH_VOICE_SOURCE } = require('../services/voice-agent/relay-protocol');

function handlerFor(path) {
  const layer = voiceRouter.stack.find((l) => l.route && l.route.path === path);
  if (!layer) throw new Error(`no route ${path}`);
  return layer.route.stack[0].handle;
}
function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.type = jest.fn(() => res);
  res.send = jest.fn((body) => { res.body = body; return res; });
  res.sendStatus = jest.fn((code) => { res.statusCode = code; return res; });
  return res;
}
const call = (body) => ({ CallSid: 'CA-tech-1', From: '+19415550101', To: LINE, CallStatus: 'ringing', ...body });

beforeEach(() => {
  jest.clearAllMocks();
  db.mockReset();
  isFailureStatus.mockReturnValue(false);
});

describe('/tech-voice', () => {
  test('a refused call is a bare <Reject>: nothing rings, records or speaks', async () => {
    admitTechVoiceCall.mockResolvedValueOnce({ ok: false, reason: 'unknown_caller' });
    const res = mockRes();
    await handlerFor('/tech-voice')({ body: call({ StirVerstat: 'TN-Validation-Passed-A' }) }, res);
    expect(res.body).toMatch(/<Response><Reject\/><\/Response>/);
    expect(admitTechVoiceCall).toHaveBeenCalledWith(db, {
      callSid: 'CA-tech-1', from: '+19415550101', to: LINE, callStatus: 'ringing', stirVerstat: 'TN-Validation-Passed-A',
    });
  });

  test('an admitted call hears the notice and hangs up — no dial, record, gather or relay', async () => {
    admitTechVoiceCall.mockResolvedValueOnce({ ok: true, technicianId: 'tech-1' });
    const res = mockRes();
    await handlerFor('/tech-voice')({ body: call() }, res);
    expect(res.body).toContain('<Say');
    expect(res.body).toContain('The Waves tech line is not ready yet. Goodbye.');
    expect(res.body).toContain('<Hangup/>');
    expect(res.body).not.toMatch(/<Dial|<Record|<Gather|<Connect|<Reject/);
  });

  test('an admission error rejects (fail closed)', async () => {
    admitTechVoiceCall.mockRejectedValueOnce(Object.assign(new Error('pg down'), { code: '57P01' }));
    const res = mockRes();
    await handlerFor('/tech-voice')({ body: call() }, res);
    expect(res.body).toMatch(/<Reject\/>/);
  });
});

describe('/voice', () => {
  test('the tech voice line reaching the customer route is rejected before any customer logic', async () => {
    const res = mockRes();
    await handlerFor('/voice')({ body: call(), query: {}, headers: {} }, res);
    expect(res.body).toMatch(/<Response><Reject\/><\/Response>/);
    expect(db).not.toHaveBeenCalledWith('customers');
  });
});

describe('/call-status', () => {
  function primeStatus({ existing }) {
    const insert = jest.fn().mockResolvedValue([1]);
    const update = jest.fn().mockResolvedValue(1);
    const first = jest.fn(async () => existing);
    const where = jest.fn(() => ({ first, update, whereNull: jest.fn(() => ({ update })) }));
    const trx = jest.fn(() => ({ insert, where }));
    trx.raw = jest.fn().mockResolvedValue(undefined);
    db.transaction = jest.fn(async (fn) => fn(trx));
    db.mockImplementation(() => ({ insert, where }));
    return { insert, update };
  }

  test('a tech-line call settles its minutes, never gets recording recovery or a failure bell', async () => {
    primeStatus({ existing: { id: 7, status: 'in-progress', source: TECH_VOICE_SOURCE, duration_seconds: 0, created_at: new Date() } });
    const res = mockRes();
    await handlerFor('/call-status')({ body: call({ CallStatus: 'completed', CallDuration: '70', Direction: 'inbound' }), query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(settleTechVoiceCall).toHaveBeenCalledWith(db, { callSid: 'CA-tech-1', callStatus: 'completed', durationSeconds: '70' });
    expect(recoverRecordingForCall).not.toHaveBeenCalled();
    isFailureStatus.mockReturnValue(true);
    await handlerFor('/call-status')({ body: call({ CallStatus: 'busy', CallDuration: '0', Direction: 'inbound' }), query: {} }, mockRes());
    expect(alertTwilioFailure).not.toHaveBeenCalled();
  });

  test('a refused tech-line call with no row gets an internal fallback row, never a customer row', async () => {
    const { insert } = primeStatus({ existing: undefined });
    await handlerFor('/call-status')({ body: call({ CallStatus: 'busy', CallDuration: '0', Direction: 'inbound' }), query: {} }, mockRes());
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0]).toMatchObject({ direction: 'inbound', source: TECH_VOICE_SOURCE, to_phone: LINE });
    expect(insert.mock.calls[0][0].customer_id).toBeUndefined();
    expect(JSON.parse(insert.mock.calls[0][0].metadata)).toMatchObject({ tech_voice: true, source: 'status_callback' });
  });
});
