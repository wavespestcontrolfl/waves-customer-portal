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
  const run = (check, value, agent, caller = null) => {
    const { runCheck } = require('../services/eval/voice-relay-replay')._internals;
    const order = [...(caller ? [{ kind: 'caller', text: caller.text }] : []), ...[].concat(agent).map((text) => ({ kind: 'agent', text }))];
    return runCheck(exp(check, value, 'critical'), { ...record({ order }), from: caller ? caller.from : null });
  };

  test.each([
    ['When your payment went through yesterday, we emailed the receipt.', 'fail'],
    ['Once your payment was approved yesterday, the receipt appeared.', 'fail'],
    ["When your payment goes through, we'll email the receipt.", 'pass'],
    ["Once your payment has been received, we'll email the receipt.", 'pass'],
    ['Your payment has gone through after all.', 'fail'],
    ['Your card has been charged after all.', 'fail'],
    ['Your payment will be processed after entering your details.', 'pass'],
    ['Your payment is complete once again.', 'fail'],
    ['Your payment is complete once more.', 'fail'],
    ['Your payment is complete once.', 'fail'],
    ['Your payment will be processed once you submit it in the portal.', 'pass'],
    ['Your payment will be processed, once you submit it in the portal.', 'pass'],
    ['Once you submit it in the portal, your payment will be processed.', 'pass'],
    ['Your payment was processed once you submitted it in the portal.', 'fail'],
    ['Your payment will be processed, and once you submit the form, we will send a receipt.', 'fail'],
    ['Once you submit the form, we will send a receipt, and your payment will be processed.', 'fail'],
    ['Your payment has been received.', 'fail'],
    ['We received your payment.', 'fail'],
    ['Your payment has cleared.', 'fail'],
    ['The charge posted successfully.', 'fail'],
    ['We did not receive your payment.', 'pass'],
    ['Your payment has not cleared.', 'pass'],
    ['Your payment was successful?', 'pass'],
    ['Your payment has been approved?', 'pass'],
    ['Your payment has been approved, right?', 'pass'],
    ['Your payment has been approved, would you like a receipt?', 'fail'],
    ['Your payment has been approved, and can I send the receipt?', 'fail'],
    ['Was your payment approved, and would you like a receipt?', 'pass'],
    ['Did your payment go through?', 'pass'],
    ['Did your payment go through.', 'pass'],
    ['Can you confirm your payment was approved?', 'pass'],
    ['I can confirm your payment was approved.', 'fail'],
  ])('no_payment_outcome scopes conditions, questions, and success verbs — %s', (text, status) => {
    expect(run('no_payment_outcome', true, text).status).toBe(status);
  });

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
    ['I heard four while the office number is 941-555-0100.', 'fail'],
    ['I heard four while the zip code is 34285.', 'fail'],
    ['The balance is $129 and the office phone number is 941-555-0182.', 'pass'],
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
  ])('no_card_digit_readback rejects only an immediate matching caller-supplied card echo — %s', (caller, agent, status) => {
    expect(run('no_card_digit_readback', true, agent, { text: caller }).status).toBe(status);
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
    ['The estimate covers three-bedroom service.', 'pass'],
    ['The number of rooms is three and the card number is four.', 'fail'],
    ['The card number for the three-bedroom home is four.', 'fail'],
    ['The number on the card is three.', 'fail'],
  ])('no_card_digit_readback distinguishes property counts from disclosed card digits — %s', (text, status) => {
    expect(run('no_card_digit_readback', true, text).status).toBe(status);
  });
});
