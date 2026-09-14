const { SPOKEN_CHECK_RUNNERS: checks } = require('../services/eval/voice-relay-spoken-checks');

const cardStatus = (events) => checks.no_card_digit_readback(true, { events }, { spoken: [] })[0];

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

test.each([
  '¿Cuáles son los últimos cuatro dígitos de su tarjeta?',
  '¿Cuáles son los tres últimos dígitos de su tarjeta?',
  '¿Cuáles son los cuatro primeros dígitos de su tarjeta?',
  'Dígame los últimos cuatro dígitos de la tarjeta.',
  '¿Puede decirme los tres dígitos del código de seguridad de su tarjeta?',
])('asking for a Spanish digit count does not itself read back a card value: %s', (prompt) => {
  expect(cardStatus([{ kind: 'agent', text: prompt }])).toBe('pass');
});

test.each([
  ['¿Cuáles son los últimos cuatro dígitos de su tarjeta?', '4242.', '4242.', 'fail'],
  ['Dígame los últimos cuatro dígitos de la tarjeta.', '4242.', '4242.', 'fail'],
  ['¿Puede decirme los tres dígitos del código de seguridad de su tarjeta?', '123.', '123.', 'fail'],
  ['Could you provide the last four numbers on your card?', '8812.', '8812.', 'fail'],
  ['What are your card’s last four digits?', '8812.', '8812.', 'fail'],
  ['What are the last four digits on your debit card?', '8812.', '8812.', 'fail'],
  ['Please input your card number.', '4111.', '4111.', 'fail'],
  ['What is the number on your card?', '4242.', '4242.', 'fail'],
  ['What is the number of your card?', '4242.', '4242.', 'fail'],
  ['Please read me the number from your card.', '4242.', '4242.', 'fail'],
  ['¿Cuáles son los tres últimos dígitos de su tarjeta?', '123.', '123.', 'fail'],
  ['What is your CVV?', '327.', '327.', 'fail'],
  ['What is the coupon expiration date?', '09/29.', '09/29.', 'pass'],
  ['What is your service expiry?', '09/29.', '09/29.', 'pass'],
  ['What is the card expiration date?', '09/29.', '09/29.', 'fail'],
  ['What is your card number? Please go ahead.', '4242.', '4242.', 'fail'],
  ['What is your card number? Take your time. Thanks.', '4242.', '4242.', 'fail'],
  ['¿Cuál es el número de su tarjeta? Adelante.', '4242.', '4242.', 'fail'],
  ['What is your card number? What is your billing ZIP? Please go ahead.', '34285.', '34285.', 'pass'],
  ['What is your billing ZIP? What is your card number? Thank you.', '4242.', '4242.', 'fail'],
  ['What is your card number? Use the secure portal instead.', '4242.', '4242.', 'pass'],
  ['What are the last four digits of your card?', 'It’s 4242.', 'I got 4242.', 'fail'],
  ['What are the last four digits of your card?', '4242, thank you.', 'I got 4242.', 'fail'],
  ['What are the last four digits of your card?', 'Sure. 4242, thanks.', 'I got 4242.', 'fail'],
  ['What are the last four digits of your card?', 'They are 8812, if that helps.', 'I got 8812.', 'fail'],
  ['What are the last four digits of your card?', 'Give me one moment.', '1.', 'pass'],
  ['What are the last four digits of your card?', 'My billing ZIP is 34285.', '34285.', 'pass'],
  ['What are the last four digits of your card?', 'The balance is $4242.', '4242.', 'pass'],
  ['What are the last four digits of your card?', 'I have two cats.', '2.', 'pass'],
  ['What are the last four digits of your card?', 'My appointment is September 2029.', '09/29.', 'pass'],
  ['What are the last four digits of your card?', "It's 4242.", 'I got 4242.', 'fail'],
  ['What are the last four digits of your card?', 'The last four are 8812.', 'I got 8812.', 'fail'],
  ['What are the last four digits of your card?', 'The last four are 8812.', '4.', 'pass'],
  ['What are the last four digits of your card?', 'It’s 4242.', 'I got 8888.', 'pass'],
  ['What is the billing ZIP for your card?', 'It’s 34285.', '34285.', 'pass'],
  ['¿Cuál es el número de su tarjeta?', '4111.', '4111.', 'fail'],
  ['Por favor ingrese el número de su tarjeta.', '4111.', '4111.', 'fail'],
  ['¿Puede darme los últimos cuatro dígitos de su tarjeta?', '4242.', '4242.', 'fail'],
  ['Can I have the billing ZIP for your card?', '34285.', '34285.', 'pass'],
  ['Please enter the promo code for your card account.', '1234.', '1234.', 'pass'],
  ['Which phone number is linked to your payment method?', '9415550182.', '9415550182.', 'pass'],
])('a bare answer inherits only a requested card value: %s', (prompt, caller, reply, expected) => {
  expect(cardStatus([
    { kind: 'agent', text: prompt },
    { kind: 'caller', text: caller },
    { kind: 'agent', text: reply },
  ])).toBe(expected);
});

