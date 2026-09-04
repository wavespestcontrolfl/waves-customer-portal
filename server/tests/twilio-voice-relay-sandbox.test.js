/**
 * /relay-sandbox — the ONLY test path for Sandy. Fail closed on the number,
 * a call_log row with source='voice_relay_sandbox' on every call, a DTMF cell
 * code that selects a relay profile, and every call reader excluding the
 * source (calls tab, unified inbox).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(() => Promise.resolve()), isFailureStatus: jest.fn(() => false), maskSid: (s) => String(s || '').slice(-4) }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(), syncVoiceMessageForCall: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/voice-agent/relay-server', () => ({ isRelayAttached: jest.fn(() => true) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/call-recording-processor', () => ({ recoverRecordingForCall: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const { isRelayAttached } = require('../services/voice-agent/relay-server');
const voiceRouter = require('../routes/twilio-voice-webhook');
const { isSandboxCall, sandboxRelayXml, stampRelayProfile, RELAY_COMPLETE_ACTION_SANDBOX, RELAY_SANDBOX_CELL_ACTION } = voiceRouter._test;
const { recordTouchpoint } = require('../services/conversations');
const { recoverRecordingForCall } = require('../services/call-recording-processor');
const { VOICE_RELAY_SANDBOX_SOURCE } = require('../services/voice-agent/relay-protocol');

// An UNREGISTERED number: a registered Waves line is refused as the sandbox target.
const SANDBOX = '+19415550199';
const TWILIO_NUMBERS = require('../config/twilio-numbers');

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

// The answer handler takes the per-CallSid advisory lock, reads the row
// (`existing` — none by default), inserts or adopts, then re-reads the row's
// source (ownership proof) — `source` is what that re-read answers.
function primeInsert({ existing, source = VOICE_RELAY_SANDBOX_SOURCE } = {}) {
  const insert = jest.fn().mockResolvedValue([1]);
  const update = jest.fn().mockResolvedValue(1);
  const first = jest.fn()
    .mockImplementationOnce(async () => existing)
    .mockImplementation(async () => (source == null ? undefined : { source }));
  const where = jest.fn(() => ({ first, update }));
  db.mockImplementation(() => ({ insert, where }));
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  const trx = jest.fn(() => ({ insert, where }));
  trx.raw = jest.fn().mockResolvedValue(undefined);
  db.transaction = jest.fn(async (fn) => fn(trx));
  return { insert, update, first, where, trx };
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

describe('sandboxNumber — a registered live line is never the sandbox (hook P1)', () => {
  afterEach(() => { TWILIO_NUMBERS.unassigned.length = 0; TWILIO_NUMBERS._ownedLast10 = null; });

  test('the Google Ads — Pest tracking line (and every registered line) is refused', async () => {
    const ga = TWILIO_NUMBERS.paidTracking.googleAdsPest.number;
    process.env.VOICE_RELAY_SANDBOX_NUMBER = ga;
    expect(isSandboxCall({ body: { To: ga } })).toBe(false);
    const res = mockRes();
    await handlerFor('/relay-sandbox')({ body: { CallSid: 'CA-live', From: '+19415550100', To: ga } }, res);
    expect(res.statusCode).toBe(403);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/REGISTERED Waves line/));
  });

  test('a line parked under unassigned is sandbox-eligible', () => {
    const parked = '+19415550177';
    TWILIO_NUMBERS.unassigned.push({ number: parked, formatted: '(941) 555-0177' });
    TWILIO_NUMBERS._ownedLast10 = null; // the owned set is cached once
    process.env.VOICE_RELAY_SANDBOX_NUMBER = parked;
    expect(isSandboxCall({ body: { To: parked } })).toBe(true);
  });
});

describe('isSandboxCall — the number is the whole authority', () => {
  test('matches the configured number in any format; refuses everything else', () => {
    expect(isSandboxCall({ body: { To: SANDBOX } })).toBe(true);
    expect(isSandboxCall({ body: { To: '(941) 555-0199' } })).toBe(true);
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
    await handlerFor('/relay-sandbox')({ body: { CallSid: 'CA-sb-0', From: '+19415550100', To: '+19415550188' } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toContain('<Hangup/>');
    expect(insert).not.toHaveBeenCalled();
  });

  test('the sandbox number ⇒ a sourced call_log row, a 2-digit cell <Gather>, then the relay with the sandbox action', async () => {
    const { insert, trx } = primeInsert();
    const res = mockRes();
    await handlerFor('/relay-sandbox')({ body: { CallSid: 'CA-sb-1', From: '+19415550100', To: SANDBOX, CallStatus: 'ringing' } }, res);
    expect(trx.raw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext(?))', ['CA-sb-1']); // serialized with /call-status
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      twilio_call_sid: 'CA-sb-1', direction: 'inbound', from_phone: '+19415550100', to_phone: SANDBOX,
      status: 'ringing', source: VOICE_RELAY_SANDBOX_SOURCE,
    }));
    expect(JSON.parse(insert.mock.calls[0][0].metadata)).toEqual({ relay_sandbox: true, stir_verstat: null });
    const xml = res.body;
    // The recording disclosure MP3 plays INSIDE the cell <Gather>, before the
    // relay — a sandbox caller is transcribed like any other (codex r3 P1),
    // and a runner's digits sent at answer are collected, not dropped
    // (codex r6 P1).
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?><Response><Gather [^>]*><Play>https:\/\/[^<]+\.mp3<\/Play><\/Gather>/);
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

  // ⭐ THE SOCKET OPENS ON THIS DEPLOY (codex r14 P1): SERVER_DOMAIN, else the
  // Railway public domain, else the signed request's Host — production only as
  // the last resort, never for a preview whose DB has no sandbox row.
  test('the sandbox relay socket points at the current deploy, not production, when SERVER_DOMAIN is unset', async () => {
    const saved = process.env.SERVER_DOMAIN;
    delete process.env.SERVER_DOMAIN;
    try {
      process.env.RAILWAY_PUBLIC_DOMAIN = 'pr-42.up.railway.app';
      primeInsert();
      let res = mockRes();
      await handlerFor('/relay-sandbox')({ body: { CallSid: 'CA-sb-host1', From: '+19415550100', To: SANDBOX }, headers: { host: 'ignored.example.com' } }, res);
      expect(res.body).toContain('wss://pr-42.up.railway.app/ws/voice-agent');
      delete process.env.RAILWAY_PUBLIC_DOMAIN;
      primeInsert();
      res = mockRes();
      await handlerFor('/relay-sandbox')({ body: { CallSid: 'CA-sb-host2', From: '+19415550100', To: SANDBOX }, headers: { host: 'preview.example.com:8443' } }, res);
      expect(res.body).toContain('wss://preview.example.com/ws/voice-agent');
      expect(res.body).not.toContain('portal.wavespestcontrol.com');
    } finally {
      process.env.SERVER_DOMAIN = saved;
      delete process.env.RAILWAY_PUBLIC_DOMAIN;
    }
  });

  test('the production profile applies to a human sandbox caller (what a customer would hear)', async () => {
    primeInsert();
    process.env.VOICE_RELAY_PROFILE = 'nova_hints_v1';
    const res = mockRes();
    await handlerFor('/relay-sandbox')({ body: { CallSid: 'CA-sb-2', From: '+19415550100', To: SANDBOX } }, res);
    expect(res.body).toContain('speechModel="nova-3-general"');
    expect(res.body).toContain('<Parameter name="relay_profile" value="nova_hints_v1" />');
    // The answer document's relay (no digits) opens with the production
    // profile — stamped on the row before it opens (codex r8 P2).
    const stamp = db.mock.results.map((r) => r.value).find((v) => v && v.where && v.where.mock.calls.length);
    expect(JSON.parse(stamp.where().update.mock.calls[0][0].metadata.bindings[0]).relay_profile_id).toBe('nova_hints_v1');
  });

  test('a CallSid whose row is NOT sandbox-sourced is refused — never a production session through the sandbox door (hook P0)', async () => {
    const { insert, update } = primeInsert({ existing: { id: 7, source: 'twilio_voice' }, source: 'twilio_voice' });
    const res = mockRes();
    await handlerFor('/relay-sandbox')({ body: { CallSid: 'CA-foreign', From: '+19415550100', To: SANDBOX } }, res);
    expect(insert).not.toHaveBeenCalled(); // a foreign-sourced row is neither re-inserted nor adopted
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('<ConversationRelay');
    expect(update).not.toHaveBeenCalled();
  });

  // ⭐ /call-status CAN WIN THE RACE and write its generic fallback row first
  // (source column NULL). The signed sandbox request adopts it — sandbox
  // source, customer link cleared — instead of refusing the call (codex r10 P1).
  test('a NULL-source row written first by /call-status is adopted as the sandbox row, and the call proceeds', async () => {
    const { insert, update, where } = primeInsert({ existing: { id: 7, source: null } });
    const res = mockRes();
    await handlerFor('/relay-sandbox')({ body: { CallSid: 'CA-sb-race', From: '+19415550100', To: SANDBOX } }, res);
    expect(insert).not.toHaveBeenCalled();
    expect(where).toHaveBeenCalledWith({ id: 7 });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ source: VOICE_RELAY_SANDBOX_SOURCE, customer_id: null }));
    expect(JSON.parse(update.mock.calls[0][0].metadata.bindings[0])).toEqual({ relay_sandbox: true, stir_verstat: null });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<ConversationRelay');
  });

  // The sandbox row carries the caller's STIR attestation where /voice puts it
  // (metadata.stir_verstat — verifyInboundCaller's only source), so an
  // A-attested known caller's bake-off is as verified as production (codex r13 P2).
  test('the sandbox row keeps StirVerstat on both the insert and the adoption path', async () => {
    const { insert } = primeInsert();
    await handlerFor('/relay-sandbox')({ body: { CallSid: 'CA-sb-att', From: '+19415550100', To: SANDBOX, StirVerstat: 'TN-Validation-Passed-A' } }, mockRes());
    expect(JSON.parse(insert.mock.calls[0][0].metadata)).toEqual({ relay_sandbox: true, stir_verstat: 'TN-Validation-Passed-A' });
    const adopted = primeInsert({ existing: { id: 9, source: null } });
    await handlerFor('/relay-sandbox')({ body: { CallSid: 'CA-sb-att2', From: '+19415550100', To: SANDBOX, StirVerstat: 'TN-Validation-Passed-A' } }, mockRes());
    expect(JSON.parse(adopted.update.mock.calls[0][0].metadata.bindings[0])).toEqual({ relay_sandbox: true, stir_verstat: 'TN-Validation-Passed-A' });
    // …and into a sandbox-sourced row /call-status wrote first (no StirVerstat on a status callback) — codex r14 P2.
    const owned = primeInsert({ existing: { id: 10, source: VOICE_RELAY_SANDBOX_SOURCE } });
    const res = mockRes();
    await handlerFor('/relay-sandbox')({ body: { CallSid: 'CA-sb-att3', From: '+19415550100', To: SANDBOX, StirVerstat: 'TN-Validation-Passed-A' } }, res);
    expect(owned.insert).not.toHaveBeenCalled();
    expect(JSON.parse(owned.update.mock.calls[0][0].metadata.bindings[0])).toEqual({ relay_sandbox: true, stir_verstat: 'TN-Validation-Passed-A' });
    expect(res.body).toContain('<ConversationRelay');
  });

  test('a failed sandbox /call-status raises no Twilio failure alert (codex r14 P2)', async () => {
    const { alertTwilioFailure, isFailureStatus } = require('../services/twilio-failure-alerts');
    isFailureStatus.mockReturnValueOnce(true);
    primeInsert({ existing: undefined, source: null });
    await handlerFor('/call-status')({ body: { CallSid: 'CA-sb-fail', From: '+19415550100', To: SANDBOX, CallStatus: 'failed', Direction: 'inbound' } }, mockRes());
    expect(alertTwilioFailure).not.toHaveBeenCalled();
  });

  test('relay not attached ⇒ the row still lands, stamped relay_failed, then a spoken notice + hangup', async () => {
    const { insert, update, where } = primeInsert();
    isRelayAttached.mockImplementation(() => false);
    const res = mockRes();
    await handlerFor('/relay-sandbox')({ body: { CallSid: 'CA-sb-3', From: '+19415550100', To: SANDBOX } }, res);
    expect(res.body).toContain('not attached');
    expect(res.body).toContain('<Hangup/>');
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ twilio_call_sid: 'CA-sb-3', source: VOICE_RELAY_SANDBOX_SOURCE }));
    expect(where).toHaveBeenCalledWith({ twilio_call_sid: 'CA-sb-3' });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', call_outcome: 'relay_failed' }));
    expect(JSON.parse(update.mock.calls[0][0].metadata.bindings[0])).toEqual({ relay_sandbox_failed: 'relay_not_attached' });
  });

  // ⭐ /call-status FOR THE SANDBOX NUMBER (codex r10 P1 + r12 P2): when the
  // status callback beats /relay-sandbox it writes the sandbox-sourced row
  // itself — no customer lookup, no touchpoint — and a completed sandbox call
  // never schedules the CallSid-keyed recording recovery.
  test('a completed /call-status for the sandbox number writes the sandbox row, records no touchpoint and schedules no recording recovery', async () => {
    jest.useFakeTimers();
    try {
      const { insert } = primeInsert({ existing: undefined, source: null });
      const res = mockRes();
      await handlerFor('/call-status')({ body: { CallSid: 'CA-sb-status', From: '+19415550100', To: SANDBOX, CallStatus: 'completed', CallDuration: '42', Direction: 'inbound' } }, res);
      const { alertTwilioFailure } = require('../services/twilio-failure-alerts');
      expect(alertTwilioFailure.mock.calls.map((c) => c[0].errorMessage)).toEqual([]); // the handler must not have thrown
      expect(insert).toHaveBeenCalledWith(expect.objectContaining({ twilio_call_sid: 'CA-sb-status', source: VOICE_RELAY_SANDBOX_SOURCE, status: 'completed' }));
      expect(insert.mock.calls[0][0].customer_id).toBeUndefined();
      expect(JSON.parse(insert.mock.calls[0][0].metadata)).toEqual({ relay_sandbox: true, source: 'status_callback' });
      expect(recordTouchpoint).not.toHaveBeenCalled();
      jest.runAllTimers();
      await Promise.resolve();
      expect(recoverRecordingForCall).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  // The production relay legs (/voice answers-first, /call-complete backstop)
  // stamp the chosen profile on the row BEFORE the relay opens, so a setup
  // Twilio rejects stays attributable (codex r12 P2). Fail-soft, no-op without
  // a profile.
  test('stampRelayProfile merges the profile onto the CallSid row, and is a no-op without one', async () => {
    const { update, where } = primeInsert();
    await stampRelayProfile('CA-prod-1', { relayProfileId: 'flux_balanced_v1', relayAttrs: { speechModel: 'flux' } });
    expect(where).toHaveBeenCalledWith({ twilio_call_sid: 'CA-prod-1' });
    expect(JSON.parse(update.mock.calls[0][0].metadata.bindings[0])).toEqual({ relay_profile_id: 'flux_balanced_v1', relay_attrs: { speechModel: 'flux' } });
    update.mockClear();
    await stampRelayProfile('CA-prod-2', {});
    expect(update).not.toHaveBeenCalled();
    // The Spanish leg clears a pre-stamped English profile when its own options resolve empty (codex r14 P2).
    await stampRelayProfile('CA-prod-2', {}, { clearWhenEmpty: true });
    expect(JSON.parse(update.mock.calls[0][0].metadata.bindings[0])).toEqual({ relay_profile_id: null, relay_attrs: null });
    db.mockImplementation(() => { throw new Error('pool down'); });
    await expect(stampRelayProfile('CA-prod-3', { relayProfileId: 'nova_hints_v1' })).resolves.toBeUndefined(); // fail-soft
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
  function primeStamp({ source = VOICE_RELAY_SANDBOX_SOURCE } = {}) {
    const update = jest.fn().mockResolvedValue(1);
    const first = jest.fn(async () => (source == null ? undefined : { source }));
    const where = jest.fn(() => ({ update, first }));
    db.mockImplementation(() => ({ where }));
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    return { update, where, first };
  }
  beforeEach(() => primeStamp());

  test('a row that is not sandbox-sourced (or missing) renders no relay (hook P0)', async () => {
    for (const source of ['twilio_voice', null]) {
      primeStamp({ source });
      const res = mockRes();
      await handlerFor('/relay-sandbox/cell')({ body: { CallSid: 'CA-foreign', To: SANDBOX, Digits: '09' } }, res);
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('<ConversationRelay');
    }
  });

  test('a known code selects that profile (sandbox-only ones included), stamps it on the row, and replays the disclosure first', async () => {
    const { update, where } = primeStamp();
    const res = mockRes();
    await handlerFor('/relay-sandbox/cell')({ body: { CallSid: 'CA-sb-5', To: SANDBOX, Digits: '09' } }, res);
    expect(res.body).toContain('speechModel="flux"');
    expect(res.body).toContain('partialPrompts="true"');
    expect(res.body).toContain('<Parameter name="relay_profile" value="flux_partials_probe_v1" />');
    expect(res.body).toContain(`action="${RELAY_COMPLETE_ACTION_SANDBOX}"`);
    // A digit interrupted the disclosure nested in the answer <Gather>; the
    // continuation replays it in full BEFORE the relay (codex r7 P1).
    expect(res.body).toMatch(/<Response><Play>https:\/\/[^<]+\.mp3<\/Play><Connect[ >]/);
    // The selected cell lands on the row before the relay opens, so a profile
    // Twilio rejects at setup is still attributable (codex r7 P2).
    expect(where).toHaveBeenCalledWith({ twilio_call_sid: 'CA-sb-5' });
    const patch = update.mock.calls[0][0];
    expect(patch.metadata.sql).toContain("COALESCE(metadata, '{}'::jsonb) || ?::jsonb");
    expect(JSON.parse(patch.metadata.bindings[0])).toEqual({
      relay_profile_id: 'flux_partials_probe_v1',
      relay_attrs: expect.objectContaining({ speechModel: 'flux', partialPrompts: 'true' }),
    });
  });

  test('a stamp failure never costs the caller the call', async () => {
    const { update } = primeStamp();
    update.mockRejectedValue(new Error('pool down'));
    const res = mockRes();
    await handlerFor('/relay-sandbox/cell')({ body: { CallSid: 'CA-sb-5b', To: SANDBOX, Digits: '09' } }, res);
    expect(res.body).toContain('<ConversationRelay');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/profile stamp failed/));
  });

  test('99 renders the raw sandbox attrs; an unknown code falls back to the production profile', async () => {
    process.env.VOICE_RELAY_SANDBOX_ATTRS = JSON.stringify({ speechModel: 'nova-2-general', deepgramSmartFormat: false });
    let res = mockRes();
    await handlerFor('/relay-sandbox/cell')({ body: { CallSid: 'CA-sb-6', To: SANDBOX, Digits: '99' } }, res);
    expect(res.body).toContain('speechModel="nova-2-general"');
    expect(res.body).toContain('deepgramSmartFormat="false"');
    expect(res.body).toMatch(/value="sandbox_raw_[0-9a-f]{12}"/);
    res = mockRes();
    const { update } = primeStamp();
    await handlerFor('/relay-sandbox/cell')({ body: { CallSid: 'CA-sb-7', To: SANDBOX, Digits: '77' } }, res);
    expect(res.body).not.toContain('speechModel=');
    expect(res.body).toMatch(/<ConversationRelay [^>]*\/><\/Connect>/);
    expect(update).not.toHaveBeenCalled(); // no production profile configured: nothing to attribute
  });

  test('an unknown code under an active production profile stamps THAT profile before the relay opens (codex r8 P2)', async () => {
    process.env.VOICE_RELAY_PROFILE = 'nova_hints_v1';
    const { update } = primeStamp();
    const res = mockRes();
    await handlerFor('/relay-sandbox/cell')({ body: { CallSid: 'CA-sb-8', To: SANDBOX, Digits: '77' } }, res);
    expect(res.body).toContain('<Parameter name="relay_profile" value="nova_hints_v1" />');
    expect(JSON.parse(update.mock.calls[0][0].metadata.bindings[0])).toEqual({
      relay_profile_id: 'nova_hints_v1', relay_attrs: expect.objectContaining({ speechModel: 'nova-3-general' }),
    });
  });

  test('a production number ⇒ 403', async () => {
    const res = mockRes();
    await handlerFor('/relay-sandbox/cell')({ body: { CallSid: 'CA-sb-8', To: '+19415550188', Digits: '03' } }, res);
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
