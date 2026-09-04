/**
 * /relay-sandbox — the ONLY test path for Sandy. Fail closed on the number,
 * a call_log row with source='voice_relay_sandbox' on every call, a DTMF cell
 * code that selects a relay profile, and every call reader excluding the
 * source (calls tab, unified inbox).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(), isFailureStatus: jest.fn(() => false), maskSid: (s) => String(s || '').slice(-4) }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(), syncVoiceMessageForCall: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/voice-agent/relay-server', () => ({ isRelayAttached: jest.fn(() => true) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));

const db = require('../models/db');
const logger = require('../services/logger');
const { isRelayAttached } = require('../services/voice-agent/relay-server');
const voiceRouter = require('../routes/twilio-voice-webhook');
const { isSandboxCall, sandboxRelayXml, RELAY_COMPLETE_ACTION_SANDBOX, RELAY_SANDBOX_CELL_ACTION } = voiceRouter._test;
const { VOICE_RELAY_SANDBOX_SOURCE } = require('../services/voice-agent/relay-protocol');

const SANDBOX = '+19412691697';

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
  return res;
}

function primeInsert() {
  const ignore = jest.fn().mockResolvedValue([]);
  const onConflict = jest.fn(() => ({ ignore }));
  const insert = jest.fn(() => ({ onConflict }));
  db.mockImplementation(() => ({ insert }));
  return { insert, onConflict, ignore };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.mockReset();
  isRelayAttached.mockImplementation(() => true);
  process.env.VOICE_RELAY_WS_SECRET = 'shh-secret-123';
  process.env.VOICE_RELAY_SANDBOX_NUMBER = SANDBOX;
  process.env.SERVER_DOMAIN = 'portal.example.com';
  delete process.env.VOICE_RELAY_PROFILE;
  delete process.env.VOICE_RELAY_SANDBOX_ATTRS;
});

describe('isSandboxCall — the number is the whole authority', () => {
  test('matches the configured number in any format; refuses everything else', () => {
    expect(isSandboxCall({ body: { To: SANDBOX } })).toBe(true);
    expect(isSandboxCall({ body: { To: '(941) 269-1697' } })).toBe(true);
    expect(isSandboxCall({ body: { To: '+19415550100' } })).toBe(false);
    expect(isSandboxCall({ body: {} })).toBe(false);
  });
  test('no configured number ⇒ nothing is the sandbox', () => {
    delete process.env.VOICE_RELAY_SANDBOX_NUMBER;
    expect(isSandboxCall({ body: { To: SANDBOX } })).toBe(false);
  });
});

describe('POST /relay-sandbox', () => {
  test('a production number ⇒ 403 hangup, no row', async () => {
    const { insert } = primeInsert();
    const res = mockRes();
    await handlerFor('/relay-sandbox')({ body: { CallSid: 'CA-sb-0', From: '+19415550100', To: '+19415550199' } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toContain('<Hangup/>');
    expect(insert).not.toHaveBeenCalled();
  });

  test('the sandbox number ⇒ a sourced call_log row, a 2-digit cell <Gather>, then the relay with the sandbox action', async () => {
    const { insert, onConflict } = primeInsert();
    const res = mockRes();
    await handlerFor('/relay-sandbox')({ body: { CallSid: 'CA-sb-1', From: '+19415550100', To: SANDBOX, CallStatus: 'ringing' } }, res);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      twilio_call_sid: 'CA-sb-1', direction: 'inbound', from_phone: '+19415550100', to_phone: SANDBOX,
      status: 'ringing', source: VOICE_RELAY_SANDBOX_SOURCE,
    }));
    expect(JSON.parse(insert.mock.calls[0][0].metadata)).toEqual({ relay_sandbox: true });
    expect(onConflict).toHaveBeenCalledWith('twilio_call_sid'); // a Twilio retry re-renders, never re-inserts
    const xml = res.body;
    // The recording disclosure MP3 plays BEFORE the cell <Gather> and the
    // relay — a sandbox caller is transcribed like any other (codex r3 P1).
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?><Response><Play>https:\/\/[^<]+\.mp3<\/Play><Gather /);
    expect(xml).toMatch(/<Gather [^>]*numDigits="2"/);
    expect(xml).toMatch(/<Gather [^>]*timeout="3"/);
    expect(xml).toContain(`action="${RELAY_SANDBOX_CELL_ACTION}"`);
    expect(xml.indexOf('<Gather')).toBeLessThan(xml.indexOf('<Connect'));
    expect(xml).toContain(`<Connect action="${RELAY_COMPLETE_ACTION_SANDBOX.replace('?', '?')}"`);
    expect(xml).toContain('wss://portal.example.com/ws/voice-agent');
    expect(xml).toContain('callSid=CA-sb-1');
    expect(xml).not.toContain('shh-secret-123');
    // No production profile ⇒ the relay element is the plain self-closing one.
    expect(xml).toMatch(/<ConversationRelay [^>]*\/><\/Connect>/);
    expect(xml).not.toContain('<Parameter');
  });

  test('the production profile applies to a human sandbox caller (what a customer would hear)', async () => {
    primeInsert();
    process.env.VOICE_RELAY_PROFILE = 'nova_hints_v1';
    const res = mockRes();
    await handlerFor('/relay-sandbox')({ body: { CallSid: 'CA-sb-2', From: '+19415550100', To: SANDBOX } }, res);
    expect(res.body).toContain('speechModel="nova-3-general"');
    expect(res.body).toContain('<Parameter name="relay_profile" value="nova_hints_v1" />');
  });

  test('relay not attached ⇒ spoken notice + hangup, no row', async () => {
    const { insert } = primeInsert();
    isRelayAttached.mockImplementation(() => false);
    const res = mockRes();
    await handlerFor('/relay-sandbox')({ body: { CallSid: 'CA-sb-3', From: '+19415550100', To: SANDBOX } }, res);
    expect(res.body).toContain('not attached');
    expect(res.body).toContain('<Hangup/>');
    expect(insert).not.toHaveBeenCalled();
  });

  test('a DB failure still answers with valid TwiML (hangup), never a 500 into the call', async () => {
    db.mockImplementation(() => { throw new Error('pool down'); });
    const res = mockRes();
    await handlerFor('/relay-sandbox')({ body: { CallSid: 'CA-sb-4', From: '+19415550100', To: SANDBOX } }, res);
    expect(res.body).toContain('<Hangup/>');
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('POST /relay-sandbox/cell', () => {
  test('a known code selects that profile (sandbox-only ones included)', async () => {
    const res = mockRes();
    await handlerFor('/relay-sandbox/cell')({ body: { CallSid: 'CA-sb-5', To: SANDBOX, Digits: '09' } }, res);
    expect(res.body).toContain('speechModel="flux"');
    expect(res.body).toContain('partialPrompts="true"');
    expect(res.body).toContain('<Parameter name="relay_profile" value="flux_partials_probe_v1" />');
    expect(res.body).toContain(`action="${RELAY_COMPLETE_ACTION_SANDBOX}"`);
  });

  test('99 renders the raw sandbox attrs; an unknown code falls back to the production profile', async () => {
    process.env.VOICE_RELAY_SANDBOX_ATTRS = JSON.stringify({ speechModel: 'nova-2-general', deepgramSmartFormat: false });
    let res = mockRes();
    await handlerFor('/relay-sandbox/cell')({ body: { CallSid: 'CA-sb-6', To: SANDBOX, Digits: '99' } }, res);
    expect(res.body).toContain('speechModel="nova-2-general"');
    expect(res.body).toContain('deepgramSmartFormat="false"');
    expect(res.body).toContain('value="sandbox_raw"');
    res = mockRes();
    await handlerFor('/relay-sandbox/cell')({ body: { CallSid: 'CA-sb-7', To: SANDBOX, Digits: '77' } }, res);
    expect(res.body).not.toContain('speechModel=');
    expect(res.body).toMatch(/<ConversationRelay [^>]*\/><\/Connect>/);
  });

  test('a production number ⇒ 403', async () => {
    const res = mockRes();
    await handlerFor('/relay-sandbox/cell')({ body: { CallSid: 'CA-sb-8', To: '+19415550199', Digits: '03' } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('sandboxRelayXml', () => {
  test('is the same builder every production leg uses, pointed at the sandbox action', () => {
    const xml = sandboxRelayXml({ callSid: 'CA-sb-9', cell: { relayAttrs: { speechModel: 'flux' }, relayProfileId: 'flux_balanced_v1' } });
    expect(xml).toContain('<Connect action="/api/webhooks/twilio/relay-complete?sandbox=1" method="POST">');
    expect(xml).toContain('speechModel="flux"');
    expect(xml).toContain('welcomeGreeting=');
  });
});

describe('POST /relay-complete?sandbox=1', () => {
  test('a failed sandbox session hangs up and stamps the row — never records voicemail', async () => {
    const update = jest.fn().mockResolvedValue(1);
    const builder = { update, where: jest.fn(() => builder) };
    db.mockImplementation(() => builder);
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: { CallSid: 'CA-sb-10', ErrorCode: '64105' }, query: { sandbox: '1' } }, res);
    expect(res.body).toContain('<Hangup/>');
    expect(res.body).not.toContain('<Record');
    // relay_failed is a TERMINAL outcome the session's end() reconcile
    // excludes — a late socket close cannot rewrite it as ai_handled.
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', call_outcome: 'relay_failed' }));
    const metaRaw = update.mock.calls[0][0].metadata;
    expect(metaRaw.sql).toContain("COALESCE(metadata, '{}'::jsonb) ||");
    expect(JSON.parse(metaRaw.bindings[0])).toEqual({ relay_sandbox_failed: '64105' });
    const { syncVoiceMessageForCall } = require('../services/conversations');
    expect(syncVoiceMessageForCall).not.toHaveBeenCalled();
  });

  test('a clean sandbox end is the same bare <Response/> as production', async () => {
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: { CallSid: 'CA-sb-11', SessionStatus: 'completed' }, query: { sandbox: '1' } }, res);
    expect(res.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  });

  test('without the signed sandbox flag a failure still falls to voicemail (production unchanged)', async () => {
    const update = jest.fn().mockResolvedValue(1);
    const builder = { update, where: jest.fn(() => builder) };
    db.mockImplementation(() => builder);
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: { CallSid: 'CA-prod-1', ErrorCode: '64105' }, query: {} }, res);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ call_outcome: 'voicemail' }));
    expect(res.body).toContain('<Record');
  });
});

// The unified-inbox exclusion (conversations.syncVoiceMessageForCall) is
// covered in voice-relay-sandbox-sync.test.js — it needs the real
// conversations module with only the db mocked.
