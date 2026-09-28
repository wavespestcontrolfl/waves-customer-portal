// Pure-function tests for the missing-contact capture on the public estimate
// accept card (owner ruling 2026-09-27) — gap detection + input
// sanitization/validation. No DB, no route — see
// estimate-public-accept-atomicity.test.js for the integration coverage
// (new-profile placeholder replacement, existing-customer never-overwrite,
// invalid email 400).
const {
  computeContactGaps,
  sanitizeContactLastName,
  sanitizeContactFirstName,
  sanitizeContactEmail,
  CONTACT_LAST_NAME_MAX,
  CONTACT_EMAIL_MAX,
} = require('../services/estimate-contact-gaps');

describe('computeContactGaps', () => {
  test('unlinked estimate, single-token name, no email: both gaps true', () => {
    const gaps = computeContactGaps({ estimate: { customer_name: 'Testy', customer_email: null } });
    expect(gaps).toEqual({ firstName: false, lastName: true, email: true });
  });

  test('unlinked estimate with a full two-token name and an email: no gaps', () => {
    const gaps = computeContactGaps({
      estimate: { customer_name: 'Testy Sample', customer_email: 'testy@example.com' },
    });
    expect(gaps).toEqual({ firstName: false, lastName: false, email: false });
  });

  test('the legacy "Testy undefined" concatenation artifact still reads as a lastName gap', () => {
    const gaps = computeContactGaps({ estimate: { customer_name: 'Testy undefined', customer_email: 'x@example.com' } });
    expect(gaps.lastName).toBe(true);
  });

  test('a linked customer with a real last name closes the gap even if the estimate row is single-token', () => {
    const gaps = computeContactGaps({
      estimate: { customer_name: 'Testy', customer_email: null },
      linkedCustomer: { last_name: 'Sample', email: 'testy@example.com' },
    });
    expect(gaps).toEqual({ firstName: false, lastName: false, email: false });
  });

  test('the "Customer" placeholder on the linked customer does NOT close the lastName gap', () => {
    const gaps = computeContactGaps({
      estimate: { customer_name: 'Testy', customer_email: null },
      linkedCustomer: { last_name: 'Customer', email: null },
    });
    expect(gaps).toEqual({ firstName: false, lastName: true, email: true });
  });

  test('a blank/null linked customer last_name or email still gaps', () => {
    const gaps = computeContactGaps({
      estimate: { customer_name: 'Testy', customer_email: '' },
      linkedCustomer: { last_name: '', email: null },
    });
    expect(gaps).toEqual({ firstName: false, lastName: true, email: true });
  });

  test('nothing to ask when the estimate already carries both fields, even unlinked', () => {
    const gaps = computeContactGaps({
      estimate: { customer_name: 'Testy Sample', customer_email: 'testy@example.com' },
    });
    expect(gaps).toEqual({ firstName: false, lastName: false, email: false });
  });
});

describe('sanitizeContactLastName', () => {
  test('absent/blank/non-string input is not an error — just nothing supplied', () => {
    expect(sanitizeContactLastName(undefined)).toEqual({ value: null, error: null });
    expect(sanitizeContactLastName(null)).toEqual({ value: null, error: null });
    expect(sanitizeContactLastName('   ')).toEqual({ value: null, error: null });
    expect(sanitizeContactLastName(42)).toEqual({ value: null, error: null });
  });

  test('collapses internal whitespace and trims', () => {
    expect(sanitizeContactLastName('  Sample   Name  ')).toEqual({ value: 'Sample Name', error: null });
  });

  test('caps length at CONTACT_LAST_NAME_MAX rather than rejecting', () => {
    const long = 'A'.repeat(CONTACT_LAST_NAME_MAX + 20);
    const { value, error } = sanitizeContactLastName(long);
    expect(error).toBeNull();
    expect(value).toHaveLength(CONTACT_LAST_NAME_MAX);
  });

  test('rejects control characters', () => {
    const { value, error } = sanitizeContactLastName('Sample\x01Name');
    expect(value).toBeNull();
    expect(error).toEqual({ code: 'CONTACT_LAST_NAME_INVALID', message: 'Please enter a valid last name.' });
  });
});

