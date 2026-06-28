const router = require('../routes/twilio-messenger-webhook');

describe('messenger webhook channel mapping', () => {
  test('messenger: addresses map to facebook_messenger', () => {
    expect(router.channelForAddress('messenger:110336442031847')).toBe('facebook_messenger');
  });

  test('instagram: addresses map to instagram', () => {
    expect(router.channelForAddress('instagram:17841400000000000')).toBe('instagram');
  });

  test('non-social / unknown addresses return null (ignored, never mis-tagged)', () => {
    expect(router.channelForAddress('')).toBeNull();
    expect(router.channelForAddress(undefined)).toBeNull();
    expect(router.channelForAddress(null)).toBeNull();
    expect(router.channelForAddress('+19415551234')).toBeNull();
    expect(router.channelForAddress('whatsapp:+19415551234')).toBeNull();
  });
});
