/**
 * Surname from a county owner string. All names here are invented; the shapes
 * match the three county layers (Manatee `LAST, FIRST M`, Sarasota
 * `LAST FIRST MIDDLE [SUFFIX] [(note)]`, Charlotte `LAST FIRST M & FIRST2 ...`).
 */

const { surnameForFirstName, surnameFromOwnerNames } = require('../utils/owner-name-parse');
const { surnameFromEmail, BUSINESS_WORDS } = require('../utils/email-surname-parse');

describe('Manatee: LAST, FIRST M', () => {
  const s = (owner, first) => surnameForFirstName(owner, first, 'Manatee');

  test('the first word after the comma is the given name', () => {
    expect(s('SAMPLE, PAT Q', 'Pat')).toBe('Sample');
    expect(s('SAMPLE, PAT', 'pat')).toBe('Sample');
  });
  test('a middle name equal to the caller first name does not match', () => {
    expect(s('SAMPLE, ROBIN PAT', 'Pat')).toBeNull();
  });
  test('a different given name does not match', () => {
    expect(s('SAMPLE, ROBIN Q', 'Pat')).toBeNull();
  });
  test('no comma is not a Manatee shape', () => {
    expect(s('SAMPLE PAT Q', 'Pat')).toBeNull();
  });
  test('suffixes and notes are stripped on either side of the comma', () => {
    expect(s('SAMPLE JR, PAT Q', 'Pat')).toBe('Sample');
    expect(s('SAMPLE, PAT Q JR', 'Pat')).toBe('Sample');
    expect(s('SAMPLE, PAT Q (LIFE EST)', 'Pat')).toBe('Sample');
  });
  test('a multi-word surname before the comma is kept whole', () => {
    expect(s('VAN EXAMPLE, PAT', 'Pat')).toBe('Van Example');
  });
  test('"County" after the county name is accepted', () => {
    expect(surnameForFirstName('SAMPLE, PAT', 'Pat', 'Manatee County')).toBe('Sample');
  });
});

describe('Sarasota: LAST FIRST MIDDLE [SUFFIX] [(note)]', () => {
  const s = (owner, first) => surnameForFirstName(owner, first, 'Sarasota');

  test('the given name follows the surname', () => {
    expect(s('EXAMPLE ROBIN L', 'Robin')).toBe('Example');
    expect(s('EXAMPLE ROBIN', 'Robin')).toBe('Example');
  });
  test('suffixes and parenthetical notes are removed', () => {
    expect(s('EXAMPLE ROBIN L JR (E LIFE EST)', 'Robin')).toBe('Example');
    expect(s('EXAMPLE ROBIN L SR', 'Robin')).toBe('Example');
    expect(s('EXAMPLE ROBIN L III', 'Robin')).toBe('Example');
    expect(s('EXAMPLE ROBIN L TRUSTEE', 'Robin')).toBe('Example');
    expect(s('EXAMPLE ROBIN L TTEE', 'Robin')).toBe('Example');
    expect(s('EXAMPLE ROBIN L ET AL', 'Robin')).toBe('Example');
    expect(s('EXAMPLE ROBIN L ETAL', 'Robin')).toBe('Example');
    expect(s('EXAMPLE ROBIN L LIFE EST', 'Robin')).toBe('Example');
    expect(s('EXAMPLE ROBIN L (UNCLOSED NOTE', 'Robin')).toBe('Example');
  });
  test('a particle run belongs to the surname', () => {
    expect(s('VAN EXAMPLE JOHN', 'John')).toBe('Van Example');
    expect(s('DE LA SAMPLE MARIA', 'Maria')).toBe('De la Sample');
  });
  test('a middle name equal to the caller first name does not match', () => {
    expect(s('EXAMPLE PAT ROBIN', 'Robin')).toBeNull();
    expect(s('EXAMPLE ROBIN PAT', 'Pat')).toBeNull();
  });
  test('an unhyphenated two-word surname does not parse', () => {
    expect(s('SAMPLE EXAMPLE ROBIN', 'Robin')).toBeNull();
  });
  test('a surname alone, or particles only, gives nothing', () => {
    expect(s('EXAMPLE', 'Example')).toBeNull();
    expect(s('VAN DE', 'De')).toBeNull();
  });
  test('only the primary owner before an ampersand is read', () => {
    expect(s('EXAMPLE ROBIN L & PAT M', 'Pat')).toBeNull();
    expect(s('EXAMPLE ROBIN L & PAT M', 'Robin')).toBe('Example');
  });
  test('an address line in the second name field is not a name', () => {
    expect(s('123 SAMPLE ST', 'Sample')).toBeNull();
    expect(s('C/O EXAMPLE ROBIN', 'Robin')).toBeNull();
    expect(s('PO BOX 12', 'Box')).toBeNull();
  });
});

