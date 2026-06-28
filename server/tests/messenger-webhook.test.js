const router = require('../routes/twilio-messenger-webhook');

describe('messenger webhook channel mapping', () => {
  test('messenger: addresses map to facebook_messenger', () => {
    expect(router.channelForAddress('messenger:110336442031847')).toBe('facebook_messenger');
  });

  test('instagram: addresses map to instagram', () => {
    expect(router.channelForAddress('instagram:17841400000000000')).toBe('instagram');
  });

  test('unknown / empty address defaults to facebook_messenger', () => {
    expect(router.channelForAddress('')).toBe('facebook_messenger');
    expect(router.channelForAddress(undefined)).toBe('facebook_messenger');
    expect(router.channelForAddress(null)).toBe('facebook_messenger');
  });
});
