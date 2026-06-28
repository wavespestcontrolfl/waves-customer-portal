/**
 * No-answer backstop → ConversationRelay graduation.
 *
 * The /voice + /call-complete routing decision (decideVoiceRoute) is covered by
 * voice-route-decision.test.js. These tests cover the NEW glue that turns a
 * decision of `agent` into the correct TwiML and never strands a call:
 *   - agentHandoffKind(): classifies the configured endpoint (relay / dial /
 *     relay_disabled when the ws server is off / none).
 *   - appendAgentHandoff(): only ever <Dial>s a PSTN/SIP agent; refuses a wss://
 *     (ConversationRelay) endpoint so it can never dial a wss URL as a number.
 *   - buildRelayTwiML(): emits <Connect><ConversationRelay> with the wss URL +
 *     the FL §934.03 / automated-assistant disclosure greeting.
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

const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;
const voiceRouter = require('../routes/twilio-voice-webhook');
const { buildRelayTwiML, DEFAULT_WELCOME_GREETING } = require('../services/voice-agent/relay-protocol');

const { agentHandoffKind, appendAgentHandoff } = voiceRouter._test;

const RELAY_URL = 'wss://portal.example.com/ws/voice-agent';

describe('no-answer backstop — agentHandoffKind', () => {
  let savedFlag;
  beforeEach(() => { savedFlag = process.env.VOICE_RELAY_ENABLED; });
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.VOICE_RELAY_ENABLED;
    else process.env.VOICE_RELAY_ENABLED = savedFlag;
  });

  test('no endpoint → none', () => {
    expect(agentHandoffKind({})).toBe('none');
    expect(agentHandoffKind({ agentEndpoint: '' })).toBe('none');
    expect(agentHandoffKind({ agentEndpoint: '   ' })).toBe('none');
    expect(agentHandoffKind(null)).toBe('none');
  });

  test('wss endpoint → relay only when VOICE_RELAY_ENABLED=true, else relay_disabled', () => {
    process.env.VOICE_RELAY_ENABLED = 'true';
    expect(agentHandoffKind({ agentEndpoint: RELAY_URL })).toBe('relay');
    expect(agentHandoffKind({ agentEndpoint: 'ws://localhost:3000/ws/voice-agent' })).toBe('relay');

    process.env.VOICE_RELAY_ENABLED = 'false';
    expect(agentHandoffKind({ agentEndpoint: RELAY_URL })).toBe('relay_disabled');
    delete process.env.VOICE_RELAY_ENABLED;
    expect(agentHandoffKind({ agentEndpoint: RELAY_URL })).toBe('relay_disabled');
  });

  test('PSTN number / SIP URI → dial (regardless of relay flag)', () => {
    process.env.VOICE_RELAY_ENABLED = 'true';
    expect(agentHandoffKind({ agentEndpoint: '+19415551234' })).toBe('dial');
    expect(agentHandoffKind({ agentEndpoint: 'sip:agent@waves.sip.twilio.com' })).toBe('dial');
    process.env.VOICE_RELAY_ENABLED = 'false';
    expect(agentHandoffKind({ agentEndpoint: '+19415551234' })).toBe('dial');
  });
});

describe('no-answer backstop — appendAgentHandoff never dials a wss endpoint', () => {
  test('refuses a wss (ConversationRelay) endpoint: returns false, appends no <Dial>', () => {
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

describe('no-answer backstop — buildRelayTwiML (the relay handoff shape)', () => {
  test('emits <Connect><ConversationRelay> with the wss URL + disclosure greeting', () => {
    const xml = buildRelayTwiML({ wsUrl: RELAY_URL });
    expect(xml).toContain('<Connect>');
    expect(xml).toContain('<ConversationRelay ');
    expect(xml).toContain(`url="${RELAY_URL}"`);
    // FL §934.03 + automated-assistant disclosure rides on welcomeGreeting.
    expect(xml).toContain('welcomeGreeting=');
    expect(DEFAULT_WELCOME_GREETING.toLowerCase()).toContain('automated assistant');
    expect(xml).not.toContain('<Dial');
  });
});
