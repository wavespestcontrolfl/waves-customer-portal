// The v1 compatibility mapping against the REAL species catalog (the main
// engine suite runs on a fixture). A named v2 species may only inherit a
// v1 identity that is true of it (pre-push audit on Codex #4916 r3).
const catalog = require('../services/species-catalog');
const { buildAnswer, mapToV1, _test: { v1IdentityFor } } = require('../services/photo-id-v2/pest-engine');

describe('v1IdentityFor on the real catalog', () => {
  test('exact legacy mappings resolve to themselves', () => {
    expect(v1IdentityFor('fire-ant')).toEqual({ slug: 'fire-ant', inherited: false });
    expect(v1IdentityFor('american-cockroach')).toEqual({ slug: 'american-roach', inherited: false });
  });

  test('a species inherits a generic v1 label that is true of its whole group', () => {
    expect(v1IdentityFor('aedes-mosquito')).toEqual({ slug: 'mosquito', inherited: true });
    expect(v1IdentityFor('brown-widow')).toEqual({ slug: 'black-widow', inherited: true });
  });

  test('honey bee entries map to v1 honey-bee explicitly; other bees never borrow it', () => {
    expect(v1IdentityFor('honey-bee-wall-colony')).toEqual({ slug: 'honey-bee', inherited: false });
    expect(v1IdentityFor('honey-bee-swarm')).toEqual({ slug: 'honey-bee', inherited: false });
    expect(v1IdentityFor('carpenter-bee')).toBeNull();
  });

  test('unknown slugs stay unmatched', () => {
    expect(v1IdentityFor('not-a-species')).toBeNull();
    expect(v1IdentityFor(null)).toBeNull();
  });
});

describe('inherited v1 identity keeps the named v2 entry service contract', () => {
  const candidate = (slug, { approved = true } = {}) => {
    const entry = {
      ...catalog.getEntry(slug),
      review: { status: approved ? 'owner_approved' : 'draft', notes: '' },
      verification: [],
    };
    return {
      slug, offCatalogName: null, groupId: entry.group, confidence: 0.85, entry,
      traitsVisible: [1], traitsNotVisible: [], checked: true, verified: true,
    };
  };
  const answerFor = (slug, options) => buildAnswer({
    candidates: [candidate(slug, options)], disagreed: false, disagreementNode: null,
    escalationTriggered: false, openaiAnswered: false, openaiStoodInAlone: false,
    qualityUsable: true, qualityIssue: 'none', subjectConflict: false, currentMonth: 6,
  });

  test.each([
    ['black-widow', 'widow-spiders', 'black-widow', 'arachnid', { venomous: true }],
    ['aedes-mosquito', 'aedes', 'mosquito', 'insect', { disease_vector: true }],
  ])('a draft %s climb maps the selected lineage node to its legitimate generic v1 identity',
    (slug, nodeId, legacySlug, category, safety) => {
      const built = answerFor(slug, { approved: false });
      expect(built.topEntrySlug).toBeNull();
      expect(built.answer.node_id).toBe(nodeId);

      const mapped = mapToV1(built);
      expect(mapped).toMatchObject({ species_slug: legacySlug, category });
      expect(mapped.report_contract).toMatchObject({
        identification: { slug: legacySlug, category },
        safety,
      });
    });

  test.each([
    ['carpenter-bee', 'honey-bee', 'bees', 'insect'],
    ['aphid', 'aphid-scale', 'plant-pests-small', 'insect'],
  ])('a draft %s climb preserves category but never borrows the narrower %s identity',
    (slug, forbiddenLegacySlug, nodeId, category) => {
      const built = answerFor(slug, { approved: false });
      expect(built.topEntrySlug).toBeNull();
      expect(built.answer.node_id).toBe(nodeId);

      const mapped = mapToV1(built);
      expect(mapped.species_slug).toBeNull();
      expect(mapped.species_slug).not.toBe(forbiddenLegacySlug);
      expect(mapped.category).toBe(category);
      expect(mapped.report_contract.service).toMatchObject({
        key: null, label: 'Pest Consultation', inspection_required: true,
      });
    });

  test('an unmatched draft spider climb preserves the selected spiders category', () => {
    const built = answerFor('southern-house-spider', { approved: false });
    expect(built.answer.node_id).toBe('spiders');
    const mapped = mapToV1(built);
    expect(mapped).toMatchObject({ species_slug: null, category: 'arachnid', service_line: 'pest' });
    expect(mapped.report_contract.identification).toMatchObject({ slug: null, category: 'arachnid' });
  });

  test.each([
    ['american-dog-tick', 'pest', 'General Pest Control', 'high'],
    ['lone-star-tick', 'pest', 'General Pest Control', 'high'],
    ['blacklegged-tick', 'pest', 'General Pest Control', 'moderate'],
    ['brown-dog-tick', 'flea', 'Flea & Tick Treatment', 'high'],
  ])('%s inherits the tick identity and preserves its authored service and urgency', (slug, key, label, urgency) => {
    const mapped = mapToV1(answerFor(slug));
    expect(mapped).toMatchObject({ species_slug: 'tick', service_line: 'pest', urgency });
    expect(mapped.report_contract).toMatchObject({
      identification: { slug: 'tick', category: 'arachnid' },
      urgency,
      service: { line: 'pest', key, label, inspection_required: false },
    });
  });

  test.each(['millipede', 'greenhouse-millipede'])('%s inherits the generic millipede identity', (slug) => {
    expect(v1IdentityFor(slug)).toEqual({ slug: 'millipede', inherited: true });
    const mapped = mapToV1(answerFor(slug));
    expect(mapped).toMatchObject({ species_slug: 'millipede', service_line: 'pest', urgency: 'low' });
    expect(mapped.report_contract).toMatchObject({
      identification: { slug: 'millipede', category: 'other' },
      service: { line: 'pest', key: 'pest', label: 'General Pest Control', inspection_required: false },
    });
  });

  test('a direct v1 mapping still uses its established compatibility service and urgency', () => {
    const mapped = mapToV1(answerFor('fire-ant'));
    expect(mapped).toMatchObject({ species_slug: 'fire-ant', service_line: 'pest', urgency: 'high' });
    expect(mapped.report_contract.service).toMatchObject({ key: 'pest', label: 'General Pest Control', inspection_required: false });
  });

  test('a named entry with no v1 identity retains the unmatched consultation service', () => {
    const mapped = mapToV1(answerFor('carpenter-bee'));
    expect(mapped.species_slug).toBeNull();
    expect(mapped.report_contract.service).toMatchObject({ key: null, label: 'Pest Consultation', inspection_required: true });
  });

  test('the real v2-only Sri Lankan weevil stays on the inspection-first unmatched path', () => {
    const mapped = mapToV1(answerFor('sri-lankan-weevil'));
    expect(mapped).toMatchObject({ species_slug: null, service_line: 'tree_shrub', urgency: 'low' });
    expect(mapped.report_contract).toMatchObject({
      identification: { slug: null, category: 'insect' },
      service: { line: 'tree_shrub', key: null, label: 'Pest Consultation', inspection_required: true },
    });
  });
});

