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
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
  voiceGptLiveTestLive: () => process.env.GATE_VOICE_GPT_LIVE_TEST === 'true',
  voiceSandboxRecordingLive: () => process.env.GATE_VOICE_SANDBOX_RECORDING === 'true',
}));
jest.mock('../services/call-recording-processor', () => ({ recoverRecordingForCall: jest.fn() }));
// The REST client is a fake (the TwiML builder stays real), so a run with real
// Twilio credentials in the environment can never call the API.
const mockCallUpdate = jest.fn(() => Promise.resolve({}));
const mockCalls = jest.fn(() => ({ update: mockCallUpdate }));
jest.mock('twilio', () => {
  const actual = jest.requireActual('twilio');
  const client = jest.fn(() => ({ calls: mockCalls }));
  return Object.assign(client, actual);
});

const db = require('../models/db');
const { PER_CALL_RESERVE_USD } = require('../services/voice-agent/live-bridge');
const logger = require('../services/logger');
const { isRelayAttached } = require('../services/voice-agent/relay-server');
const voiceRouter = require('../routes/twilio-voice-webhook');
const { isSandboxCall, sandboxRelayXml, stampRelayProfile, RELAY_COMPLETE_ACTION_SANDBOX, RELAY_SANDBOX_CELL_ACTION } = voiceRouter._test;
const { recordTouchpoint } = require('../services/conversations');
const { recoverRecordingForCall } = require('../services/call-recording-processor');
const { VOICE_RELAY_SANDBOX_SOURCE, spanishWelcomeGreeting } = require('../services/voice-agent/relay-protocol');

// An UNREGISTERED number: a registered Waves line is refused as the sandbox target.
const SANDBOX = '+19415550199';
const TWILIO_NUMBERS = require('../config/twilio-numbers');
// GATE_VOICE_SANDBOX_RECORDING: a staff forward number (the only caller ever recorded), the carrier verdict that
// vouches for it, the one instruction the gate adds, and the stamp that carries the decision to the cell document.
const STAFF_PHONE = '+19415550142';
const A_ATTESTED = 'TN-Validation-Passed-A';
const SANDBOX_RECORDING = '<Start><Recording channels="dual" trim="do-not-trim"/></Start>';
const RECORDING_STAMP = 'sandbox_recording_ok';
const STAFF_PHONE_ENV = ['WAVES_FALLBACK_FORWARD_NUMBERS', 'OWNER_PHONE', 'ADAM_PHONE', 'VIRGINIA_PHONE', 'OFFICE_MANAGER_PHONE', 'WAVES_OFFICE_MANAGER_PHONE', 'WAVES_CSR_NUMBER_MAP'];

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

// A request as Twilio sends it: signed over the public URL and the form body (undefined fields are not posted).
// `signed: false` leaves the header off; mutate the returned body to model a tampered one.
function twilioReq(routePath, fields, { signed = true } = {}) {
  const body = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  const url = `/api/webhooks/twilio${routePath}`;
  const headers = { host: 'portal.example.com', 'x-forwarded-proto': 'https' };
  if (signed) headers['x-twilio-signature'] = require('twilio').getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN || '', `https://portal.example.com${url}`, body);
  return { body, headers, originalUrl: url, protocol: 'http', get: (name) => headers[String(name).toLowerCase()] };
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
  delete process.env.GATE_VOICE_SANDBOX_RECORDING;
  for (const name of STAFF_PHONE_ENV) delete process.env[name];
  process.env.WAVES_FALLBACK_FORWARD_NUMBERS = STAFF_PHONE;
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

