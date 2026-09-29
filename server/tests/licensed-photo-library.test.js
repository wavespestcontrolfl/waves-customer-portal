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
  // Codex r3 on #5216: every photo is a file already committed in the
  // Astro repo, referenced by local path — nothing is fetched at publish.
  test('every entry is a local committed path with the full attribution', () => {
    for (const entry of PHOTO_LIBRARY) {
      expect(entry.src).toMatch(/^\/images\/[a-z0-9/_.-]+\.(webp|jpe?g|png|avif)$/);
      for (const field of ['alt', 'credit', 'license', 'catalog_slug']) {
        expect(typeof entry[field]).toBe('string');
        expect(entry[field].length).toBeGreaterThan(0);
      }
      expect(entry.source_page).toMatch(/^https:\/\//);
      expect(entry.license_url).toMatch(/^https?:\/\/creativecommons\.org\//);
      // Parens would end a Markdown link destination early.
      expect(entry.source_page).not.toMatch(/[()]/);
    }
  });

  test('srcs and catalog slugs are unique', () => {
    expect(new Set(PHOTO_LIBRARY.map((e) => e.src)).size).toBe(PHOTO_LIBRARY.length);
    expect(new Set(PHOTO_LIBRARY.map((e) => e.catalog_slug)).size).toBe(PHOTO_LIBRARY.length);
  });

  test('every sign / look-alike reference names an entry in the library', () => {
    const slugs = new Set(PHOTO_LIBRARY.map((e) => e.catalog_slug));
    for (const entry of PHOTO_LIBRARY) {
      for (const ref of [entry.sign, ...entry.look_alikes].filter(Boolean)) expect(slugs.has(ref)).toBe(true);
    }
  });

  test('libraryPhotoBySrc / isLibraryPhotoSrc look photos up by exact local path only', () => {
    const { libraryPhotoBySrc, isLibraryPhotoSrc } = require('../services/content/licensed-photo-library');
    const entry = PHOTO_LIBRARY[0];
    expect(libraryPhotoBySrc(entry.src)).toBe(entry);
    expect(isLibraryPhotoSrc(entry.src)).toBe(true);
    expect(isLibraryPhotoSrc(entry.src.toUpperCase())).toBe(false);
    expect(isLibraryPhotoSrc(`https://www.wavespestcontrol.com${entry.src}`)).toBe(false);
    expect(isLibraryPhotoSrc('/images/blog/some-post/body-1.webp')).toBe(false);
  });

  test('brief photo objects carry the local src and attribution, not catalog internals', () => {
    const photo = findPhotoForSlot('fire ant identification', 'pest');
    expect(Object.keys(photo).sort()).toEqual(['alt', 'credit', 'license', 'license_url', 'source_page', 'src']);
    expect(photo.src).toBe('/images/blog/dangerous-ants-in-florida/fire-ant-workers.webp');
  });
});

