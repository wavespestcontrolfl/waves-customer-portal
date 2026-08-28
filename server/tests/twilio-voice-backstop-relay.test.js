/**
 * No-answer backstop → ConversationRelay graduation + the Codex P0/P1 hardening.
 *
 * The /voice + /call-complete routing DECISION (decideVoiceRoute) is covered by
 * voice-route-decision.test.js. These tests cover the glue that turns a decision
 * of `agent` into the correct, SAFE TwiML:
 *   - agentHandoffKind(): classifies the endpoint, and treats a wss agent as
 *     reachable ('relay') only when the relay ws server ACTUALLY attached
 *     (isRelayAttached) — not just the env flag — so a half-configured relay
 *     falls through to voicemail instead of a dead endpoint (P1).
 *   - appendAgentHandoff(): only ever <Dial>s a PSTN/SIP agent; refuses a wss
 *     endpoint so it can never dial a WebSocket URL as a phone number.
 *   - buildRelayTwiML(): emits <Connect><ConversationRelay> carrying the shared
 *     secret `key` that authenticates the ws upgrade (P0) + the disclosure
 *     greeting.
 *   - appendWsKey()/maskPhone(): the auth-URL + PII-log helpers.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio-failure-alerts', () => ({
  alertTwilioFailure: jest.fn(),
  isFailureStatus: jest.fn(() => false),
}));
jest.mock('../services/conversations', () => ({
  recordTouchpoint: jest.fn(),
  syncVoiceMessageForCall: jest.fn(),
}));
jest.mock('../models/db', () => jest.fn());
// Control actual relay-attach state (the webhook consults this, not the env flag).
jest.mock('../services/voice-agent/relay-server', () => ({ isRelayAttached: jest.fn() }));

const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;
const voiceRouter = require('../routes/twilio-voice-webhook');
const { isRelayAttached } = require('../services/voice-agent/relay-server');
const {
  buildRelayTwiML,
  DEFAULT_WELCOME_GREETING,
  defaultWelcomeGreeting,
  agentName,
  DEFAULT_TTS_VOICE_ID,
  appendCallAuth,
  mintCallToken,
  verifyCallToken,
  CALL_TOKEN_TTL_MS,
  maskPhone,
} = require('../services/voice-agent/relay-protocol');

const { agentHandoffKind, appendAgentHandoff } = voiceRouter._test;

const RELAY_URL = 'wss://portal.example.com/ws/voice-agent';

describe('agentHandoffKind — reachability reflects ACTUAL relay attach', () => {
  let savedPortalUrl;
  beforeEach(() => {
    savedPortalUrl = process.env.PUBLIC_PORTAL_URL;
    process.env.PUBLIC_PORTAL_URL = 'https://portal.example.com'; // trusts RELAY_URL's host
  });
  afterEach(() => {
    isRelayAttached.mockReset();
    if (savedPortalUrl === undefined) delete process.env.PUBLIC_PORTAL_URL;
    else process.env.PUBLIC_PORTAL_URL = savedPortalUrl;
  });

  test('no endpoint → none', () => {
    isRelayAttached.mockReturnValue(true);
    expect(agentHandoffKind({})).toBe('none');
    expect(agentHandoffKind({ agentEndpoint: '   ' })).toBe('none');
    expect(agentHandoffKind(null)).toBe('none');
  });

  test('valid relay endpoint → relay only when the ws server actually attached', () => {
    isRelayAttached.mockReturnValue(true);
    expect(agentHandoffKind({ agentEndpoint: RELAY_URL })).toBe('relay');
    expect(agentHandoffKind({ agentEndpoint: 'ws://localhost:3000/ws/voice-agent' })).toBe('relay');
  });

  test('valid relay endpoint → relay_disabled when the ws server did NOT attach', () => {
    isRelayAttached.mockReturnValue(false);
    expect(agentHandoffKind({ agentEndpoint: RELAY_URL })).toBe('relay_disabled');
  });

  test('malformed or untrusted-host ws/wss endpoint → relay_disabled (never relay, never dialed)', () => {
    isRelayAttached.mockReturnValue(true); // even when the server is up
    expect(agentHandoffKind({ agentEndpoint: 'wss://portal.example.com/wrong-path' })).toBe('relay_disabled'); // wrong path
    expect(agentHandoffKind({ agentEndpoint: 'wss://attacker.example/ws/voice-agent' })).toBe('relay_disabled'); // untrusted host — would leak the secret
    expect(agentHandoffKind({ agentEndpoint: 'ws://evil.example.com/ws/voice-agent' })).toBe('relay_disabled'); // ws:// only allowed on localhost
    expect(agentHandoffKind({ agentEndpoint: 'wss://not a url' })).toBe('relay_disabled');
  });

  test('PSTN number / SIP URI → dial regardless of relay attach', () => {
    isRelayAttached.mockReturnValue(true);
    expect(agentHandoffKind({ agentEndpoint: '+19415551234' })).toBe('dial');
    isRelayAttached.mockReturnValue(false);
    expect(agentHandoffKind({ agentEndpoint: 'sip:agent@waves.sip.twilio.com' })).toBe('dial');
  });
});

describe('appendAgentHandoff never dials a wss endpoint', () => {
  test('refuses a wss (ConversationRelay) endpoint: returns false, no <Dial>', () => {
    const twiml = new VoiceResponse();
    const ok = appendAgentHandoff(twiml, { agentEndpoint: RELAY_URL }, { callerId: '+19415550000' });
    expect(ok).toBe(false);
    const xml = twiml.toString();
    expect(xml).not.toContain('<Dial');
    expect(xml).not.toContain('voice-agent');
  });

  test('returns false for an empty endpoint', () => {
    const twiml = new VoiceResponse();
    expect(appendAgentHandoff(twiml, { agentEndpoint: '' })).toBe(false);
    expect(twiml.toString()).not.toContain('<Dial');
  });

  test('dials a PSTN number agent with the /agent-fallback action (fail-open)', () => {
    const twiml = new VoiceResponse();
    const ok = appendAgentHandoff(twiml, { agentEndpoint: '+19415551234' }, { callerId: '+19415550000' });
    expect(ok).toBe(true);
    const xml = twiml.toString();
    expect(xml).toContain('<Dial');
    expect(xml).toContain('<Number>+19415551234</Number>');
    expect(xml).toContain('action="/api/webhooks/twilio/agent-fallback"');
  });

  test('dials a SIP URI agent', () => {
    const twiml = new VoiceResponse();
    const ok = appendAgentHandoff(twiml, { agentEndpoint: 'sip:agent@waves.sip.twilio.com' });
    expect(ok).toBe(true);
    expect(twiml.toString()).toContain('<Sip>sip:agent@waves.sip.twilio.com</Sip>');
  });
});

describe('buildRelayTwiML — authenticates the upgrade + disclosure greeting', () => {
  let saved;
  beforeEach(() => { saved = process.env.VOICE_RELAY_WS_SECRET; });
  afterEach(() => {
    if (saved === undefined) delete process.env.VOICE_RELAY_WS_SECRET;
    else process.env.VOICE_RELAY_WS_SECRET = saved;
  });

  // ⭐ THE SECRET ITSELF NEVER GOES IN THE URL. It used to: one reusable string
  // in a query param that Twilio writes to its logs, and the only credential the
  // endpoint had. The URL now carries a token minted for THIS CallSid that dies
  // in minutes, so a captured URL buys a session on a call that already ended.
  test('embeds a per-call token — never the secret — plus the disclosure greeting', () => {
    process.env.VOICE_RELAY_WS_SECRET = 'shh-secret-123';
    const xml = buildRelayTwiML({ wsUrl: RELAY_URL, callSid: 'CA-live-1' });
    expect(xml).toContain('<Connect>');
    expect(xml).toContain('<ConversationRelay ');
    expect(xml).toContain('callSid=CA-live-1');
    expect(xml).toMatch(/t=v1\.\d+\.[0-9a-f]{16}\.[0-9a-f]{32}/);
    expect(xml).toContain('&amp;t='); // the URL is XML-escaped inside the attribute
    expect(xml).not.toContain('shh-secret-123'); // the minting key stays server-side
    expect(xml).not.toContain('key=');
    expect(xml).toContain('welcomeGreeting=');
    // Owner ruling 2026-08-28: the opener carries NO recording/AI notice — the
    // greeting MP3 that precedes the relay on every production path does.
    expect(DEFAULT_WELCOME_GREETING.toLowerCase()).not.toMatch(/recorded|automated|assistant|ai\b/);
    // The opener plays in full — non-interruptible.
    expect(xml).toContain('welcomeGreetingInterruptible="none"');
    expect(xml).not.toContain('<Dial');
  });

  test('a stale `key` param on an operator-supplied endpoint is stripped, never re-emitted', () => {
    process.env.VOICE_RELAY_WS_SECRET = 'shh-secret-123';
    const xml = buildRelayTwiML({ wsUrl: `${RELAY_URL}?key=old-shared-secret`, callSid: 'CA-live-2' });
    expect(xml).not.toContain('old-shared-secret');
    expect(xml).not.toContain('key=');
    expect(xml).toContain('callSid=CA-live-2');
  });

  test('no secret, or no CallSid, mints nothing — the server then refuses the upgrade', () => {
    delete process.env.VOICE_RELAY_WS_SECRET;
    const xml = buildRelayTwiML({ wsUrl: RELAY_URL, callSid: 'CA-live-3' });
    expect(xml).toContain(`url="${RELAY_URL}"`);
    expect(xml).not.toContain('t=');
    process.env.VOICE_RELAY_WS_SECRET = 'shh-secret-123';
    const noSid = buildRelayTwiML({ wsUrl: RELAY_URL });
    expect(noSid).toContain(`url="${RELAY_URL}"`);
    expect(noSid).not.toContain('shh-secret-123');
  });

  test('adds the <Connect action> fallback when an action is provided, omits it otherwise', () => {
    delete process.env.VOICE_RELAY_WS_SECRET;
    expect(buildRelayTwiML({ wsUrl: RELAY_URL, action: '/api/webhooks/twilio/relay-complete' }))
      .toContain('<Connect action="/api/webhooks/twilio/relay-complete" method="POST">');
    const noAction = buildRelayTwiML({ wsUrl: RELAY_URL });
    expect(noAction).toContain('<Connect>');
    expect(noAction).not.toContain('action=');
  });
});

describe('buildRelayTwiML — Sandy persona parity (voice + greeting)', () => {
  const savedEnv = {};
  const KEYS = ['VOICE_RELAY_TTS_VOICE', 'VOICE_RELAY_GREETING', 'VOICE_AGENT_NAME', 'VOICE_RELAY_WS_SECRET'];
  beforeEach(() => { for (const k of KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => {
    for (const k of KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  test('default voice id is the Sandy voice, env-overridable', () => {
    expect(DEFAULT_TTS_VOICE_ID).toBe('21m00Tcm4TlvDq8ikWAM');
    expect(buildRelayTwiML({ wsUrl: RELAY_URL })).toContain('voice="21m00Tcm4TlvDq8ikWAM"');
    process.env.VOICE_RELAY_TTS_VOICE = 'custom-voice-id';
    expect(buildRelayTwiML({ wsUrl: RELAY_URL })).toContain('voice="custom-voice-id"');
  });

  test('default greeting is the bare owner-ruled opener — name + day-part, no notice', () => {
    const greeting = defaultWelcomeGreeting();
    expect(greeting).toContain('Sandy');
    expect(greeting.toLowerCase()).not.toMatch(/recorded|automated|assistant/);
    expect(greeting).toMatch(/^Waves, this is Sandy\. How can I help you this (morning|afternoon|evening)\?$/);
    expect(greeting).toMatch(/How can I help you this (morning|afternoon|evening)\?$/);
    expect(greeting).not.toContain('{dayPart}');
    expect(buildRelayTwiML({ wsUrl: RELAY_URL })).toContain('Sandy');
  });

  test('the greeting day-part follows the ET clock at render time (owner ruling 2026-08-28)', () => {
    const { greetingDayPart } = require('../services/voice-agent/relay-protocol');
    expect(greetingDayPart(new Date('2026-08-28T12:30:00Z'))).toBe('this morning');   // 08:30 ET
    expect(greetingDayPart(new Date('2026-08-28T15:59:00Z'))).toBe('this morning');   // 11:59 ET
    expect(greetingDayPart(new Date('2026-08-28T16:00:00Z'))).toBe('this afternoon'); // 12:00 ET
    expect(greetingDayPart(new Date('2026-08-28T20:59:00Z'))).toBe('this afternoon'); // 16:59 ET
    expect(greetingDayPart(new Date('2026-08-28T21:00:00Z'))).toBe('this evening');   // 17:00 ET
    expect(greetingDayPart(new Date('2026-08-29T03:30:00Z'))).toBe('this evening');   // 23:30 ET
    expect(defaultWelcomeGreeting(new Date('2026-08-28T21:00:00Z'))).toContain('How can I help you this evening?');
  });

  test('VOICE_AGENT_NAME renames her; VOICE_RELAY_GREETING overrides the whole line', () => {
    expect(agentName()).toBe('Sandy');
    process.env.VOICE_AGENT_NAME = 'Marge';
    expect(agentName()).toBe('Marge');
    expect(defaultWelcomeGreeting()).toContain('Marge');
    // The override is used VERBATIM — nothing is appended (the notice lives in
    // the greeting MP3, not here).
    process.env.VOICE_RELAY_GREETING = 'Hi, this is Sandy! How can I help you today?';
    expect(defaultWelcomeGreeting()).toBe('Hi, this is Sandy! How can I help you today?');
    expect(buildRelayTwiML({ wsUrl: RELAY_URL })).toContain('Hi, this is Sandy! How can I help you today?');
  });

  // ⭐ THE ONE GUARD LEFT: an override may not CLAIM to be human. The identity
  // lie — with or without a denial word — is discarded wholesale and the
  // canonical opener speaks instead.
  test('an override that claims to be human is replaced wholesale by the canonical opener', () => {
    for (const bad of [
      'Hi! You are speaking with a human assistant.',
      'This is a real person at Waves, how can I help?',
      "Thanks for calling Waves — I'm a live agent, what can I do for you?",
    ]) {
      process.env.VOICE_RELAY_GREETING = bad;
      const spoken = defaultWelcomeGreeting();
      expect(spoken).toMatch(/^Waves, this is Sandy\. How can I help you this (morning|afternoon|evening)\?$/);
      expect(spoken).not.toMatch(/human|real person|live agent/);
    }
    // …while any honest override is used exactly as written.
    process.env.VOICE_RELAY_GREETING = 'Thanks for calling Waves, this is Sandy.';
    expect(defaultWelcomeGreeting()).toBe('Thanks for calling Waves, this is Sandy.');
  });
});

describe('relay-protocol auth/PII helpers', () => {
  test('appendCallAuth carries CallSid + token, drops any stale key, no-op without a secret', () => {
    const url = appendCallAuth('wss://h/ws', { callSid: 'CA1', secret: 'sek' });
    expect(url).toMatch(/^wss:\/\/h\/ws\?callSid=CA1&t=v1\.\d+\.[0-9a-f]{16}\.[0-9a-f]{32}$/);
    expect(appendCallAuth('wss://h/ws?key=stale&x=1', { callSid: 'CA1', secret: 'sek' })).not.toContain('key=');
    expect(appendCallAuth('wss://h/ws?key=stale&x=1', { callSid: 'CA1', secret: 'sek' })).toContain('x=1');
    expect(appendCallAuth('wss://h/ws', { callSid: 'CA1', secret: '' })).toBe('wss://h/ws');
    expect(appendCallAuth('wss://h/ws', { callSid: '', secret: 'sek' })).toBe('wss://h/ws');
  });

  // ⭐ SANITIZED EVEN WHEN THERE IS NOTHING TO MINT WITH. A stale configured
  // endpoint can still carry the retired `?key=<secret>`; the old early return
  // handed it back VERBATIM on a mint failure — re-emitting the one credential
  // this design keeps out of URLs. A mint failure now renders a URL with no
  // credentials at all, which the server refuses (visible misconfig, no leak).
  test('a mint failure still strips a stale raw secret from the endpoint URL', () => {
    for (const opts of [
      { callSid: '', secret: 'sek' }, // no CallSid to bind
      { callSid: 'CA1', secret: '' }, // no secret to mint with
    ]) {
      const out = appendCallAuth('wss://h/ws?key=THE-RAW-SECRET&x=1', opts);
      expect(out).not.toContain('THE-RAW-SECRET');
      expect(out).not.toContain('key=');
      expect(out).toContain('x=1'); // only OWNED params are stripped
    }
  });

  // ⭐ BOUND TO ONE CALL, AND SHORT-LIVED IN BOTH DIRECTIONS. A stale token is
  // refused; so is one minted to live far longer than this code grants, which is
  // what keeps the lifetime a property of the server rather than of whoever
  // rendered the URL.
  test('two mints for the SAME call are DIFFERENT tokens (a Connect-action retry must survive the burn)', () => {
    const now = Date.UTC(2026, 7, 12, 12, 0, 0);
    const a = mintCallToken('CA1', { secret: 'sek', now });
    const b = mintCallToken('CA1', { secret: 'sek', now }); // same call, same second
    expect(a).not.toBe(b);
    expect(verifyCallToken(a, 'CA1', { secret: 'sek', now })).toBe(true);
    expect(verifyCallToken(b, 'CA1', { secret: 'sek', now })).toBe(true);
  });

  test('verifyCallToken accepts only its own CallSid, secret, and lifetime', () => {
    const now = Date.UTC(2026, 7, 12, 12, 0, 0);
    const token = mintCallToken('CA1', { secret: 'sek', now });
    expect(verifyCallToken(token, 'CA1', { secret: 'sek', now })).toBe(true);
    expect(verifyCallToken(token, 'CA2', { secret: 'sek', now })).toBe(false); // another call
    expect(verifyCallToken(token, 'CA1', { secret: 'other', now })).toBe(false); // forged
    expect(verifyCallToken(token, 'CA1', { secret: 'sek', now: now + CALL_TOKEN_TTL_MS + 1000 })).toBe(false); // expired
    expect(verifyCallToken('', 'CA1', { secret: 'sek', now })).toBe(false);
    expect(verifyCallToken('v1.999.abc', 'CA1', { secret: 'sek', now })).toBe(false); // malformed
    expect(verifyCallToken(`v9.${Math.floor((now + 1000) / 1000)}.${'a'.repeat(16)}.${'a'.repeat(32)}`, 'CA1', { secret: 'sek', now })).toBe(false);
    // The pre-nonce 3-part shape is not grandfathered — a deterministic token
    // is exactly what the nonce exists to retire.
    expect(verifyCallToken(`v1.${Math.floor((now + 1000) / 1000)}.${'a'.repeat(32)}`, 'CA1', { secret: 'sek', now })).toBe(false);
    // A far-future expiry is a token minted to live forever — refused.
    const farFuture = mintCallToken('CA1', { secret: 'sek', now, ttlMs: 400 * 24 * 60 * 60 * 1000 });
    expect(verifyCallToken(farFuture, 'CA1', { secret: 'sek', now })).toBe(false);
  });

  test('maskPhone keeps only the last 4 digits', () => {
    expect(maskPhone('+19415551234')).toBe('***1234');
    expect(maskPhone('5551234')).toBe('***1234');
    expect(maskPhone('12')).toBe('***');
    expect(maskPhone('')).toBe('***');
    expect(maskPhone(null)).toBe('***');
  });
});
