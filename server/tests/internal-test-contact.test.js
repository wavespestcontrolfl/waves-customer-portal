// isInternalTestContact: the one rule the ad lanes use to keep the owner's own
// test records out of conversions and contact lists.
const {
  isInternalTestContact,
  isInternalTestCustomerId,
  isInternalTestEmail,
  INTERNAL_TEST_CUSTOMERS,
} = require('../services/internal-test-customers');

const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; });

// The listed test name, read from the list so no real name is written here.
const [LISTED_FIRST, ...LISTED_REST] = INTERNAL_TEST_CUSTOMERS[0].split(' ');
const LISTED_LAST = LISTED_REST.join(' ');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

describe('isInternalTestContact', () => {
  test('existing exports keep working', () => {
    expect(isInternalTestCustomerId('3274944a-f509-413c-9dee-a8b0cdb16493')).toBe(true);
    expect(isInternalTestEmail('AppReview+demo@wavespestcontrol.com')).toBe(true);
    // Names are stored lowercased, as "first last".
    expect(INTERNAL_TEST_CUSTOMERS.length).toBeGreaterThan(0);
    expect(INTERNAL_TEST_CUSTOMERS.every((n) => n === n.trim().toLowerCase())).toBe(true);
  });

  test('a listed customer id', () => {
    expect(isInternalTestContact({ customerId: '3274944a-f509-413c-9dee-a8b0cdb16493' })).toBe(true);
  });

  test('a listed name, case and spacing ignored', () => {
    expect(isInternalTestContact({ firstName: ` ${LISTED_FIRST.toUpperCase()} `, lastName: cap(LISTED_LAST) })).toBe(true);
    expect(isInternalTestContact({ firstName: `${cap(LISTED_FIRST)}  ${cap(LISTED_LAST)}` })).toBe(true);
    expect(isInternalTestContact({ firstName: cap(LISTED_FIRST), lastName: 'Other' })).toBe(false);
  });

  test('a listed email', () => {
    expect(isInternalTestContact({ email: 'appreview+demo@wavespestcontrol.com' })).toBe(true);
  });

  test('the owner cell from ADAM_PHONE, any format; unset = no phone check', () => {
    process.env.ADAM_PHONE = '+19415550177';
    expect(isInternalTestContact({ phone: '+19415550177' })).toBe(true);
    expect(isInternalTestContact({ phone: '(941) 555-0177' })).toBe(true);
    expect(isInternalTestContact({ phone: '941-555-0177' })).toBe(true);
    expect(isInternalTestContact({ phone: '9415550100' })).toBe(false);
    delete process.env.ADAM_PHONE;
    expect(isInternalTestContact({ phone: '9415550177' })).toBe(false);
  });

  test('a Shakedown Test name, split or whole', () => {
    expect(isInternalTestContact({ firstName: 'Shakedown', lastName: 'Test (Waves internal)' })).toBe(true);
    expect(isInternalTestContact({ firstName: 'Shakedown Test' })).toBe(true);
    expect(isInternalTestContact({ firstName: 'Shakedown', lastName: 'Smith' })).toBe(false);
  });

  test('metadata.shakedown, object or JSON string', () => {
    expect(isInternalTestContact({ metadata: { shakedown: true } })).toBe(true);
    expect(isInternalTestContact({ metadata: '{"shakedown":true}' })).toBe(true);
    expect(isInternalTestContact({ metadata: '{"shakedown":false}' })).toBe(false);
    expect(isInternalTestContact({ metadata: 'not json' })).toBe(false);
  });

  test('empty or unrelated contacts are not test records', () => {
    expect(isInternalTestContact()).toBe(false);
    expect(isInternalTestContact({})).toBe(false);
    expect(isInternalTestContact({ firstName: 'Pat', lastName: 'Sample', email: 'pat@example.com', phone: '9415550100' })).toBe(false);
  });
});
