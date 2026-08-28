/**
 * Spanish language vestibule (GATE_VOICE_SPANISH_MENU) — the ONE
 * language-selection TwiML, its eligibility ladder, the Gather action
 * contract, the Spanish relay leg, and the Spanish voicemail failover.
 * Gate off ⇒ the greeting renders as the bare <Play> it always was.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(), isFailureStatus: jest.fn(() => false) }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(), syncVoiceMessageForCall: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/voice-agent/relay-server', () => ({ isRelayAttached: jest.fn(() => true) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));

const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;
const { isEnabled } = require('../config/feature-gates');
const voiceRouter = require('../routes/twilio-voice-webhook');
const {
  languageVestibule, appendLanguageVestibule, vestibuleInnerXml, buildSpanishRelayTwiML,
  spanishSelected, appendVoicemailRecording, SPANISH_MENU_PROMPT, LANGUAGE_MENU_ACTION,
} = voiceRouter._test;
const { DEFAULT_WELCOME_GREETING_ES, SPANISH_LANGUAGE } = require('../services/voice-agent/relay-protocol');

const GREETING = 'https://assets.example/greeting.mp3';
const CONFIG = { agentEndpoint: 'wss://portal.example.com/ws/voice-agent', spanishMenuEnabled: true, spanishVoice: '' };
const VEST = { relayUrl: CONFIG.agentEndpoint, voice: null };

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockImplementation(() => true);
  process.env.VOICE_RELAY_WS_SECRET = 'test-secret';
  delete process.env.WAVES_VOICEMAIL_URL_ES;
  delete process.env.VOICE_RELAY_GREETING_ES;
});

describe('eligibility ladder — every leg fails closed', () => {
  test('all conditions met ⇒ vestibule with the relay url + optional voice', () => {
    expect(languageVestibule({ routingConfig: CONFIG, handoffKind: 'relay', reentry: false }))
      .toEqual({ relayUrl: CONFIG.agentEndpoint, voice: null });
    expect(languageVestibule({ routingConfig: { ...CONFIG, spanishVoice: 'abc' }, handoffKind: 'relay', reentry: false }).voice).toBe('abc');
  });
  test('gate off ⇒ null', () => {
    isEnabled.mockImplementation((g) => g !== 'voiceSpanishMenu');
    expect(languageVestibule({ routingConfig: CONFIG, handoffKind: 'relay', reentry: false })).toBeNull();
  });
  test('owner switch off / missing ⇒ null', () => {
    expect(languageVestibule({ routingConfig: { ...CONFIG, spanishMenuEnabled: false }, handoffKind: 'relay', reentry: false })).toBeNull();
    expect(languageVestibule({ routingConfig: { ...CONFIG, spanishMenuEnabled: 'true' }, handoffKind: 'relay', reentry: false })).toBeNull();
    expect(languageVestibule({ routingConfig: null, handoffKind: 'relay', reentry: false })).toBeNull();
  });
  test.each(['none', 'dial', 'relay_disabled'])('agent kind %s cannot run a Spanish session ⇒ null', (kind) => {
    expect(languageVestibule({ routingConfig: CONFIG, handoffKind: kind, reentry: false })).toBeNull();
  });
  test('a re-entry never re-offers the menu', () => {
    expect(languageVestibule({ routingConfig: CONFIG, handoffKind: 'relay', reentry: true })).toBeNull();
  });
});

describe('appendLanguageVestibule — the one implementation', () => {
  test('no vestibule ⇒ bare <Play>, byte-identical to the pre-feature greeting', () => {
    const twiml = new VoiceResponse();
    expect(appendLanguageVestibule(twiml, { greetingUrl: GREETING, vestibule: null })).toBe(false);
    const expected = new VoiceResponse();
    expected.play(GREETING);
    expect(twiml.toString()).toBe(expected.toString());
    expect(twiml.toString()).not.toContain('<Gather');
  });
  test('vestibule ⇒ greeting <Play> INSIDE the <Gather>, then the Spanish sentence, timeout 1, action ?lang=menu', () => {
    const twiml = new VoiceResponse();
    expect(appendLanguageVestibule(twiml, { greetingUrl: GREETING, vestibule: VEST })).toBe(true);
    const xml = twiml.toString();
    expect(xml).toMatch(/<Gather [^>]*input="dtmf"[^>]*>/);
    expect(xml).toMatch(/<Gather [^>]*numDigits="1"/);
    expect(xml).toMatch(/<Gather [^>]*timeout="1"/);
    expect(xml).toContain(`action="${LANGUAGE_MENU_ACTION}"`);
    expect(xml).not.toContain('actionOnEmptyResult'); // timeout falls through, never hits the action
    const gatherInner = xml.slice(xml.indexOf('<Gather'), xml.indexOf('</Gather>'));
    expect(gatherInner).toContain(`<Play>${GREETING}</Play>`);
    expect(gatherInner.indexOf('<Play>')).toBeLessThan(gatherInner.indexOf('<Say'));
    expect(gatherInner).toMatch(/<Say [^>]*language="es-US"[^>]*>Para español, oprima dos\.<\/Say>/);
    expect(gatherInner).toMatch(/<Say [^>]*voice="Polly\.Lupe-Neural"/);
    // Nothing else in the response: the caller's next verb is appended by the route.
    expect(xml.replace(/<Gather[\s\S]*<\/Gather>/, '')).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });
  test('null greeting (answers-first relay path) ⇒ Gather with only the Spanish sentence', () => {
    const twiml = new VoiceResponse();
    appendLanguageVestibule(twiml, { greetingUrl: null, vestibule: VEST });
    expect(twiml.toString()).not.toContain('<Play>');
    expect(twiml.toString()).toContain(SPANISH_MENU_PROMPT);
  });
  test('vestibuleInnerXml is the same builder unwrapped (no second copy of the markup)', () => {
    const twiml = new VoiceResponse();
    appendLanguageVestibule(twiml, { greetingUrl: null, vestibule: VEST });
    const inner = vestibuleInnerXml({ greetingUrl: null, vestibule: VEST });
    expect(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`).toBe(twiml.toString());
    expect(vestibuleInnerXml({ greetingUrl: GREETING, vestibule: null })).toBe('');
  });
});

describe('Gather action contract', () => {
  test.each([
    [{ Digits: '2' }, true],
    [{ Digits: ' 2 ' }, true],
    [{ Digits: '1' }, false], [{ Digits: '0' }, false], [{ Digits: '*' }, false], [{ Digits: '#' }, false],
    [{ Digits: '22' }, false], [{ Digits: '' }, false], [{}, false], [null, false], [{ Digits: 2 }, true], [{ Digits: ['2'] }, false],
  ])('Digits=%j ⇒ spanish=%s', (body, expected) => {
    expect(spanishSelected(body)).toBe(expected);
  });
});

describe('Spanish relay leg', () => {
  test('es-US session with the Spanish disclosure greeting, <Parameter lang=es>, relay-complete action, and NO voice by default', () => {
    const xml = buildSpanishRelayTwiML({ vestibule: VEST, callSid: 'CA123' });
    expect(xml).toContain('<Connect action="/api/webhooks/twilio/relay-complete" method="POST">');
    expect(xml).toMatch(/<ConversationRelay [^>]*language="es-US"/);
    expect(xml).toMatch(/<ConversationRelay [^>]*welcomeGreetingInterruptible="none"/);
    expect(xml).toContain('<Parameter name="lang" value="es" />');
    expect(xml).not.toMatch(/<ConversationRelay [^>]*voice=/); // Twilio's default es-US voice
    expect(xml).toContain('url="wss://portal.example.com/ws/voice-agent?callSid=CA123&amp;t=');
    expect(xml).toContain('esta llamada puede ser grabada');
    expect(xml).toContain('asistente automatizado');
    expect(SPANISH_LANGUAGE).toBe('es-US');
  });
  test('an owner-configured Spanish voice is emitted', () => {
    const xml = buildSpanishRelayTwiML({ vestibule: { ...VEST, voice: 'CaJslL1xziwefCeTNzHv' }, callSid: 'CA123' });
    expect(xml).toMatch(/<ConversationRelay [^>]*voice="CaJslL1xziwefCeTNzHv"/);
  });
  test('the default Spanish greeting is the disclosure', () => {
    expect(DEFAULT_WELCOME_GREETING_ES).toMatch(/grabada/);
    expect(DEFAULT_WELCOME_GREETING_ES).toMatch(/asistente automatizado/);
  });
});

describe('Spanish voicemail failover', () => {
  test('English path unchanged', () => {
    const twiml = new VoiceResponse();
    appendVoicemailRecording(twiml);
    expect(twiml.toString()).toContain('Your message will be recorded and transcribed.');
    expect(twiml.toString()).toContain('<Record ');
  });
  test('es ⇒ Spanish <Say> before the same recorder; optional Spanish asset only when configured', () => {
    const a = new VoiceResponse();
    appendVoicemailRecording(a, { language: 'es' });
    expect(a.toString()).toMatch(/<Say [^>]*language="es-US"[^>]*>Su mensaje será grabado y transcrito\.<\/Say>/);
    expect(a.toString()).not.toContain('<Play>');
    expect(a.toString()).not.toContain('Your message will be recorded');
    expect(a.toString()).toContain('transcribeCallback="/api/webhooks/twilio/transcription"');
    process.env.WAVES_VOICEMAIL_URL_ES = 'https://assets.example/vm-es.mp3';
    const b = new VoiceResponse();
    appendVoicemailRecording(b, { language: 'es-US' });
    expect(b.toString()).toContain('<Play>https://assets.example/vm-es.mp3</Play>');
  });
});