describe('real-catalog answer guards (Codex #4974 r2)', () => {
  const { REFERRAL_TEMPLATES } = require('../services/photo-id-v2/pest-engine');
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

  test.each([
    ['aedes-mosquito', 'asian-tiger-mosquito'],
    ['asian-tiger-mosquito', 'aedes-mosquito'],
  ])('a likely %s versus %s result after approval never asks for skin contact', (first, second) => {
    const candidates = [cand(first, 0.65), cand(second, 0.3)];
    const approved = new Map(candidates.map((candidate) => [candidate.slug, candidate.entry]));
    const getEntry = catalog.getEntry;
    // Future approval must also be visible to the target-entry lookup that
    // protects pair prose. Keep the real persisted approval records intact.
    const lookup = jest.spyOn(catalog, 'getEntry').mockImplementation((slug) => approved.get(slug) || getEntry(slug));
    try {
      const built = buildAnswer(ctx(candidates));
      expect(built.answer).toMatchObject({ level: 'entry', wording: 'likely', node_id: first });
      expect(built.nextPhoto.ask).toMatch(/wall or another non-contact surface/i);
      expect(built.nextPhoto.ask).toMatch(/never use skin as a perch/i);
      expect(built.nextPhoto.ask).not.toMatch(/rests? on skin|on skin or a wall/i);
    } finally {
      lookup.mockRestore();
    }
  });

  test('a bare genus never lands on a sign entry (Codex #4974 r8)', () => {
    expect(catalog.resolveName('Rattus')?.node?.kind).not.toBe('sign');
  });

  test('a sign-only read lists no organism among the other possibilities (Codex #4974 r8)', () => {
    const built = buildAnswer({ ...ctx([cand('subterranean-termite', 0.9), cand('termite-mud-tubes', 0.5)]), evidenceKind: { shownKind: 'sign', hiddenKind: 'organism' } });
    expect(built.entry?.kind).not.toBe('organism');
    expect(built.candidatesBlock.map((c) => c.slug)).not.toContain('subterranean-termite');
    expect(built.evidence.matches.join(' ')).not.toMatch(/soldier|worker|body/i);
  });

  test('an organism-only read never names a sign entry (Codex #4974 r10)', () => {
    const built = buildAnswer({ ...ctx([cand('discarded-wings', 0.95), cand('subterranean-termite', 0.3)]), evidenceKind: { shownKind: 'organism', hiddenKind: 'sign' } });
    expect(built.entry?.kind).not.toBe('sign');
    expect(built.candidatesBlock.map((c) => c.slug)).not.toContain('discarded-wings');
  });

  test('after dropping the contradicted kind, the best remaining candidate can still be named (Codex #4974 r11)', () => {
    const built = buildAnswer({ ...ctx([cand('discarded-wings', 0.95), cand('subterranean-termite', 0.9)]), evidenceKind: { shownKind: 'organism', hiddenKind: 'sign' } });
    expect(built.entry?.slug).toBe('subterranean-termite');
  });

  test('"plaster bagworm" never resolves to the outdoor bagworm (Codex #4974 r10)', () => {
    expect(catalog.resolveName('plaster bagworm')?.node?.slug).not.toBe('bagworm');
    expect(catalog.resolveName('I found plaster bagworms')?.node?.slug).not.toBe('bagworm');
    expect(catalog.resolveName('bagworm')?.node?.slug).toBe('bagworm');
  });

  test('bats get the exclusion-only referral, never a trapper', () => {
    expect(catalog.getEntry('brazilian-free-tailed-bat').service.referral).toBe('bat_exclusion');
    expect(REFERRAL_TEMPLATES.bat_exclusion).toMatch(/never trapped or handled/);
  });
});
