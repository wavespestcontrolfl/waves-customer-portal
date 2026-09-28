/**
 * Unit tests for licensed-photo-library.js — the closed catalog of real,
 * licensed photos an identification ("diagnostic") post's pest/sign/
 * look-alike slots may draw from (C3, blog work order 2026-09-28).
 */

const {
  PHOTO_LIBRARY,
  findPhotoForSlot,
  buildPhotoSlots,
} = require('../services/content/licensed-photo-library');

describe('PHOTO_LIBRARY catalog', () => {
  test('every entry carries a real license + credit + source page', () => {
    for (const entry of PHOTO_LIBRARY) {
      expect(typeof entry.url).toBe('string');
      expect(entry.url.startsWith('https://')).toBe(true);
      expect(typeof entry.license).toBe('string');
      expect(entry.license.length).toBeGreaterThan(0);
      expect(typeof entry.credit).toBe('string');
      expect(entry.credit.length).toBeGreaterThan(0);
      expect(typeof entry.alt).toBe('string');
      expect(entry.alt.length).toBeGreaterThan(0);
      expect(['pest', 'sign', 'look_alike']).toContain(entry.slot);
    }
  });
});

describe('findPhotoForSlot', () => {
  test('matches a species alias for its slot', () => {
    const photo = findPhotoForSlot('florida huntsman spider identification guide', 'pest');
    expect(photo).not.toBeNull();
    expect(photo.alt).toMatch(/huntsman/i);
    // Internal 'aliases'/'slot' fields must not leak into the returned asset.
    expect(photo.aliases).toBeUndefined();
    expect(photo.slot).toBeUndefined();
  });

  test('returns the look-alike photo, not the pest photo, for the look_alike slot', () => {
    const photo = findPhotoForSlot('florida huntsman spider identification guide', 'look_alike');
    expect(photo).not.toBeNull();
    expect(photo.alt).toMatch(/wolf spider/i);
  });

  test('returns the sign photo (mound), not the ant photo, for the sign slot', () => {
    const photo = findPhotoForSlot('how to identify a fire ant mound in your yard', 'sign');
    expect(photo).not.toBeNull();
    expect(photo.alt).toMatch(/mound/i);
  });

  test('returns null for a species the catalog has never vetted', () => {
    expect(findPhotoForSlot('brown widow spider in your garage', 'pest')).toBeNull();
  });

  test('returns null for a species/slot pairing the catalog does not have, even if the species matches another slot', () => {
    // American cockroach only has a 'pest' entry — no sign/look_alike photo exists.
    expect(findPhotoForSlot('can american cockroaches play dead', 'sign')).toBeNull();
    expect(findPhotoForSlot('can american cockroaches play dead', 'look_alike')).toBeNull();
  });

  test('never partial-token matches ("ant" must not match "fire ant")', () => {
    // A topic that mentions ants generically, with no fire-ant phrase, must
    // not accidentally return the fire ant photo.
    expect(findPhotoForSlot('carpenter ant identification', 'sign')).toBeNull();
  });

  test('returns null for an empty/missing topic or slot', () => {
    expect(findPhotoForSlot('', 'pest')).toBeNull();
    expect(findPhotoForSlot(null, 'pest')).toBeNull();
    expect(findPhotoForSlot('fire ant', null)).toBeNull();
  });
});

describe('buildPhotoSlots', () => {
  test('returns exactly 3 slots: pest, sign, look_alike', () => {
    const slots = buildPhotoSlots('fire ant');
    expect(slots.map((s) => s.slot)).toEqual(['pest', 'sign', 'look_alike']);
  });

  test('a fully-covered species (fire ant: pest + sign) still flags the uncovered look_alike slot', () => {
    const slots = buildPhotoSlots('fire ant');
    const bySlot = Object.fromEntries(slots.map((s) => [s.slot, s]));
    expect(bySlot.pest.photo).not.toBeNull();
    expect(bySlot.pest.flagged_for_human).toBe(false);
    expect(bySlot.sign.photo).not.toBeNull();
    expect(bySlot.sign.flagged_for_human).toBe(false);
    expect(bySlot.look_alike.photo).toBeNull();
    expect(bySlot.look_alike.flagged_for_human).toBe(true);
  });

  test('a species with no catalog coverage at all flags every slot, never AI art or a placeholder URL', () => {
    const slots = buildPhotoSlots('brown widow spider');
    for (const s of slots) {
      expect(s.photo).toBeNull();
      expect(s.flagged_for_human).toBe(true);
      expect(s.caption).toEqual(expect.any(String));
    }
  });

  test('every slot carries a caption even with no topic', () => {
    const slots = buildPhotoSlots('');
    for (const s of slots) {
      expect(s.photo).toBeNull();
      expect(s.flagged_for_human).toBe(true);
      expect(typeof s.caption).toBe('string');
      expect(s.caption.length).toBeGreaterThan(0);
    }
  });
});
