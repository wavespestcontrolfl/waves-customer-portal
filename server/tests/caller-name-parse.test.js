/**
 * Surname from a Twilio caller name (CNAM). Names are invented.
 */

const { surnameFromCallerName } = require('../utils/caller-name-parse');

const s = (name, first, callerType = 'CONSUMER') => surnameFromCallerName({ name, callerType }, first);

describe('surnameFromCallerName', () => {
  test('surname before the first name', () => {
    expect(s('SAMPLE PAT', 'Pat')).toBe('Sample');
  });
  test('first name before the surname', () => {
    expect(s('PAT SAMPLE', 'Pat')).toBe('Sample');
  });
  test('comma form', () => {
    expect(s('SAMPLE,PAT', 'Pat')).toBe('Sample');
    expect(s('SAMPLE, PAT', 'Pat')).toBe('Sample');
  });
  test('a middle initial is dropped', () => {
    expect(s('PAT Q SAMPLE', 'Pat')).toBe('Sample');
    expect(s('SAMPLE PAT Q', 'Pat')).toBe('Sample');
    expect(s('SAMPLE PAT Q.', 'Pat')).toBe('Sample');
  });
  test('mixed case and a nickname of the first name', () => {
    expect(s('Sample Bill', 'William')).toBe('Sample');
    expect(s('WILLIAM SAMPLE', 'Bill')).toBe('Sample');
  });
  test('apostrophes and hyphens stay, other characters go', () => {
    expect(s("O'SAMPLE PAT", 'Pat')).toBe("O'Sample");
    expect(s('SAMPLE-EX PAT', 'Pat')).toBe('Sample-Ex');
    expect(s('SAMPLE#1 PAT', 'Pat')).toBe('Sample'); // punctuation and digits become spaces
  });
  test('no name, UNKNOWN, or a non-string gives nothing', () => {
    expect(s(null, 'Pat')).toBeNull();
    expect(s('', 'Pat')).toBeNull();
    expect(s('   ', 'Pat')).toBeNull();
    expect(s('UNKNOWN', 'Pat')).toBeNull();
    expect(s('unknown', 'Pat')).toBeNull();
    expect(s(42, 'Pat')).toBeNull();
  });
  test('a BUSINESS caller type gives nothing', () => {
    expect(s('SAMPLE PAT', 'Pat', 'BUSINESS')).toBeNull();
    expect(s('SAMPLE PAT', 'Pat', 'business')).toBeNull();
    expect(s('SAMPLE PAT', 'Pat', null)).toBe('Sample');
  });
  test('a raw name of 15 characters or more is cut off: nothing', () => {
    expect(s('SAMPLEXXXX PAT Q', 'Pat')).toBeNull(); // 16
    expect(s('SAMPLEXXXX PATQ', 'Pat')).toBeNull(); // 15 exactly, not a first-name match anyway
    expect(s('SAMPLEXXX PAT', 'Pat')).toBe('Samplexxx'); // 13
    expect(s('SAMPLEXXXXX PAT', 'Pat')).toBeNull(); // 15 exactly
  });
  test('no token is the first name', () => {
    expect(s('SAMPLE ROBIN', 'Pat')).toBeNull();
  });
  test('two tokens are the first name', () => {
    expect(s('PAT PAT', 'Pat')).toBeNull();
    expect(s('BILL WILLIAM', 'Bill')).toBeNull();
  });
  test('two leftover tokens give nothing', () => {
    expect(s('SAMPLE EXAMPLE PAT', 'Pat')).toBeNull();
  });
  test('no leftover token gives nothing', () => {
    expect(s('PAT', 'Pat')).toBeNull();
    expect(s('PAT Q', 'Pat')).toBeNull();
  });
  test('a blank customer first name gives nothing', () => {
    expect(s('SAMPLE PAT', '')).toBeNull();
    expect(s('SAMPLE PAT', null)).toBeNull();
  });
});