// The recording decision's number check. The forwarding code's isStaffForwardNumber matches the last ten digits (right
// for "is this leg internal"); a decision to record a voice needs the whole number.
describe('isStaffForwardE164: the whole number, never its last ten digits', () => {
  test('matches a configured staff number in any env spelling, only for a caller number in strict E.164', () => {
    process.env.WAVES_FALLBACK_FORWARD_NUMBERS = '+19415550142, (941) 555-0143';
    process.env.WAVES_CSR_NUMBER_MAP = '19415550144:Pat';
    process.env.OWNER_PHONE = '941-555-0145';
    for (const staff of ['+19415550142', '+19415550143', '+19415550144', '+19415550145']) expect(TWILIO_NUMBERS.isStaffForwardE164(staff)).toBe(true);
    for (const other of ['+19415550100', '+4419415550142', '+449415550142', '9415550142', '19415550142', ' +19415550142', '+1941555014', 'anonymous', '', null, undefined, 19415550142]) {
      expect(TWILIO_NUMBERS.isStaffForwardE164(other)).toBe(false);
    }
    // The last-ten-digit matcher is unchanged: it still treats the foreign look-alike as internal.
    expect(TWILIO_NUMBERS.isStaffForwardNumber('+4419415550142')).toBe(true);
    expect([...TWILIO_NUMBERS.staffForwardLast10()].sort()).toEqual(['9415550142', '9415550143', '9415550144', '9415550145']);
  });

  test('no staff number configured: nothing matches', () => {
    delete process.env.WAVES_FALLBACK_FORWARD_NUMBERS;
    expect(TWILIO_NUMBERS.isStaffForwardE164(STAFF_PHONE)).toBe(false);
  });

  // The call router reads a WAVES_CSR_NUMBER_MAP entry only when it has a number AND a name (getCsrNumberMap). An
  // entry it ignores (a stale bare number, a name deleted but the colon left) must not make that number a staff phone.
  test('a CSR map entry counts only with a number and a name, as the call router reads it', () => {
    delete process.env.WAVES_FALLBACK_FORWARD_NUMBERS;
    process.env.WAVES_CSR_NUMBER_MAP = '+19415550142, +19415550143:, +19415550144:  ,+19415550145:Pat, :Sam';
    for (const unnamed of ['+19415550142', '+19415550143', '+19415550144']) expect(TWILIO_NUMBERS.isStaffForwardE164(unnamed)).toBe(false);
    expect(TWILIO_NUMBERS.isStaffForwardE164('+19415550145')).toBe(true);
    // The last-ten-digit set that marks a leg internal is unchanged: it still holds every number written there.
    expect([...TWILIO_NUMBERS.staffForwardLast10()].sort()).toEqual(['9415550142', '9415550143', '9415550144', '9415550145']);
  });

  // The configured side is read as strictly as the caller's side. Guessing here would let a staff entry that is not a
  // plain number authorize a DIFFERENT caller, whom the carrier then truthfully vouches for.
  test('a configured value is read only when it is one unambiguous number', () => {
    const read = (raw) => TWILIO_NUMBERS.staffNumberE164(raw);
    for (const raw of ['+19415550142', '(941) 555-0142', '941-555-0142', '941.555.0142', '1 941 555 0142', '1-941-555-0142', '+1 (941) 555-0142', ' +19415550142 ']) {
      expect(read(raw)).toBe('+19415550142');
    }
    expect(read('+44 20 7946 0958')).toBe('+442079460958');
    for (const raw of [
      '4419415550142', '0019415550142', '011 44 20 7946 0958', // a country code without its "+"
      '941-555-0142 x123', '+1 941 555 0142 ext 5', '19415550142;ext=5', '9415550142123', // an extension
      '+1 941 555 0142 +1 941 555 0143', '941 555 0142 941 555 0143', // two numbers in one entry
      '+1941555014', '555-0142', '94155501425', '+1 041 555 0142', '+1 941 055 0142', '+0 123456789', '+', '', '   ', null, undefined,
    ]) {
      expect(read(raw)).toBeNull();
    }
  });

  test('an ambiguous configured value authorizes nobody, least of all the number a loose reading would make of it', () => {
    // toE164 would read these two as +1 941 555 0142 and +1 555 014 2123.
    process.env.WAVES_FALLBACK_FORWARD_NUMBERS = '4419415550142, 941-555-0142 x123';
    process.env.WAVES_CSR_NUMBER_MAP = '4419415550143:Pat';
    process.env.OWNER_PHONE = '941-555-0144 ext 9';
    for (const caller of ['+19415550142', '+15550142123', '+4419415550142', '+19415550143', '+4419415550143', '+19415550144']) {
      expect(TWILIO_NUMBERS.isStaffForwardE164(caller)).toBe(false);
    }
    // A plain entry beside them still counts, and an explicit foreign number matches only itself.
    process.env.VIRGINIA_PHONE = '941-555-0145';
    process.env.ADAM_PHONE = '+44 20 7946 0958';
    expect(TWILIO_NUMBERS.isStaffForwardE164('+19415550145')).toBe(true);
    expect(TWILIO_NUMBERS.isStaffForwardE164('+442079460958')).toBe(true);
    expect(TWILIO_NUMBERS.isStaffForwardE164('+12079460958')).toBe(false);
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
      expect(JSON.parse(insert.mock.calls[0][0].metadata)).toEqual({ relay_sandbox: true, source: 'status_callback', inserted_on_status: 'completed' });
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
    // relay_language is always written (null when the profile has none —
    // codex r2 P2 on #4947), never omitted: an omitted key would leave a
    // STALE language from an earlier stamp in place after the jsonb merge.
    expect(JSON.parse(update.mock.calls[0][0].metadata.bindings[0])).toEqual({ relay_profile_id: 'flux_balanced_v1', relay_attrs: { speechModel: 'flux' }, relay_language: null });
    update.mockClear();
    await stampRelayProfile('CA-prod-2', {});
    expect(update).not.toHaveBeenCalled();
    // The Spanish leg clears a pre-stamped English profile when its own options resolve empty (codex r14 P2).
    await stampRelayProfile('CA-prod-2', {}, { clearWhenEmpty: true });
    expect(JSON.parse(update.mock.calls[0][0].metadata.bindings[0])).toEqual({ relay_profile_id: null, relay_attrs: null, relay_language: null });
    db.mockImplementation(() => { throw new Error('pool down'); });
    await expect(stampRelayProfile('CA-prod-3', { relayProfileId: 'nova_hints_v1' })).resolves.toBeUndefined(); // fail-soft
  });

  // GATE_VOICE_SANDBOX_RECORDING: the test-call grader needs audio, and the sandbox line keeps none. The gate spends
  // money (Twilio bills a recorded minute) and records a voice, so the regressions that matter are a recording nobody
  // approved (gate off, or a caller who is not provably staff), a response that tells an unsigned request which numbers
  // are staff, a recording that starts before the disclosure ends, and one the recording pipeline hears about.
  describe('GATE_VOICE_SANDBOX_RECORDING on the answer document', () => {
    beforeEach(() => { process.env.TWILIO_AUTH_TOKEN = 'test-token'; });
    afterEach(() => {
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_SIGNATURE_VALIDATION;
    });
    // One answer webhook from a signed, A-attested staff phone unless overridden. Returns the document and the
    // metadata the handler wrote on the sandbox row (insert, or the adoption update when `existing` is given).
    const answer = async ({ fields = {}, signed = true, tamper = null, existing } = {}) => {
      const { insert, update } = primeInsert({ existing });
      const req = twilioReq('/relay-sandbox', { CallSid: 'CA-sb-rec', To: SANDBOX, From: STAFF_PHONE, StirVerstat: A_ATTESTED, ...fields }, { signed });
      if (tamper) Object.assign(req.body, tamper);
      const res = mockRes();
      await handlerFor('/relay-sandbox')(req, res);
      const meta = insert.mock.calls.length ? JSON.parse(insert.mock.calls[0][0].metadata) : JSON.parse(update.mock.calls[0][0].metadata.bindings[0]);
      return { xml: res.body, meta };
    };
    // The answer document every caller got before the gate: the cell <Gather> with Twilio's default finish key.
    const UNCHANGED_GATHER = '<Gather input="dtmf" numDigits="2" timeout="3" action="/api/webhooks/twilio/relay-sandbox/cell" method="POST"><Play>';
    const expectUnchangedDocument = (xml) => {
      expect(xml).toContain(UNCHANGED_GATHER);
      expect(xml).toContain('</Gather><Connect');
      expect(xml).not.toMatch(/<Start|<Recording|finishOnKey/);
    };
    // A verified delivery that decided "not staff": no recording, and the row says so.
    const expectNotRecorded = ({ xml, meta }) => {
      expectUnchangedDocument(xml);
      expect(meta[RECORDING_STAMP]).toBe(false);
    };
    // A delivery with no say (unverified, or the gate off): no recording, and it writes no stamp at all.
    const expectNoSay = ({ xml, meta }) => {
      expectUnchangedDocument(xml);
      expect(meta).not.toHaveProperty(RECORDING_STAMP);
    };
    const sandboxRow = (stamp) => ({ id: 7, source: VOICE_RELAY_SANDBOX_SOURCE, metadata: { relay_sandbox: true, stir_verstat: A_ATTESTED, ...(stamp === undefined ? {} : { [RECORDING_STAMP]: stamp }) } });

    test('gate off: a signed, attested staff phone is not recorded, and the document and the row are what they were', async () => {
      const { xml, meta } = await answer();
      expectUnchangedDocument(xml);
      expect(meta).toEqual({ relay_sandbox: true, stir_verstat: A_ATTESTED });
    });

    // Twilio's default finish key ends a <Gather> with no digits when "#" is pressed alone: no action is requested,
    // the nested disclosure stops, and the next verb runs. On a document that records, that next verb is the
    // recording. With no finish key every key press is input and goes to the cell handler, which replays the
    // disclosure outside any <Gather> before it records.
    test('gate on: a recorded document has no finish key, so no key press can skip the disclosure and reach the recording', async () => {
      process.env.GATE_VOICE_SANDBOX_RECORDING = 'true';
      const { xml } = await answer();
      expect(xml).toContain(`<Gather input="dtmf" numDigits="2" timeout="3" action="/api/webhooks/twilio/relay-sandbox/cell" method="POST" finishOnKey=""><Play>`);
      // the only route to the recording inside this document is the end of the <Gather>
      expect(xml).toMatch(new RegExp(`</Play></Gather>${SANDBOX_RECORDING}<Connect`));
      expect(xml.split('<Gather')).toHaveLength(2);
    });

    test('gate on: a signed, A-attested staff phone starts ONE dual-channel recording after the disclosure <Gather> and before the relay, with no status callback, and the row is stamped', async () => {
      process.env.GATE_VOICE_SANDBOX_RECORDING = 'true';
      const { xml, meta } = await answer();
      expect(xml).toContain(`</Gather>${SANDBOX_RECORDING}<Connect`);
      expect(xml.split('<Recording')).toHaveLength(2);
      // No callback: /recording-status never hears of a sandbox recording, so nothing transcribes or extracts it.
      expect(xml).not.toMatch(/recordingStatusCallback/i);
      expect(meta).toEqual({ relay_sandbox: true, stir_verstat: A_ATTESTED, [RECORDING_STAMP]: true });
      // The adoption path (a row /call-status wrote first) carries the same stamp.
      const adopted = await answer({ existing: { id: 7, source: null } });
      expect(adopted.xml).toContain(SANDBOX_RECORDING);
      expect(adopted.meta[RECORDING_STAMP]).toBe(true);
      // A staff number written without a country code in the env is the same +1 number.
      process.env.WAVES_FALLBACK_FORWARD_NUMBERS = '(941) 555-0142';
      expect((await answer()).xml).toContain(SANDBOX_RECORDING);
    });

    test('gate on: an unsigned or tampered request never learns that a number is staff and writes no stamp, in every middleware mode', async () => {
      process.env.GATE_VOICE_SANDBOX_RECORDING = 'true';
      for (const mode of ['log', 'disabled', 'enforce']) {
        process.env.TWILIO_SIGNATURE_VALIDATION = mode;
        expectNoSay(await answer({ signed: false }));
        // signed for a stranger's number, then the posted From swapped to the staff number
        expectNoSay(await answer({ fields: { From: '+19415550100' }, tamper: { From: STAFF_PHONE } }));
      }
      delete process.env.TWILIO_AUTH_TOKEN; // nothing to verify with
      expectNoSay(await answer());
    });

    // The first verified delivery decides for the call. A redelivery (Twilio retries an answer webhook) must not turn
    // a refusal into a recording because the staff list changed in between, nor replace the stored answer at all.
    test('gate on: a redelivery reuses the stored decision and never writes another', async () => {
      process.env.GATE_VOICE_SANDBOX_RECORDING = 'true';
      // refused first; this delivery alone would say yes
      expectNoSay(await answer({ existing: sandboxRow(false) }));
      // approved first; the number is no longer configured as staff, so this delivery alone would say no
      delete process.env.WAVES_FALLBACK_FORWARD_NUMBERS;
      const kept = await answer({ existing: sandboxRow(true) });
      expect(kept.xml).toContain(`</Gather>${SANDBOX_RECORDING}<Connect`);
      expect(kept.meta).not.toHaveProperty(RECORDING_STAMP);
      process.env.WAVES_FALLBACK_FORWARD_NUMBERS = STAFF_PHONE;
      // metadata read back as text is the same stored decision
      const text = sandboxRow(false);
      expectNoSay(await answer({ existing: { ...text, metadata: JSON.stringify(text.metadata) } }));
      // an approved call still needs THIS delivery verified and the gate on to get the instruction
      expectNoSay(await answer({ existing: sandboxRow(true), signed: false }));
      delete process.env.GATE_VOICE_SANDBOX_RECORDING;
      expectNoSay(await answer({ existing: sandboxRow(true) }));
    });

    test('gate on: a row with no decision yet (written first by /call-status, or by a delivery with no say) gets this delivery\'s', async () => {
      process.env.GATE_VOICE_SANDBOX_RECORDING = 'true';
      for (const existing of [sandboxRow(undefined), sandboxRow('true'), sandboxRow(null), { id: 7, source: null, metadata: null }, { id: 7, source: null, metadata: '{not json' }]) {
        const first = await answer({ existing });
        expect(first.xml).toContain(SANDBOX_RECORDING);
        expect(first.meta[RECORDING_STAMP]).toBe(true);
        expectNotRecorded(await answer({ existing, fields: { From: '+19415550100' } }));
      }
    });

    test('gate on: a staff number the carrier does not vouch for is not recorded (a spoofed caller ID is not staff)', async () => {
      process.env.GATE_VOICE_SANDBOX_RECORDING = 'true';
      for (const StirVerstat of ['TN-Validation-Passed-B', 'TN-Validation-Passed-C', 'TN-Validation-Failed-A', 'No-TN-Validation', '', undefined]) {
        expectNotRecorded(await answer({ fields: { StirVerstat } }));
      }
    });

    test('gate on: only the WHOLE staff number counts (a stranger, a foreign number with the same last ten digits, a national-format, withheld or missing number are not recorded)', async () => {
      process.env.GATE_VOICE_SANDBOX_RECORDING = 'true';
      // The forwarding code's last-ten-digit match accepts the foreign number; this decision must not.
      expect(TWILIO_NUMBERS.isStaffForwardNumber('+4419415550142')).toBe(true);
      for (const From of ['+19415550100', '+4419415550142', '+449415550142', '9415550142', '19415550142', 'anonymous', '', undefined]) {
        expectNotRecorded(await answer({ fields: { From } }));
      }
      // The same strictness on the configured side: an entry that is not one plain number authorizes nobody.
      process.env.WAVES_FALLBACK_FORWARD_NUMBERS = '4419415550142, 941-555-0142 x123';
      for (const From of ['+19415550142', '+15550142123', '+4419415550142']) expectNotRecorded(await answer({ fields: { From } }));
    });

    test('gate on with no staff phone configured: nobody is recorded (fail closed)', async () => {
      process.env.GATE_VOICE_SANDBOX_RECORDING = 'true';
      delete process.env.WAVES_FALLBACK_FORWARD_NUMBERS;
      expectNotRecorded(await answer());
    });

    // The route calls the reader through `?.()`, so a reader that is not exported would read as "off" for good
    // (the 11-18 lost-export trap). This suite mocks the gate module, so the real one is checked here.
    test('the real gate module exports the reader, and only exactly "true" turns it on', () => {
      const { voiceSandboxRecordingLive } = jest.requireActual('../config/feature-gates');
      for (const value of [undefined, '', 'TRUE', '1', 'yes', ' true', 'false']) {
        if (value === undefined) delete process.env.GATE_VOICE_SANDBOX_RECORDING;
        else process.env.GATE_VOICE_SANDBOX_RECORDING = value;
        expect(voiceSandboxRecordingLive()).toBe(false);
      }
      process.env.GATE_VOICE_SANDBOX_RECORDING = 'true';
      expect(voiceSandboxRecordingLive()).toBe(true);
    });

    test('relay not attached: the spoken notice and hangup start no recording', async () => {
      process.env.GATE_VOICE_SANDBOX_RECORDING = 'true';
      isRelayAttached.mockImplementation(() => false);
      const { xml } = await answer();
      expect(xml).toContain('<Hangup/>');
      expect(xml).not.toMatch(/<Start|<Recording/);
    });
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
      relay_language: null,
    });
  });

  // GATE_VOICE_SANDBOX_RECORDING on the cell document. The cell never decides who is staff: it honours the stamp the
  // answer webhook put on the row, on its own verified signature, with a relay that can take the call.
  describe('GATE_VOICE_SANDBOX_RECORDING on the cell document', () => {
    beforeEach(() => {
      process.env.GATE_VOICE_SANDBOX_RECORDING = 'true';
      process.env.TWILIO_AUTH_TOKEN = 'test-token';
    });
    afterEach(() => {
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_SIGNATURE_VALIDATION;
    });
    // One cell callback over a sandbox row with this metadata (stamped true unless overridden).
    const stamped = (value) => ({ relay_sandbox: true, [RECORDING_STAMP]: value });
    const render = async ({ metadata = stamped(true), signed = true, tamper = null, From = '+19415550100', asText = false } = {}) => {
      const update = jest.fn().mockResolvedValue(1);
      // The row as the query asked for it: metadata only when the handler selected it.
      const first = jest.fn(async (...columns) => ({
        source: VOICE_RELAY_SANDBOX_SOURCE,
        ...(columns.includes('metadata') ? { metadata: asText ? JSON.stringify(metadata) : metadata } : {}),
      }));
      db.mockImplementation(() => ({ where: jest.fn(() => ({ update, first })) }));
      db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
      const req = twilioReq('/relay-sandbox/cell', { CallSid: 'CA-sb-rec', To: SANDBOX, From, Digits: '09' }, { signed });
      if (tamper) Object.assign(req.body, tamper);
      const res = mockRes();
      await handlerFor('/relay-sandbox/cell')(req, res);
      return { xml: res.body, first };
    };
    const RECORDED = new RegExp(`<Response><Play>https://[^<]+\\.mp3</Play>${SANDBOX_RECORDING}<Connect[ >]`);
    const expectRelayNotRecorded = (xml) => {
      expect(xml).toMatch(/<Response><Play>https:\/\/[^<]+\.mp3<\/Play><Connect[ >]/); // the caller still gets the relay
      expect(xml).not.toMatch(/<Start|<Recording/);
    };

    test('a stamped call is recorded after the replayed disclosure and before the relay, once, with no status callback', async () => {
      const { xml, first } = await render();
      expect(xml).toMatch(RECORDED);
      expect(xml.split('<Recording')).toHaveLength(2);
      expect(xml).not.toMatch(/recordingStatusCallback/i);
      // The stamp rides the ownership read: one query for the row, never a second one the call would wait on.
      expect(first.mock.calls).toEqual([['source', 'metadata']]);
      expect((await render({ asText: true })).xml).toMatch(RECORDED); // metadata read back as text
    });

    test('the stamp decides, not the number this request posts', async () => {
      // stamped at answer, and this callback posts a number that is not staff: still that call's recording
      expect((await render({ From: '+19415550100' })).xml).toMatch(RECORDED);
      // not stamped exactly true, and this callback posts the staff number: never recorded
      for (const metadata of [stamped(false), stamped('true'), stamped(1), stamped(null), { relay_sandbox: true }, null]) {
        expectRelayNotRecorded((await render({ metadata, From: STAFF_PHONE })).xml);
      }
    });

    test('an unsigned or tampered cell callback reads no stamp and starts no recording, in every middleware mode', async () => {
      for (const mode of ['log', 'disabled', 'enforce']) {
        process.env.TWILIO_SIGNATURE_VALIDATION = mode;
        for (const opts of [{ signed: false }, { tamper: { Digits: '10' } }]) {
          const { xml, first } = await render(opts);
          expect(xml).not.toMatch(/<Start|<Recording/);
          expect(first.mock.calls).toEqual([['source']]); // the ownership read as it was: the stamp is not even selected
        }
      }
    });

    test('a relay that cannot take the call, or the gate off: the same document and the same row read as before, no recording', async () => {
      isRelayAttached.mockImplementation(() => false);
      const detached = await render();
      expectRelayNotRecorded(detached.xml);
      expect(detached.first.mock.calls).toEqual([['source']]);
      isRelayAttached.mockImplementation(() => true);
      delete process.env.GATE_VOICE_SANDBOX_RECORDING;
      const off = await render();
      expectRelayNotRecorded(off.xml);
      expect(off.first.mock.calls).toEqual([['source']]); // gate off: the query is what it was
    });
  });

  // Codex r1 P1 on #4947: language="multi" alone carries no Spanish signal
  // into RelayConversation.language — cell 10 must ALSO carry the same
  // <Parameter lang=es> marker the Spanish-menu vestibule uses, and the row
  // stamp must persist the language for the one permitted reconnect.
  test('cell "10" (Flux Multilingual) renders language="multi" AND the <Parameter lang=es> marker, and stamps relay_language', async () => {
    const { update } = primeStamp();
    const res = mockRes();
    await handlerFor('/relay-sandbox/cell')({ body: { CallSid: 'CA-sb-10', To: SANDBOX, Digits: '10' } }, res);
    expect(res.body).toContain('speechModel="flux"');
    expect(res.body).toContain('language="multi"');
    expect(res.body).toContain('<Parameter name="lang" value="es" />');
    expect(res.body).toContain('<Parameter name="relay_profile" value="flux_multilingual_es_v1" />');
    // Codex r2 P2 on #4947: the Spanish welcome opener, not the English
    // default (buildRelayTwiML's welcomeGreeting default is English).
    expect(res.body).toContain(`welcomeGreeting="${spanishWelcomeGreeting().replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`);
    const patch = update.mock.calls[0][0];
    expect(JSON.parse(patch.metadata.bindings[0])).toEqual({
      relay_profile_id: 'flux_multilingual_es_v1',
      relay_attrs: expect.objectContaining({ speechModel: 'flux', transcriptionProvider: 'Deepgram' }),
      relay_language: 'multi',
    });
  });

  // Codex r2 P2 on #4947: without writing `null` (never omitting the key),
  // moving a CallSid from a Flux Multilingual cell onto a plain profile
  // would leave the earlier "multi" stuck in metadata via the jsonb merge.
  test('re-stamping the SAME CallSid from cell "10" onto a plain profile overwrites relay_language with null, never leaving it stale', async () => {
    const { update } = primeStamp();
    const res1 = mockRes();
    await handlerFor('/relay-sandbox/cell')({ body: { CallSid: 'CA-sb-10b', To: SANDBOX, Digits: '10' } }, res1);
    expect(JSON.parse(update.mock.calls[0][0].metadata.bindings[0]).relay_language).toBe('multi');
    update.mockClear();
    const res2 = mockRes();
    await handlerFor('/relay-sandbox/cell')({ body: { CallSid: 'CA-sb-10b', To: SANDBOX, Digits: '03' } }, res2);
    expect(JSON.parse(update.mock.calls[0][0].metadata.bindings[0])).toEqual({
      relay_profile_id: 'flux_balanced_v1',
      relay_attrs: expect.objectContaining({ speechModel: 'flux' }),
      relay_language: null,
    });
  });

  // Codex r3 P2 on #4947: with recovery on, an EMPTY stamp (e.g. a retried
  // /relay-sandbox after the cell-10 continuation) takes the clearing branch,
  // which must wipe relay_language too — the jsonb merge keeps omitted keys.
  test('clearing a cell-10 stamp (recovery on, empty options) also clears relay_language', async () => {
    const saved = process.env.GATE_VOICE_RELAY_RECOVERY;
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    try {
      const { update } = primeInsert();
      await stampRelayProfile('CA-sb-10c', { relayProfileId: 'flux_multilingual_es_v1', relayAttrs: { speechModel: 'flux' }, language: 'multi' });
      expect(JSON.parse(update.mock.calls[0][0].metadata.bindings[0]).relay_language).toBe('multi');
      update.mockClear();
      await stampRelayProfile('CA-sb-10c', {});
      expect(JSON.parse(update.mock.calls[0][0].metadata.bindings[0])).toEqual({ relay_profile_id: null, relay_attrs: null, relay_language: null });
    } finally {
      if (saved === undefined) delete process.env.GATE_VOICE_RELAY_RECOVERY; else process.env.GATE_VOICE_RELAY_RECOVERY = saved;
    }
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
      relay_profile_id: 'nova_hints_v1', relay_attrs: expect.objectContaining({ speechModel: 'nova-3-general' }), relay_language: null,
    });
  });

  test('a production number ⇒ 403', async () => {
    const res = mockRes();
    await handlerFor('/relay-sandbox/cell')({ body: { CallSid: 'CA-sb-8', To: '+19415550188', Digits: '03' } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('GPT-Live trial: cell 71 / 72 behind GATE_VOICE_GPT_LIVE_TEST', () => {
  // The cell handler's reads and writes: the ownership read (db `first`; the
  // production path stamps with db `update` = prodUpdate), then ONE transaction
  // for GPT-Live: the budget lock, the spent read (`whereNot(...).first(raw)`
  // answers `usd`) and the reservation stamp (trx `update`).
  // The ledger (voice_gpt_live_ledger): the spent read (`first(raw)` answers
  // `usd`) and the claim (`insert().onConflict().ignore().returning()`,
  // [] = already claimed). call_log in the same transaction: the stamp.
  function primeLive({ usd = 0, budgetFails = false, stampFails = false, stampRows = 1, claimed = true, rowMetadata } = {}) {
    const prodUpdate = jest.fn(() => Promise.resolve(1));
    const builder = { where: jest.fn(() => builder), first: jest.fn(async () => ({ source: VOICE_RELAY_SANDBOX_SOURCE, ...(rowMetadata ? { metadata: rowMetadata } : {}) })), update: prodUpdate };
    db.mockImplementation(() => builder);
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    const spent = jest.fn(async () => {
      if (budgetFails) throw new Error('pool down');
      return { usd };
    });
    const insert = jest.fn(() => ledger);
    const returning = jest.fn(async () => (claimed ? [{ call_sid: 'CA-sb-live' }] : []));
    const release = jest.fn(async () => 0); // stale, never-admitted rows released at $0
    const ledger = {
      first: spent, insert, onConflict: jest.fn(() => ledger), ignore: jest.fn(() => ledger), returning,
      whereNull: jest.fn(() => ledger), whereRaw: jest.fn(() => ledger), update: release,
    };
    const update = jest.fn(() => (stampFails ? Promise.reject(new Error('pool down')) : Promise.resolve(stampRows)));
    const tb = { where: jest.fn(() => tb), whereRaw: jest.fn(() => tb), update };
    const trx = jest.fn((table) => (table === 'voice_gpt_live_ledger' ? ledger : tb));
    trx.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    trx.fn = { now: () => 'NOW()' };
    db.transaction = jest.fn(async (fn) => fn(trx));
    return { update, prodUpdate, spent, insert, release, ledger, tb, trx };
  }
  // A cell request as Twilio sends it: signed over the public URL and the form
  // body (the route checks it itself; the shared middleware may only log).
  const CELL_PATH = '/api/webhooks/twilio/relay-sandbox/cell';
  const cell = (digits, CallSid = 'CA-sb-live', { signed = true, extra = {} } = {}) => {
    const body = { CallSid, To: SANDBOX, Digits: digits, ...extra };
    const headers = { host: 'portal.example.com', 'x-forwarded-proto': 'https' };
    if (signed) {
      headers['x-twilio-signature'] = require('twilio').getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN || '', `https://portal.example.com${CELL_PATH}`, body);
    }
    return { body, headers, originalUrl: CELL_PATH, protocol: 'http', get: (name) => headers[String(name).toLowerCase()] };
  };

  beforeEach(() => { process.env.TWILIO_AUTH_TOKEN = 'test-token'; });
  afterEach(() => {
    delete process.env.GATE_VOICE_GPT_LIVE_TEST;
    delete process.env.VOICE_GPT_LIVE_TEST_MAX_USD;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_SIGNATURE_VALIDATION;
  });

  test('an unsigned or wrongly signed live cell request is refused before any ledger write or Twilio update, whatever the middleware mode', async () => {
    process.env.GATE_VOICE_GPT_LIVE_TEST = 'true';
    process.env.TWILIO_ACCOUNT_SID = 'AC-test';
    try {
      for (const mode of ['log', 'disabled', 'enforce']) {
        process.env.TWILIO_SIGNATURE_VALIDATION = mode;
        const tampered = cell('71');
        tampered.body.Digits = '72'; // signed over 71
        for (const req of [cell('71', 'CA-sb-live', { signed: false }), tampered]) {
          primeLive();
          mockCallUpdate.mockClear();
          const res = mockRes();
          await handlerFor('/relay-sandbox/cell')(req, res);
          expect(res.body).toContain('not available right now');
          expect(res.body).not.toContain('<Stream');
          expect(db.transaction).not.toHaveBeenCalled();
          expect(mockCallUpdate).not.toHaveBeenCalled();
        }
      }
      delete process.env.TWILIO_AUTH_TOKEN; // nothing to verify with: refused too
      primeLive();
      const res = mockRes();
      await handlerFor('/relay-sandbox/cell')(cell('71'), res);
      expect(res.body).toContain('not available right now');
      expect(db.transaction).not.toHaveBeenCalled();
    } finally {
      delete process.env.TWILIO_ACCOUNT_SID;
    }
  });

  test('gate off: 71 is an unknown code and renders the unchanged production-profile TwiML', async () => {
    process.env.VOICE_RELAY_PROFILE = 'nova_hints_v1';
    const { prodUpdate, update } = primeLive();
    const res = mockRes();
    await handlerFor('/relay-sandbox/cell')(cell('71'), res);
    expect(res.body).toContain('<ConversationRelay');
    expect(res.body).toContain('<Parameter name="relay_profile" value="nova_hints_v1" />');
    expect(res.body).not.toContain('<Stream');
    expect(JSON.parse(prodUpdate.mock.calls[0][0].metadata.bindings[0]).relay_profile_id).toBe('nova_hints_v1');
    expect(db.transaction).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  test('gate on: 71 plays the disclosure, then connects a Stream with the CallSid and token as path segments and no query string', async () => {
    process.env.GATE_VOICE_GPT_LIVE_TEST = 'true';
    process.env.TWILIO_ACCOUNT_SID = 'AC-test';
    process.env.TWILIO_AUTH_TOKEN = 'test-token';
    const { update, trx, tb, insert, release, ledger, spent } = primeLive();
    const res = mockRes();
    await handlerFor('/relay-sandbox/cell')(cell('71'), res);
    // Twilio's own stop at 600 s, on the fake client
    expect(mockCalls).toHaveBeenCalledWith('CA-sb-live');
    expect(mockCallUpdate).toHaveBeenCalledWith({ timeLimit: 600 });
    expect(res.body).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?><Response><Play>https:\/\/[^<]+\.mp3<\/Play><Connect action="\/api\/webhooks\/twilio\/relay-sandbox\/live-complete">/);
    const url = res.body.match(/<Stream url="([^"]+)"/)[1];
    expect(url).toMatch(/^wss:\/\/portal\.example\.com\/ws\/voice-live\/CA-sb-live\/[0-9a-z]+\.\d+\.[0-9a-f]{16}\.[0-9a-f]+$/);
    expect(url).not.toContain('?');
    // the same builder the upgrade's Twilio signature check uses
    expect(url).toBe(require('../services/voice-agent/relay-protocol').liveStreamUrl('portal.example.com', 'CA-sb-live', url.split('/').pop()));
    expect(res.body).not.toContain('<ConversationRelay');
    expect(res.body).not.toContain('shh-secret-123');
    // The ledger read, the ledger claim and the stamp run under one lock, in one transaction.
    expect(trx.raw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext(?))', ['voice_gpt_live_budget']);
    expect(trx).toHaveBeenCalledWith('voice_gpt_live_ledger');
    // First, reservations whose stream never opened within the token's life go back at $0.
    expect(ledger.whereNull).toHaveBeenCalledWith('admitted_at');
    expect(ledger.whereNull).toHaveBeenCalledWith('cost_usd');
    expect(ledger.whereRaw).toHaveBeenCalledWith("created_at < now() - (? * interval '1 second')", [360]);
    expect(release).toHaveBeenCalledWith({ cost_usd: 0, settled_at: 'NOW()' });
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(spent.mock.invocationCallOrder[0]);
    expect(insert).toHaveBeenCalledWith({ call_sid: 'CA-sb-live', reserved_usd: PER_CALL_RESERVE_USD });
    expect(ledger.onConflict).toHaveBeenCalledWith('call_sid');
    // single-use: the stamp lands only on a row with no gpt_live yet
    expect(tb.where).toHaveBeenCalledWith({ twilio_call_sid: 'CA-sb-live' });
    expect(tb.whereRaw).toHaveBeenCalledWith("(metadata->'gpt_live') IS NULL");
    // The stamp the WS upgrade later requires, carrying this call's reservation.
    const stamp = JSON.parse(update.mock.calls[0][0].metadata.bindings[0]).gpt_live;
    // ...bound to the one token this response issues (its digest, never the token)
    const { callTokenDigest, verifyCallToken, LIVE_TOKEN_AUDIENCE } = require('../services/voice-agent/relay-protocol');
    // signed for /ws/voice-live/ only: the relay socket's verify refuses it
    expect(verifyCallToken(url.split('/').pop(), 'CA-sb-live', { audience: LIVE_TOKEN_AUDIENCE })).toBe(true);
    expect(verifyCallToken(url.split('/').pop(), 'CA-sb-live')).toBe(false);
    expect(stamp).toEqual({
      cell: '71', voice: 'marin', started_at: expect.any(String), reserved_usd: PER_CALL_RESERVE_USD,
      stream_token_sha256: callTokenDigest(url.split('/').pop()),
    });
    expect(update.mock.calls[0][0].metadata.sql).toContain("COALESCE(metadata, '{}'::jsonb) || ?::jsonb");
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
  });

  test('GATE_VOICE_SANDBOX_RECORDING: a call the answer webhook stamped is recorded on cell 71 after the disclosure and before the Stream; an unstamped call, a refused call and the gate off are not', async () => {
    process.env.GATE_VOICE_GPT_LIVE_TEST = 'true';
    process.env.GATE_VOICE_SANDBOX_RECORDING = 'true';
    const render = async (stamp, prime = {}) => {
      primeLive({ rowMetadata: { relay_sandbox: true, [RECORDING_STAMP]: stamp }, ...prime });
      const res = mockRes();
      await handlerFor('/relay-sandbox/cell')(cell('71', 'CA-sb-live', { extra: { From: STAFF_PHONE } }), res);
      return res.body;
    };
    const xml = await render(true);
    expect(xml).toMatch(new RegExp(`^<\\?xml version="1.0" encoding="UTF-8"\\?><Response><Play>https://[^<]+\\.mp3</Play>${SANDBOX_RECORDING}<Connect action="/api/webhooks/twilio/relay-sandbox/live-complete"><Stream `));
    expect(xml.split('<Recording')).toHaveLength(2);
    expect(xml).not.toMatch(/recordingStatusCallback/i);
    // Not stamped at answer: the staff number on this callback changes nothing.
    expect(await render(false)).toMatch(/<\/Play><Connect action=/);
    // A refused call (the budget is used up) plays a notice and hangs up: nothing to record.
    const refused = await render(true, { usd: 5 });
    expect(refused).toContain('budget is used up');
    expect(refused).not.toMatch(/<Start|<Recording/);
    // The relay went away between the answer and the key press: the live cell says so and hangs up.
    isRelayAttached.mockImplementation(() => false);
    expect(await render(true)).not.toMatch(/<Start|<Recording/);
    isRelayAttached.mockImplementation(() => true);
    delete process.env.GATE_VOICE_SANDBOX_RECORDING;
    expect(await render(true)).toMatch(/<\/Play><Connect action=/);
  });

  test('gate on: 72 selects the delta voice', async () => {
    process.env.GATE_VOICE_GPT_LIVE_TEST = 'true';
    const { update } = primeLive();
    const res = mockRes();
    await handlerFor('/relay-sandbox/cell')(cell('72'), res);
    expect(res.body).toContain('/ws/voice-live/CA-sb-live/');
    expect(JSON.parse(update.mock.calls[0][0].metadata.bindings[0]).gpt_live).toMatchObject({ cell: '72', voice: 'delta' });
  });

  test('gate on: any other code still takes the production path', async () => {
    process.env.GATE_VOICE_GPT_LIVE_TEST = 'true';
    primeLive();
    const res = mockRes();
    await handlerFor('/relay-sandbox/cell')(cell('09'), res);
    expect(res.body).toContain('speechModel="flux"');
    expect(res.body).not.toContain('<Stream');
  });

  test('a reservation that does not fit under $5 (settled costs, else reservations): a spoken notice and a hangup, no stamp, no stream', async () => {
    process.env.GATE_VOICE_GPT_LIVE_TEST = 'true';
    const { update, spent } = primeLive({ usd: 5 - PER_CALL_RESERVE_USD + 0.01 });
    const res = mockRes();
    await handlerFor('/relay-sandbox/cell')(cell('71'), res);
    expect(res.body).toContain('The GPT-Live test budget is used up. Goodbye.');
    expect(res.body).toContain('<Hangup/>');
    expect(res.body).not.toContain('<Stream');
    expect(update).not.toHaveBeenCalled();
    // the ledger table, never call_log (whose rows can be deleted): settled cost, else the reservation
    expect(spent.mock.calls[0][0].sql).toBe('COALESCE(SUM(COALESCE(cost_usd, reserved_usd)), 0) AS usd');
  });

  test('VOICE_GPT_LIVE_TEST_MAX_USD moves the cap; the whole reservation must fit', async () => {
    process.env.GATE_VOICE_GPT_LIVE_TEST = 'true';
    process.env.VOICE_GPT_LIVE_TEST_MAX_USD = '2';
    primeLive({ usd: 2 - PER_CALL_RESERVE_USD }); // exactly fits under 2
    let res = mockRes();
    await handlerFor('/relay-sandbox/cell')(cell('71'), res);
    expect(res.body).toContain('<Stream');
    primeLive({ usd: 2 - PER_CALL_RESERVE_USD + 0.01 }); // does not
    res = mockRes();
    await handlerFor('/relay-sandbox/cell')(cell('71'), res);
    expect(res.body).toContain('budget is used up');
  });

  test('the budget comparison is exact: $0.0450 spent + the $0.525 reservation fits a $0.57 cap; one ten-thousandth more does not', async () => {
    process.env.GATE_VOICE_GPT_LIVE_TEST = 'true';
    process.env.VOICE_GPT_LIVE_TEST_MAX_USD = '0.57';
    let res = mockRes();
    primeLive({ usd: '0.0450' });
    await handlerFor('/relay-sandbox/cell')(cell('71'), res);
    expect(res.body).toContain('<Stream');
    res = mockRes();
    primeLive({ usd: '0.0451' });
    await handlerFor('/relay-sandbox/cell')(cell('71'), res);
    expect(res.body).toContain('budget is used up');
  });

  test('a set VOICE_GPT_LIVE_TEST_MAX_USD that is not a plain number refuses the call; it never falls back to $5', async () => {
    process.env.GATE_VOICE_GPT_LIVE_TEST = 'true';
    for (const bad of ['', '   ', '$1', '-1', 'five', '1e3', '9'.repeat(400), '0.52499']) {
      process.env.VOICE_GPT_LIVE_TEST_MAX_USD = bad;
      const { insert } = primeLive();
      const res = mockRes();
      await handlerFor('/relay-sandbox/cell')(cell('71'), res);
      expect(res.body).toContain('not available right now');
      expect(res.body).not.toContain('<Stream');
      expect(insert).not.toHaveBeenCalled();
    }
  });

  test('a database error on the budget read or the stamp, or a call that already claimed a reservation (a repeated cell request), refuses the call (fail closed)', async () => {
    process.env.GATE_VOICE_GPT_LIVE_TEST = 'true';
    for (const opts of [{ budgetFails: true }, { stampFails: true }, { stampRows: 0 }, { claimed: false }]) {
      primeLive(opts);
      const res = mockRes();
      await handlerFor('/relay-sandbox/cell')(cell('71'), res);
      expect(res.body).toContain('not available right now');
      expect(res.body).toContain('<Hangup/>');
      expect(res.body).not.toContain('<Stream');
    }
  });

  test('a failed stamp write logs a bounded code, never the error message (it can echo the caller\'s numbers)', async () => {
    process.env.GATE_VOICE_GPT_LIVE_TEST = 'true';
    const { update } = primeLive({ stampFails: true });
    update.mockImplementation(() => Promise.reject(Object.assign(new Error('update call_log set metadata = {"from":"+19415550100","to":"+19412412993"}'), { code: '57014' })));
    logger.error.mockClear();
    const res = mockRes();
    await handlerFor('/relay-sandbox/cell')(cell('71'), res);
    expect(res.body).toContain('not available right now');
    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).toContain('code=57014');
    expect(logged).not.toMatch(/9415550100|9412412993|update call_log/);
  });

  test('relay not attached: the same spoken notice as the answer handler', async () => {
    process.env.GATE_VOICE_GPT_LIVE_TEST = 'true';
    primeLive();
    isRelayAttached.mockImplementation(() => false);
    const res = mockRes();
    await handlerFor('/relay-sandbox/cell')(cell('71'), res);
    expect(res.body).toContain('not attached');
    expect(res.body).not.toContain('<Stream');
  });

  test('a row that is not sandbox-sourced is refused before any of this', async () => {
    process.env.GATE_VOICE_GPT_LIVE_TEST = 'true';
    primeLive();
    const builder = { where: jest.fn(() => builder), first: jest.fn(async () => ({ source: 'twilio_voice' })) };
    db.mockImplementation(() => builder);
    const res = mockRes();
    await handlerFor('/relay-sandbox/cell')(cell('71'), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('<Stream');
  });

  test('/relay-sandbox/live-complete hangs up, and refuses a number that is not the sandbox', async () => {
    let res = mockRes();
    await handlerFor('/relay-sandbox/live-complete')({ body: { CallSid: 'CA-sb-live', To: SANDBOX } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<Hangup/>');
    res = mockRes();
    await handlerFor('/relay-sandbox/live-complete')({ body: { CallSid: 'CA-prod', To: '+19415550188' } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toContain('<Hangup/>');
  });
});

describe('sandboxRelayXml', () => {
  test('is the same builder every production leg uses, pointed at the sandbox action', () => {
    const xml = sandboxRelayXml({ callSid: 'CA-sb-9', cell: { relayAttrs: { speechModel: 'flux' }, relayProfileId: 'flux_balanced_v1' } });
    expect(xml).toContain('<Connect action="/api/webhooks/twilio/relay-complete?sandbox=1" method="POST">');
    expect(xml).toContain('speechModel="flux"');
    expect(xml).toContain('welcomeGreeting=');
  });

  // Codex r1 P1 on #4947.
  test('a cell carrying language: "multi" (Flux Multilingual) ALSO gets the <Parameter lang=es> Spanish marker', () => {
    const xml = sandboxRelayXml({ callSid: 'CA-sb-multi', cell: { relayAttrs: { speechModel: 'flux' }, relayProfileId: 'flux_multilingual_es_v1', language: 'multi' } });
    expect(xml).toContain('language="multi"');
    expect(xml).toContain('<Parameter name="lang" value="es" />');
  });

  // Codex r2 P2 on #4947.
  test('a cell carrying language: "multi" gets the Spanish welcome opener, not buildRelayTwiML\'s English default', () => {
    const xml = sandboxRelayXml({ callSid: 'CA-sb-multi-greeting', cell: { relayAttrs: { speechModel: 'flux' }, relayProfileId: 'flux_multilingual_es_v1', language: 'multi' } });
    const escaped = spanishWelcomeGreeting().replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    expect(xml).toContain(`welcomeGreeting="${escaped}"`);
  });

  test('a cell with no `language` key renders no lang parameter and the English default greeting — byte-identical to before this profile existed', () => {
    const xml = sandboxRelayXml({ callSid: 'CA-sb-plain', cell: { relayAttrs: { speechModel: 'flux' }, relayProfileId: 'flux_balanced_v1' } });
    expect(xml).not.toContain('<Parameter name="lang"');
    expect(xml).not.toContain(spanishWelcomeGreeting());
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
