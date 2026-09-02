/**
 * utils/name-match.js — the shared person-name policy (moved out of
 * call-recording-processor.js 2026-09-02). Pins: normalization, nickname-aware
 * first names, and payerNameCorroborates — the identity leg the Zelle notice
 * reconciler requires beside an exact-cent amount match (amount alone is never
 * identity; a near-miss parks for a human).
 */
const {
  normalizeNamePart,
  firstNameVariants,
  sameFirstName,
  payerNameCorroborates,
} = require('../utils/name-match');

describe('normalizeNamePart', () => {
  test('lowercases and strips everything but alphanumerics', () => {
    expect(normalizeNamePart("  O'Brien-Smith ")).toBe('obriensmith');
    expect(normalizeNamePart(null)).toBe('');
  });
});

describe('sameFirstName / firstNameVariants', () => {
  test('equal or same nickname group', () => {
    expect(sameFirstName('robert', 'bob')).toBe(true);
    expect(sameFirstName('pat', 'pat')).toBe(true);
    expect(sameFirstName('robert', 'james')).toBe(false);
    expect(sameFirstName('', 'bob')).toBe(false);
    expect(firstNameVariants('william')).toEqual(expect.arrayContaining(['bill', 'will', 'liam']));
    expect(firstNameVariants('zaphod')).toEqual(['zaphod']);
  });
});

describe('payerNameCorroborates', () => {
  const customer = { first_name: 'Robert', last_name: 'Doe' };

  test('bank-style upper-case "FIRST LAST" corroborates the customer', () => {
    expect(payerNameCorroborates('ROBERT DOE', customer)).toBe(true);
  });

  test('nickname first name still corroborates', () => {
    expect(payerNameCorroborates('Bob Doe', customer)).toBe(true);
  });

  test('joint accounts and middle names: any first-name-compatible token beside the last name', () => {
    expect(payerNameCorroborates('Pat & Robert Doe', customer)).toBe(true);
    expect(payerNameCorroborates('Pat and Robert Doe', customer)).toBe(true);
    expect(payerNameCorroborates('Robert James Doe', customer)).toBe(true);
    expect(payerNameCorroborates('Doe, Robert', customer)).toBe(true);
  });

  test('compound names on either side match as contiguous token runs', () => {
    const delacruz = { first_name: 'Maria', last_name: 'De La Cruz' };
    expect(payerNameCorroborates('MARIA DE LA CRUZ', delacruz)).toBe(true);
    expect(payerNameCorroborates('Maria Delacruz', delacruz)).toBe(true);
    expect(payerNameCorroborates('De La Cruz Maria', delacruz)).toBe(true);
    expect(payerNameCorroborates('Jose De La Cruz', delacruz)).toBe(false);
    const maryAnn = { first_name: 'Mary Ann', last_name: 'Smith' };
    expect(payerNameCorroborates('MARY ANN SMITH', maryAnn)).toBe(true);
    expect(payerNameCorroborates('MaryAnn Smith', maryAnn)).toBe(true);
    expect(payerNameCorroborates('Ann Smith', maryAnn)).toBe(false);
  });

  test('last name must appear as a whole token — typo variants never match', () => {
    expect(payerNameCorroborates('Robert Doee', customer)).toBe(false);
    expect(payerNameCorroborates('Robert Do', customer)).toBe(false);
  });

  test('a different first name with the right last name does not corroborate (spouse on the bill is a human call)', () => {
    expect(payerNameCorroborates('Pat Doe', customer)).toBe(false);
  });

  test('an initial never satisfies the first-name leg', () => {
    expect(payerNameCorroborates('R. Doe', customer)).toBe(false);
    expect(payerNameCorroborates('R Doe', customer)).toBe(false);
  });

  test('a customer record missing either name part never corroborates', () => {
    expect(payerNameCorroborates('Robert Doe', { first_name: 'Robert' })).toBe(false);
    expect(payerNameCorroborates('Robert Doe', { last_name: 'Doe' })).toBe(false);
    expect(payerNameCorroborates('', customer)).toBe(false);
  });
});
