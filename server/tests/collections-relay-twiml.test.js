/**
 * buildRelayTwiML `parameters` support (PR B) — pins:
 *  - WITHOUT parameters the rendered TwiML is BYTE-IDENTICAL to the
 *    pre-change output (self-closing <ConversationRelay .../>) — the whole
 *    inbound lane must be untouched by this addition;
 *  - with parameters, <Parameter name value /> children render inside a
 *    paired <ConversationRelay> element, XML-escaped;
 *  - the collections leg's session_mode parameter round-trips.
 */

describe('buildRelayTwiML parameters', () => {
  const OLD_ENV = process.env;
  let protocol;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV, VOICE_RELAY_WS_SECRET: 'test-secret-value' };
    protocol = require('../services/voice-agent/relay-protocol');
  });

  afterAll(() => { process.env = OLD_ENV; });

  const base = () => ({
    wsUrl: 'wss://portal.example.com/ws/voice-agent',
    callSid: 'CA00000000000000000000000000000001',
    welcomeGreeting: 'Hello, this call may be recorded, automated assistant.',
  });

  test('no parameters → self-closing element, byte-identical shape', () => {
    const xml = protocol.buildRelayTwiML(base());
    expect(xml).toMatch(/<ConversationRelay [^>]*\/><\/Connect><\/Response>$/);
    expect(xml).not.toContain('<Parameter');
  });

  test('parameters render as <Parameter> children', () => {
    const xml = protocol.buildRelayTwiML({ ...base(), parameters: { session_mode: 'collections' } });
    expect(xml).toContain('<Parameter name="session_mode" value="collections" />');
    expect(xml).toMatch(/<ConversationRelay [^>]*><Parameter[^>]*\/><\/ConversationRelay>/);
  });

  test('parameter names/values are XML-escaped and null values dropped', () => {
    const xml = protocol.buildRelayTwiML({
      ...base(),
      parameters: { 'a&b': '<x>"q"', empty: null },
    });
    expect(xml).toContain('name="a&amp;b"');
    expect(xml).toContain('value="&lt;x&gt;&quot;q&quot;"');
    expect(xml).not.toContain('name="empty"');
  });

  test('empty parameters object behaves exactly like absent', () => {
    const a = protocol.buildRelayTwiML(base());
    // Token minting is time/nonce-random — compare structure, not the URL.
    const b = protocol.buildRelayTwiML({ ...base(), parameters: {} });
    const strip = (s) => s.replace(/url="[^"]*"/, 'url=""');
    expect(strip(b)).toBe(strip(a));
  });
});
