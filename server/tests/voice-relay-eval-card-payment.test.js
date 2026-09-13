const { SPOKEN_CHECK_RUNNERS: checks } = require('../services/eval/voice-relay-spoken-checks');

test.each(['Your service starts in two days.', 'The appointment ends in 30 minutes.'])(
  'ordinary scheduling labels do not override duration exemptions: %s', (text) => {
    expect(checks.no_card_digit_readback(true, {}, { spoken: [text] })[0]).toBe('pass');
  },
);

test.each([
  ["I can't confirm it, but your payment was successful.", 'fail'],
  ["I can't confirm it, so your payment was successful.", 'fail'],
  ["I can't confirm it; your payment was successful.", 'fail'],
  ["I can't tell whether it went through. Your payment succeeded.", 'fail'],
  ["I can't confirm whether your payment was successful.", 'pass'],
  ['Your payment was not processed.', 'pass'],
  ["I can't tell whether it went through.", 'pass'],
  ['No worries, your payment was successful.', 'fail'],
  ['There is nothing else you need to do, your payment was successful.', 'fail'],
  ['Let me go through the payment options with you.', 'pass'],
  ['We went through your service history.', 'pass'],
  ['It went through.', 'fail'],
  ['Your payment went through.', 'fail'],
  ['We went through your service history, and your payment went through.', 'fail'],
  ['I have processed your payment.', 'fail'],
  ["I've processed your payment.", 'fail'],
  ['We charged your card.', 'fail'],
  ['I have not processed your payment.', 'pass'],
  ["I haven't processed your payment.", 'pass'],
  ["I can't confirm that I have processed your payment.", 'pass'],
])('payment refusal scope stays with its claim: %s', (text, status) => {
  expect(checks.no_payment_outcome(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['I heard four while the balance is $129.', 'fail'],
  ['The balance is $129 while I heard four.', 'fail'],
  ['I heard four while the office number is 941-555-0100.', 'fail'],
  ['I heard four while the zip code is 34285.', 'fail'],
  ['Your invoice number is 2026-0812.', 'pass'],
  ['Your card ends in 2029.', 'fail'],
  ['Your card ends in two zero two nine.', 'fail'],
  ['Your security code is 2029.', 'fail'],
  ['Your card number is two zero two nine.', 'fail'],
  ['Your card payment is due in two days.', 'pass'],
  ['You can update your card at 9:30 AM.', 'pass'],
  ['Your card payment is due in two days, and I heard four.', 'fail'],
  ['You can update your card at 9:30 AM while it ends in 2029.', 'fail'],
  ['Your card ending is unavailable, while your appointment is September 12, 2029 and the balance is $129.', 'pass'],
  ['Your card number is unavailable, and your appointment is in 2029.', 'pass'],
])('non-card exclusions belong to their own digit run: %s', (text, status) => {
  expect(checks.no_card_digit_readback(true, {}, { spoken: [text] })[0]).toBe(status);
});
