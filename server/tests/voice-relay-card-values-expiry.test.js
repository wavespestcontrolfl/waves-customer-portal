const {
  cardFragmentsIn,
  normalizedCardExpiration,
  cardValuesMatch,
} = require('../services/eval/voice-relay-card-values');

const statusFor = (text) => (cardFragmentsIn(text).length ? 'fail' : 'pass');
const statusAfterCaller = (caller, reply) => {
  const supplied = cardFragmentsIn(caller);
  return cardFragmentsIn(reply, supplied).length ? 'fail' : 'pass';
};

describe('voice relay card expiration value parser', () => {
  test.each([
    'Your card expires September 2029.',
    'Su tarjeta vence septiembre 2029.',
    'La tarjeta expira septiembre 2029.',
    'Su tarjeta de crédito vence en septiembre 2029.',
    'Su tarjeta caduca septiembre 2029.',
    'Su tarjeta es válida hasta septiembre 2029.',
    'La tarjeta válida hasta septiembre 2029.',
    'Su Visa vence septiembre 2029.',
    'Your card expires next September 2029.',
    'Your card expires this September 2029.',
    'Your card expiration date is listed as September 2029.',
    'Your card expiration date is shown as 09/29.',
    'Your Visa expires September 2029.',
    'The expiration date on your Visa is September 2029.',
    '  Visa expires September 2029.',
    'Your Mastercard expired September 2029.',
    'Your payment method expires 09/29.',
    'Your debit is valid through September 2029.',
    'My card expires October 2031.',
    'Your card expires 2029.',
    'Your card expires September 29.',
    'Your card expires September two nine.',
    'Your card expires September twenty-nine.',
    'Your card expiration date is in September 2029.',
    'Your card will expire September 2029.',
    'Your card expired September 2026.',
    'The expiration date on your card is September 2029.',
    'The expiry on the card was 09/2026.',
    'Your card has an expiration date of September 2029.',
    'The card has an expiry date of 09/29.',
  ])('extracts an explicit expiration value: %s', (text) => {
    expect(statusFor(text)).toBe('fail');
  });

  test.each([
    'Your appointment is September 12, 2029.',
    'Your appointment date is in September 2029.',
    'The next service date is October 2031.',
    'The service expires September 2029.',
    'Su servicio vence septiembre 2029.',
    'El cupón expira septiembre 2029.',
    'Your card expiration date is unavailable, and your appointment is listed as September 2029.',
    'The coupon expiration date is listed as September 2029.',
    'Your service expiration date is September 2029.',
    'The coupon expiration date is 09/29.',
    'The coupon’s expiration date is September 2029.',
    'The subscription expiry is 09/29.',
    'The travel visa expires September 2029.',
    'Your Visa was issued in 2024.',
    'Your Visa expiration is unavailable, and your appointment is September 2029.',
    'Your card expiration date is unavailable, and your appointment is September 12, 2029.',
    'Your card expiration date is unavailable, the service date is September 12, 2029, the office phone number is 941-555-0182, and the balance is $129.00.',
    'Your card expiration date is unavailable, while your appointment is September 29.',
    'Your card payment is due on 09/29/2026.',
    'Your card expired, and your appointment is September 2026.',
    'The expiration date on your card is unavailable, and the next service is September 2029.',
    'You can update your card on September 29th, 2026.',
    'The appointment has a date of September 2029.',
    'Your card has no expiration date on file, and the appointment date is September 2029.',
    'Your card expiration date is unavailable, and the appointment has a date of September 2029.',
  ])('keeps a non-card date exempt: %s', (text) => {
    expect(statusFor(text)).toBe('pass');
  });

  test.each([
    'Your appointment is September 12, 2029, and your card expires October 2030.',
    'Your service expiration date is September 2029, and your card expires October 2030.',
    'The coupon expiration date is 09/29, and your security code is 123.',
    'Your card expiration date is 09/29, and the coupon expiration date is 10/30.',
    'Your appointment is September 2029 with a card that will expire October 2030.',
    'Your appointment is September 2029, but your card expiration date is in October 2030.',
    'Your card expires September 2029, while the office phone number is 941-555-0182 and the balance is $129.00.',
    'Your card ends in 2029, while your appointment is September 12, 2030 and the balance is $129.00.',
    'Your card ends in two zero two nine, while your appointment is September 12, 2030 and the balance is $129.00.',
    'Your card has an expiration date of September 2029, while the appointment has a date of October 2030.',
  ])('retains a card value beside a non-card date: %s', (text) => {
    expect(statusFor(text)).toBe('fail');
  });

  test.each([
    'The expiration date is September 2029.',
    'Your card expires: September 2029.',
    'The expiration date is: September 2029.',
    'Your card expires:09/29.',
    'Your card expires — September 2029.',
    'Your card expires September 4, 2026 per the portal.',
    'Your card expiration date is September 4, 2026.',
    'My card expires 09/29.',
    'Your card expires 09/29/2026.',
    'Your card expires September 29th, 2026.',
    'Your card number is 09/29/2026.',
    'La fecha de vencimiento es 09/29/2029.',
  ])('does not apply a calendar exemption to an explicit card value: %s', (text) => {
    expect(statusFor(text)).toBe('fail');
  });

  test('keeps an ordinary Spanish calendar date exempt', () => {
    expect(statusFor('La fecha de la cita es 09/29/2029.')).toBe('pass');
  });

  test.each([
    'The appointment date is: September 2029.',
    'Your card expiration is unavailable. The appointment date is: September 2029.',
  ])('keeps punctuation from changing date ownership: %s', (text) => {
    expect(statusFor(text)).toBe('pass');
  });

  test.each([
    ['My card expires October 2031.', '10.', 'fail'],
    ['Su tarjeta vence septiembre 2029.', '09/29, correcto.', 'fail'],
    ['La tarjeta expira septiembre 2029.', 'Cero nueve.', 'fail'],
    ['My Visa expires October 2031.', 'One zero.', 'fail'],
    ['My card expires October 2031.', 'One zero.', 'fail'],
    ['My card expires October 2031.', 'One zero three one.', 'fail'],
    ['My card expires October 2031.', 'One zero three.', 'fail'],
    ['My card expires October 2031.', 'One zero three two.', 'pass'],
    ['My card expires October 2031.', 'The balance is $1031.', 'pass'],
    ['My card expires November 2031.', '11.', 'fail'],
    ['My card expires December 2031.', 'One two.', 'fail'],
    ['My card expires October 2031.', '31.', 'fail'],
    ['My card expires September 2031.', '10.', 'pass'],
    ['My card expires October 2031.', '11.', 'pass'],
    ['My card expires October 2031.', '30.', 'pass'],
    ['My card expires October 2031.', 'The appointment is October 2031.', 'pass'],
    ['My card expires October 2031.', 'The balance is $10.', 'pass'],
    ['My card expires October 2031.', 'We have 10 appointments.', 'pass'],
  ])('matches only caller-supplied expiration fragments: %s -> %s', (caller, reply, expected) => {
    expect(statusAfterCaller(caller, reply)).toBe(expected);
  });

  test.each([
    ['The coupon has an expiration date of September 2029.', 'pass'],
    ['The service has an expiration date of 09/29.', 'pass'],
    ['The subscription had an expiry of September 2029.', 'pass'],
    ['The warranty with an expiration date of 09/29 is available.', 'pass'],
    ['Your card has an expiration date of September 2029.', 'fail'],
    ['The coupon has an expiration date of September 2029, and your card expires October 2030.', 'fail'],
    ['The service has an expiration date of 09/29, and I heard four.', 'fail'],
  ])('preserves the expiration subject and nearby card values: %s', (text, expected) => {
    expect(statusFor(text)).toBe(expected);
  });

  test.each([
    ['September 2029', '0929'],
    ['September 29, 2029', '092929'],
    ['09/29', '0929'],
    ['09/29/2029', '092929'],
    ['septiembre dos mil veintinueve', '0929'],
    ['29 de septiembre de 2029', '092929'],
    ['veintinueve de septiembre de dos mil veintinueve', '092929'],
  ])('normalizes expiration values: %s', (value, expected) => {
    expect(normalizedCardExpiration(value)).toBe(expected);
  });

  test.each([
    ['September 2029', '09/29', true],
    ['September 29, 2029', '09/29/2029', true],
    ['October 2031', '10', true],
    ['October 2031', '11', false],
    ['septiembre dos mil veintinueve', '09/29', true],
    ['29 de septiembre de 2029', '09/29/2029', true],
  ])('compares equivalent expiration forms: %s / %s', (supplied, candidate, expected) => {
    expect(cardValuesMatch(supplied, candidate)).toBe(expected);
  });

  test('matches a spoken compound expiration year to its numeric echo', () => {
    const supplied = cardFragmentsIn('My card expires September two thousand twenty-nine.');
    expect(supplied).toEqual(['September 2029']);
    expect(cardFragmentsIn('2029.', supplied)).toEqual(['2029']);
    expect(cardValuesMatch('September two thousand twenty-nine', '09/29')).toBe(true);
  });

  test('matches a Spanish day-first expiration to its numeric echo', () => {
    const supplied = cardFragmentsIn('Su tarjeta vence veintinueve de septiembre de dos mil veintinueve.');
    expect(supplied).toEqual(['29 de septiembre de 2029']);
    expect(cardFragmentsIn('09/29/2029.', supplied)).toEqual(['09/29/2029']);
  });

  test.each([
    [['4242', 'September 2029'], '42420929.', ['42420929']],
    [['4242', 'September 2029'], '42422029.', ['42422029']],
    [['123', 'October 2031'], '1231031.', ['1231031']],
    [['4242', 'September 2029'], '42421029.', []],
    [['4242', 'September 2029'], '09294242.', []],
  ])('canonicalizes each expiration before matching combined evidence: %j -> %s', (supplied, reply, expected) => {
    expect(cardFragmentsIn(reply, supplied)).toEqual(expected);
  });

  test.each([
    ['September, correct?', ['September 2029'], ['September']],
    ["It's September, correct?", ['September 2029'], ['September']],
    ['Thanks. September, correct?', ['September 2029'], ['September']],
    ['September.', ['September 2029'], ['September']],
    ['Septiembre, correcto?', ['septiembre 2029'], ['Septiembre']],
    ['October, correct?', ['September 2029'], []],
    ['May I help?', ['May 2029'], []],
    ['The appointment is in September.', ['September 2029'], []],
    ['September is the appointment month.', ['September 2029'], []],
    ['The service month is September.', ['September 2029'], []],
  ])('matches only a bare named month from supplied expiration evidence: %s', (reply, supplied, expected) => {
    expect(cardFragmentsIn(reply, supplied)).toEqual(expected);
  });

  test('extracts a bare month while collecting an explicit card answer', () => {
    expect(cardFragmentsIn('September.', true, true)).toEqual(['September']);
  });

  test.each([
    ['My security code is one hundred oh one.', ['101']],
    ['My security code is a hundred oh one.', ['101']],
    ['My card number is a thousand oh one.', ['1001']],
    ['My security code is one hundred zero five.', ['105']],
    ['My card number is two thousand oh one.', ['2001']],
    ['My card number is oh one.', ['01']],
    ['My card number is one hundred oh one twenty-three.', ['10123']],
  ])('preserves zero placeholders in English scaled and grouped values: %s', (caller, expected) => {
    expect(cardFragmentsIn(caller)).toEqual(expected);
  });

  test.each([
    ['My security code is one hundred oh one.', '101.'],
    ['My security code is one hundred zero five.', '105.'],
    ['My card number is two thousand oh one.', '2001.'],
  ])('matches an English scaled zero value to its numeric echo: %s', (caller, reply) => {
    expect(cardFragmentsIn(reply, cardFragmentsIn(caller))).toEqual([reply.replace('.', '')]);
  });

  test.each([
    ['I heard one hundred oh one appointments and your card ends in four.', ['4']],
    ['The balance is one hundred oh one dollars and your security code is two hundred three.', ['203']],
    ['My card number is one hundred oh one, and we have twenty-three appointments.', ['101']],
  ])('keeps scaled-zero amount and count spans separate from neighboring card values: %s', (text, expected) => {
    expect(cardFragmentsIn(text)).toEqual(expected);
  });
});
