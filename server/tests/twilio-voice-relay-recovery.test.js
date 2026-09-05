/**
 * Sandy PR 2B — /relay-complete session recovery (GATE_VOICE_RELAY_RECOVERY).
 *
 * First failure ⇒ ONE fenced reconnect claim + the relay re-rendered for the
 * same CallSid (resumed greeting, `resumed=1`, same action / language /
 * sandbox); unconfirmed claim ⇒ today's fallback (a late-landing claim is
 * put back); second failure ⇒ the 2A staff ring when the office is open and
 * the transfer gate is on, else today's voicemail; sandbox second failure ⇒
 * today's relay_failed hangup. Gate off ⇒ byte-identical to today (pinned).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(() => Promise.resolve()), isFailureStatus: jest.fn(() => false), maskSid: (s) => String(s || '').slice(-4) }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(), syncVoiceMessageForCall: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/voice-agent/relay-server', () => ({ isRelayAttached: jest.fn(() => true) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/call-recording-processor', () => ({ recoverRecordingForCall: jest.fn() }));
jest.mock('../services/call-routing-config', () => ({ getCallRoutingConfig: jest.fn(async () => ({ agentEndpoint: 'wss://portal.wavespestcontrol.com/ws/voice-agent', spanishVoice: 'es-voice-1' })) }));
jest.mock('../services/voice-route-decision', () => ({ decideVoiceRoute: jest.fn(() => ({ action: 'agent', reason: 'test' })) }));
jest.mock('../services/voice-agent/relay-context', () => ({
  ...jest.requireActual('../services/voice-agent/relay-context'),
  loadOfficeHours: jest.fn(async () => ({ open: true })),
  isOfficeOpenAt: jest.fn(() => true),
}));

const db = require('../models/db');
const voiceRouter = require('../routes/twilio-voice-webhook');
const { loadOfficeHours, isOfficeOpenAt } = require('../services/voice-agent/relay-context');

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
function primeDb({ claimRows = 1, firstRow = { metadata: { relay_session_claim_owner: 'nonce-1' } } } = {}) {
  const updates = [];
  const guardQ = { whereNull: jest.fn().mockReturnThis(), orWhereNotIn: jest.fn().mockReturnThis(), orWhere: jest.fn().mockReturnThis() };
  const builder = {
    update: jest.fn(async (patch) => { updates.push(patch); return patch.metadata && String(patch.metadata.sql || '').includes('relay_reconnects') ? claimRows : 1; }),
    where: jest.fn((arg) => { if (typeof arg === 'function') arg(guardQ); return builder; }),
    whereRaw: jest.fn(() => builder),
    whereIn: jest.fn(() => builder),
    whereNull: jest.fn(() => builder),
    first: jest.fn(async () => firstRow),
    select: jest.fn(() => builder),
  };
  db.mockReturnValue(builder);
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return { builder, updates, guardQ };
}

const FAILED = { CallSid: 'CA-rc-1', ErrorCode: '64105' };
let savedNumbers;
beforeEach(() => {
  savedNumbers = process.env.WAVES_FALLBACK_FORWARD_NUMBERS;
  process.env.WAVES_FALLBACK_FORWARD_NUMBERS = '+19415550001';
  process.env.VOICE_RELAY_WS_SECRET = 'test-secret';
  process.env.PUBLIC_PORTAL_URL = 'https://portal.wavespestcontrol.com';
  jest.clearAllMocks();
  loadOfficeHours.mockResolvedValue({ open: true });
  isOfficeOpenAt.mockReturnValue(true);
});
afterEach(() => {
  delete process.env.GATE_VOICE_RELAY_RECOVERY;
  delete process.env.GATE_VOICE_RELAY_TRANSFER;
  if (savedNumbers === undefined) delete process.env.WAVES_FALLBACK_FORWARD_NUMBERS; else process.env.WAVES_FALLBACK_FORWARD_NUMBERS = savedNumbers;
});

describe('/relay-complete — gate OFF is byte-identical to today', () => {
  test('a failed session ⇒ the voicemail stamp + recorder; no reconnect claim, no relay', async () => {
    const { updates } = primeDb();
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: {} }, res);
    expect(res.body).toContain('<Record');
    expect(res.body).not.toContain('ConversationRelay');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual(expect.objectContaining({ answered_by: 'voicemail', call_outcome: 'voicemail' }));
  });
});

describe('/relay-complete — first failure reconnects ONCE', () => {
  test('the claim is ONE fenced UPDATE and the relay re-renders: same action, resumed greeting, resumed=1, token minted after the stamp', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { builder, updates, guardQ } = primeDb();
    const res = mockRes();
    const before = Date.now();
    await handlerFor('/relay-complete')({ body: FAILED, query: {} }, res);
    // the claim
    const claim = updates.find((u) => u.metadata && String(u.metadata.sql).includes('relay_reconnects'));
    expect(claim).toEqual(expect.objectContaining({ call_outcome: null, status: 'in-progress', answered_by: 'ai_agent' }));
    expect(claim.metadata.bindings[0]).toBeGreaterThanOrEqual(before);
    expect(builder.whereRaw).toHaveBeenCalledWith("COALESCE((metadata->>'relay_reconnects')::int, 0) < ?", [1]);
    expect(guardQ.orWhere).toHaveBeenCalledWith('call_outcome', 'ai_handled');
    // no voicemail stamp on this path
    expect(updates.some((u) => u.call_outcome === 'voicemail')).toBe(false);
    // the render
    expect(res.body).toContain('<Connect action="/api/webhooks/twilio/relay-complete" method="POST">');
    expect(res.body).toContain('<ConversationRelay url="wss://portal.wavespestcontrol.com/ws/voice-agent?callSid=CA-rc-1&amp;t=v1.');
    expect(res.body).toContain('welcomeGreeting="Sorry, I lost you for a second — where were we?"');
    expect(res.body).toContain('<Parameter name="resumed" value="1" />');
    expect(res.body).not.toContain('<Record');
    expect(res.body).not.toContain('<Dial');
  });

  test('a Spanish caller reconnects on the Spanish action, language, voice and greeting', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb();
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: { lang: 'es' } }, res);
    expect(res.body).toContain('<Connect action="/api/webhooks/twilio/relay-complete?lang=es" method="POST">');
    expect(res.body).toContain('language="es-US"');
    expect(res.body).toContain('voice="es-voice-1"');
    expect(res.body).toContain('welcomeGreeting="Disculpe, se cortó por un segundo. ¿En qué estábamos?"');
    expect(res.body).toContain('<Parameter name="resumed" value="1" />');
    expect(res.body).toContain('<Parameter name="lang" value="es" />');
  });

  test('a sandbox failure reconnects on the sandbox action with the sandbox socket — never staff, never voicemail', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    process.env.SERVER_DOMAIN = 'preview.example.test';
    primeDb();
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: { sandbox: '1' } }, res);
    delete process.env.SERVER_DOMAIN;
    expect(res.body).toContain('<Connect action="/api/webhooks/twilio/relay-complete?sandbox=1" method="POST">');
    expect(res.body).toContain('url="wss://preview.example.test/ws/voice-agent?callSid=CA-rc-1');
    expect(res.body).not.toContain('<Record');
    expect(res.body).not.toContain('<Hangup');
  });

  test('an UNCONFIRMED claim (timeout) ⇒ today\'s voicemail, and a claim that lands later is put back (fenced on its own stamp)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    jest.useFakeTimers();
    const { builder, updates } = primeDb();
    let settleClaim;
    builder.update = jest.fn((patch) => { updates.push(patch); return patch.metadata && String(patch.metadata.sql || '').includes('relay_reconnects') ? new Promise((r) => { settleClaim = r; }) : Promise.resolve(1); });
    const res = mockRes();
    const p = handlerFor('/relay-complete')({ body: { CallSid: 'CA-rc-hung', ErrorCode: '64105' }, query: {} }, res);
    await jest.advanceTimersByTimeAsync(4000);
    await p;
    expect(res.body).toContain('<Record');
    expect(res.body).not.toContain('ConversationRelay');
    expect(updates.some((u) => u.call_outcome === 'voicemail' && u.answered_by === 'voicemail')).toBe(true);
    settleClaim(1); // the queued claim lands after the recorder started
    await jest.advanceTimersByTimeAsync(0);
    jest.useRealTimers();
    await new Promise((r) => setImmediate(r));
    const undo = updates[updates.length - 1];
    expect(undo).toEqual(expect.objectContaining({ call_outcome: 'voicemail', status: 'completed' }));
    expect(builder.whereRaw).toHaveBeenCalledWith("(metadata->>'relay_reconnect_ms')::bigint = ?", [expect.any(Number)]);
  });

  test('the claim landed but no relay is reachable ⇒ the row is put back and today\'s voicemail plays', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { getCallRoutingConfig } = require('../services/call-routing-config');
    getCallRoutingConfig.mockResolvedValueOnce({ agentEndpoint: '' });
    const { updates } = primeDb();
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: {} }, res);
    expect(res.body).toContain('<Record');
    expect(updates.some((u) => u.status === 'failed' && u.call_outcome === 'voicemail')).toBe(true); // the undo
    expect(updates[updates.length - 1]).toEqual(expect.objectContaining({ answered_by: 'voicemail', call_outcome: 'voicemail' })); // today's stamp
  });
});

describe('/relay-complete — the second failure', () => {
  test('office open + transfer gate on ⇒ the 2A staff ring, owner-bound to the row\'s current claim owner, no voicemail', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    const { builder, updates } = primeDb({ claimRows: 0 });
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: {} }, res);
    expect(res.body).toContain('<Dial');
    expect(res.body).not.toContain('<Record');
    expect(res.body).not.toContain('ConversationRelay');
    expect(builder.whereRaw).toHaveBeenCalledWith(expect.stringContaining('relay_session_claim_owner'), ['nonce-1']);
    expect(updates.some((u) => u.metadata && String(u.metadata.sql).includes('relay_transfer_ring_at'))).toBe(true);
  });

  test('office closed, or the transfer gate off ⇒ today\'s voicemail', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    isOfficeOpenAt.mockReturnValue(false);
    primeDb({ claimRows: 0 });
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: {} }, res);
    expect(res.body).toContain('<Record');
    expect(res.body).not.toContain('<Dial');
    isOfficeOpenAt.mockReturnValue(true);
    delete process.env.GATE_VOICE_RELAY_TRANSFER;
    primeDb({ claimRows: 0 });
    const res2 = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: {} }, res2);
    expect(res2.body).toContain('<Record');
    expect(res2.body).not.toContain('<Dial');
  });

  test('a sandbox second failure ⇒ today\'s relay_failed stamp + hangup (never staff)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    const { updates } = primeDb({ claimRows: 0 });
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: { sandbox: '1' } }, res);
    expect(res.body).toContain('<Hangup/>');
    expect(res.body).not.toContain('<Dial');
    expect(updates.some((u) => u.call_outcome === 'relay_failed')).toBe(true);
  });

  test('a failed session carrying a transfer frame still takes the recovery path (the frame is not trusted on a failure)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb();
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: { ...FAILED, HandoffData: JSON.stringify({ reason: 'transfer' }) }, query: {} }, res);
    expect(res.body).toContain('ConversationRelay');
    expect(res.body).not.toContain('<Dial');
  });
});
