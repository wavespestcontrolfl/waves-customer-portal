/**
 * Unit tests for licensed-photo-library.js — the closed catalog of real,
 * licensed photos an identification ("diagnostic") post's pest/sign/
 * look-alike slots may draw from (C3, blog work order 2026-09-28).
 */

const {
  PHOTO_LIBRARY,
  matchSpecies,
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

  test('matches the ordinary plural of the alias (Codex P1 follow-up: word-boundary must not break "fire ants")', () => {
    const photo = findPhotoForSlot('how to get rid of fire ants in your yard', 'pest');
    expect(photo).not.toBeNull();
    expect(photo.alt).toMatch(/fire ant/i);
  });

  test('matches the irregular -es plural ("cockroaches")', () => {
    const photo = findPhotoForSlot('why do american cockroaches play dead', 'pest');
    expect(photo).not.toBeNull();
    expect(photo.alt).toMatch(/american cockroach/i);
  });

  test('a longer unrelated word sharing the alias prefix never matches ("fire antique" must not match "fire ant")', () => {
    expect(findPhotoForSlot('fire antique cabinet identification', 'pest')).toBeNull();
  });
});

describe('matchSpecies — ambiguity guard (Codex P1)', () => {
  test('returns the single species a topic clearly names', () => {
    expect(matchSpecies('florida huntsman spider identification')).toBe('huntsman spider');
  });

  test('returns null (never guesses) when the topic names two distinct catalog species', () => {
    // Both "fire ant" and "huntsman spider" are real catalog species — a
    // topic naming both must never silently pick one for the pest slot.
    expect(matchSpecies('fire ant vs huntsman spider: which is more dangerous')).toBeNull();
  });

  test('returns null when the topic compares a catalog species against an UNCATALOGUED one (Codex P1)', () => {
    // Only "huntsman spider" is in the catalog — "brown recluse" is not —
    // so the two-DISTINCT-catalog-species guard alone would miss this and
    // confidently hand back the huntsman photo for a post that might
    // actually be about the brown recluse.
    expect(matchSpecies('brown recluse vs huntsman spider: how to tell them apart')).toBeNull();
    expect(matchSpecies('wolf spider or huntsman spider in your garage')).toBeNull();
    expect(matchSpecies('carpenter ant vs fire ant identification')).toBeNull();
  });

  test('returns null for every comparison phrasing named in review round 2 (Codex P1 follow-up)', () => {
    expect(matchSpecies('brown recluse and huntsman spider')).toBeNull();
    expect(matchSpecies('difference between a brown recluse and a huntsman spider')).toBeNull();
    expect(matchSpecies('huntsman spider compared to brown recluse')).toBeNull();
    expect(matchSpecies('is it a huntsman spider or a brown recluse')).toBeNull();
    expect(matchSpecies('huntsman spider mistaken for a brown recluse')).toBeNull();
    expect(matchSpecies('huntsman spider confused with a brown recluse')).toBeNull();
    expect(matchSpecies('a brown recluse look-alike: the huntsman spider')).toBeNull();
    expect(matchSpecies('huntsman spider instead of a brown recluse')).toBeNull();
  });

  test('an ordinary single-species identification topic with no connector still matches (no over-triggering)', () => {
    expect(matchSpecies('florida huntsman spider identification guide')).toBe('huntsman spider');
    expect(matchSpecies('how to get rid of fire ants in your yard')).toBe('fire ant');
  });

  test('a multi-species-ambiguous topic flags every photo slot rather than guessing', () => {
    const slots = buildPhotoSlots('fire ant vs huntsman spider: which is more dangerous');
    for (const s of slots) {
      expect(s.photo).toBeNull();
      expect(s.flagged_for_human).toBe(true);
    }
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

  test('caption names the canonical species, never the raw question-shaped query (Codex P1)', () => {
    const slots = buildPhotoSlots('is a huntsman spider dangerous');
    const pestSlot = slots.find((s) => s.slot === 'pest');
    expect(pestSlot.caption).toContain('the huntsman spider');
    expect(pestSlot.caption).not.toMatch(/is a huntsman spider dangerous/);
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
