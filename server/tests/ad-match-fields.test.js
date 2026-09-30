// Tests services/ads/ad-match-fields.js — normalization + source picking for the extra ad match keys.
const F = require('../services/ads/ad-match-fields');

describe('normalization (Meta + Google rules)', () => {
  test('names: lowercase, no punctuation, honorific/suffix stripped, placeholders rejected', () => {
    expect(F.normalizeName("  Jo-Ann ")).toBe('joann');
    expect(F.normalizeName('Mrs. Mary  Ann')).toBe('mary ann');
    expect(F.normalizeName("O'Neil Jr.", 'last')).toBe('oneil');
    expect(F.normalizeName('Smith, III', 'last')).toBe('smith');
    expect(F.normalizeName('José')).toBe('josé');
    for (const junk of [null, '', '  ', 'Unknown', 'N/A', '123', '--']) expect(F.normalizeName(junk)).toBeNull();
  });
  test('city: letters only, no spaces or punctuation', () => {
    expect(F.normalizeCity('St. Petersburg')).toBe('stpetersburg');
    expect(F.normalizeCity('  ')).toBeNull();
  });
  test('state: 2-letter ANSI lowercase, full names mapped, junk rejected', () => {
    expect(F.normalizeState('FL')).toBe('fl');
    expect(F.normalizeState(' Florida ')).toBe('fl');
    expect(F.normalizeState('New York')).toBe('ny');
    expect(F.normalizeState('ZZ')).toBeNull();
    expect(F.normalizeState('Ontario')).toBeNull();
  });
  test('zip: first 5 digits of a US ZIP only', () => {
    expect(F.normalizeZip('34221')).toBe('34221');
    expect(F.normalizeZip('34221-1234')).toBe('34221');
    expect(F.normalizeZip(' FL 34221 ')).toBe('34221');
    expect(F.normalizeZip(34221)).toBe('34221');
    for (const bad of ['3422', 'K1A 0B1', '9412975749', null, '']) expect(F.normalizeZip(bad)).toBeNull();
  });
  test('external id: trimmed + lowercased', () => {
    expect(F.normalizeExternalId('  ABC-1 ')).toBe('abc-1');
    expect(F.normalizeExternalId('')).toBeNull();
  });
  test('a single full-name field splits at the last space; separate fields pass through', () => {
    expect(F.splitName('Mary Ann Smith', null)).toEqual({ first: 'Mary Ann', last: 'Smith' });
    expect(F.splitName('Jo', 'Lee')).toEqual({ first: 'Jo', last: 'Lee' });
    expect(F.splitName('Cher', '')).toEqual({ first: 'Cher', last: '' });
    expect(F.splitName('John Smith Jr.', null)).toEqual({ first: 'John', last: 'Smith' });
    expect(F.splitName('John Smith, III', '')).toEqual({ first: 'John', last: 'Smith' });
  });
});

describe('source picking', () => {
  test('a full first+last pair wins over a partial one; ZIP-bearing source owns the address block', () => {
    const m = F.mergeIdentity(
      { firstName: 'Jo', lastName: null, zip: '34221' },
      { firstName: 'Joanne', lastName: 'Lee', city: 'Palmetto', state: 'FL', zip: '34221' },
    );
    expect(m).toEqual({ firstName: 'Joanne', lastName: 'Lee', city: 'Palmetto', state: 'FL', zip: '34221' });
  });
  test('city/state are NOT borrowed from a fallback with a different ZIP', () => {
    const m = F.mergeIdentity({ zip: '34221' }, { city: 'Sarasota', state: 'FL', zip: '34236' });
    expect(m).toMatchObject({ zip: '34221', city: null, state: null });
  });
  test('external id: customer id, else lead-scoped', () => {
    expect(F.externalIdFor({ customerId: 'c1', leadId: 'l1' })).toBe('lead:l1');
    expect(F.externalIdFor({ customerId: 'c1' })).toBe('c1');
    expect(F.externalIdFor({ leadId: 'l1' })).toBe('lead:l1');
    expect(F.externalIdFor({})).toBeNull();
  });

  describe('identityForContact', () => {
    const lead = { email: 'Spouse@Example.com', phone: '(941) 555-0101', firstName: 'Pat', lastName: 'Lee', zip: '34202' };
    const cust = { email: 'owner@example.com', phone: '941-555-0199', firstName: 'Sam', lastName: 'Rivera', city: 'Bradenton', state: 'FL', zip: '34211' };

    it('never pairs a different caller\'s contact with the account holder\'s name', () => {
      const id = F.identityForContact({ email: lead.email, phone: lead.phone }, cust, lead);
      expect(id).toMatchObject({ firstName: 'Pat', lastName: 'Lee', zip: '34202', state: null });
    });

    it('merges both sources when they share a contact', () => {
      const same = { ...lead, email: 'OWNER@example.com', firstName: null, lastName: null, zip: null };
      const id = F.identityForContact({ email: same.email, phone: same.phone }, cust, same);
      expect(id).toMatchObject({ firstName: 'Sam', lastName: 'Rivera', zip: '34211', state: 'FL' });
    });

    it('sends no name/address when the uploaded contact mixes two people', () => {
      const leadEmailOnly = { ...lead, phone: null };
      const id = F.identityForContact({ email: leadEmailOnly.email, phone: cust.phone }, cust, leadEmailOnly);
      expect(id).toEqual({ firstName: null, lastName: null, city: null, state: null, zip: null });
    });
  });
});
