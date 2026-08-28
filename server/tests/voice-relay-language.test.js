/**
 * relay-language — session-language plumbing for the inbound relay agent:
 * the Spanish prompt addendum, the deterministic Spanish closes (English
 * byte-identical), the Spanish greeting validation arms, and the
 * confident-resolution-only preference stamp.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { isSpanish, copy, COPY, LANGUAGE_ADDENDUM_ES } = require('../services/voice-agent/relay-language');
const { buildBasePrompt, SYSTEM_PROMPT } = require('../services/voice-agent/relay-conversation');
const { spanishWelcomeGreeting, DEFAULT_WELCOME_GREETING_ES, defaultWelcomeGreeting } = require('../services/voice-agent/relay-protocol');

afterEach(() => { delete process.env.VOICE_RELAY_GREETING_ES; delete process.env.VOICE_RELAY_GREETING; delete process.env.VOICE_AGENT_NAME; });

test('isSpanish accepts es / es-US / es_MX only', () => {
  expect(isSpanish('es')).toBe(true);
  expect(isSpanish('es-US')).toBe(true);
  expect(isSpanish('es_MX')).toBe(true);
  expect(isSpanish('en-US')).toBe(false);
  expect(isSpanish('est')).toBe(false);
  expect(isSpanish(null)).toBe(false);
});

test('prompt: no/English language is byte-identical; Spanish appends the addendum LAST', () => {
  expect(buildBasePrompt(false)).toBe(SYSTEM_PROMPT);
  expect(buildBasePrompt(false, 'en-US')).toBe(SYSTEM_PROMPT);
  const es = buildBasePrompt(false, 'es');
  expect(es.startsWith(SYSTEM_PROMPT)).toBe(true);
  expect(es.endsWith(LANGUAGE_ADDENDUM_ES)).toBe(true);
  expect(LANGUAGE_ADDENDUM_ES).toMatch(/Speak ONLY in natural/);
});

test('deterministic closes: English strings are the prior literals verbatim; Spanish twins exist for every key', () => {
  expect(copy('turnCap')).toBe('A Waves team member will follow up with you as soon as possible to take care of this. Thanks for calling!');
  expect(copy('unavailable', 'en')).toBe('Sorry, I am unable to help right now. A team member will call you back.');
  expect(copy('streamTimeout', null)).toBe('Sorry, that took a moment — could you say that again?');
  expect(copy('modelError')).toBe('Sorry, I had trouble there. Could you say that again?');
  expect(copy('toolRounds')).toBe("Sorry — that's taking me longer than it should. I've made a note for the team to follow up. Is there anything else I can help with?");
  for (const key of Object.keys(COPY)) {
    const es = copy(key, 'es-US');
    expect(es).not.toBe(COPY[key].en);
    expect(es).not.toMatch(/\b(sorry|team member|call you back)\b/i); // no English leaks
  }
  expect(() => copy('nope', 'es')).toThrow(/unknown copy key/);
});

describe('Spanish greeting validation arms', () => {
  test('default keeps a one-clause recorded-line notice (the English MP3 may have been cut by the key press) and NO AI mention', () => {
    expect(spanishWelcomeGreeting()).toBe(DEFAULT_WELCOME_GREETING_ES);
    expect(DEFAULT_WELCOME_GREETING_ES).toMatch(/puede ser grabada/);
    expect(DEFAULT_WELCOME_GREETING_ES).not.toMatch(/automatizad|asistente|IA\b/);
    process.env.VOICE_AGENT_NAME = 'Marisol';
    expect(spanishWelcomeGreeting()).toContain('habla Marisol');
  });
  test('an override that states the recording is used verbatim; one without it gets the Spanish recording clause appended', () => {
    process.env.VOICE_RELAY_GREETING_ES = 'Hola, esta llamada puede ser grabada. ¿Cómo puedo ayudarle?';
    expect(spanishWelcomeGreeting()).toBe(process.env.VOICE_RELAY_GREETING_ES);
    process.env.VOICE_RELAY_GREETING_ES = 'Hola, gracias por llamar a Waves.';
    expect(spanishWelcomeGreeting()).toBe('Hola, gracias por llamar a Waves. Esta llamada puede ser grabada.');
  });
  test.each([
    'Esta llamada no es grabada. ¿Cómo puedo ayudarle?',
    'Hola, está hablando con una persona real.',
  ])('a negated-recording or human-claiming override is discarded: %s', (bad) => {
    process.env.VOICE_RELAY_GREETING_ES = bad;
    expect(spanishWelcomeGreeting()).toBe(DEFAULT_WELCOME_GREETING_ES);
  });
  test('the English opener never carries a notice', () => {
    delete process.env.VOICE_RELAY_GREETING;
    expect(defaultWelcomeGreeting()).toMatch(/^Waves, this is Sandy\. How can I help you this (morning|afternoon|evening)\?$/);
  });
});
