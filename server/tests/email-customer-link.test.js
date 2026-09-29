'use strict';

const { extractEmailAddresses, personSentFilter } = require('../services/email/email-customer-link');

describe('extractEmailAddresses', () => {
  test('a bare address passes through', () => {
    expect(extractEmailAddresses('customer@example.invalid')).toEqual(['customer@example.invalid']);
  });

  test('"Name <addr>" form (the raw shape Gmail actually stores in to_address)', () => {
    expect(extractEmailAddresses('Jamie Fixture <jamie.fixture@example.invalid>')).toEqual(['jamie.fixture@example.invalid']);
  });

  test('a comma-separated multi-recipient list, mixed "Name <addr>" and bare', () => {
    expect(extractEmailAddresses('Jamie Fixture <jamie.fixture@example.invalid>, other.fixture@example.invalid'))
      .toEqual(['jamie.fixture@example.invalid', 'other.fixture@example.invalid']);
  });

  test('a display name containing a comma does not split into a false extra address', () => {
    expect(extractEmailAddresses('Fixture, Jamie <jamie.fixture@example.invalid>')).toEqual(['jamie.fixture@example.invalid']);
  });

  test('lowercases and de-duplicates', () => {
    expect(extractEmailAddresses('Jamie@Example.Invalid, jamie@example.invalid')).toEqual(['jamie@example.invalid']);
  });

  test('empty/null/no-address input returns an empty array', () => {
    expect(extractEmailAddresses(null)).toEqual([]);
    expect(extractEmailAddresses('')).toEqual([]);
    expect(extractEmailAddresses('Jamie Fixture')).toEqual([]);
  });
});

describe('personSentFilter', () => {
  test('builds a jsonb_exists SENT-not-INBOX predicate for the given alias', () => {
    expect(personSentFilter('er')).toBe("jsonb_exists(er.label_ids::jsonb, 'SENT') AND NOT jsonb_exists(er.label_ids::jsonb, 'INBOX')");
  });
});