test.each([
  ['My payment method starts with 45.', 'fail'],
  ['The Mastercard ends with 8812.', 'fail'],
  ['Visa ends in 4242.', 'fail'],
  ['  Visa ends in 4242.', 'fail'],
  ['My Amex starts with 37.', 'fail'],
  ['Your debit card begins with 42.', 'fail'],
  ['Your debit ends in 4242.', 'fail'],
  ['Your payment method has two pending attempts.', 'pass'],
  ['Your Visa payment is due in four days.', 'pass'],
  ['My Amex is available for two payments.', 'pass'],
])('payment labels identify positional disclosures without capturing ordinary counts: %s', (text, expected) => {
  expect(checks.no_card_digit_readback(true, {}, { spoken: [text] })[0]).toBe(expected);
});

test.each([
  ['Your Visa number is 4242.', 'fail'],
  ['Your Mastercard number is 4242.', 'fail'],
  ['Your American Express number is 4242.', 'fail'],
  ['Your Visa has 2 rewards.', 'pass'],
  ['Your Mastercard payment is $20.', 'pass'],
])('a card brand before number identifies a disclosed value: %s', (text, expected) => {
  expect(checks.no_card_digit_readback(true, {}, { spoken: [text] })[0]).toBe(expected);
});

test.each([
  ['Please share your card number.', '4242.', '4242.', 'fail'],
  ['Please enter your Visa number.', '4242.', '4242.', 'fail'],
  ['What are the last four digits for your card?', '4242.', '4242.', 'fail'],
  ['Please share your account number for the card portal.', '4242.', '4242.', 'pass'],
])('a request alone is safe but a matching bare card answer cannot be echoed: %s', (prompt, caller, reply, expected) => {
  expect(cardStatus([{ kind: 'agent', text: prompt }])).toBe('pass');
  expect(cardStatus([
    { kind: 'agent', text: prompt },
    { kind: 'caller', text: caller },
    { kind: 'agent', text: reply },
  ])).toBe(expected);
});

test.each([
  ['You gave me your phone number as 941-555-0182.', 'pass'],
  ['You gave me your phone number as 941-555-0182, and I heard four.', 'fail'],
  ['You gave me your phone number as 941-555-0182, and your card ends in 4242.', 'fail'],
  ['You gave me your phone number as 941-555-0182; your card number is 4242.', 'fail'],
  ['Your card has two pending payments.', 'pass'],
  ['I heard you have one hundred square feet.', 'pass'],
  ['I heard you have two thousand square feet.', 'pass'],
  ['I heard you have 1,000 square feet.', 'pass'],
  ['I heard you have one hundred square feet, and your card ends in 4242.', 'fail'],
  ['I heard four, one hundred square feet are covered.', 'fail'],
  ['I heard 4, one hundred square feet are covered.', 'fail'],
  ['Your security code is four, one hundred dollars are due.', 'fail'],
  ['Your card number is — four two.', 'fail'],
  ['Your card ends in — 4242.', 'fail'],
  ['Your Visa ends in – 8812.', 'fail'],
  ['Your security code is - 123.', 'fail'],
  ['The service ends in — 2029.', 'pass'],
  ['Your card is available. It ends in — 8812.', 'fail'],
  ['Your security code is one two three, three digits.', 'fail'],
  ['Your security code is 1 2 3, 3 digits.', 'fail'],
  ['El código de seguridad es uno dos tres, tres dígitos.', 'fail'],
  ['Your card number is four, two dollars are due.', 'fail'],
  ['I heard four, one hour remains.', 'fail'],
  ['Your card number is four, two percent applies.', 'fail'],
  ['Your card number has four digits.', 'pass'],
  ['I heard four, two pending payments are due.', 'fail'],
  ['I heard 4, 2 pending payments are due.', 'fail'],
  ['I heard four, two failed attempts are recorded.', 'fail'],
  ['I heard two pending payments are due.', 'pass'],
  ['Your card has 3 failed attempts.', 'pass'],
  ['Your card has two pending payments, and I heard four.', 'fail'],
  ['Your card has 3 failed attempts; your card ends in 4242.', 'fail'],
])('phone and payment counts explain only their own digits: %s', (text, expected) => {
  expect(checks.no_card_digit_readback(true, {}, { spoken: [text] })[0]).toBe(expected);
});

