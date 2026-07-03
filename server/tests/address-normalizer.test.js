const {
  normalizeLeadAddress, parseRawAddress, formatAddress,
  normalizeUnitLine, unitLineValueKey, splitStreetLineUnit,
} = require('../utils/address-normalizer');

describe('address normalizer', () => {
  test('splits the malformed Bill Waterman Parrish address into street/city/state/zip', () => {
    expect(normalizeLeadAddress({ raw: '17394 whiskey creek trail PArrish FL 34219' })).toMatchObject({
      raw: '17394 whiskey creek trail PArrish FL 34219',
      line1: '17394 Whiskey Creek Trl',
      city: 'Parrish',
      state: 'FL',
      zip: '34219',
      fullAddress: '17394 Whiskey Creek Trl, Parrish, FL 34219',
    });
  });

  test('keeps a Google formatted address split cleanly', () => {
    expect(normalizeLeadAddress({ raw: '17394 Whiskey Crk Trl, Parrish, FL 34219, USA' })).toMatchObject({
      line1: '17394 Whiskey Crk Trl',
      city: 'Parrish',
      state: 'FL',
      zip: '34219',
      fullAddress: '17394 Whiskey Crk Trl, Parrish, FL 34219',
    });
  });

  test('stores Terrace suffix as Ter for call/customer address consistency', () => {
    expect(normalizeLeadAddress({ raw: '6905 Cumberland Terrace, Sarasota, FL 34243' })).toMatchObject({
      line1: '6905 Cumberland Ter',
      city: 'Sarasota',
      state: 'FL',
      zip: '34243',
      fullAddress: '6905 Cumberland Ter, Sarasota, FL 34243',
    });
  });

  test('normalizes common terminal street suffix aliases', () => {
    expect(normalizeLeadAddress({ raw: '123 Palm Avenue, Sarasota, FL 34236' }).line1).toBe('123 Palm Ave');
    expect(normalizeLeadAddress({ raw: '456 Harbor Road, Sarasota, FL 34236' }).line1).toBe('456 Harbor Rd');
    expect(normalizeLeadAddress({ raw: '789 Ridge Parkway, Sarasota, FL 34236' }).line1).toBe('789 Ridge Pkwy');
    expect(normalizeLeadAddress({ raw: '101 Shore Dr., Sarasota, FL 34236' }).line1).toBe('101 Shore Dr');
    expect(normalizeLeadAddress({ raw: '202 Oak Grove, Sarasota, FL 34236' }).line1).toBe('202 Oak Grv');
  });

  test('normalizes ordinal street names without shouting the suffix', () => {
    expect(normalizeLeadAddress({ raw: '8920 39TH Street Circle E, Parrish, FL 34219' })).toMatchObject({
      line1: '8920 39th St Cir E',
      city: 'Parrish',
      state: 'FL',
      zip: '34219',
      fullAddress: '8920 39th St Cir E, Parrish, FL 34219',
    });
  });

  test('does not abbreviate street-name tokens before terminal suffixes', () => {
    expect(normalizeLeadAddress({ raw: '123 Court Street, Sarasota, FL 34236' }).line1).toBe('123 Court St');
    expect(normalizeLeadAddress({ raw: '456 Lane Road, Sarasota, FL 34236' }).line1).toBe('456 Lane Rd');
    expect(normalizeLeadAddress({ raw: '789 Street Road, Sarasota, FL 34236' }).line1).toBe('789 Street Rd');
  });

  test('splits comma-free addresses with suffix aliases introduced for normalization', () => {
    expect(normalizeLeadAddress({ raw: '123 Harbor Point Sarasota FL 34236' })).toMatchObject({
      line1: '123 Harbor Pt',
      city: 'Sarasota',
      state: 'FL',
      zip: '34236',
      fullAddress: '123 Harbor Pt, Sarasota, FL 34236',
    });
    expect(normalizeLeadAddress({ raw: '456 Bay Causeway Sarasota FL 34236' })).toMatchObject({
      line1: '456 Bay Cswy',
      city: 'Sarasota',
      state: 'FL',
      zip: '34236',
      fullAddress: '456 Bay Cswy, Sarasota, FL 34236',
    });
  });

  test('keeps city suffix words out of the street line for comma-free addresses', () => {
    expect(normalizeLeadAddress({ raw: '123 Main Street Palm Harbor FL 34683' })).toMatchObject({
      line1: '123 Main St',
      city: 'Palm Harbor',
      state: 'FL',
      zip: '34683',
      fullAddress: '123 Main St, Palm Harbor, FL 34683',
    });
    expect(normalizeLeadAddress({ raw: '123 Main Street Key West FL 33040' })).toMatchObject({
      line1: '123 Main St',
      city: 'Key West',
      state: 'FL',
      zip: '33040',
      fullAddress: '123 Main St, Key West, FL 33040',
    });
    expect(normalizeLeadAddress({ raw: '123 Main Street Lake City FL 32025' })).toMatchObject({
      line1: '123 Main St',
      city: 'Lake City',
      state: 'FL',
      zip: '32025',
      fullAddress: '123 Main St, Lake City, FL 32025',
    });
    expect(normalizeLeadAddress({ raw: '123 Main Street Grove City FL 34224' })).toMatchObject({
      line1: '123 Main St',
      city: 'Grove City',
      state: 'FL',
      zip: '34224',
      fullAddress: '123 Main St, Grove City, FL 34224',
    });
    expect(normalizeLeadAddress({ raw: '123 Main Street Ridge Wood Heights FL 34231' })).toMatchObject({
      line1: '123 Main St',
      city: 'Ridge Wood Heights',
      state: 'FL',
      zip: '34231',
      fullAddress: '123 Main St, Ridge Wood Heights, FL 34231',
    });
  });

  test('prefers structured Google address components over raw typed text', () => {
    expect(normalizeLeadAddress({
      raw: '17394 whiskey creek trail PArrish FL 34219',
      components: {
        line1: '17394 Whiskey Crk Trl',
        city: 'Parrish',
        state: 'FL',
        zip: '34219',
        placeId: 'place_123',
      },
    })).toMatchObject({
      line1: '17394 Whiskey Crk Trl',
      city: 'Parrish',
      state: 'FL',
      zip: '34219',
      placeId: 'place_123',
      fullAddress: '17394 Whiskey Crk Trl, Parrish, FL 34219',
    });
  });

  test('does not treat a street suffix as a state when no state is present', () => {
    expect(normalizeLeadAddress({ raw: '123 Main St Parrish' })).toMatchObject({
      line1: '123 Main St',
      city: 'Parrish',
      state: 'FL',
      zip: '',
      fullAddress: '123 Main St, Parrish, FL',
    });
  });

  test('does not create a display address from the default state alone', () => {
    expect(normalizeLeadAddress({ raw: '' })).toMatchObject({
      line1: '',
      city: '',
      state: 'FL',
      zip: '',
      fullAddress: '',
    });
  });

  test('raw parser leaves state empty unless an explicit Florida token is present', () => {
    expect(parseRawAddress('123 Main St Parrish')).toMatchObject({
      line1: '123 Main St',
      city: 'Parrish',
      state: '',
      zip: '',
    });
  });

  test('normalizes full state names to DB-safe two-letter codes', () => {
    expect(normalizeLeadAddress({
      line1: '123 Main St',
      city: 'Atlanta',
      state: 'Georgia',
      zip: '30301',
    })).toMatchObject({
      line1: '123 Main St',
      city: 'Atlanta',
      state: 'GA',
      zip: '30301',
      fullAddress: '123 Main St, Atlanta, GA 30301',
    });
  });

  test('does not rewrite raw non-Florida states to Florida', () => {
    expect(normalizeLeadAddress({ raw: '123 Main St, Atlanta, GA 30301' })).toMatchObject({
      line1: '123 Main St',
      city: 'Atlanta',
      state: 'GA',
      zip: '30301',
      fullAddress: '123 Main St, Atlanta, GA 30301',
    });
  });

  test('does not inflate a bare street fragment with the default state', () => {
    expect(normalizeLeadAddress({ raw: '1' })).toMatchObject({
      line1: '1',
      city: '',
      state: 'FL',
      zip: '',
      fullAddress: '1',
    });
  });

  test('does not strip state-name street tokens from typed addresses', () => {
    expect(normalizeLeadAddress({ raw: '123 Georgia Ave Sarasota FL 34236' })).toMatchObject({
      line1: '123 Georgia Ave',
      city: 'Sarasota',
      state: 'FL',
      zip: '34236',
      fullAddress: '123 Georgia Ave, Sarasota, FL 34236',
    });
    expect(normalizeLeadAddress({ raw: '123 Florida Ave Sarasota 34236' })).toMatchObject({
      line1: '123 Florida Ave',
      city: 'Sarasota',
      state: 'FL',
      zip: '34236',
      fullAddress: '123 Florida Ave, Sarasota, FL 34236',
    });
  });

  test('keeps St city prefixes out of the street line', () => {
    expect(normalizeLeadAddress({ raw: '123 Main St St Petersburg FL 33701' })).toMatchObject({
      line1: '123 Main St',
      city: 'St Petersburg',
      state: 'FL',
      zip: '33701',
      fullAddress: '123 Main St, St Petersburg, FL 33701',
    });
  });

  test('keeps apartment text with the street for typed addresses', () => {
    expect(normalizeLeadAddress({ raw: '123 Main St Apt 4 Sarasota FL 34236' })).toMatchObject({
      line1: '123 Main St Apt 4',
      city: 'Sarasota',
      state: 'FL',
      zip: '34236',
      fullAddress: '123 Main St Apt 4, Sarasota, FL 34236',
    });
  });

  test('keeps apartment text with the street for comma-separated addresses', () => {
    expect(normalizeLeadAddress({ raw: '123 Main St, Apt 4, Sarasota, FL 34236' })).toMatchObject({
      line1: '123 Main St Apt 4',
      city: 'Sarasota',
      state: 'FL',
      zip: '34236',
      fullAddress: '123 Main St Apt 4, Sarasota, FL 34236',
    });
  });

  test('carries a dedicated unit field as line2 and into fullAddress', () => {
    expect(normalizeLeadAddress({
      line1: '123 Main St', line2: '4b', city: 'Sarasota', state: 'FL', zip: '34236',
    })).toMatchObject({
      line1: '123 Main St',
      line2: 'Unit 4B',
      fullAddress: '123 Main St, Unit 4B, Sarasota, FL 34236',
    });
  });

  test('accepts the unit via the address_line2 / unit input keys', () => {
    expect(normalizeLeadAddress({
      line1: '123 Main St', address_line2: 'apt 4', city: 'Sarasota', zip: '34236',
    }).line2).toBe('Apt 4');
    expect(normalizeLeadAddress({
      line1: '123 Main St', unit: '#12', city: 'Sarasota', zip: '34236',
    }).line2).toBe('Unit 12');
  });

  test('does not duplicate a unit already inline in the street line', () => {
    expect(normalizeLeadAddress({
      raw: '123 Main St Apt 4 Sarasota FL 34236', line2: 'Apt 4',
    })).toMatchObject({
      line1: '123 Main St Apt 4',
      line2: '',
      fullAddress: '123 Main St Apt 4, Sarasota, FL 34236',
    });
  });

  test('dedupes an inline unit by VALUE, not display text ("Apt 4" inline vs "#4" field)', () => {
    expect(normalizeLeadAddress({
      raw: '123 Main St Apt 4 Sarasota FL 34236', line2: '#4',
    })).toMatchObject({
      line1: '123 Main St Apt 4',
      line2: '',
      fullAddress: '123 Main St Apt 4, Sarasota, FL 34236',
    });
  });

  test('line2 stays empty when no unit is provided (fullAddress unchanged)', () => {
    const result = normalizeLeadAddress({ raw: '17394 Whiskey Crk Trl, Parrish, FL 34219, USA' });
    expect(result.line2).toBe('');
    expect(result.fullAddress).toBe('17394 Whiskey Crk Trl, Parrish, FL 34219');
  });
});

