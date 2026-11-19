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

describe('isInternalTestContact', () => {
  test('existing exports keep working', () => {
    expect(isInternalTestCustomerId('3274944a-f509-413c-9dee-a8b0cdb16493')).toBe(true);
    expect(isInternalTestEmail('AppReview+demo@wavespestcontrol.com')).toBe(true);
    expect(INTERNAL_TEST_CUSTOMERS).toContain('adam martinez');
  });

  test('a listed customer id', () => {
    expect(isInternalTestContact({ customerId: '3274944a-f509-413c-9dee-a8b0cdb16493' })).toBe(true);
  });

  test('a listed name, case and spacing ignored', () => {
    expect(isInternalTestContact({ firstName: ' ADAM ', lastName: 'Martinez' })).toBe(true);
    expect(isInternalTestContact({ firstName: 'Adam  Martinez' })).toBe(true);
    expect(isInternalTestContact({ firstName: 'Adam', lastName: 'Other' })).toBe(false);
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
