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
  appendWsKey,
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

  test('embeds the shared-secret key in the wss URL + the disclosure greeting', () => {
    process.env.VOICE_RELAY_WS_SECRET = 'shh-secret-123';
    const xml = buildRelayTwiML({ wsUrl: RELAY_URL });
    expect(xml).toContain('<Connect>');
    expect(xml).toContain('<ConversationRelay ');
    expect(xml).toContain('url="wss://portal.example.com/ws/voice-agent?key=shh-secret-123"');
    expect(xml).toContain('welcomeGreeting=');
    expect(DEFAULT_WELCOME_GREETING.toLowerCase()).toContain('automated assistant');
    // The disclosure greeting must play in full — non-interruptible (FL §934.03).
    expect(xml).toContain('welcomeGreetingInterruptible="none"');
    expect(xml).not.toContain('<Dial');
  });

  test('omits the key when no secret is configured (fail-closed is enforced at attach, not here)', () => {
    delete process.env.VOICE_RELAY_WS_SECRET;
    const xml = buildRelayTwiML({ wsUrl: RELAY_URL });
    expect(xml).toContain(`url="${RELAY_URL}"`);
    expect(xml).not.toContain('key=');
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

  test('default greeting names the agent AND keeps the §934.03 recorded-line + AI disclosure', () => {
    const greeting = defaultWelcomeGreeting();
    expect(greeting).toContain('Sandy');
    expect(greeting.toLowerCase()).toContain('recorded');
    expect(greeting.toLowerCase()).toContain('automated assistant');
    expect(greeting).toContain('How can I help you today?');
    expect(buildRelayTwiML({ wsUrl: RELAY_URL })).toContain('Sandy');
  });

  test('VOICE_AGENT_NAME renames her; VOICE_RELAY_GREETING overrides the whole line', () => {
    expect(agentName()).toBe('Sandy');
    process.env.VOICE_AGENT_NAME = 'Marge';
    expect(agentName()).toBe('Marge');
    expect(defaultWelcomeGreeting()).toContain('Marge');
    // ⚠️ THE GREETING *IS* THE FL §934.03 DISCLOSURE (the /voice backstop relies
    // on it), so a verbatim override could delete a legal disclosure with an
    // env-var edit. An override missing it gets the disclosure APPENDED rather
    // than rejected — refusing would strand live calls on a bad env value.
    process.env.VOICE_RELAY_GREETING = 'Hi, this is Sandy! How can I help you today?';
    const patched = defaultWelcomeGreeting();
    expect(patched).toContain('Hi, this is Sandy! How can I help you today?');
    expect(patched).toMatch(/record(ed|ing)/i);
    expect(patched).toMatch(/automated assistant/i);
    expect(buildRelayTwiML({ wsUrl: RELAY_URL })).toContain('Hi, this is Sandy! How can I help you today?');

    // An override that ALREADY discloses both is used verbatim — no double-up.
    process.env.VOICE_RELAY_GREETING =
      'Thanks for calling Waves. This call may be recorded and you are speaking with our automated assistant.';
    expect(defaultWelcomeGreeting()).toBe(process.env.VOICE_RELAY_GREETING);
    expect((defaultWelcomeGreeting().match(/automated assistant/gi) || []).length).toBe(1);
  });
});

describe('relay-protocol auth/PII helpers', () => {
  test('appendWsKey sets the current key (overwriting any stale one), no-op without secret', () => {
    expect(appendWsKey('wss://h/ws', 'sek')).toBe('wss://h/ws?key=sek');
    expect(appendWsKey('wss://h/ws?x=1', 'sek')).toBe('wss://h/ws?x=1&key=sek');
    expect(appendWsKey('wss://h/ws?key=stale', 'sek')).toBe('wss://h/ws?key=sek'); // overwrite, never reuse stale
    expect(appendWsKey('wss://h/ws', '')).toBe('wss://h/ws');
    expect(appendWsKey('wss://h/ws', undefined)).toBe('wss://h/ws');
  });

  test('maskPhone keeps only the last 4 digits', () => {
    expect(maskPhone('+19415551234')).toBe('***1234');
    expect(maskPhone('5551234')).toBe('***1234');
    expect(maskPhone('12')).toBe('***');
    expect(maskPhone('')).toBe('***');
    expect(maskPhone(null)).toBe('***');
  });
});