describe('normalizeUnitLine', () => {
  test('bare unit values gain a Unit designator and uppercase the token', () => {
    expect(normalizeUnitLine('4b')).toBe('Unit 4B');
    expect(normalizeUnitLine('302')).toBe('Unit 302');
    expect(normalizeUnitLine('#12')).toBe('Unit 12');
  });

  test('existing designators are kept and title-cased', () => {
    expect(normalizeUnitLine('apt 4b')).toBe('Apt 4B');
    expect(normalizeUnitLine('SUITE 210')).toBe('Suite 210');
    expect(normalizeUnitLine('unit 7')).toBe('Unit 7');
  });

  test('empty and whitespace-only input returns empty string', () => {
    expect(normalizeUnitLine('')).toBe('');
    expect(normalizeUnitLine('   ')).toBe('');
    expect(normalizeUnitLine(null)).toBe('');
    expect(normalizeUnitLine('#')).toBe('');
  });

  test('hashes after designators are stripped — "Apt #4" is the same unit as "#4"', () => {
    expect(normalizeUnitLine('Apt #4')).toBe('Apt 4');
    expect(normalizeUnitLine('Suite #210')).toBe('Suite 210');
    expect(unitLineValueKey(normalizeUnitLine('Apt #4'))).toBe(unitLineValueKey(normalizeUnitLine('#4')));
  });
});