describe('matchSpecies — specific aliases never borrow another species\' photo', () => {
  test.each([
    ['tropical fire ant identification'],
    ['southern fire ants in sarasota'],
    ['tokay gecko in the attic'],
    ['black carpenter ant damage'],
  ])('%s → no photo', (topic) => {
    expect(buildPhotoSlots(topic).every((s) => s.photo === null)).toBe(true);
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
    expect(findPhotoForSlot('ghost ant identification', 'sign')).toBeNull();
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
    // Codex r10 on #5216 narrows the bare and/or/from/not connectors to
    // a pest named on BOTH sides; "brown recluse" still counts through the
    // catalog's organism head nouns (recluse), so these stay null.
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

  // Codex r5 on #5216 ("Do not classify identification phrasing as
  // comparison"): the bare `like` alternative made ordinary terminal
  // identification phrasing — "what do X look like" — comparison-shaped,
  // nulling every photo slot on the most common identification phrasing
  // there is. Only a TERMINAL "look(s) like" is exempted; "like" anywhere
  // else in the topic still reads as a comparison.
  test('terminal "what do X look like" phrasing is not comparison-shaped', () => {
    expect(matchSpecies('what do fire ants look like')).toBe('fire ant');
    expect(matchSpecies('what does a fire ant look like?')).toBe('fire ant');
    expect(matchSpecies('what do ghost ants look like')).toBe('ghost ant');
  });

  test('"like" mid-topic still reads as a comparison and stays null', () => {
    expect(matchSpecies('bugs that look like fire ants')).toBeNull();
    expect(matchSpecies('what looks like a fire ant but isn\'t')).toBeNull();
    expect(matchSpecies('fire ant-like insects in Florida')).toBeNull();
  });

  // Codex r10 on #5216 ("Restrict comparison matching to comparison
  // phrases"): and/or/from/not are ordinary connector words too, and
  // matching them unconditionally nulled everyday single-species
  // identification topics that happen to contain one.
  // Codex r6–r9 on #5272: every narrowing of the connector words let a
  // two-subject topic through, so and/or/from/not stay unconditional (as on
  // main). The cost is fail-closed: these single-species topics get no
  // automatic photo, and a human fills the slot.
  test('a standalone connector word fails closed (no automatic photo)', () => {
    expect(matchSpecies('where do fire ants come from')).toBeNull();
    expect(matchSpecies('fire ant signs and identification')).toBeNull();
    expect(matchSpecies('is it a fire ant or not')).toBeNull();
    expect(matchSpecies('fire ants and insects')).toBeNull();
    expect(matchSpecies('fire ants or pests')).toBeNull();
    expect(matchSpecies('fire ants and gnats')).toBeNull();
  });

  test('a connector naming a pest on BOTH sides still reads as a comparison', () => {
    expect(matchSpecies('fire ants or red ants')).toBeNull();
    expect(matchSpecies('fire ants and ghost ants')).toBeNull();
    // "termite" has no catalog entry at all — the generic pest-noun list
    // (not the catalog aliases) is what must catch this, or the topic
    // would wrongly resolve to the carpenter-ant photo.
    expect(matchSpecies('carpenter ants from termites')).toBeNull();
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

// Codex r7 on #5216 ("Recognize suffixed look-like identification queries").
describe('identification phrasing with an ordinary qualifier', () => {
  const { matchSpecies } = require('../services/content/licensed-photo-library');
  test.each([
    ['what do fire ants look like in Florida?', 'fire ant'],
    ['what do fire ants look like up close', 'fire ant'],
    ['what do fire ants look like in comparison to red ants', null],
    ['bugs that look like fire ants in Florida', null],
  ])('%s -> %s', (topic, species) => {
    expect(matchSpecies(topic) ? matchSpecies(topic).toLowerCase() : null).toBe(species);
  });
});

// Codex r9 on #5216 ("Honor the publisher's page_type diagnostic fallback"):
// the shared predicate judges the post type the publisher ships.
describe('isIdentificationPost matches the publisher\'s normalized post_type', () => {
  jest.mock('../models/db', () => jest.fn());
  const { isIdentificationPost } = require('../services/content/licensed-photo-library');
  const { normalizeAutonomousBlogFrontmatter } = require('../services/content-astro/astro-publisher')._internals;
  test.each([
    [{ post_type: 'diagnostic' }],
    [{ page_type: 'diagnostic' }],
    [{ post_type: '', page_type: 'diagnostic' }],
    [{ post_type: 'how-to', page_type: 'diagnostic' }],
    [{ post_type: 'Diagnostic' }],
    [{ post_type: 'decision' }],
    [{}],
  ])('%j', (fmIn) => {
    const shipped = normalizeAutonomousBlogFrontmatter({ title: 'T', meta_description: 'x', ...fmIn }, {}).post_type;
    expect(isIdentificationPost(fmIn)).toBe(shipped === 'diagnostic');
  });
});

describe('connector comparisons use the catalog\'s organism names', () => {
  const { matchSpecies } = require('../services/content/licensed-photo-library');
  test.each([
    ['southern black widow or huntsman spider', null],
    ['huntsman spider and brown widows', null],
    ['fire ant bites and mounds', null],
    ['fire ant signs and identification', null],
  ])('%s -> %s', (topic, expected) => {
    expect(matchSpecies(topic)).toBe(expected);
  });
});

// Codex r1 on #5272 ("Keep bare "like" comparison phrases fail-closed").
describe('bare "like" stays comparison-shaped', () => {
  const { matchSpecies } = require('../services/content/licensed-photo-library');
  test.each([
    ['bugs like fire ants', null],
    ['insects like huntsman spiders', null],
    ['what do fire ants look like', 'fire ant'],
    ['what do fire ants look like in Florida?', 'fire ant'],
  ])('%s -> %s', (topic, expected) => {
    expect(matchSpecies(topic)).toBe(expected);
  });
});

// Codex r2 on #5272 ("Recognize pluralized catalog head nouns").
test('a pluralized catalog-only head noun still names a pest', () => {
  const { matchSpecies } = require('../services/content/licensed-photo-library');
  expect(matchSpecies('brown recluses and huntsman spider')).toBeNull();
  expect(matchSpecies('southern black widows or huntsman spider')).toBeNull();
});

// Codex r3 on #5272 ("Match complete catalog aliases around connectors"):
// a topic that names any other catalog organism by its full name or alias
// is a comparison, whatever joins the two.
describe('a second pest named by its full catalog name', () => {
  const { matchSpecies } = require('../services/content/licensed-photo-library');
  test.each([
    ['huntsman spider and daddy long legs', null],
    ['fire ants and no-see-ums', null],
    ['florida huntsman spider identification guide', 'huntsman spider'],
    ['red imported fire ants in lawns', 'fire ant'],
  ])('%s -> %s', (topic, expected) => {
    expect(matchSpecies(topic)).toBe(expected);
  });
});

// Codex r6 on #5272 ("Detect longer species names before blanking shared
// aliases").
describe('a longer species name that contains the matched alias', () => {
  const { matchSpecies } = require('../services/content/licensed-photo-library');
  test.each([
    ['fire ants and little fire ants', null],
    ['tawny crazy ant and longhorn crazy ant', null],
    ['florida carpenter ants in the attic', 'Florida carpenter ant'],
  ])('%s -> %s', (topic, expected) => {
    expect(matchSpecies(topic)).toBe(expected);
  });
});

// Codex r7 on #5272 ("Treat broad other-organism classes as a second pest").
describe('"other" plus a broad organism class is a second subject', () => {
  const { matchSpecies } = require('../services/content/licensed-photo-library');
  test.each([
    ['fire ants and other insects', null],
    ['fire ants or other pests', null],
    ['huntsman spiders and other arachnids', null],
    ['house geckos and other reptiles', null],
    ['fire ant pest control in bradenton', 'fire ant'],
  ])('%s -> %s', (topic, expected) => {
    expect(matchSpecies(topic)).toBe(expected);
  });
});

// Codex r8 on #5272 ("Reject negated species topics before assigning photos").
test.each([
  ['this is not a fire ant'],
  ['how to know it is not a fire ant'],
])('%s names no species to photograph', (topic) => {
  const { matchSpecies } = require('../services/content/licensed-photo-library');
  expect(matchSpecies(topic)).toBeNull();
});

