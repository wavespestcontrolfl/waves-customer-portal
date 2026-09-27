// Pure-function tests for the missing-contact capture on the public estimate
// accept card (owner ruling 2026-09-27) — gap detection + input
// sanitization/validation. No DB, no route — see
// estimate-public-accept-atomicity.test.js for the integration coverage
// (new-profile placeholder replacement, existing-customer never-overwrite,
// invalid email 400).
const {
  computeContactGaps,
  sanitizeContactLastName,
  sanitizeContactEmail,
  CONTACT_LAST_NAME_MAX,
  CONTACT_EMAIL_MAX,
} = require('../services/estimate-contact-gaps');

describe('computeContactGaps', () => {
  test('unlinked estimate, single-token name, no email: both gaps true', () => {
    const gaps = computeContactGaps({ estimate: { customer_name: 'Testy', customer_email: null } });
    expect(gaps).toEqual({ lastName: true, email: true });
  });

  test('unlinked estimate with a full two-token name and an email: no gaps', () => {
    const gaps = computeContactGaps({
      estimate: { customer_name: 'Testy Sample', customer_email: 'testy@example.com' },
    });
    expect(gaps).toEqual({ lastName: false, email: false });
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
    expect(gaps).toEqual({ lastName: false, email: false });
  });

  test('the "Customer" placeholder on the linked customer does NOT close the lastName gap', () => {
    const gaps = computeContactGaps({
      estimate: { customer_name: 'Testy', customer_email: null },
      linkedCustomer: { last_name: 'Customer', email: null },
    });
    expect(gaps).toEqual({ lastName: true, email: true });
  });

  test('a blank/null linked customer last_name or email still gaps', () => {
    const gaps = computeContactGaps({
      estimate: { customer_name: 'Testy', customer_email: '' },
      linkedCustomer: { last_name: '', email: null },
    });
    expect(gaps).toEqual({ lastName: true, email: true });
  });

  test('nothing to ask when the estimate already carries both fields, even unlinked', () => {
    const gaps = computeContactGaps({
      estimate: { customer_name: 'Testy Sample', customer_email: 'testy@example.com' },
    });
    expect(gaps).toEqual({ lastName: false, email: false });
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
