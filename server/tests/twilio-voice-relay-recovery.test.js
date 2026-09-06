/**
 * Sandy PR 2B — /relay-complete session recovery (GATE_VOICE_RELAY_RECOVERY).
 *
 * First failure ⇒ ONE fenced reconnect claim + the relay re-rendered for the
 * same CallSid (resumed greeting, `resumed=1`, same action / language /
 * sandbox); unconfirmed claim ⇒ 503 without fallback instructions (a late claim is
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
// A row the resumed leg has CLAIMED (its token was minted after the stamp: claim gen ≥ relay_reconnect_ms).
const RECONNECTED_ROW = { metadata: { relay_session_claim_owner: 'nonce-2', relay_reconnects: 1, relay_reconnect_ms: 777, relay_session_claim_gen: 900 } };
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
  require('../config/feature-gates').isEnabled.mockReturnValue(true);
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
    // the render — the action carries the reconnect generation (= the claim's stamp)
    expect(res.body).toContain(`<Connect action="/api/webhooks/twilio/relay-complete?gen=${claim.metadata.bindings[0]}" method="POST">`);
    expect(res.body).toContain('<ConversationRelay url="wss://portal.wavespestcontrol.com/ws/voice-agent?callSid=CA-rc-1&amp;t=v1.');
    expect(res.body).toContain('welcomeGreeting="Sorry, I lost you for a second — where were we?"');
    expect(res.body).toContain('<Parameter name="resumed" value="1" />');
    expect(res.body).not.toContain('<Record');
    expect(res.body).not.toContain('<Dial');
  });

  test.each(['before', 'during'])('the production AI kill switch stops reconnect %s routing', async (when) => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb();
    const gates = require('../config/feature-gates');
    if (when === 'before') gates.isEnabled.mockImplementation((name) => name !== 'voiceAiAgent');
    else require('../services/call-routing-config').getCallRoutingConfig.mockImplementationOnce(async () => {
      gates.isEnabled.mockImplementation((name) => name !== 'voiceAiAgent');
      return { agentEndpoint: 'wss://portal.wavespestcontrol.com/ws/voice-agent' };
    });
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: {} }, res);
    expect(res.body).not.toContain('<ConversationRelay');
    expect(res.body).toContain('<Record');
  });

  test('an explicitly untuned first leg remains untuned after the active profile changes', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const saved = process.env.VOICE_RELAY_PROFILE;
    process.env.VOICE_RELAY_PROFILE = 'flux_fast_v1';
    try {
      primeDb({ firstRow: { metadata: { relay_profile_id: null, relay_attrs: null } } });
      const res = mockRes();
      await handlerFor('/relay-complete')({ body: FAILED, query: {} }, res);
      expect(res.body).toContain('<ConversationRelay');
      expect(res.body).not.toContain('name="relay_profile"');
      expect(res.body).not.toContain('speechModel="flux"');
    } finally {
      if (saved === undefined) delete process.env.VOICE_RELAY_PROFILE; else process.env.VOICE_RELAY_PROFILE = saved;
    }
  });

  test('a reissue during routing cannot mint a token newer than this response action', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { builder, updates } = primeDb();
    const routing = require('../services/call-routing-config').getCallRoutingConfig;
    routing.mockImplementationOnce(async () => {
      const stamp = updates.find((u) => u.metadata && String(u.metadata.sql).includes('relay_reconnects')).metadata.bindings[0];
      builder.first.mockResolvedValue({ metadata: { relay_reconnect_ms: stamp + 10, relay_reconnects: 1 } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { agentEndpoint: 'wss://portal.wavespestcontrol.com/ws/voice-agent' };
    });
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: {} }, res);
    const actionGen = Number(res.body.match(/gen=(\d+)/)[1]);
    const token = res.body.match(/&amp;t=([^"&]+)/)[1];
    const tokenGen = parseInt(token.split('.')[2].slice(0, 12), 16);
    expect(tokenGen).toBe(actionGen);
    expect(tokenGen).toBeLessThan((await builder.first()).metadata.relay_reconnect_ms);
    expect(require('../services/voice-agent/relay-protocol').verifyCallToken(token, FAILED.CallSid)).toBe(true);
  });

  test('a Spanish caller reconnects on the Spanish action, language, voice and greeting', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb();
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: { lang: 'es' } }, res);
    expect(res.body).toMatch(/<Connect action="\/api\/webhooks\/twilio\/relay-complete\?lang=es&amp;gen=\d+" method="POST">/);
    expect(res.body).toContain('language="es-US"');
    expect(res.body).toContain('voice="es-voice-1"');
    expect(res.body).toContain('welcomeGreeting="Disculpe, se cortó por un segundo. ¿En qué estábamos?"');
    expect(res.body).toContain('<Parameter name="resumed" value="1" />');
    expect(res.body).toContain('<Parameter name="lang" value="es" />');
  });

  test('Spanish reconnect retains the provider default when no Spanish voice was configured', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb();
    require('../services/call-routing-config').getCallRoutingConfig.mockResolvedValueOnce({ agentEndpoint: 'wss://portal.wavespestcontrol.com/ws/voice-agent' });
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: { lang: 'es' } }, res);
    expect(res.body).toContain('language="es-US"');
    expect(res.body).not.toMatch(/<ConversationRelay[^>]* voice=/);
  });

  test('a sandbox failure reconnects on the sandbox action with the sandbox socket — never staff, never voicemail — and with the SAME profile the first leg was stamped with (hook P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    process.env.SERVER_DOMAIN = 'preview.example.test';
    const { updates } = primeDb({ firstRow: { metadata: { relay_profile_id: 'flux_fast_v1', relay_attrs: { transcriptionProvider: 'Deepgram', speechModel: 'flux' } } } });
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: { sandbox: '1' } }, res);
    delete process.env.SERVER_DOMAIN;
    expect(res.body).toMatch(/<Connect action="\/api\/webhooks\/twilio\/relay-complete\?sandbox=1&amp;gen=\d+" method="POST">/);
    expect(res.body).toContain('url="wss://preview.example.test/ws/voice-agent?callSid=CA-rc-1');
    expect(res.body).toContain('speechModel="flux"');
    expect(res.body).toContain('<Parameter name="relay_profile" value="flux_fast_v1" />');
    expect(updates.some((u) => u.metadata && String(u.metadata.bindings && u.metadata.bindings[0]).includes('"relay_profile_id":"flux_fast_v1"'))).toBe(true); // re-stamped, same profile
    expect(res.body).not.toContain('<Record');
    expect(res.body).not.toContain('<Hangup');
  });

  test.each(['error', 'timeout'])('an unreadable original profile (%s) returns 503 without a replacement profile stamp', async (mode) => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { builder, updates } = primeDb();
    builder.first.mockImplementation(() => mode === 'error' ? Promise.reject(new Error('pool down')) : new Promise(() => {}));
    const res = mockRes();
    jest.useFakeTimers();
    try {
      const pending = handlerFor('/relay-complete')({ body: FAILED, query: {} }, res);
      await jest.advanceTimersByTimeAsync(1600);
      await pending;
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toMatch(/ConversationRelay|<Record|<Hangup/);
      expect(updates.some((patch) => JSON.stringify(patch).includes('relay_profile_id'))).toBe(false);
    } finally { jest.useRealTimers(); }
  });

  test('an UNCONFIRMED claim (timeout) ⇒ 503 without fallback instructions, and a claim that lands later is put back (fenced on its own stamp)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    jest.useFakeTimers();
    const { builder, updates } = primeDb();
    let settleClaim;
    builder.update = jest.fn((patch) => { updates.push(patch); return patch.metadata && String(patch.metadata.sql || '').includes('relay_reconnects') ? new Promise((r) => { settleClaim = r; }) : Promise.resolve(1); });
    const res = mockRes();
    const p = handlerFor('/relay-complete')({ body: { CallSid: 'CA-rc-hung', ErrorCode: '64105' }, query: {} }, res);
    await jest.advanceTimersByTimeAsync(4000);
    await p;
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain('<Record');
    expect(res.body).not.toContain('ConversationRelay');
    expect(updates.some((u) => u.call_outcome === 'voicemail' && u.answered_by === 'voicemail')).toBe(false);
    settleClaim(1); // the queued claim lands after the unconfirmed response
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
    const { builder, updates } = primeDb({ claimRows: 0, firstRow: RECONNECTED_ROW });
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: { gen: '777' } }, res);
    expect(res.body).toContain('<Dial');
    expect(res.body).not.toContain('<Record');
    expect(res.body).not.toContain('ConversationRelay');
    expect(builder.whereRaw).toHaveBeenCalledWith(expect.stringContaining('relay_session_claim_owner'), ['nonce-2']);
    expect(updates.some((u) => u.metadata && String(u.metadata.sql).includes('relay_transfer_ring_at'))).toBe(true);
  });

  test('the second-failure voicemail fallback stamps a TERMINAL status (the claim had put the row back to in-progress); a first failure / gate off does not touch status (codex r4 P2)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { updates } = primeDb({ claimRows: 0, firstRow: RECONNECTED_ROW });
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: { gen: '777' } }, res);
    expect(res.body).toContain('<Record');
    expect(updates.find((u) => u.call_outcome === 'voicemail')).toEqual(expect.objectContaining({ answered_by: 'voicemail', status: 'completed' }));
    delete process.env.GATE_VOICE_RELAY_RECOVERY;
    const { updates: off } = primeDb();
    await handlerFor('/relay-complete')({ body: FAILED, query: {} }, mockRes());
    expect(off.find((u) => u.call_outcome === 'voicemail')).not.toHaveProperty('status');
  });

  test('a second-failure ring that falls to voicemail inside the transfer helper (no staff numbers) still stamps a TERMINAL status (codex r5 P2)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    delete process.env.WAVES_FALLBACK_FORWARD_NUMBERS;
    const { updates, builder } = primeDb({ claimRows: 0, firstRow: RECONNECTED_ROW });
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: { gen: '777' } }, res);
    expect(res.body).toContain('<Record');
    expect(res.body).not.toContain('<Dial');
    expect(updates.some((u) => u.call_outcome === 'voicemail')).toBe(true);
    expect(updates.some((u) => u.status === 'completed' && !u.call_outcome)).toBe(true);
    expect(builder.where).toHaveBeenCalledWith('call_outcome', 'voicemail');
  });

  test('office closed, or the transfer gate off ⇒ today\'s voicemail', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    isOfficeOpenAt.mockReturnValue(false);
    primeDb({ claimRows: 0, firstRow: RECONNECTED_ROW });
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: { gen: '777' } }, res);
    expect(res.body).toContain('<Record');
    expect(res.body).not.toContain('<Dial');
    isOfficeOpenAt.mockReturnValue(true);
    delete process.env.GATE_VOICE_RELAY_TRANSFER;
    primeDb({ claimRows: 0, firstRow: RECONNECTED_ROW });
    const res2 = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: { gen: '777' } }, res2);
    expect(res2.body).toContain('<Record');
    expect(res2.body).not.toContain('<Dial');
  });

  test('an UNCONFIRMED owner read on the second failure ⇒ voicemail, never an empty response (codex r1 P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    const { builder } = primeDb({ claimRows: 0, firstRow: RECONNECTED_ROW });
    let reads = 0;
    builder.first = jest.fn(() => (++reads <= 1 ? Promise.resolve(RECONNECTED_ROW) : Promise.reject(new Error('pool down')))); // the reconnect-state read answers; the owner read fails
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: { gen: '777' } }, res);
    expect(res.body).toContain('<Record');
    expect(res.body).not.toContain('<Dial');
  });

  test('a sandbox second failure ⇒ today\'s relay_failed stamp + hangup (never staff)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    const { updates } = primeDb({ claimRows: 0, firstRow: RECONNECTED_ROW });
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: { sandbox: '1', gen: '777' } }, res);
    expect(res.body).toContain('<Hangup/>');
    expect(res.body).not.toContain('<Dial');
    expect(updates.some((u) => u.call_outcome === 'relay_failed')).toBe(true);
  });

  test('a Twilio RETRY of the first leg\'s failure (no gen / stale gen) on a row that already reconnected is IGNORED — the healthy resumed session is never ended (hook P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    for (const query of [{}, { gen: '1' }, { lang: 'es' }]) {
      const { updates } = primeDb({ claimRows: 0, firstRow: RECONNECTED_ROW });
      const res = mockRes();
      await handlerFor('/relay-complete')({ body: FAILED, query }, res);
      expect(res.body).toMatch(/^<\?xml[^>]*\?><Response\/>$/);
      expect(updates.filter((u) => u.call_outcome === 'voicemail' || (u.metadata && String(u.metadata.sql).includes('relay_transfer_ring_at')))).toHaveLength(0);
    }
    // …whereas a never-reconnected row that is simply not resumable (0 rows, reconnects 0) takes today's path.
    primeDb({ claimRows: 0, firstRow: { metadata: { relay_reconnects: 0 } } });
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: {} }, res);
    expect(res.body).toContain('<Record');
  });

  test.each([{ call_outcome: 'ai_transferred' }, { metadata: { relay_transfer_ring_at: '2026-01-01T00:00:00Z' } }])('a stale callback cannot replace a transfer before a resumed claim: %j', async (transfer) => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { updates } = primeDb({ claimRows: 0, firstRow: { ...transfer, metadata: {
      relay_reconnects: 1, relay_reconnect_ms: 777, relay_session_claim_gen: 500, ...transfer.metadata,
    } } });
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: {} }, res);
    expect(res.body).not.toContain('<Record');
    expect(res.body).not.toContain('<ConversationRelay');
    expect(updates.some((patch) => patch.call_outcome === 'voicemail')).toBe(false);
  });

  test('a retry of the first leg\'s callback whose reconnect RESPONSE was lost (row reconnected, claim still the first leg\'s) re-issues the reconnect on a FRESH stamp — never ends the call (codex r2 P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const firstLegStillOwns = { metadata: { relay_session_claim_owner: 'nonce-1', relay_reconnects: 1, relay_reconnect_ms: 777, relay_session_claim_gen: 500 } };
    const { builder, updates } = primeDb({ claimRows: 0, firstRow: firstLegStillOwns });
    const res = mockRes();
    const before = Date.now();
    await handlerFor('/relay-complete')({ body: FAILED, query: {} }, res);
    // the re-stamp: ONE fenced UPDATE — prior stamp, no claim at/after it, outcome still NULL (a compensated row is never re-rendered)
    const reissue = updates.find((u) => u.metadata && String(u.metadata.sql).includes("'relay_reconnect_ms'") && !String(u.metadata.sql).includes('relay_reconnects'));
    expect(reissue.metadata.bindings[0]).toBeGreaterThanOrEqual(before);
    expect(builder.whereRaw).toHaveBeenCalledWith("(metadata->>'relay_reconnect_ms')::bigint = ?", [777]);
    expect(builder.whereRaw).toHaveBeenCalledWith("COALESCE((metadata->>'relay_session_claim_gen')::bigint, 0) < ?", [777]);
    expect(builder.whereNull).toHaveBeenCalledWith('call_outcome');
    expect(res.body).toContain(`<Connect action="/api/webhooks/twilio/relay-complete?gen=${reissue.metadata.bindings[0]}" method="POST">`);
    expect(res.body).toContain('<ConversationRelay url="wss://portal.wavespestcontrol.com/ws/voice-agent?callSid=CA-rc-1&amp;t=v1.');
    expect(res.body).toContain('<Parameter name="resumed" value="1" />');
    expect(updates.some((u) => u.call_outcome === 'voicemail')).toBe(false);
    expect(updates.filter((u) => u.metadata && String(u.metadata.sql).includes('relay_reconnects'))).toHaveLength(1); // the one (refused) claim — no second reconnect
    // a row with NO claim record yet (verification pending on the first leg) reads the same way: no socket minted by the reconnect has claimed
    primeDb({ claimRows: 0, firstRow: { metadata: { relay_reconnects: 1, relay_reconnect_ms: 777 } } });
    const res2 = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: { lang: 'es' } }, res2);
    expect(res2.body).toMatch(/relay-complete\?lang=es&amp;gen=\d{13}/);
    // …but the resumed leg's OWN failure (gen = the stamp) is the second failure, not a replay
    primeDb({ claimRows: 0, firstRow: firstLegStillOwns });
    const res3 = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: { gen: '777' } }, res3);
    expect(res3.body).not.toContain('<ConversationRelay');
    expect(res3.body).toContain('<Record');
  });

  test('a replay whose re-stamp is REFUSED: a compensated (terminal) row takes today\'s voicemail; a row the resumed leg claimed meanwhile is ignored; an unconfirmed re-stamp returns 503 and a late one is put back (hook r21 P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const firstLegStillOwns = { metadata: { relay_session_claim_owner: 'nonce-1', relay_reconnects: 1, relay_reconnect_ms: 777, relay_session_claim_gen: 500 } };
    const isReissue = (patch) => patch.metadata && String(patch.metadata.sql).includes("'relay_reconnect_ms'") && !String(patch.metadata.sql).includes('relay_reconnects');
    // terminal row: the re-stamp matches 0 rows and the re-read still shows the first leg's claim ⇒ not resumable ⇒ voicemail
    let { builder, updates } = primeDb({ claimRows: 0, firstRow: firstLegStillOwns });
    builder.update.mockImplementation(async (patch) => { updates.push(patch); return isReissue(patch) || String(patch.metadata?.sql || '').includes('relay_reconnects') ? 0 : 1; });
    let res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: {} }, res);
    expect(res.body).not.toContain('<ConversationRelay');
    expect(res.body).toContain('<Record');
    expect(updates.some((u) => u.call_outcome === 'voicemail')).toBe(true);
    // the resumed leg claimed between the read and the re-stamp ⇒ ignored, never voicemail
    ({ builder, updates } = primeDb({ claimRows: 0, firstRow: firstLegStillOwns }));
    builder.update.mockImplementation(async (patch) => { updates.push(patch); return isReissue(patch) || String(patch.metadata?.sql || '').includes('relay_reconnects') ? 0 : 1; });
    builder.first.mockResolvedValueOnce(firstLegStillOwns).mockResolvedValueOnce(RECONNECTED_ROW);
    res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: {} }, res);
    expect(res.body).toMatch(/^<\?xml[^>]*\?><Response\/>$/);
    expect(updates.some((u) => u.call_outcome === 'voicemail')).toBe(false);
    // a CONCURRENT retry won the re-issue (the stamp moved) ⇒ this one is a duplicate, never the fallback (codex r3 P1)
    ({ builder, updates } = primeDb({ claimRows: 0, firstRow: firstLegStillOwns }));
    builder.update.mockImplementation(async (patch) => { updates.push(patch); return isReissue(patch) || String(patch.metadata?.sql || '').includes('relay_reconnects') ? 0 : 1; });
    builder.first.mockResolvedValueOnce(firstLegStillOwns).mockResolvedValueOnce({ metadata: { relay_session_claim_owner: 'nonce-1', relay_reconnects: 1, relay_reconnect_ms: 999, relay_session_claim_gen: 500 } });
    res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: {} }, res);
    expect(res.body).toMatch(/^<\?xml[^>]*\?><Response\/>$/);
    expect(updates.some((u) => u.call_outcome === 'voicemail')).toBe(false);
    // unconfirmed re-stamp ⇒ 503 with no fallback instructions; when it lands later it is put back, fenced on its own stamp AND on no claim at/after it
    ({ builder, updates } = primeDb({ claimRows: 0, firstRow: firstLegStillOwns }));
    let landReissue;
    builder.update.mockImplementation((patch) => {
      updates.push(patch);
      if (isReissue(patch)) return new Promise((resolve) => { landReissue = () => resolve(1); });
      return Promise.resolve(String(patch.metadata?.sql || '').includes('relay_reconnects') ? 0 : 1);
    });
    res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: {} }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain('<Record');
    expect(res.body).not.toContain('<ConversationRelay');
    builder.whereRaw.mockClear();
    landReissue();
    await new Promise((r) => setTimeout(r, 5));
    const reissueMs = updates.find(isReissue).metadata.bindings[0];
    const putBack = updates.find((u) => u.call_outcome === 'voicemail' && u.status === 'completed');
    expect(putBack).toBeTruthy();
    expect(builder.whereRaw).toHaveBeenCalledWith("(metadata->>'relay_reconnect_ms')::bigint = ?", [reissueMs]);
    expect(builder.whereRaw).toHaveBeenCalledWith("COALESCE((metadata->>'relay_session_claim_gen')::bigint, 0) < ?", [reissueMs]);
  });

  test.each([false, true])('an unconfirmed reconnect-state read never sends a healthy call to voicemail (reissue=%s)', async (reissue) => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { builder, updates } = primeDb({ claimRows: 0 });
    builder.update.mockImplementation(async (patch) => { updates.push(patch); return 0; });
    if (reissue) builder.first.mockResolvedValueOnce({ metadata: { relay_reconnects: 1, relay_reconnect_ms: 777, relay_session_claim_gen: 500 } });
    builder.first.mockRejectedValue(new Error('unavailable'));
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query: {} }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toMatch(/Record|Dial|Hangup/);
    expect(updates.some((patch) => patch.call_outcome === 'voicemail')).toBe(false);
  });

  test.each([{}, { sandbox: '1' }])('a fallback whose generation changed after the read issues no stale instructions: %j', async (query) => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { builder } = primeDb({ claimRows: 0, firstRow: { metadata: {} } });
    builder.update.mockResolvedValue(0); // the atomic fallback predicate lost to a reconnect
    const res = mockRes();
    await handlerFor('/relay-complete')({ body: FAILED, query }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/Record|Dial|Hangup/);
    expect(builder.whereRaw).toHaveBeenCalledWith("COALESCE((metadata->>'relay_reconnect_ms')::bigint, 0) = ?", [0]);
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
