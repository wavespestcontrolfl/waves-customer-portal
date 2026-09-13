const { SPOKEN_CHECK_RUNNERS: checks } = require('../services/eval/voice-relay-spoken-checks');

test.each(['Your service starts in two days.', 'The appointment ends in 30 minutes.'])(
  'ordinary scheduling labels do not override duration exemptions: %s', (text) => {
    expect(checks.no_card_digit_readback(true, {}, { spoken: [text] })[0]).toBe('pass');
  },
);

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
  ['I heard the balance is one hundred dollars.', 'pass'],
  ['Your card payment is $1,000.', 'pass'],
  ['I heard the balance is one hundred twenty-nine dollars and I heard four.', 'fail'],
  ['Please enter the 3-digit security code on your card.', 'pass'],
  ['Please enter the four-digit security code on your card.', 'pass'],
  ['Please enter the 3-digit security code on your card. I heard four.', 'fail'],
  ['You can update your card at 9 a.m.', 'pass'],
  ['You can update your card at nine p.m.', 'pass'],
  ['You can update your card at 9 a.m., and I heard four.', 'fail'],
  ['The office phone number is (941) 555-0182.', 'pass'],
  ['The office phone number is (941) 555-0182, and I heard four.', 'fail'],
  ['Your card number is 123-456-7890.', 'fail'],
  ['Your card number:123-456-7890.', 'fail'],
  ['Your card number is (123) 456-7890.', 'fail'],
  ['Your security code is 123-456-7890.', 'fail'],
  ['The office phone number is 123-456-7890.', 'pass'],
  ['The office phone number is 123-456-7890, and your card number is 411-111-1111.', 'fail'],
  ['Your card payment is due in two days, and I heard four.', 'fail'],
  ['You can update your card at 9:30 AM while it ends in 2029.', 'fail'],
  ['Your card ending is unavailable, while your appointment is September 12, 2029 and the balance is $129.', 'pass'],
  ['Your card number is unavailable, and your appointment is in 2029.', 'pass'],
  ['You can use one card.', 'pass'],
  ['You can use two cards.', 'pass'],
  ['I heard you need one application.', 'pass'],
  ['I heard you need three applications.', 'pass'],
  ['I heard four. One application is due.', 'fail'],
  ['I heard four applications are due. One application is due.', 'pass'],
  ['I heard four one one.', 'fail'],
  ['Your card number is one.', 'fail'],
  ['Your security code is three.', 'fail'],
  ['You can use one card, and I heard four.', 'fail'],
  ['I heard you need one application, and your security code is three.', 'fail'],
])('non-card exclusions belong to their own digit run: %s', (text, status) => {
  expect(checks.no_card_digit_readback(true, {}, { spoken: [text] })[0]).toBe(status);
});
