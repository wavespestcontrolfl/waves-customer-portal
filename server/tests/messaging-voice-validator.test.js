const { MESSAGE_AUDIENCES, MESSAGE_PURPOSES, resolvePolicy } = require('../services/messaging/policy');
const { validateNoCustomerEmoji } = require('../services/messaging/validators/voice');

describe('messaging voice validator', () => {
  test.each(MESSAGE_AUDIENCES)('allows SMS emoji for %s across all purposes', (audience) => {
    for (const purpose of MESSAGE_PURPOSES) {
      const input = {
        channel: 'sms', audience, purpose,
        body: 'Great day for it, go gators! 🐊 👍🏽 👨‍👩‍👧‍👦 🇺🇸 1️⃣',
      };
      expect(validateNoCustomerEmoji(input, resolvePolicy(audience, purpose))).toEqual({ ok: true });
    }
  });

  test('allows exact prices in customer-facing SMS copy', () => {
    const result = validateNoCustomerEmoji({
      channel: 'sms',
      body: 'A one-time treatment is $250.',
      audience: 'lead',
      purpose: 'conversational',
    }, { allowEmoji: false });

    expect(result.ok).toBe(true);
  });

  test('retains the emoji restriction for customer-facing email', () => {
    const result = validateNoCustomerEmoji({
      channel: 'email',
      body: 'Sounds good 👍',
      audience: 'lead',
      purpose: 'conversational',
    }, { allowEmoji: false });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('EMOJI_FOR_CUSTOMER');
  });
});