describe('sanitizeContactEmail', () => {
  test('absent/blank/non-string input is not an error', () => {
    expect(sanitizeContactEmail(undefined)).toEqual({ value: null, error: null });
    expect(sanitizeContactEmail('   ')).toEqual({ value: null, error: null });
    expect(sanitizeContactEmail(42)).toEqual({ value: null, error: null });
  });

  test('trims and lowercases a valid address', () => {
    expect(sanitizeContactEmail('  Testy@Example.COM  ')).toEqual({ value: 'testy@example.com', error: null });
  });

  test('rejects a malformed address', () => {
    for (const bad of ['not-an-email', 'missing-domain@', '@no-local.com', 'plain text with spaces@x.com']) {
      const { value, error } = sanitizeContactEmail(bad);
      expect(value).toBeNull();
      expect(error).toEqual({ code: 'CONTACT_EMAIL_INVALID', message: 'Please enter a valid email address.' });
    }
  });

  test('rejects an address over the length cap rather than truncating it', () => {
    const long = `${'a'.repeat(CONTACT_EMAIL_MAX)}@example.com`;
    const { value, error } = sanitizeContactEmail(long);
    expect(value).toBeNull();
    expect(error?.code).toBe('CONTACT_EMAIL_INVALID');
  });

  test('rejects control characters even inside an otherwise valid-looking address', () => {
    const { value, error } = sanitizeContactEmail('sample\x01@example.com');
    expect(value).toBeNull();
    expect(error?.code).toBe('CONTACT_EMAIL_INVALID');
  });
});

describe('computeContactGaps — stored placeholder names', () => {
  test.each(['Unknown caller', 'New Customer', '  unknown   CALLER '])('%s reads as a missing last name', (name) => {
    expect(computeContactGaps({ estimate: { customer_name: name, customer_email: 'x@example.com' } }).lastName).toBe(true);
  });
});

describe('computeContactGaps — legacy surname sentinels on the linked customer', () => {
  test.each(['undefined', 'NULL', ' Null '])('linked last_name %p does not close the gap', (last) => {
    const gaps = computeContactGaps({ estimate: { customer_name: 'Pat', customer_email: 'x@example.com' }, linkedCustomer: { last_name: last, email: 'x@example.com' } });
    expect(gaps.lastName).toBe(true);
  });
});

describe('computeContactGaps — appended placeholder surname', () => {
  test('"Pat Customer" reads as a missing last name', () => {
    expect(computeContactGaps({ estimate: { customer_name: 'Pat Customer', customer_email: 'x@example.com' } }).lastName).toBe(true);
  });
  test('a real two-word name is untouched', () => {
    expect(computeContactGaps({ estimate: { customer_name: 'Customer Sample', customer_email: 'x@example.com' } }).lastName).toBe(false);
  });
});

describe('computeContactGaps — first name only when there is none anywhere', () => {
  test('a placeholder-only estimate with no linked profile asks for a first name', () => {
    expect(computeContactGaps({ estimate: { customer_name: 'Unknown caller', customer_email: 'x@example.com' } }).firstName).toBe(true);
  });
  test('an estimate with a real first name never asks for one', () => {
    expect(computeContactGaps({ estimate: { customer_name: 'Pat', customer_email: 'x@example.com' } }).firstName).toBe(false);
  });
  test('a linked profile with a real first name closes the first-name gap', () => {
    expect(computeContactGaps({ estimate: { customer_name: '' }, linkedCustomer: { first_name: 'Pat' } }).firstName).toBe(false);
  });
  test('a linked placeholder first name ("New") does not', () => {
    expect(computeContactGaps({ estimate: { customer_name: '' }, linkedCustomer: { first_name: 'New' } }).firstName).toBe(true);
  });
});

