// The v1 compatibility mapping against the REAL species catalog (the main
// engine suite runs on a fixture). A named v2 species may only inherit a
// v1 identity that is true of it (pre-push audit on Codex #4916 r3).
const { _test: { v1SlugFor } } = require('../services/photo-id-v2/pest-engine');

describe('v1SlugFor on the real catalog', () => {
  test('exact legacy mappings resolve to themselves', () => {
    expect(v1SlugFor('fire-ant')).toBe('fire-ant');
    expect(v1SlugFor('american-cockroach')).toBe('american-roach');
  });

  test('a species inherits a generic v1 label that is true of its whole group', () => {
    expect(v1SlugFor('aedes-mosquito')).toBe('mosquito');
    expect(v1SlugFor('brown-widow')).toBe('black-widow');
  });

  test('honey bee entries map to v1 honey-bee explicitly; other bees never borrow it', () => {
    expect(v1SlugFor('honey-bee-wall-colony')).toBe('honey-bee');
    expect(v1SlugFor('honey-bee-swarm')).toBe('honey-bee');
    expect(v1SlugFor('carpenter-bee')).toBeNull();
  });

  test('unknown slugs stay unmatched', () => {
    expect(v1SlugFor('not-a-species')).toBeNull();
    expect(v1SlugFor(null)).toBeNull();
  });
});

describe('real-catalog answer guards (Codex #4974 r2)', () => {
  const catalog = require('../services/species-catalog');
  const { buildAnswer, REFERRAL_TEMPLATES } = require('../services/photo-id-v2/pest-engine');
  // The guards under test are about photo-confirmability, not the owner's
  // review state, so the top entry is treated as approved here.
  const cand = (slug, confidence) => {
    const entry = { ...catalog.getEntry(slug), review: { status: 'owner_approved', notes: '' }, verification: [] };
    return { slug, offCatalogName: null, groupId: entry.group, confidence, entry, traitsVisible: [1], traitsNotVisible: [], checked: true, verified: true };
  };
  const ctx = (candidates) => ({
    candidates, disagreed: false, disagreementNode: null, escalationTriggered: false, openaiAnswered: false,
    openaiStoodInAlone: false, qualityUsable: true, qualityIssue: 'none', subjectConflict: false, currentMonth: 6,
  });

  test('southern house spider over a brown recluse never reads pretty sure: the recluse side says no photo settles it', () => {
    const built = buildAnswer(ctx([cand('southern-house-spider', 0.95), cand('brown-recluse', 0.3)]));
    expect(built.answer.wording).not.toBe('pretty_sure');
  });

  test('a lone southern house spider never reads pretty sure either: the reverse recluse veto applies with one candidate (Codex #4974 r4)', () => {
    const built = buildAnswer(ctx([cand('southern-house-spider', 0.95)]));
    expect(built.answer.wording).not.toBe('pretty_sure');
    expect(built.nextPhoto.photo_can_confirm).toBe(false);
  });

  test('a confirmable runner-up pair never masks an unconfirmable look-alike (Formosan termite; Codex #4974 r5)', () => {
    const built = buildAnswer(ctx([cand('formosan-termite', 0.95), cand('subterranean-termite', 0.3)]));
    expect(built.answer.wording).not.toBe('pretty_sure');
    expect(built.nextPhoto.photo_can_confirm).toBe(false);
  });

  test('a bare "bat" does not name one bat species', () => {
    const r = catalog.resolveName('bats');
    expect(r?.node?.slug).not.toBe('brazilian-free-tailed-bat');
  });

  test('a bare genus never lands on a sign entry (Codex #4974 r8)', () => {
    expect(catalog.resolveName('Rattus')?.node?.kind).not.toBe('sign');
  });

  test('a sign-only read lists no organism among the other possibilities (Codex #4974 r8)', () => {
    const built = buildAnswer({ ...ctx([cand('subterranean-termite', 0.9), cand('termite-mud-tubes', 0.5)]), signOnly: true });
    expect(built.entry?.kind).not.toBe('organism');
    expect(built.candidatesBlock.map((c) => c.slug)).not.toContain('subterranean-termite');
  });

  test('bats get the exclusion-only referral, never a trapper', () => {
    expect(catalog.getEntry('brazilian-free-tailed-bat').service.referral).toBe('bat_exclusion');
    expect(REFERRAL_TEMPLATES.bat_exclusion).toMatch(/never trapped or handled/);
  });
});
