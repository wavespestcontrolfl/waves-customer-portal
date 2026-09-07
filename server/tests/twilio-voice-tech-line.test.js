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
const { appendStaffRingDial, techLineUnacceptedLegSid } = voiceRouter._test;

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
  test('nobody accepted the tech leg → rings the office list; only the unaccepted-leg SID is stamped, no outcome', async () => {
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
    expect(update).toHaveBeenCalledTimes(1);
    const stamp = update.mock.calls[0][0];
    expect(Object.keys(stamp).sort()).toEqual(['metadata', 'updated_at']);
    expect(stamp.metadata.sql).toContain("'{tech_line_unaccepted_leg}'");
    expect(stamp.metadata.bindings).toEqual(['"CA-1-tech"']);
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
    // the stamp only — no status / answered_by / call_outcome
    expect(update).toHaveBeenCalledTimes(1);
    expect(Object.keys(update.mock.calls[0][0]).sort()).toEqual(['metadata', 'updated_at']);
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

describe('/recording-status — the unaccepted tech-leg clip is never the row\'s recording', () => {
  test('techLineUnacceptedLegSid reads the stamp from jsonb or a legacy string', () => {
    expect(techLineUnacceptedLegSid({ tech_line_unaccepted_leg: 'CA-x' })).toBe('CA-x');
    expect(techLineUnacceptedLegSid(JSON.stringify({ tech_line_unaccepted_leg: 'CA-y' }))).toBe('CA-y');
    expect(techLineUnacceptedLegSid({})).toBeNull();
    expect(techLineUnacceptedLegSid(null)).toBeNull();
    expect(techLineUnacceptedLegSid('{bad json')).toBeNull();
  });

  test('a recording delivered for the stamped leg is kept as evidence under superseded_recordings and not attached or scheduled', async () => {
    const update = jest.fn().mockResolvedValue(1);
    const row = { id: 'row-1', twilio_call_sid: 'CA-1', recording_sid: null, recording_url: null, processing_status: null, transcription_metadata: null, metadata: { tech_line_unaccepted_leg: 'CA-1-tech' } };
    const chain = { update, first: jest.fn().mockResolvedValue(row) };
    chain.where = jest.fn(() => chain);
    db.mockImplementation(() => chain);
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    const res = { sendStatus: jest.fn() };
    await handlerFor('/recording-status')({
      body: { CallSid: 'CA-1-tech', ParentCallSid: 'CA-1', RecordingSid: 'RE-tech', RecordingUrl: 'https://api.twilio.com/rec/RE-tech', RecordingDuration: '9', RecordingStatus: 'completed' },
    }, res);
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(update).toHaveBeenCalledTimes(1);
    const write = update.mock.calls[0][0];
    expect(Object.keys(write).sort()).toEqual(['metadata', 'updated_at']);
    expect(write.metadata.sql).toContain("'{superseded_recordings}'");
    expect(JSON.parse(write.metadata.bindings[0])[0]).toMatchObject({ recording_sid: 'RE-tech', recording_duration_seconds: 9, reason: 'tech_line_unaccepted_leg' });
    // never the row's recording
    expect(write).not.toHaveProperty('recording_sid');
  });

  test('a redelivery of that clip writes nothing', async () => {
    const update = jest.fn().mockResolvedValue(1);
    const row = { id: 'row-1', twilio_call_sid: 'CA-1', recording_sid: null, recording_url: null, processing_status: null, transcription_metadata: null,
      metadata: { tech_line_unaccepted_leg: 'CA-1-tech', superseded_recordings: [{ recording_sid: 'RE-tech', reason: 'tech_line_unaccepted_leg' }] } };
    const chain = { update, first: jest.fn().mockResolvedValue(row) };
    chain.where = jest.fn(() => chain);
    db.mockImplementation(() => chain);
    const res = { sendStatus: jest.fn() };
    await handlerFor('/recording-status')({
      body: { CallSid: 'CA-1-tech', ParentCallSid: 'CA-1', RecordingSid: 'RE-tech', RecordingUrl: 'https://api.twilio.com/rec/RE-tech', RecordingDuration: '9', RecordingStatus: 'completed' },
    }, res);
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(update).not.toHaveBeenCalled();
  });
});