describe('name sanitizers — canonical contact normalization', () => {
  test('surname casing is normalized once, before the cap', () => {
    expect(sanitizeContactLastName("o'BRIEN").value).toBe("O'Brien");
  });
  test('first name goes through the same normalizer', () => {
    expect(sanitizeContactFirstName('testy').value).toBe('Testy');
    expect(sanitizeContactFirstName('Sample\u0001').error.code).toBe('CONTACT_FIRST_NAME_INVALID');
  });
});

describe('computeContactGaps — multi-word given name with no surname', () => {
  test('an estimate name equal to the linked multi-word first name still asks for a surname', () => {
    const gaps = computeContactGaps({ estimate: { customer_name: 'Mary Ann', customer_email: 'x@example.com' }, linkedCustomer: { first_name: 'Mary Ann', last_name: null } });
    expect(gaps.lastName).toBe(true);
  });
  test('the legacy "Mary Ann Customer" shape too', () => {
    const gaps = computeContactGaps({ estimate: { customer_name: 'Mary Ann Customer' }, linkedCustomer: { first_name: 'Mary Ann', last_name: 'Customer' } });
    expect(gaps.lastName).toBe(true);
  });
  test('a real surname on the profile still closes it', () => {
    const gaps = computeContactGaps({ estimate: { customer_name: 'Mary Ann' }, linkedCustomer: { first_name: 'Mary Ann', last_name: 'Sample' } });
    expect(gaps.lastName).toBe(false);
  });
});

describe('computeContactGaps — every placeholder-only name shape', () => {
  test.each(['Customer', 'Unknown', 'Unknown Customer', 'unknown caller', 'New Customer'])('%p asks for a first name too', (name) => {
    const gaps = computeContactGaps({ estimate: { customer_name: name, customer_email: 'x@example.com' } });
    expect(gaps.firstName).toBe(true);
    expect(gaps.lastName).toBe(true);
  });
  test('a real name that merely contains a placeholder word is kept', () => {
    // A placeholder word as the SURNAME of a real given name is kept
    // (a leading placeholder is a missing first name — covered below).
    expect(computeContactGaps({ estimate: { customer_name: 'Pat New', customer_email: 'x@example.com' } }).firstName).toBe(false);
  });
});

describe('one placeholder rule everywhere', () => {
  test.each(['Customer', 'undefined', 'NULL', 'Unknown', 'unknown caller'])('typed %p is rejected as a name', (v) => {
    expect(sanitizeContactLastName(v).error.code).toBe('CONTACT_LAST_NAME_INVALID');
    expect(sanitizeContactFirstName(v).error.code).toBe('CONTACT_FIRST_NAME_INVALID');
  });
  test('a linked profile split as Unknown + caller is missing both names', () => {
    const gaps = computeContactGaps({ estimate: { customer_name: 'Unknown caller', customer_email: 'x@example.com' }, linkedCustomer: { first_name: 'Unknown', last_name: 'caller', email: 'x@example.com' } });
    expect(gaps.firstName).toBe(true);
    expect(gaps.lastName).toBe(true);
  });
});

describe('leading placeholder given name ("Unknown Smith")', () => {
  test('asks for the first name but keeps the real surname', () => {
    const gaps = computeContactGaps({ estimate: { customer_name: 'Unknown Smith', customer_email: 'x@example.com' } });
    expect(gaps.firstName).toBe(true);
    expect(gaps.lastName).toBe(false);
  });
});

describe('code-point-safe name cap', () => {
  test('never splits a surrogate pair at the 50-character boundary', () => {
    const v = sanitizeContactLastName(`${'a'.repeat(49)}\u{1F600}b`).value;
    expect(Array.from(v)).toHaveLength(50);
    expect(v.endsWith('\u{1F600}')).toBe(true);
  });
  test('a lone surrogate is rejected', () => {
    expect(sanitizeContactLastName('Sam\uD800ple').error.code).toBe('CONTACT_LAST_NAME_INVALID');
  });
});