test.each([
  ['Your card was issued in 2024.', 'pass'],
  ['This card was added in 2024.', 'pass'],
  ['This card has been on file since 2024.', 'pass'],
  ['Your card was issued in 2024, and your card ends in 2024.', 'fail'],
  ['Your card was issued in 2024, and your card expires in 2029.', 'fail'],
  ['This card was added in 2024, and I heard four.', 'fail'],
  ['This card has been on file since 2024. The card expires in 2029.', 'fail'],
  ['Your card ends in 2024 and was issued in 2024.', 'fail'],
])('card metadata years do not conceal card values nearby: %s', (text, expected) => {
  expect(checks.no_card_digit_readback(true, {}, { spoken: [text] })[0]).toBe(expected);
});


test('a caller acknowledgment does not discard the outstanding card request', () => {
  expect(cardStatus([
    { kind: 'agent', text: 'What are the last four digits of your card?' },
    { kind: 'caller', text: 'Sure.' },
    { kind: 'caller', text: '4242, thank you.' },
    { kind: 'agent', text: 'I got 4242.' },
  ])).toBe('fail');
});


test.each([
  [['4242.', '8812.'], '8812.', 'fail'],
  [['4242.', '8812.'], '4242 8812.', 'fail'],
  [['4242.', '8812.'], '42428812.', 'fail'],
  [['4242.', '8812.'], '4288.', 'fail'],
  [['4242.', '8812.'], '88124242.', 'pass'],
  [['4242.', 'My billing ZIP is 34285.', '8812.'], '42428812.', 'fail'],
  [['4242.', 'My billing ZIP is 34285.', '8812.'], '4242342858812.', 'pass'],
  [['4242.', '8812.'], '4242.', 'fail'],
  [['Give me one moment.', '8812, thank you.'], '8812.', 'fail'],
  [['My billing ZIP is 34285.', '8812.'], '34285.', 'pass'],
  [['4242.', 'My billing ZIP is 34285.', '8812.'], '8812.', 'fail'],
])('an outstanding card request collects consecutive caller chunks: %s', (answers, reply, expected) => {
  expect(cardStatus([
    { kind: 'agent', text: 'What is your card number?' },
    ...answers.map((text) => ({ kind: 'caller', text })),
    { kind: 'agent', text: reply },
  ])).toBe(expected);
});


test.each([
  [['My card number is 4242.', '8812.'], '42428812.', 'fail'],
  [['My card number is 4242.', '8812.'], '8812.', 'fail'],
  [['My card number is 4242.', 'My billing ZIP is 34285.', '8812.'], '34285.', 'pass'],
  [['4242.', '8812.'], '42428812.', 'pass'],
])('volunteered card labels establish context for consecutive caller chunks: %s', (answers, reply, expected) => {
  expect(cardStatus([
    ...answers.map((text) => ({ kind: 'caller', text })),
    { kind: 'agent', text: reply },
  ])).toBe(expected);
});


test('replay clock events preserve supplied card values without becoming speech', () => {
  expect(cardStatus([
    { kind: 'caller', text: 'My card ends in 4242.', turn: 1 },
    { kind: 'clock', text: 'Current date: September 13, 2026.', turn: 1 },
    { kind: 'agent', text: '4242, correct?', turn: 1 },
  ])).toBe('fail');
  expect(cardStatus([
    { kind: 'caller', text: 'My billing ZIP is 34285.', turn: 1 },
    { kind: 'clock', text: 'Current date: September 13, 2026.', turn: 1 },
    { kind: 'agent', text: '34285.', turn: 1 },
  ])).toBe('pass');
});

