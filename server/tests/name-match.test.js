/**
 * utils/name-match.js — the shared person-name policy (moved out of
 * call-recording-processor.js 2026-09-02). Pins: normalization, nickname-aware
 * first names, and payerNameCorroborates — the identity leg the Zelle notice
 * reconciler requires beside an exact-cent amount match (amount alone is never
 * identity; a near-miss parks for a human).
 */
const {
  normalizeNamePart,
  normalizeNameFolded,
  firstNameVariants,
  sameFirstName,
  payerNameCorroborates,
} = require('../utils/name-match');

describe('normalizeNamePart', () => {
  test('stays the byte-identical twin of the call processor SQL normalization (no diacritic folding)', () => {
    expect(normalizeNamePart('JOSÉ NUÑEZ')).toBe('josnuez');
  });

  test('normalizeNameFolded folds diacritics instead of deleting the letters', () => {
    expect(normalizeNameFolded('JOSÉ NUÑEZ')).toBe('josenunez');
    expect(normalizeNameFolded('José')).not.toBe(normalizeNameFolded('Jos'));
    expect(normalizeNameFolded('SØREN ŁUKASZ Œ')).toBe('sorenlukaszoe');
    expect(payerNameCorroborates('SØREN DOE', { first_name: 'Soren', last_name: 'Doe' })).toBe(true);
    expect(payerNameCorroborates('SØREN DOE', { first_name: 'Sren', last_name: 'Doe' })).toBe(false);
  });

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

  test('an ambiguous nickname (Pat / Chris / Sam / Alex) only matches an identical customer first name', () => {
    expect(payerNameCorroborates('PAT DOE', { first_name: 'Patrick', last_name: 'Doe' })).toBe(false);
    expect(payerNameCorroborates('PAT DOE', { first_name: 'Patricia', last_name: 'Doe' })).toBe(false);
    expect(payerNameCorroborates('PAT DOE', { first_name: 'Pat', last_name: 'Doe' })).toBe(true);
    expect(payerNameCorroborates('SAM DOE', { first_name: 'Samuel', last_name: 'Doe' })).toBe(false);
    // The bank's full name still resolves a customer recorded by nickname.
    expect(payerNameCorroborates('SAMANTHA DOE', { first_name: 'Sam', last_name: 'Doe' })).toBe(true);
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
    // Surname-first without a comma is not a bank form — the surname is the trailing run.
    expect(payerNameCorroborates('De La Cruz Maria', delacruz)).toBe(false);
    expect(payerNameCorroborates('Jose De La Cruz', delacruz)).toBe(false);
    // The fragment after a particle is not a surname: Maria De La Cruz is not Maria Cruz.
    expect(payerNameCorroborates('MARIA DE LA CRUZ', { first_name: 'Maria', last_name: 'Cruz' })).toBe(false);
    expect(payerNameCorroborates('MARIA DE LA CRUZ', { first_name: 'Maria', last_name: 'La Cruz' })).toBe(false);
    expect(payerNameCorroborates('DICK VAN DYKE', { first_name: 'Dick', last_name: 'Dyke' })).toBe(false);
    expect(payerNameCorroborates('DICK VAN DYKE', { first_name: 'Dick', last_name: 'Van Dyke' })).toBe(true);
    const maryAnn = { first_name: 'Mary Ann', last_name: 'Smith' };
    expect(payerNameCorroborates('MARY ANN SMITH', maryAnn)).toBe(true);
    expect(payerNameCorroborates('MaryAnn Smith', maryAnn)).toBe(true);
    expect(payerNameCorroborates('Ann Smith', maryAnn)).toBe(false);
  });

  test('both name parts must belong to the same person — joint lines and middle names cannot cross-match', () => {
    // Alice Jones and Robert Doe are two people; neither is "Alice Doe".
    expect(payerNameCorroborates('ALICE JONES & ROBERT DOE', { first_name: 'Alice', last_name: 'Doe' })).toBe(false);
    expect(payerNameCorroborates('ALICE JONES & ROBERT DOE', { first_name: 'Alice', last_name: 'Jones' })).toBe(true);
    expect(payerNameCorroborates('ALICE JONES & ROBERT DOE', customer)).toBe(true);
    // The surname is the trailing run: "Robert James Doe" is not "James Robert".
    expect(payerNameCorroborates('ROBERT JAMES DOE', { first_name: 'James', last_name: 'Robert' })).toBe(false);
    // A middle name never satisfies the first-name leg: "Robert James Doe" is not James Doe.
    expect(payerNameCorroborates('ROBERT JAMES DOE', { first_name: 'James', last_name: 'Doe' })).toBe(false);
    // A single-token person shares the line's final surname.
    expect(payerNameCorroborates('ALICE & ROBERT DOE', { first_name: 'Alice', last_name: 'Doe' })).toBe(true);
  });

  test('generational suffixes never block the surname', () => {
    expect(payerNameCorroborates('ROBERT DOE JR', customer)).toBe(true);
    expect(payerNameCorroborates('ROBERT DOE II', customer)).toBe(true);
    expect(payerNameCorroborates('Robert Doe, Sr.', customer)).toBe(true);
  });

  test('every common joint separator splits people, so a second person can never lend a surname', () => {
    for (const line of ['ALICE JONES / ROBERT DOE', 'ALICE JONES + ROBERT DOE', 'ALICE JONES; ROBERT DOE', 'Alice Jones AND Robert Doe', 'ALICE JONES OR ROBERT DOE']) {
      expect(payerNameCorroborates(line, { first_name: 'Alice', last_name: 'Doe' })).toBe(false);
      expect(payerNameCorroborates(line, customer)).toBe(true);
    }
  });

  test('a final person with a middle name lends no surname — Pat parks rather than becoming Pat James Doe', () => {
    expect(payerNameCorroborates('PAT & ROBERT JAMES DOE', { first_name: 'Pat', last_name: 'Doe' })).toBe(false);
    expect(payerNameCorroborates('PAT & ROBERT JAMES DOE', { first_name: 'Pat', last_name: 'James Doe' })).toBe(false);
    expect(payerNameCorroborates('PAT & ROBERT JAMES DOE', customer)).toBe(true);
  });

  test('a multi-token earlier person on a joint line never borrows the final surname (ambiguous → human)', () => {
    // "Ann" (given) and "Jones" (surname) are indistinguishable here; both park.
    expect(payerNameCorroborates('MARY ANN & ROBERT SMITH', { first_name: 'Mary Ann', last_name: 'Smith' })).toBe(false);
    expect(payerNameCorroborates('ALICE JONES & ROBERT DOE', { first_name: 'Alice', last_name: 'Doe' })).toBe(false);
  });

  test('accented bank names corroborate ASCII customer records', () => {
    expect(payerNameCorroborates('JOSÉ NUÑEZ', { first_name: 'Jose', last_name: 'Nunez' })).toBe(true);
    expect(payerNameCorroborates('Jose Nunez', { first_name: 'José', last_name: 'Nuñez' })).toBe(true);
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
