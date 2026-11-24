/**
 * The short typed address of a new home (services/mail/home-slug.js): county-shaped lines in, one slug out. Pure
 * functions; the unique-index clash rule is tested against PostgreSQL in mail-prospect-store-postgres.test.js.
 * Synthetic addresses only.
 */
const { buildBaseSlug, slugCandidates, SLUG_RE, STREET_SUFFIXES } = require('../services/mail/home-slug');

describe('buildBaseSlug', () => {
  test.each([
    // The owner's ruling: house number and street NAME, no street type.
    ['101 EXAMPLE TRL', '101-example'],
    ['101 Example Trail', '101-example'],
    ['4512 N RIVER OAKS DR', '4512-n-river-oaks'],
    ['123 SW 5TH AVE', '123-sw-5th'],
    ['88 LAKE VIEW BLVD UNIT 3', '88-lake-view'],
    ['77 SAMPLE PL', '77-sample'],
    ['9 TESTER CT', '9-tester'],
    ['2210 SAMPLE CIR', '2210-sample'],
    ['15 TESTER WAY', '15-tester'],
    ['600 EXAMPLE LOOP', '600-example'],
    ['41 SAMPLE PKWY', '41-sample'],
    ['12 SAMPLE XING', '12-sample'],
    ['8 SAMPLE PT', '8-sample'],
    ['3 TESTER RUN', '3-tester'],
    ['5 SAMPLE TER', '5-sample'],
    ['10 TESTER LN', '10-tester'],
    ['1500 SAMPLE RD', '1500-sample'],
    ['900 EXAMPLE HWY', '900-example'],
    // Only the LAST word goes: a name that holds a type word keeps it.
    ['450 LAKE VIEW DR', '450-lake-view'],
    ['20 OCEAN PARK DR', '20-ocean-park'],
    ['333 PINE LAKE CT', '333-pine-lake'],
    // A directional after the type stays; the type goes.
    ['123 SAMPLE ST NW', '123-sample-nw'],
    ['123 N SAMPLE ST SE', '123-n-sample-se'],
    // A name with no type keeps all of it, numbers too.
    ['1234 COUNTY ROAD 7', '1234-county-road-7'],
    ['55 US HWY 41', '55-us-hwy-41'],
    ['60 STATE ROAD 70 E', '60-state-road-70-e'],
    ['12 OLD TAMPA', '12-old-tampa'],
    // A street that is only its type word keeps it (it is the name).
    ['5 PARK', '5-park'],
  ])('%s -> %s', (line, slug) => {
    expect(buildBaseSlug(line)).toBe(slug);
  });

  test.each([
    ['88 LAKE VIEW BLVD APT 4B', '88-lake-view'],
    ['88 LAKE VIEW BLVD #7', '88-lake-view'],
    ['88 LAKE VIEW BLVD # 7', '88-lake-view'],
    ['88 LAKE VIEW BLVD STE 100', '88-lake-view'],
    ['88 LAKE VIEW BLVD SUITE 100', '88-lake-view'],
    ['88 LAKE VIEW BLVD BLDG 2 UNIT 3', '88-lake-view'],
    ['88 LAKE VIEW BLVD LOT 9', '88-lake-view'],
    ['88 LAKE VIEW BLVD UNIT 3, SAMPLETON', '88-lake-view'],
    ['12 SPACE COAST PKWY', '12-space-coast'], // SPACE is a street name, not a unit word
  ])('the unit part goes: %s -> %s', (line, slug) => {
    expect(buildBaseSlug(line)).toBe(slug);
  });

  test('case, spaces, commas, periods and accents', () => {
    expect(buildBaseSlug('  101   example   trl  ')).toBe('101-example');
    expect(buildBaseSlug('101 EXAMPLE TRL.')).toBe('101-example');
    expect(buildBaseSlug('101 Example Trl,')).toBe('101-example');
    expect(buildBaseSlug('7 O\'NEIL ST')).toBe('7-o-neil');
    expect(buildBaseSlug('7 CAFÉ ST')).toBe('7-cafe');
    expect(buildBaseSlug('7 SAMPLE-HILL DR')).toBe('7-sample-hill');
    expect(buildBaseSlug('0101 EXAMPLE TRL')).toBe('101-example'); // leading zeros dropped
  });

  test.each([
    [null], [undefined], [''], ['   '], [42],
    ['101'], // nothing after the number
    ['EXAMPLE TRL'], // no house number
    ['12A EXAMPLE TRL'], // letters in the number
    ['12-14 EXAMPLE TRL'], // a range
    ['12 1/2 EXAMPLE TRL'], // a fraction
    ['0 EXAMPLE TRL'], // no number
    ['12345678 EXAMPLE TRL'], // too many digits
    ['PO BOX 12'],
    ['101 #5'], // only a unit after the number
    ['101 !!!'], // no letters or digits left
    [`101 ${'LONGNAME'.repeat(10)} DR`], // over 60 characters: the card prints the QR code only
  ])('no slug for %p', (line) => {
    expect(buildBaseSlug(line)).toBeNull();
  });

  test('every slug it builds matches the table CHECK shape', () => {
    for (const line of ['101 EXAMPLE TRL', '4512 N RIVER OAKS DR', '123 SW 5TH AVE', '7 O\'NEIL ST', '60 STATE ROAD 70 E']) {
      expect(buildBaseSlug(line)).toMatch(SLUG_RE);
    }
    expect(SLUG_RE.test('-101-example')).toBe(false);
    expect(SLUG_RE.test('101--example')).toBe(false);
    expect(SLUG_RE.test('101-Example')).toBe(false);
    expect(SLUG_RE.test('example-101')).toBe(false);
    expect(SLUG_RE.test('101')).toBe(false);
  });

  test('the suffix list holds the owner\'s examples and the USPS abbreviations', () => {
    for (const word of ['TRL', 'TRAIL', 'ST', 'AVE', 'DR', 'CT', 'LN', 'RD', 'BLVD', 'CIR', 'WAY', 'PL', 'TER', 'LOOP',
      'PKWY', 'CV', 'PT', 'RUN', 'PATH', 'XING', 'PASS', 'ROW', 'SQ', 'HWY', 'CURVE', 'CURV']) {
      expect(STREET_SUFFIXES.has(word)).toBe(true);
    }
    // The shared USPS table (property-lookup/usps-street-suffixes.js) also lists TRLR (trailer) as a suffix.
    // A directional or a unit word is never a street type.
    for (const word of ['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'UNIT', 'APT']) expect(STREET_SUFFIXES.has(word)).toBe(false);
  });
});

describe('slugCandidates', () => {
  test('the plain slug first, then the one with the ZIP', () => {
    expect(slugCandidates({ addressLine1: '101 EXAMPLE TRL', zip: '34211' })).toEqual(['101-example', '101-example-34211']);
  });

  test('a ZIP+4 or spaces give the five digits; no ZIP gives only the plain slug', () => {
    expect(slugCandidates({ addressLine1: '101 EXAMPLE TRL', zip: '34211-1234' })[1]).toBe('101-example-34211');
    expect(slugCandidates({ addressLine1: '101 EXAMPLE TRL', zip: ' 34211 ' })[1]).toBe('101-example-34211');
    expect(slugCandidates({ addressLine1: '101 EXAMPLE TRL', zip: null })).toEqual(['101-example']);
    expect(slugCandidates({ addressLine1: '101 EXAMPLE TRL', zip: '342' })).toEqual(['101-example']);
  });

  test('no address slug: no candidates; no argument: no candidates', () => {
    expect(slugCandidates({ addressLine1: '12A EXAMPLE TRL', zip: '34211' })).toEqual([]);
    expect(slugCandidates({ addressLine1: null, zip: '34211' })).toEqual([]);
    expect(slugCandidates()).toEqual([]);
  });

  test('the ZIP form is dropped when it would be over the length limit', () => {
    const line = `101 ${'abcdefgh '.repeat(5)}DR`; // 101-abcdefgh-x5 = 49 chars; + 6 = 55: still fine
    expect(slugCandidates({ addressLine1: line, zip: '34211' })).toHaveLength(2);
    const long = `101 ${'abcdefgh '.repeat(6)}DR`; // 58 chars; + 6 = 64: over the limit
    expect(slugCandidates({ addressLine1: long, zip: '34211' })).toHaveLength(1);
  });
});

describe('buildBaseSlug keepStreetType (text-to-book: the words as typed)', () => {
  test.each([
    ['88 LAKE VIEW', '88-lake-view'],
    ['88 LAKE VIEW BLVD', '88-lake-view-blvd'],
    ['101 EXAMPLE TRL', '101-example-trl'],
    ['123 MAIN ST NW', '123-main-st-nw'],
    ['88 LAKE VIEW BLVD UNIT 3', '88-lake-view-blvd'], // the unit part is still dropped
  ])('%s', (line, expected) => {
    expect(buildBaseSlug(line, { keepStreetType: true })).toBe(expected);
  });

  test('the default drops the street type, as the postcard slug does', () => {
    expect(buildBaseSlug('88 LAKE VIEW BLVD')).toBe('88-lake-view');
    expect(buildBaseSlug('88 LAKE VIEW BLVD', { keepStreetType: false })).toBe('88-lake-view');
  });
});