describe('Charlotte: LAST FIRST M & FIRST2 [M] [LAST2]', () => {
  const s = (owner, first) => surnameForFirstName(owner, first, 'Charlotte');

  test('the first owner matches as in Sarasota', () => {
    expect(s('SAMPLE PAT Q & ROBIN L SAMPLE', 'Pat')).toBe('Sample');
  });
  test('a later owner with the same surname at the end matches', () => {
    expect(s('SAMPLE PAT Q & ROBIN L SAMPLE', 'Robin')).toBe('Sample');
    expect(s('SAMPLE PAT & ROBIN SAMPLE', 'Robin')).toBe('Sample');
  });
  test('a later owner that is the name alone shares the first surname', () => {
    expect(s('SAMPLE PAT & ROBIN', 'Robin')).toBe('Sample');
  });
  test('a later owner that is the name plus initials shares the first surname', () => {
    expect(s('SAMPLE PAT & ROBIN L', 'Robin')).toBe('Sample');
    expect(s('SAMPLE PAT & ROBIN L M', 'Robin')).toBe('Sample');
  });
  test('a later owner with a different surname gives nothing', () => {
    expect(s('SAMPLE PAT & ROBIN L EXAMPLE', 'Robin')).toBeNull();
  });
  test('a later owner with a spelled-out middle name and no surname gives nothing', () => {
    expect(s('SAMPLE PAT & ROBIN LEE', 'Robin')).toBeNull();
  });
  test('a later segment whose first word is not the caller gives nothing', () => {
    expect(s('SAMPLE PAT & LEE ROBIN', 'Robin')).toBeNull();
  });
  test('a multi-word surname must repeat in full on the later owner', () => {
    expect(s('VAN SAMPLE PAT & ROBIN VAN SAMPLE', 'Robin')).toBe('Van Sample');
    expect(s('VAN SAMPLE PAT & ROBIN SAMPLE', 'Robin')).toBeNull();
  });
  test('padding spaces and suffixes are ignored', () => {
    expect(s('  SAMPLE   PAT Q JR   ', 'Pat')).toBe('Sample');
  });
});

describe('nickname match uses sameFirstName', () => {
  test('Bill matches William and Bob matches Robert in each county', () => {
    expect(surnameForFirstName('EXAMPLE, WILLIAM T', 'Bill', 'Manatee')).toBe('Example');
    expect(surnameForFirstName('EXAMPLE WILLIAM T', 'Bill', 'Sarasota')).toBe('Example');
    expect(surnameForFirstName('EXAMPLE ROBERT & PAT EXAMPLE', 'Bob', 'Charlotte')).toBe('Example');
  });
  test('an unrelated name does not match', () => {
    expect(surnameForFirstName('EXAMPLE WILLIAM T', 'Robert', 'Sarasota')).toBeNull();
  });
});

describe('entity owners and bad input', () => {
  test.each([
    ['SAMPLE PAT HOLDINGS LLC'],
    ['SAMPLE PAT Q REVOCABLE TRUST'],
    ['SAMPLE PAT Q LIVING TRUST'],
    ['PAT SAMPLE INC'],
    ['SAMPLE PAT CORP'],
    ['SAMPLE PAT BANK NA'],
    ['SAMPLE PAT ASSOCIATION'],
    ['SAMPLE PAT HOA'],
    ['SAMPLE PAT CHURCH OF GOD'],
    ['SAMPLE PAT COUNTY'],
    ['CITY OF PAT'],
    ['STATE OF PAT'],
    ['SAMPLE PAT LP'],
    ['SAMPLE PAT LLP'],
    ['SAMPLE PAT L L C'],
    ['SAMPLE PAT PARTNERSHIP'],
    ['ESTATE OF SAMPLE PAT'],
    ['SAMPLE PAT Q ESTATE'],
  ])('%s -> null in every county', (owner) => {
    for (const county of ['Sarasota', 'Charlotte']) expect(surnameForFirstName(owner, 'Pat', county)).toBeNull();
    expect(surnameForFirstName(owner.replace(/^(\S+) /, '$1, '), 'Pat', 'Manatee')).toBeNull();
  });
  test('empty, null, unknown county and blank caller name give nothing', () => {
    expect(surnameForFirstName('', 'Pat', 'Manatee')).toBeNull();
    expect(surnameForFirstName(null, 'Pat', 'Manatee')).toBeNull();
    expect(surnameForFirstName('SAMPLE, PAT', 'Pat', 'Hillsborough')).toBeNull();
    expect(surnameForFirstName('SAMPLE, PAT', 'Pat', undefined)).toBeNull();
    expect(surnameForFirstName('SAMPLE, PAT', '', 'Manatee')).toBeNull();
    expect(surnameForFirstName('SAMPLE, PAT', '   ', 'Manatee')).toBeNull();
  });
});

describe('casing', () => {
  test('apostrophes and hyphens are kept', () => {
    expect(surnameForFirstName('O\'EXAMPLE, PAT', 'Pat', 'Manatee')).toBe('O\'Example');
    expect(surnameForFirstName('SAMPLE-EXAMPLE PAT', 'Pat', 'Sarasota')).toBe('Sample-Example');
    expect(surnameForFirstName('MCSAMPLE PAT', 'Pat', 'Sarasota')).toBe('McSample');
  });
  test('an upper-case Mac surname is not forced into Mac+Capital', () => {
    expect(surnameForFirstName('MACSAMPLE PAT', 'Pat', 'Sarasota')).toBe('Macsample');
  });
});

