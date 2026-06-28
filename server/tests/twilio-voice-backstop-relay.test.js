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
  appendWsKey,
  maskPhone,
} = require('../services/voice-agent/relay-protocol');

const { agentHandoffKind, appendAgentHandoff } = voiceRouter._test;

const RELAY_URL = 'wss://portal.example.com/ws/voice-agent';

describe('agentHandoffKind — reachability reflects ACTUAL relay attach', () => {
  afterEach(() => isRelayAttached.mockReset());

  test('no endpoint → none', () => {
    isRelayAttached.mockReturnValue(true);
    expect(agentHandoffKind({})).toBe('none');
    expect(agentHandoffKind({ agentEndpoint: '   ' })).toBe('none');
    expect(agentHandoffKind(null)).toBe('none');
  });

  test('wss endpoint → relay only when the ws server actually attached', () => {
    isRelayAttached.mockReturnValue(true);
    expect(agentHandoffKind({ agentEndpoint: RELAY_URL })).toBe('relay');
    expect(agentHandoffKind({ agentEndpoint: 'ws://localhost:3000/ws/voice-agent' })).toBe('relay');
  });

  test('wss endpoint → relay_disabled when the ws server did NOT attach', () => {
    isRelayAttached.mockReturnValue(false);
    expect(agentHandoffKind({ agentEndpoint: RELAY_URL })).toBe('relay_disabled');
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
    expect(xml).not.toContain('<Dial');
  });

  test('omits the key when no secret is configured (fail-closed is enforced at attach, not here)', () => {
    delete process.env.VOICE_RELAY_WS_SECRET;
    const xml = buildRelayTwiML({ wsUrl: RELAY_URL });
    expect(xml).toContain(`url="${RELAY_URL}"`);
    expect(xml).not.toContain('key=');
  });
});

describe('relay-protocol auth/PII helpers', () => {
  test('appendWsKey appends key, respects existing query, no-op without secret', () => {
    expect(appendWsKey('wss://h/ws', 'sek')).toBe('wss://h/ws?key=sek');
    expect(appendWsKey('wss://h/ws?x=1', 'sek')).toBe('wss://h/ws?x=1&key=sek');
    expect(appendWsKey('wss://h/ws?key=already', 'sek')).toBe('wss://h/ws?key=already');
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
