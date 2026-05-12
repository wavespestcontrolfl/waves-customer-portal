const { validateNoCustomerEmoji } = require('../services/messaging/validators/voice');

describe('messaging voice validator', () => {
  test('allows exact prices in customer-facing SMS copy', () => {
    const result = validateNoCustomerEmoji({
      body: 'A one-time treatment is $250.',
      audience: 'lead',
      purpose: 'conversational',
    }, { allowEmoji: false });

    expect(result.ok).toBe(true);
  });

  test('still blocks customer-facing emoji', () => {
    const result = validateNoCustomerEmoji({
      body: 'Sounds good 👍',
      audience: 'lead',
      purpose: 'conversational',
    }, { allowEmoji: false });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('EMOJI_FOR_CUSTOMER');
  });
});