describe('surnameFromOwnerNames: one distinct surname across the parcel', () => {
  test('two owners with different surnames, one first name matches', () => {
    expect(surnameFromOwnerNames(['SAMPLE, PAT Q', 'EXAMPLE, ROBIN L'], 'Pat', 'Manatee')).toBe('Sample');
  });
  test('two owners matching the first name with different surnames give nothing', () => {
    expect(surnameFromOwnerNames(['SAMPLE, PAT Q', 'EXAMPLE, PAT L'], 'Pat', 'Manatee')).toBeNull();
  });
  test('two owners matching with the same surname (any case) give that surname', () => {
    expect(surnameFromOwnerNames(['SAMPLE, PAT Q', 'sample, pat'], 'Pat', 'Manatee')).toBe('Sample');
  });
  test('no match, bad list and entity-only parcels give nothing', () => {
    expect(surnameFromOwnerNames(['SAMPLE, ROBIN'], 'Pat', 'Manatee')).toBeNull();
    expect(surnameFromOwnerNames(null, 'Pat', 'Manatee')).toBeNull();
    expect(surnameFromOwnerNames([], 'Pat', 'Manatee')).toBeNull();
    expect(surnameFromOwnerNames(['SAMPLE HOLDINGS LLC'], 'Pat', 'Sarasota')).toBeNull();
  });
  test('a Sarasota second field that is an address line is ignored', () => {
    expect(surnameFromOwnerNames(['EXAMPLE ROBIN L', '100 SAMPLE AVE'], 'Robin', 'Sarasota')).toBe('Example');
  });
});

describe('surnameFromEmail: separated forms only', () => {
  test('first.last, first_last and first-last', () => {
    expect(surnameFromEmail('pat.sample@example.com', 'Pat')).toBe('Sample');
    expect(surnameFromEmail('pat_sample@example.com', 'Pat')).toBe('Sample');
    expect(surnameFromEmail('pat-sample@example.com', 'Pat')).toBe('Sample');
    expect(surnameFromEmail('Pat.Sample@Example.com', 'pat')).toBe('Sample');
  });
  test('a nickname of the caller first name matches', () => {
    expect(surnameFromEmail('william.sample@example.com', 'Bill')).toBe('Sample');
  });
  test('a hyphenated or apostrophe surname is kept', () => {
    expect(surnameFromEmail('pat.sample-example@example.com', 'Pat')).toBe('Sample-Example');
    expect(surnameFromEmail('pat.o\'sample@example.com', 'Pat')).toBe('O\'Sample');
  });
  test('a plus tag is ignored', () => {
    expect(surnameFromEmail('pat.sample+pest@example.com', 'Pat')).toBe('Sample');
  });
  test('a run-together address yields nothing', () => {
    expect(surnameFromEmail('elizabethrealty@example.com', 'Elizabeth')).toBeNull();
    expect(surnameFromEmail('patsample@example.com', 'Pat')).toBeNull();
  });
  test('the first part must be the caller first name', () => {
    expect(surnameFromEmail('robin.sample@example.com', 'Pat')).toBeNull();
    expect(surnameFromEmail('sample.pat@example.com', 'Pat')).toBeNull();
  });
  test('a business word as the last part yields nothing', () => {
    expect(surnameFromEmail('elizabeth.realty@example.com', 'Elizabeth')).toBeNull();
    expect(surnameFromEmail('pat.homes@example.com', 'Pat')).toBeNull();
    expect(surnameFromEmail('pat-sample-realty@example.com', 'Pat')).toBeNull();
    expect(surnameFromEmail('pat.sample-realty@example.com', 'Pat')).toBeNull();
    for (const word of ['realty', 'realtor', 'homes', 'home', 'group', 'team', 'properties', 'property', 'sales', 'office', 'info', 'admin', 'inc', 'llc', 'pest', 'lawn', 'mail']) {
      expect(BUSINESS_WORDS.has(word)).toBe(true);
    }
  });
  test('more than two parts, digits, short or empty parts yield nothing', () => {
    expect(surnameFromEmail('pat.q.sample@example.com', 'Pat')).toBeNull();
    expect(surnameFromEmail('pat.sample2@example.com', 'Pat')).toBeNull();
    expect(surnameFromEmail('pat.s@example.com', 'Pat')).toBeNull();
    expect(surnameFromEmail('pat.@example.com', 'Pat')).toBeNull();
    expect(surnameFromEmail('.sample@example.com', 'Pat')).toBeNull();
  });
  test('bad input yields nothing', () => {
    expect(surnameFromEmail('', 'Pat')).toBeNull();
    expect(surnameFromEmail(null, 'Pat')).toBeNull();
    expect(surnameFromEmail('pat.sample', 'Pat')).toBeNull();
    expect(surnameFromEmail('pat.sample@', 'Pat')).toBeNull();
    expect(surnameFromEmail('pat.sample@example.com', '')).toBeNull();
  });
});
