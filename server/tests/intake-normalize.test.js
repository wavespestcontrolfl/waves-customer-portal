const {
  cleanEmail,
  normalizeCallExtraction,
  normalizeNanpPhone,
  normalizePhoneForStorage,
  normalizeWebsiteQuoteContact,
} = require('../utils/intake-normalize');

describe('intake contact normalization', () => {
  test('website quote contact trims names, lowercases email, and normalizes NANP phones', () => {
    const contact = normalizeWebsiteQuoteContact({
      firstName: '  AS  ',
      lastName: '  Van   Meter ',
      email: ' TEST@Example.COM ',
      phone: '(941) 555-0100',
    });

    expect(contact).toMatchObject({
      firstName: 'AS',
      lastName: 'Van Meter',
      email: 'test@example.com',
      phoneRaw: '(941) 555-0100',
      phoneE164: '+19415550100',
      phoneForStorage: '+19415550100',
    });
  });

  test('website phone storage preserves unparseable input instead of fabricating E.164', () => {
    expect(normalizeNanpPhone('12345')).toBeNull();
    expect(normalizePhoneForStorage(' 12345 ')).toBe('12345');
  });

  test('email cleanup is trim plus lowercase only', () => {
    expect(cleanEmail(' Customer+Tag@Example.COM ')).toBe('customer+tag@example.com');
  });

  test('call extraction sanitizes transcript-derived customer fields', () => {
    const extracted = normalizeCallExtraction({
      first_name: '  Jane ',
      last_name: '  DOE ',
      email: 'jane at example dot com',
      phone: null,
      address_line1: '  123   Main St ',
      city: '  Sarasota ',
      state: ' Florida ',
      zip: '34239-1234',
      call_summary: '  Asked   about ants. ',
    }, {
      callerPhone: '(941) 555-0100',
    });

    expect(extracted).toMatchObject({
      first_name: 'Jane',
      last_name: 'DOE',
      email: null,
      phone: '+19415550100',
      address_line1: '123 Main St',
      city: 'Sarasota',
      state: 'FL',
      zip: '34239',
      call_summary: 'Asked about ants.',
    });
  });

  test('call extraction does not preserve invalid raw phones', () => {
    expect(normalizeCallExtraction({ phone: '12345' }).phone).toBeNull();
    expect(normalizeCallExtraction({ phone: '12345' }, { callerPhone: '(941) 555-0100' }).phone).toBe('+19415550100');
    expect(normalizeCallExtraction({ phone: '+44 20 7946 0958' }).phone).toBe('+442079460958');
  });

  test('call extraction drops invalid ZIP text', () => {
    expect(normalizeCallExtraction({ zip: 'not sure' }).zip).toBeNull();
  });

  test('call extraction only keeps Florida state values', () => {
    expect(normalizeCallExtraction({ state: 'Florida' }).state).toBe('FL');
    expect(normalizeCallExtraction({ state: 'GA' }).state).toBeNull();
  });

  test('call extraction tolerates non-object JSON responses', () => {
    expect(normalizeCallExtraction(null, { callerPhone: '(941) 555-0100' })).toMatchObject({
      first_name: null,
      email: null,
      phone: '+19415550100',
      state: 'FL',
    });
    expect(normalizeCallExtraction(['bad'])).toMatchObject({
      first_name: null,
      phone: null,
      state: 'FL',
    });
  });
});