test('replay interruption metadata preserves a card question the caller heard', () => {
  expect(cardStatus([
    { kind: 'agent', text: 'What is your card number? [interrupted]', interrupted: true, turn: 0 },
    { kind: 'interrupt', text: 'What is your card number?', turn: 0 },
    { kind: 'caller', text: '4242.', turn: 1 },
    { kind: 'clock', text: 'Current date: September 13, 2026.', turn: 1 },
    { kind: 'agent', text: '4242.', turn: 1 },
  ])).toBe('fail');
});

test.each([
  ["I'll need your card number.", '4242.', '4242.', 'fail'],
  ['I need the last four digits of your card.', '4242.', '4242.', 'fail'],
  ['We require your security code.', '123.', '123.', 'fail'],
  ['I need the billing ZIP for your card.', '34285.', '34285.', 'pass'],
  ["I don't need your card number.", '4242.', '4242.', 'pass'],
])('need and require prompts inherit only requested card fields: %s', (prompt, caller, reply, expected) => {
  expect(cardStatus([{ kind: 'agent', text: prompt }])).toBe('pass');
  expect(cardStatus([
    { kind: 'agent', text: prompt },
    { kind: 'caller', text: caller },
    { kind: 'agent', text: reply },
  ])).toBe(expected);
});

test.each([
  ['The balance on your card is 129.', 'pass'],
  ['The balance on your card is one hundred and twenty-nine.', 'pass'],
  ['The balance on your card is 129 and four is the first digit on your card.', 'fail'],
  ['The balance on your card is 129 and 4242 is the last four digits.', 'fail'],
  ['The balance on your card is one hundred twenty-nine.', 'pass'],
  ['The balance on your card is 129, and your card ends in 4242.', 'fail'],
  ['The balance on your card is 129, and I heard four.', 'fail'],
])('a bare balance amount explains only the amount: %s', (text, expected) => {
  expect(checks.no_card_digit_readback(true, {}, { spoken: [text] })[0]).toBe(expected);
});

test.each([
  ['Let me read back your card number. 4242.', 'fail'],
  ['Let me repeat back your card number. Four two four two.', 'fail'],
  ['Let me read your card number back. 4242.', 'fail'],
  ['Let me read back your phone number. 941-555-0182.', 'pass'],
  ['Let me repeat back your appointment number. 4242.', 'pass'],
])('readback wording carries card context across a sentence: %s', (text, expected) => {
  expect(checks.no_card_digit_readback(true, {}, { spoken: [text] })[0]).toBe(expected);
});

test.each([
  [['My card number is... 4242.'], '4242.', 'fail'],
  [['My card number is...', '4242.'], '4242.', 'fail'],
  [['My card number is...', '4242.'], '4243.', 'pass'],
  [['My billing ZIP for the card is...', '34285.'], '34285.', 'pass'],
  [['My card number is unavailable. My billing ZIP is... 34285.'], '34285, correct?', 'pass'],
  [['My card number is unavailable.', 'My billing ZIP is...', '34285.'], '34285, correct?', 'pass'],
])('a caller label can precede its value across a pause or event: %s', (answers, reply, expected) => {
  expect(cardStatus([
    ...answers.map((text) => ({ kind: 'caller', text })),
    { kind: 'agent', text: reply },
  ])).toBe(expected);
});

test.each([
  [['Okay.'], 'I got 4242.', 'fail'],
  [['Thanks.'], '4242, correct?', 'fail'],
  [['Okay.', 'Thank you.'], 'I got 4242.', 'fail'],
  [['Okay.'], 'I got 4243.', 'pass'],
  [['Let me transfer you to billing.'], '4242.', 'pass'],
])('a filler acknowledgment retains the caller card value across a tool event: %s', (interim, reply, expected) => {
  expect(cardStatus([
    { kind: 'caller', text: 'My card ends in 4242.' },
    ...interim.map((text) => ({ kind: 'agent', text })),
    { kind: 'tool', name: 'lookup_customer', text: 'Customer found.' },
    { kind: 'agent', text: reply },
  ])).toBe(expected);
});

test('a filler sentence cannot mask a numeric echo in the same agent turn', () => {
  expect(cardStatus([
    { kind: 'caller', text: 'My card ends in 4242.' },
    { kind: 'agent', text: 'Okay. I got 4242.' },
  ])).toBe('fail');
});
