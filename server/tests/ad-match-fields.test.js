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
    expect(F.externalIdFor({ customerId: 'c1', leadId: 'l1' })).toBe('c1');
    expect(F.externalIdFor({ leadId: 'l1' })).toBe('lead:l1');
    expect(F.externalIdFor({})).toBeNull();
  });
});

describe('audience entry helpers', () => {
  test('legacy entries expose only email/phone handles; enriched ones add id + name+ZIP handles', () => {
    expect(F.entryHandles({ d: ['e', 'p'] })).toEqual(['e', 'p']);
    expect(F.entryHandles({ d: ['e', ''], e: { fn: 'f', ln: 'l', zp: 'z', xid: 'x' } })).toEqual(['e', 'x:x', 'n:f|l|z']);
    expect(F.entryHandles({ d: ['e', ''], e: { fn: 'f' } })).toEqual(['e']);
  });
  test('extrasSig is order-stable and empty for no extras', () => {
    expect(F.extrasSig(undefined)).toBe('');
    expect(F.extrasSig({ ln: 'l', fn: 'f' })).toBe(F.extrasSig({ fn: 'f', ln: 'l' }));
    expect(F.extrasSig({ fn: 'a' })).not.toBe(F.extrasSig({ fn: 'b' }));
  });
});

describe('uploaded-variant memory (carryVariants)', () => {
  const v1 = { fn: 'a', ln: 'b', zp: '1' };
  const v2 = { fn: 'a', ln: 'b', zp: '2' };
  test('legacy entry (no extras): the current entry passes through untouched', () => {
    const cur = { k: 'k', d: ['e', ''], e: v1 };
    expect(F.carryVariants({ k: 'k', d: ['e', ''] }, cur)).toBe(cur);
  });
  test('changed extras: latest becomes e, the previous one moves to o (deduped, bounded)', () => {
    expect(F.carryVariants({ d: ['e', ''], e: v1 }, { d: ['e', ''], e: v2 })).toEqual({ d: ['e', ''], e: v2, o: [v1] });
    const many = [1, 2, 3, 4, 5].map((n) => ({ fn: 'a', ln: 'b', zp: String(n) }));
    const out = F.carryVariants({ d: ['e', ''], e: many[0], o: many.slice(1) }, { d: ['e', ''], e: { fn: 'z', ln: 'z', zp: '9' } });
    expect(out.o).toHaveLength(4);
    expect(out.o[0]).toEqual(many[0]);
  });
  test('extras that merely shrink (subset of what was uploaded) change nothing', () => {
    const cur = { d: ['e', ''], e: { fn: 'a' } };
    expect(F.carryVariants({ d: ['e', ''], e: v1 }, cur)).toEqual({ d: ['e', ''], e: v1 });
  });
  test('extras gone from the source: the uploaded ones (latest + older) are carried forward', () => {
    expect(F.carryVariants({ d: ['e', ''], e: v2, o: [v1] }, { d: ['e', ''] })).toEqual({ d: ['e', ''], e: v2, o: [v1] });
  });
  test('handles cover every remembered variant', () => {
    expect(F.entryHandles({ d: ['e', ''], e: v2, o: [v1] })).toEqual(['e', 'n:a|b|2', 'n:a|b|1']);
  });
});