describe('unitLineValueKey', () => {
  test('drops a lone interchangeable designator so notations compare equal', () => {
    expect(unitLineValueKey('Apt 4B')).toBe('4b');
    expect(unitLineValueKey('Unit 4B')).toBe('4b');
    expect(unitLineValueKey('Suite 210')).toBe('210');
  });

  test('structural designators keep their designator — Bldg 2 is not Apt 2', () => {
    expect(unitLineValueKey('Bldg 2')).toBe('bldg 2');
    expect(unitLineValueKey('Fl 2')).toBe('fl 2');
    expect(unitLineValueKey('Lot 2')).toBe('lot 2');
    expect(unitLineValueKey('Bldg 2')).not.toBe(unitLineValueKey('Apt 2'));
  });

  test('multi-token units keep their full shape', () => {
    expect(unitLineValueKey('Bldg 2 Apt 4')).toBe('bldg 2 apt 4');
    expect(unitLineValueKey('Bldg 2 Apt 4')).not.toBe(unitLineValueKey('Apt 4'));
  });
});

describe('splitStreetLineUnit', () => {
  test('splits a trailing designator + value pair', () => {
    expect(splitStreetLineUnit('123 Main St Apt A')).toEqual({ street: '123 Main St', unit: 'Apt A' });
    expect(splitStreetLineUnit('123 Main St Unit 4B')).toEqual({ street: '123 Main St', unit: 'Unit 4B' });
  });

  test('splits a trailing # token', () => {
    expect(splitStreetLineUnit('123 Main St #4')).toEqual({ street: '123 Main St', unit: '#4' });
  });

  test('drops trailing city/state segments before splitting', () => {
    expect(splitStreetLineUnit('123 Main St Apt A, Sarasota, FL')).toEqual({ street: '123 Main St', unit: 'Apt A' });
  });

  test('street names containing designator words stay intact', () => {
    expect(splitStreetLineUnit('4501 Space Coast Blvd')).toEqual({ street: '4501 Space Coast Blvd', unit: '' });
  });

  test('a line that is only a unit never splits to an empty street', () => {
    expect(splitStreetLineUnit('Apt 4')).toEqual({ street: 'Apt 4', unit: '' });
    expect(splitStreetLineUnit('Bldg 2 Apt 4')).toEqual({ street: 'Bldg 2 Apt 4', unit: '' });
  });

  test('multi-part inline units peel fully (codex rd3)', () => {
    expect(splitStreetLineUnit('123 Main St Bldg 2 Apt 4')).toEqual({ street: '123 Main St', unit: 'Bldg 2 Apt 4' });
    expect(splitStreetLineUnit('123 Main St Bldg 2 #4')).toEqual({ street: '123 Main St', unit: 'Bldg 2 #4' });
  });
});

