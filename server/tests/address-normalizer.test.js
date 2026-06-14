const { normalizeLeadAddress, parseRawAddress } = require('../utils/address-normalizer');

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
});
