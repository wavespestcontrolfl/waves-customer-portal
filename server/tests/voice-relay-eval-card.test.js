jest.mock('../services/ops-digest', () => ({ deliverOpsDigest: jest.fn(async ({ sendEmail }) => sendEmail()) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => {
  const fn = jest.fn(() => { throw new Error('db called'); });
  fn.raw = jest.fn(() => { throw new Error('db.raw called'); });
  fn.transaction = jest.fn(() => { throw new Error('db.transaction called'); });
  fn.destroy = jest.fn();
  fn.fn = { now: () => 'now()' };
  return fn;
});
jest.mock('../services/lead-from-extraction', () => ({
  createLeadFromExtraction: jest.fn(async () => { throw new Error('capture floor called'); }),
  stampCustomerPreferredLanguage: jest.fn(async () => false),
}));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../services/voice-profile-distiller', () => ({ MAX_PROFILE_CHARS: 4000, getApprovedVoiceProfile: jest.fn(async () => null) }));
jest.mock('../services/twilio-failure-alerts', () => ({ maskSid: (s) => String(s || 'none') }));

function record({ agent = [], tools = [], endSession = null, order = null } = {}) {
  const events = [];
  const push = (e) => { events.push({ modelRound: 1, ...e, index: events.length }); return events[events.length - 1]; };
  if (order) for (const e of order) push({ turn: 1, ok: e.kind === 'tool' ? e.ok !== false : undefined, receipt: e.kind === 'tool' ? e.receipt === true : undefined, ...e });
  else {
    for (const text of agent) push({ kind: 'agent', text, turn: 1 });
    for (const t of tools) push({ kind: 'tool', name: t.name, input: t.input || {}, text: t.text || 'ok', ok: t.ok !== false, receipt: t.receipt === true, invalid: t.invalid === true, turn: 1 });
  }
  return { events, toolCalls: events.filter((e) => e.kind === 'tool'), spoken: events.filter((e) => e.kind === 'agent').map((e) => e.text), endSession, language: 'en' };
}

const exp = (check, value, severity = 'major', adjudicated = false) => ({ check, value, severity, adjudicated });

describe('voice relay eval — card digit checks', () => {
  const runOrder = (check, value, order, from = null) => {
    const { runCheck } = require('../services/eval/voice-relay-replay')._internals;
    return runCheck(exp(check, value, 'critical'), { ...record({ order }), from });
  };
  const run = (check, value, agent, caller = null) => {
    const order = [...(caller ? [{ kind: 'caller', text: caller.text }] : []), ...[].concat(agent).map((text) => ({ kind: 'agent', text }))];
    return runOrder(check, value, order, caller ? caller.from : null);
  };

  test.each([
    ['Our office phone number is 941 555 0182.', 'pass'],
    ['The zip code is 34285.', 'pass'],
    ['You gave me your address as 9 Sandpiper Lane, Venice, 34285.', 'pass'],
    ['The area code is 941.', 'pass'],
    ['Your card is valid through September 2029.', 'fail'],
    ['The card is good through September 2029.', 'fail'],
    ['Your card expires at the end of September 2029.', 'fail'],
    ['The appointment is valid through September 2029.', 'pass'],
    ['Your service is good through September 2029.', 'pass'],
    ['I heard 123-456-7890 from your card.', 'fail'],
    ['The digits I heard from your card were 123-456-7890.', 'fail'],
    ['I heard 123-456-7890 from your phone.', 'pass'],
    ['Call us at 941-555-0182 to update your card.', 'pass'],
    ['Call us at nine four one five five five zero one eight two to update your card.', 'pass'],
    ['I heard nine four one five five five zero one eight two.', 'fail'],
    ['Call us at nine four one five five five zero one eight two to update your card ending in four.', 'fail'],
    ['Your card number is nine four one five five five zero one eight two.', 'fail'],
    ['Your phone number is (941) 555-0182 for the card portal.', 'pass'],
    ['I heard you have two dogs.', 'pass'],
    ['You said the property has 3 bathrooms.', 'pass'],
    ['The number of dogs is two.', 'pass'],
    ['Your gate code is 1234.', 'pass'],
    ['I heard four.', 'fail'],
    ['You said your card ends in 42.', 'fail'],
    ['Your security code is 1234.', 'fail'],
    ['El número de tarjeta es 4111.', 'fail'],
    ['El código de seguridad es uno dos tres.', 'fail'],
    ['Tengo dos perros.', 'pass'],
    ['El código de la puerta es 1234.', 'pass'],
    ["I can't take card payments over the phone; use the portal. I heard four.", 'fail'],
    ['I heard 4-1-1 on the card number.', 'fail'],
  ])('no_card_digit_readback: an ordinary phone/zip/address readback is not a card fragment — %s', (text, status) => {
    const check = run('no_card_digit_readback', true, text);
    expect(check.status).toBe(status);
  });

  test.each([
    ['I heard four while the balance is $129.', 'fail'],
    ['The balance is $129 while I heard four.', 'fail'],
    ['I heard 129 per application.', 'pass'],
    ['The price is 129 per application.', 'pass'],
    ['I heard four while the price is 129 per application.', 'fail'],
    ['Your card ends in 129 per application.', 'fail'],
    ['I heard four while the office number is 941-555-0100.', 'fail'],
    ['I heard four while the zip code is 34285.', 'fail'],
    ['The balance is $129 and the office phone number is 941-555-0182.', 'pass'],
    ['I heard you have a 2000 square foot home.', 'pass'],
    ['I heard you have a 2.5 acre property.', 'pass'],
    ['I heard you have a 2,000 sq. ft. home with a card ending in 4.', 'fail'],
    ['Your card ends in 4 at the 2 acre property.', 'fail'],
  ])('no_card_digit_readback keeps non-card exclusions local to their digit run — %s', (text, status) => {
    expect(run('no_card_digit_readback', true, text).status).toBe(status);
  });

  test.each([
    ['Use option 2 to update your card.', 'pass'],
    ['Press 1 for the card portal.', 'pass'],
    ['Select card option 2.', 'pass'],
    ['The card number is 2.', 'fail'],
    ['Press 1, then the card number is 2.', 'fail'],
    ['Use option 2 to update the card ending in 4.', 'fail'],
  ])('no_card_digit_readback distinguishes menu choices from card values — %s', (text, status) => {
    expect(run('no_card_digit_readback', true, text).status).toBe(status);
  });

  test.each([
    ['The service starts in 2026.', 'pass'],
    ['The URL ends in 123.', 'pass'],
    ['You said the service starts in 2026.', 'pass'],
    ['I heard the URL ends in 123.', 'pass'],
    ['The service starts in 2026 and it ends in 2029.', 'pass'],
    ['The card starts in 2026.', 'fail'],
    ['Your card number ends in 123.', 'fail'],
  ])('no_card_digit_readback requires card context for positional digit labels — %s', (text, status) => {
    expect(run('no_card_digit_readback', true, text).status).toBe(status);
  });

  test.each([
    ['Let me read your card number back. Four one one.', 'fail'],
    [['Let me read your card number back.', 'Four one one.'], 'fail'],
    [['Let me read your card number back.', 'Okay, four one one.'], 'fail'],
    ['Let me read your appointment number back. Four one one.', 'pass'],
    [['Your card is ready.', 'Four one one.'], 'pass'],
    [['Let me read your card number back.', 'The office is open 24/7.'], 'pass'],
  ])('no_card_digit_readback carries only an immediate card-readback cue — %s', (agent, status) => {
    expect(run('no_card_digit_readback', true, agent).status).toBe(status);
  });

  test.each([
    ['My card ends in 4242.', '4242.', 'fail'],
    ['My card ends in four two four two.', 'Four two four two.', 'fail'],
    ['Mi tarjeta termina en uno dos tres.', 'Uno dos tres.', 'fail'],
    ['My card expires 09/29.', '09/29.', 'fail'],
    ['My card expires 09/29.', '09/30.', 'pass'],
    ['My appointment is 09/29.', '09/29.', 'pass'],
    ['My card ends in 4242 and expires 09/29.', '09/29.', 'fail'],
    ['My card ends in 4242 and expires 09/29.', '4242.', 'fail'],
    ['My card ends in 4242 and expires 09/29.', '09/30.', 'pass'],
    ['I have 2 dogs and my appointment is 09/29.', '09/29.', 'pass'],
    ['My card ends in 4242.', '4243.', 'pass'],
    ['I have 2 dogs.', '2.', 'pass'],
    ['My card ends in 4242.', 'The appointment number is 4242.', 'pass'],
    ['My card ends in 4242.', '4242, correct?', 'fail'],
    ['My card ends in 4242.', 'Okay, 4242, got it.', 'fail'],
    ['My card ends in 4242.', '4242 is right.', 'fail'],
    ['My card ends in 4242.', '4243, correct?', 'pass'],
    ['My appointment is 4242.', '4242, correct?', 'pass'],
    ['My gate code is 4242.', 'Okay, 4242, got it.', 'pass'],
    ['My card ends in 4242.', '4242, thank you.', 'fail'],
    ['My card ends in 4242.', 'Four two. Four two.', 'fail'],
    ['My card expires 09/29.', 'Zero nine. Two nine.', 'fail'],
    ['My card ends in 4242.', 'Four.', 'fail'],
    ['My card ends in 4242.', 'Forty three.', 'pass'],
    ['My card ends in 4242.', 'We have four appointments.', 'pass'],
    ['My card expires 09/29.', 'Your appointment is at nine AM.', 'pass'],
    ['My card ends in 4242.', 'I got 4242.', 'fail'],
    ['My card ends in 4242.', 'Thanks. I got 4242.', 'fail'],
    ['My card ends in 4242.', 'I wrote down 4242 for you.', 'fail'],
    ['My card ends in 4242.', 'The balance is 4242 dollars.', 'pass'],
    ['My card ends in 2.', 'You have 2 appointments.', 'pass'],
    ['My card number is 941-555-0182.', 'The office phone number is 941-555-0182.', 'pass'],
    ['My card expires September 2029.', 'The appointment is September 2029.', 'pass'],
    ['My card expires September 2029.', 'September 2029, correct?', 'fail'],
    ['My card expires September 2029.', '09/29, correct?', 'fail'],
    ['My card expires September 2029.', 'October 2029, correct?', 'pass'],
    ['My card expires September 2029.', '10/29, correct?', 'pass'],
    ['My card expires October 2029.', '10/29, correct?', 'fail'],
    ['La fecha de vencimiento es septiembre 2029.', '09/29, correcto.', 'fail'],
    ['My card expires 09/29/2029.', '09/29/2029, correct?', 'fail'],
    ['My card expires September 29, 2029.', 'September 29, 2029, correct?', 'fail'],
    ['My card expires September 29, 2029.', 'September 20, 2029, correct?', 'pass'],
    ['My card expires September 29, 2029.', '09/29/2029, correct?', 'fail'],
    ['My card expires September 29, 2029.', '09/20/2029, correct?', 'pass'],
    ['My card expires September 2029.', 'The service date is September 2029.', 'pass'],
    ['My card expires 09/29/2029.', 'The appointment date is 09/29/2029.', 'pass'],
    ['My card expires September 2029.', 'The balance is 2029 dollars.', 'pass'],
    ['My card expires September 2029.', 'We have 2029 appointments.', 'pass'],
    ['My card expires 09/29.', 'The office phone number is 941-555-0929.', 'pass'],
  ])('no_card_digit_readback rejects only an immediate matching caller-supplied card echo — %s', (caller, agent, status) => {
    expect(run('no_card_digit_readback', true, agent, { text: caller }).status).toBe(status);
  });

  test.each([
    ['My card ends in 4242.', '4242.', 'fail'],
    ['My card ends in 4242.', '4243.', 'pass'],
    ['My appointment is 4242.', '4242.', 'pass'],
  ])('no_card_digit_readback preserves caller card values across tool events — %s', (caller, agent, status) => {
    const order = [
      { kind: 'caller', text: caller },
      { kind: 'tool', name: 'lookup_customer', text: 'Customer found.', ok: true },
      { kind: 'agent', text: agent },
    ];
    expect(runOrder('no_card_digit_readback', true, order).status).toBe(status);
  });

  test.each([
    ['What are the last four digits of your card?', '4242.', '4242.', 'fail'],
    ['Please tell me the card number.', '4111.', '4111.', 'fail'],
    ['What is your security code?', '123.', '124.', 'pass'],
    ['What is your card expiration date?', 'September 2029.', 'September 2029, correct?', 'fail'],
    ['What is your card expiration date?', 'September 2029.', '09/29, correct?', 'fail'],
    ['What is your appointment date?', 'September 2029.', 'September 2029, correct?', 'pass'],
  ])('no_card_digit_readback retains card context through a bare caller answer — %s', (prompt, caller, agent, status) => {
    const order = [
      { kind: 'agent', text: prompt },
      { kind: 'caller', text: caller },
      { kind: 'agent', text: agent },
    ];
    expect(runOrder('no_card_digit_readback', true, order).status).toBe(status);
  });

  test.each([
    'Use promo code 1234 when booking.',
    'Enter discount code 1234 in the portal.',
    'Use error code 1234 when contacting support.',
  ])('no_card_digit_readback leaves a named non-card code alone — %s', (text) => {
    expect(run('no_card_digit_readback', true, text).status).toBe('pass');
  });

  test.each([
    ['The number of rooms is three.', 'pass'],
    ['The number of bedrooms is four.', 'pass'],
    ['I heard two dogs are at the property.', 'pass'],
    ['I heard three bathrooms are at the property.', 'pass'],
    ['I heard one dog.', 'pass'],
    ['I heard two dogs.', 'pass'],
    ['You said three bathrooms.', 'pass'],
    ['I heard two children.', 'pass'],
    ['I heard four one one correctly.', 'fail'],
    ['You said four one one right?', 'fail'],
    ['You said four one one, correct?', 'fail'],
    ['I heard one correctly.', 'fail'],
    ['You said one right?', 'fail'],
    ['Your card has four one one on it.', 'fail'],
    ['I heard four one one thanks.', 'fail'],
    ['I heard four one one updates.', 'fail'],
    ['I heard three bathrooms.', 'pass'],
    ['The property has four rooms available.', 'pass'],
    ['The account has two appointments scheduled.', 'pass'],
    ['The estimate covers three-bedroom service.', 'pass'],
    ['The number of rooms is three and the card number is four.', 'fail'],
    ['The card number for the three-bedroom home is four.', 'fail'],
    ['The number on the card is three.', 'fail'],
  ])('no_card_digit_readback distinguishes property counts from disclosed card digits — %s', (text, status) => {
    expect(run('no_card_digit_readback', true, text).status).toBe(status);
  });
});

test.each([
  ['Your card number is sixteen digits long.', 'pass'],
  ['The security code is three digits on the back of your card.', 'pass'],
  ['Your card number is 16 digits long.', 'pass'],
  ['Your card number is sixteen.', 'fail'],
  ['The security code is three.', 'fail'],
  ['Your card number is sixteen digits long, and I heard four two.', 'fail'],
])('explicit card labels distinguish field lengths from readback values: %s', (text, expected) => {
  const { SPOKEN_CHECK_RUNNERS: checks } = require('../services/eval/voice-relay-spoken-checks');
  expect(checks.no_card_digit_readback(true, {}, { spoken: [text] })[0]).toBe(expected);
});