describe('formatAddress', () => {
  test('joins a complete address', () => {
    expect(formatAddress({ line1: '123 Main St', city: 'Sarasota', state: 'FL', zip: '34231' }))
      .toBe('123 Main St, Sarasota, FL 34231');
  });

  test('drops a missing zip instead of rendering "FL null"', () => {
    expect(formatAddress({ line1: '123 Main St', city: 'Sarasota', state: 'FL', zip: null }))
      .toBe('123 Main St, Sarasota, FL');
  });

  test('drops a missing state and zip cleanly', () => {
    expect(formatAddress({ line1: '123 Main St', city: 'Sarasota' }))
      .toBe('123 Main St, Sarasota');
  });

  test('skips a missing city without leaving a double comma', () => {
    expect(formatAddress({ line1: '123 Main St', city: '', state: 'FL', zip: '34231' }))
      .toBe('123 Main St, FL 34231');
  });

  test('handles a city/state/zip-only label (no street line)', () => {
    expect(formatAddress({ city: 'Sarasota', state: 'FL', zip: '34231' }))
      .toBe('Sarasota, FL 34231');
  });

  test('keeps a zip with no state', () => {
    expect(formatAddress({ line1: '123 Main St', city: 'Sarasota', zip: '34231' }))
      .toBe('123 Main St, Sarasota, 34231');
  });

  test('trims whitespace-only parts to empty', () => {
    expect(formatAddress({ line1: '  ', city: '  ', state: '  ', zip: '  ' })).toBe('');
  });

  test('returns an empty string for no input', () => {
    expect(formatAddress()).toBe('');
    expect(formatAddress({})).toBe('');
  });

  test('coerces non-string zip values', () => {
    expect(formatAddress({ line1: '123 Main St', city: 'Sarasota', state: 'FL', zip: 34231 }))
      .toBe('123 Main St, Sarasota, FL 34231');
  });
});
