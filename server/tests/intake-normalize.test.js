const {
  cleanEmail,
  normalizeCallExtraction,
  normalizeNanpPhone,
  normalizePhoneForStorage,
  normalizeWebsiteQuoteContact,
  normalizeContactRecord,
  applyContactNormalization,
  normalizeContactZip,
  normalizeContactStreet,
  normalizeContactStateField,
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

  test('website quote contact rejects non-string required values', () => {
    const contact = normalizeWebsiteQuoteContact({
      firstName: false,
      lastName: 0,
      email: false,
      phone: 0,
    });

    expect(contact).toMatchObject({
      firstName: '',
      lastName: '',
      email: '',
      phoneRaw: '',
      phoneE164: null,
      phoneForStorage: null,
    });
  });

  test('email cleanup is trim plus lowercase only', () => {
    expect(cleanEmail(' Customer+Tag@Example.COM ')).toBe('customer+tag@example.com');
    expect(cleanEmail(false)).toBe('');
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
    expect(normalizeCallExtraction({ state: '' }).state).toBeNull();
    expect(normalizeCallExtraction({}).state).toBeNull();
  });

  test('call extraction rejects non-string contact text fields', () => {
    const extracted = normalizeCallExtraction({
      first_name: false,
      last_name: 0,
      address_line1: { street: '123 Main Street' },
      city: 34239,
      state: false,
      zip: 34239,
      call_summary: false,
    });

    expect(extracted).toMatchObject({
      first_name: null,
      last_name: null,
      address_line1: null,
      city: null,
      state: null,
      zip: null,
      call_summary: null,
    });

    expect(normalizeCallExtraction({ address_line1: true }).address_line1).toBeNull();
  });

  test('call extraction tolerates non-object JSON responses', () => {
    expect(normalizeCallExtraction(null, { callerPhone: '(941) 555-0100' })).toMatchObject({
      first_name: null,
      email: null,
      phone: '+19415550100',
      state: null,
    });
    expect(normalizeCallExtraction(['bad'])).toMatchObject({
      first_name: null,
      phone: null,
      state: null,
    });
  });
});

describe('normalizeContactRecord — canonical write-path formatting', () => {
  test('formats every contact field to its stored form', () => {
    expect(normalizeContactRecord({
      first_name: 'charles',
      last_name: 'SANTIAGO',
      email: '  Charles.Santiago@GMAIL.com ',
      phone: '(727) 421-9951',
      address_line1: '1234 sw 5th avenue',
      address_line2: 'apt b',
      city: 'PORT CHARLOTTE',
      state: 'florida',
      zip: '33948-1234',
    })).toEqual({
      first_name: 'Charles',
      last_name: 'Santiago',
      email: 'charles.santiago@gmail.com',
      phone: '+17274219951',
      address_line1: '1234 SW 5th Ave',
      address_line2: 'Apt B',
      city: 'Port Charlotte',
      state: 'FL',
      zip: '33948',
    });
  });

  test('abbreviates street suffixes and keeps 5-digit zip', () => {
    expect(normalizeContactStreet('45 north harbor boulevard')).toBe('45 North Harbor Blvd');
    // Suffix is abbreviated; spelled-out directionals stay words, abbreviated
    // ones are upper-cased.
    expect(normalizeContactStreet('789 East Main Street')).toBe('789 East Main St');
    expect(normalizeContactStreet('1234 sw 5th avenue')).toBe('1234 SW 5th Ave');
    expect(normalizeContactZip('34102-5567')).toBe('34102');
    expect(normalizeContactZip('34102')).toBe('34102');
  });

  test('handles Mc/Mac/O\' and naming particles via properCase', () => {
    expect(normalizeContactRecord({ first_name: 'macdonald', last_name: "o'brien-smith" }))
      .toEqual({ first_name: 'MacDonald', last_name: "O'Brien-Smith" });
    expect(normalizeContactRecord({ last_name: 'de la cruz' }))
      .toEqual({ last_name: 'De la Cruz' });
  });

  test('only returns keys that were supplied', () => {
    expect(normalizeContactRecord({ first_name: 'jane' })).toEqual({ first_name: 'Jane' });
    expect(Object.keys(normalizeContactRecord({ city: 'venice', zip: '34285' })).sort())
      .toEqual(['city', 'zip']);
  });

  test('preserves the value the caller chose for empty/null fields (no null<->"" coercion)', () => {
    expect(normalizeContactRecord({ phone: null, email: null, last_name: null }))
      .toEqual({ phone: null, email: null, last_name: null });
    expect(normalizeContactRecord({ city: '', zip: '' }))
      .toEqual({ city: '', zip: '' });
  });

  test('is idempotent on already-canonical values', () => {
    const once = normalizeContactRecord({
      first_name: 'Charles', last_name: 'Santiago', phone: '+17274219951',
      email: 'a@b.com', address_line1: '1234 SW 5th Ave', city: 'Port Charlotte',
      state: 'FL', zip: '33948',
    });
    expect(normalizeContactRecord(once)).toEqual(once);
  });

  test('state falls back to a 2-letter upper code for unmapped values', () => {
    expect(normalizeContactStateField('dc')).toBe('DC');
    expect(normalizeContactStateField('Georgia')).toBe('GA');
    expect(normalizeContactStateField('')).toBe('');
  });

  test('applyContactNormalization normalizes contact fields and leaves the rest untouched', () => {
    expect(applyContactNormalization({
      first_name: 'jose',
      last_name: 'de la cruz',
      phone: null,
      city: '',
      pipeline_stage: 'won',
      account_id: 42,
      monthly_rate: 89,
    })).toEqual({
      first_name: 'Jose',
      last_name: 'De la Cruz',
      phone: null,
      city: '',
      pipeline_stage: 'won',
      account_id: 42,
      monthly_rate: 89,
    });
  });

  test('tolerates non-object input', () => {
    expect(normalizeContactRecord(null)).toEqual({});
    expect(normalizeContactRecord(undefined)).toEqual({});
    expect(applyContactNormalization(null)).toEqual({});
  });
});
