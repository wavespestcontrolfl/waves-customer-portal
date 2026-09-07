/**
 * Tech line ring policy (GATE_TECH_LINES, owner ruling: tech cell → office
 * list → voicemail). The /voice leg for the holder carries
 * ?stage=tech_line on its dial action; /call-complete continues an
 * unaccepted stage into the office list WITHOUT stamping an outcome, and an
 * accepted one is an ordinary answered call.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(() => Promise.resolve()), isFailureStatus: jest.fn(() => false), maskSid: (s) => String(s || '').slice(-4) }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(), syncVoiceMessageForCall: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/voice-agent/relay-server', () => ({ isRelayAttached: jest.fn(() => false) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), gateEnvValue: jest.fn(() => false) }));
jest.mock('../services/call-recording-processor', () => ({ recoverRecordingForCall: jest.fn() }));

const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;
const db = require('../models/db');
const voiceRouter = require('../routes/twilio-voice-webhook');
const { appendStaffRingDial } = voiceRouter._test;

function handlerFor(path) {
  const layer = voiceRouter.stack.find((l) => l.route && l.route.path === path);
  return layer.route.stack[0].handle;
}
function mockRes() {
  const res = { body: null };
  res.type = jest.fn(() => res);
  res.send = jest.fn((body) => { res.body = body; return res; });
  res.status = jest.fn(() => res);
  return res;
}
// call_log reads for wasForwardAccepted + the completion update.
function primeDb({ acceptance = null } = {}) {
  const update = jest.fn().mockResolvedValue(1);
  const first = jest.fn().mockResolvedValue(acceptance ? { metadata: { forward_acceptance: acceptance } } : { metadata: null });
  const chain = { first, update };
  chain.where = jest.fn(() => chain);
  chain.whereRaw = jest.fn(() => chain);
  chain.select = jest.fn(() => chain);
  db.mockImplementation(() => chain);
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return { update };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.WAVES_FALLBACK_FORWARD_NUMBERS = '+19415550001,+19415550002';
});

describe('appendStaffRingDial action URL', () => {
  test('office ring is byte-identical to today (no query string)', () => {
    const twiml = new VoiceResponse();
    appendStaffRingDial(twiml, ['+19415550001'], 30);
    expect(twiml.toString()).toContain('action="/api/webhooks/twilio/call-complete"');
    expect(twiml.toString()).not.toContain('stage=');
  });
  test('the tech-first leg carries stage=tech_line, and keeps lang=es when Spanish', () => {
    const twiml = new VoiceResponse();
    appendStaffRingDial(twiml, ['+19415550101'], 20, { stage: 'tech_line' });
    expect(twiml.toString()).toContain('action="/api/webhooks/twilio/call-complete?stage=tech_line"');
    expect(twiml.toString()).toContain('timeout="20"');
    const es = new VoiceResponse();
    appendStaffRingDial(es, ['+19415550101'], 20, { stage: 'tech_line', language: 'es-US' });
    expect(es.toString()).toContain('call-complete?stage=tech_line&amp;lang=es"');
  });
});

describe('/call-complete?stage=tech_line', () => {
  test('nobody accepted the tech leg → rings the office list, stamps nothing', async () => {
    const { update } = primeDb();
    const res = mockRes();
    await handlerFor('/call-complete')({
      body: { CallSid: 'CA-1', DialCallSid: 'CA-1-tech', DialCallStatus: 'no-answer', DialCallDuration: '0' },
      query: { stage: 'tech_line' },
    }, res);
    expect(res.body).toContain('<Dial');
    expect(res.body).toContain('<Number url="/api/webhooks/twilio/inbound-forward-screen" method="POST">+19415550001</Number>');
    expect(res.body).toContain('+19415550002');
    expect(res.body).toContain('action="/api/webhooks/twilio/call-complete"');
    expect(res.body).not.toContain('stage=');
    expect(res.body).not.toContain('<Record');
    expect(update).not.toHaveBeenCalled();
  });

  test('carrier voicemail answered the cell but nobody pressed 1 → still the office list', async () => {
    const { update } = primeDb();
    const res = mockRes();
    await handlerFor('/call-complete')({
      body: { CallSid: 'CA-2', DialCallSid: 'CA-2-tech', DialCallStatus: 'completed', DialCallDuration: '23' },
      query: { stage: 'tech_line', lang: 'es' },
    }, res);
    expect(res.body).toContain('<Dial');
    expect(res.body).toContain('action="/api/webhooks/twilio/call-complete?lang=es"');
    expect(update).not.toHaveBeenCalled();
  });

  test('the tech pressed 1 → an ordinary answered call (no second ring)', async () => {
    const { update } = primeDb({ acceptance: { accepted: true, parent_call_sid: 'CA-3', dial_call_sid: 'CA-3-tech' } });
    const res = mockRes();
    await handlerFor('/call-complete')({
      body: { CallSid: 'CA-3', DialCallSid: 'CA-3-tech', DialCallStatus: 'completed', DialCallDuration: '140' },
      query: { stage: 'tech_line' },
    }, res);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', answered_by: 'human' }));
    expect(update.mock.calls[0][0].duration_seconds).toMatchObject({ bindings: [140] });
    expect(res.body).not.toContain('<Dial');
  });

  test('no office list configured → falls through to voicemail exactly like an office line', async () => {
    process.env.WAVES_FALLBACK_FORWARD_NUMBERS = '';
    for (const k of ['OWNER_PHONE', 'ADAM_PHONE', 'VIRGINIA_PHONE', 'OFFICE_MANAGER_PHONE', 'WAVES_OFFICE_MANAGER_PHONE']) delete process.env[k];
    const { update } = primeDb();
    const res = mockRes();
    await handlerFor('/call-complete')({
      body: { CallSid: 'CA-4', DialCallSid: 'CA-4-tech', DialCallStatus: 'no-answer', DialCallDuration: '0' },
      query: { stage: 'tech_line' },
    }, res);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ answered_by: 'voicemail', call_outcome: 'voicemail' }));
    expect(res.body).toContain('<Record');
  });
});
