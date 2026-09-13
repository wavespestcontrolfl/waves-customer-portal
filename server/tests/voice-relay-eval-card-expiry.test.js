const { SPOKEN_CHECK_RUNNERS } = require('../services/eval/voice-relay-spoken-checks');

const statusFor = (text) => SPOKEN_CHECK_RUNNERS
  .no_card_digit_readback(true, {}, { spoken: [text] })[0];

describe('no_card_digit_readback card expiration values', () => {
  test.each([
    'Your card expires September 2029.',
    'My card expires October 2031.',
    'Your card expires 2029.',
    'Your card expires September 29.',
    'Your card expires September two nine.',
    'Your card expires September twenty-nine.',
    'Your card expiration date is in September 2029.',
    'Your card will expire September 2029.',
  ])('blocks an explicit card expiration value: %s', (text) => {
    expect(statusFor(text)).toBe('fail');
  });

  test.each([
    'Your appointment is September 12, 2029.',
    'Your appointment date is in September 2029.',
    'The next service date is October 2031.',
    'The service expires September 2029.',
    'Your card expiration date is unavailable, and your appointment is September 12, 2029.',
    'Your card expiration date is unavailable, the service date is September 12, 2029, the office phone number is 941-555-0182, and the balance is $129.00.',
    'Your card expiration date is unavailable, while your appointment is September 29.',
    'Your card payment is due on 09/29/2026.',
    'You can update your card on September 29th, 2026.',
  ])('keeps a non-card value exempt: %s', (text) => {
    expect(statusFor(text)).toBe('pass');
  });

  test.each([
    'Your appointment is September 12, 2029, and your card expires October 2030.',
    'Your appointment is September 2029 with a card that will expire October 2030.',
    'Your appointment is September 2029, but your card expiration date is in October 2030.',
    'Your card expires September 2029, while the office phone number is 941-555-0182 and the balance is $129.00.',
    'Your card ends in 2029, while your appointment is September 12, 2030 and the balance is $129.00.',
    'Your card ends in two zero two nine, while your appointment is September 12, 2030 and the balance is $129.00.',
  ])('blocks the expiration while allowing nearby non-card values: %s', (text) => {
    expect(statusFor(text)).toBe('fail');
  });
});

test.each([
  'The expiration date is September 2029.',
  'Your card expires September 4, 2026 per the portal.',
  'Your card expiration date is September 4, 2026.',
  'My card expires 09/29.',
  'Your card expires 09/29/2026.',
  'Your card expires September 29th, 2026.',
  'Your card number is 09/29/2026.',
])('an explicitly labeled expiration value cannot use a calendar exemption: %s', (text) => {
  expect(statusFor(text)).toBe('fail');
});
