// gaugeOpportunity — the photo-triage upsell gauge (owner ruling 2026-09-25).
// Pure metric/rule tests plus the two anonymized reference shapes (never a
// real customer name/record, per repo policy): a new lead with a
// whole-property finding and a prior failed treatment → onsite; an existing
// customer with a modest finding → advice, quoted when the shared offer
// core prices the family. Pricing goes through service-report/cross-sell's
// buildOfferForFamily (the ONE existing-customer offer mechanism — its own
// suites pin ownership, demotion and per-application rules), mocked here so
// this suite tests the gauge's use of it, not the offer core itself.

const mockBuildOffer = jest.fn(async () => null);
jest.mock('../services/service-report/cross-sell', () => ({
  buildOfferForFamily: (...args) => mockBuildOffer(...args),
}));
const mockDb = jest.fn();
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { gaugeOpportunity, recheckDraftOffer, stripQuotePitch, _test } = require('../services/photo-triage-opportunity');
const { largeScope, priorTreatmentFailed, outcomeFor } = _test;

const PRICED_OFFER = (serviceKey, overrides = {}) => ({
  serviceKey, label: 'x', mode: 'priced', relationship: 'add',
  option: { id: `${serviceKey}-opt`, label: 'Standard program', cadence: '6 visits/year', perVisit: 83, ...overrides },
});
const CTA_OFFER = (serviceKey) => ({ serviceKey, label: 'x', mode: 'quote_cta', relationship: 'add', option: null });


beforeEach(() => {
  jest.clearAllMocks();
});

// ── Caption metrics ──────────────────────────────────────────────────────

describe('large_scope / prior_treatment_failed regexes', () => {
  test.each([
    'bugs on both sides of the house',
    'all my hedges look bad',
    'all of my shrubs are dying',
    'the entire hedge is infested',
    'the whole yard is covered',
    'every plant has spots',
    'bugs on the front and back of the house',
    'bugs all around the house',
  ])('%p reads as large scope', (body) => expect(largeScope(body)).toBe(true));

  // codex review 2026-09-25: hedge(s)/border(s) ALONE (no quantifier or
  // location phrase) must not set large_scope — one hedge or one border bed
  // is one spot, same as "just this one spot".
  // codex #4810 r1: bare entire/whole/every (time, or a single object) are
  // not scope evidence either — the quantifier has to land on a property
  // subject (yard, beds, hedges, shrubs, plants, sides...).
  test.each([
    'just this one spot',
    'a small patch by the door',
    'the hedges are covered in webs',
    'along the borders of the property',
    'this one patch keeps coming back every year',
    'the whole thing started last week',
    'every time it rains the spots get worse',
    'I used all my spray on this one shrub',
    'both sides of this one leaf have spots',
    'front and back of the same shrub',
    '',
  ])('%p is not large scope', (body) => expect(largeScope(body)).toBe(false));

  test.each([
    "we sprayed it twice and it still won't go away",
    "I've tried everything and can't get rid of it",
    'it keeps coming back no matter what we spray',
    "it's still there after the last visit",
    "our lawn guy came out and couldn't fix it",
    'our lawn company tried treating it and it did not work',
    "the spray we put down didn't work",
    'our lawn company failed to fix it twice',
  ])('%p reads as prior treatment failed', (body) => expect(priorTreatmentFailed(body)).toBe(true));

  // codex review 2026-09-25: "tried"/"treated" ALONE (no failure/recurrence
  // language) must not set prior_treatment_failed — "we tried a home
  // remedy" doesn't say it failed.
  test.each([
    'bugs on the hibiscus by the front door',
    'we tried treating it ourselves',
    'our lawn company already treated it',
    "I couldn't get a better photo, sorry",
    'the nest is still there, should I knock it down?',
    "my sprinkler didn't work and this shrub has spots",
    'my lawn company failed to show up; what is this bug?',
    // Recurrence alone attempted nothing (codex #4810 r9).
    'this one patch keeps coming back every year',
    "it still won't go away",
    "can't get rid of these weeds, what are they?",
    "it's still there after the rain",
  ])('%p is not a prior failure', (body) => expect(priorTreatmentFailed(body)).toBe(false));
});

// ── outcomeFor: tree_shrub ───────────────────────────────────────────────

describe('outcomeFor tree_shrub', () => {
  test('no worst_signal → harmless', () => {
    expect(outcomeFor('tree_shrub', { worst_signal: null, overall_score: 92 }).kind).toBe('harmless');
  });

  test('water_heat_mechanical_stress → cultural, not actionable', () => {
    const outcome = outcomeFor('tree_shrub', { worst_signal: 'water_heat_mechanical_stress', overall_score: 62 });
    expect(outcome).toMatchObject({ kind: 'cultural', cultural: true, uncertain: false });
  });

  test('pest_activity is actionable regardless of score', () => {
    expect(outcomeFor('tree_shrub', { worst_signal: 'pest_activity', overall_score: 68 }).kind).toBe('actionable');
  });

  test('disease_leaf_spot is actionable AND flagged uncertain', () => {
    const outcome = outcomeFor('tree_shrub', { worst_signal: 'disease_leaf_spot', overall_score: 60 });
    expect(outcome).toMatchObject({ kind: 'actionable', uncertain: true });
  });

  test('a mild foliage/color signal (score above the attention line) is neither actionable nor harmless', () => {
    const outcome = outcomeFor('tree_shrub', { worst_signal: 'foliage_fullness', overall_score: 65 });
    expect(outcome.kind).not.toBe('actionable');
    expect(outcome.kind).not.toBe('harmless');
  });

  test('attention reads the worst CATEGORY status from the contract, not the five-category average (codex #4810 r4)', () => {
    const contract = JSON.stringify({ worst_signal: { key: 'foliage_fullness', label: 'Foliage', score: 40, status: 'needs_attention' } });
    expect(outcomeFor('tree_shrub', { worst_signal: 'foliage_fullness', overall_score: 78, report_contract: contract }).kind).toBe('actionable');
    const watch = JSON.stringify({ worst_signal: { key: 'foliage_fullness', label: 'Foliage', score: 62, status: 'watch' } });
    expect(outcomeFor('tree_shrub', { worst_signal: 'foliage_fullness', overall_score: 45, report_contract: watch }).kind).toBe('watch');
  });

  test('any signal at attention level (score <= 50) is actionable even off pest/disease', () => {
    expect(outcomeFor('tree_shrub', { worst_signal: 'foliage_fullness', overall_score: 40 }).kind).toBe('actionable');
  });
});

describe('outcomeFor pest', () => {
  const contractFor = (overrides) => ({ report_contract: JSON.stringify({ identification: {}, ...overrides }) });

  test('an identifiable pest is actionable', () => {
    expect(outcomeFor('pest', contractFor({ identification: { category: 'insect' } })).kind).toBe('actionable');
  });

  test('not_a_pest is harmless', () => {
    expect(outcomeFor('pest', contractFor({ identification: { category: 'not_a_pest' } })).kind).toBe('harmless');
  });
});

// ── property facts + active-service checks ──────────────────────────────

const TREE_ANALYSIS = (worstSignal, score) => ({ worst_signal: worstSignal, overall_score: score });
const PEST_ANALYSIS = (service) => ({ report_contract: JSON.stringify({ identification: { category: 'insect' }, service }) });

describe('gaugeOpportunity', () => {
  beforeEach(() => { mockBuildOffer.mockReset(); mockBuildOffer.mockResolvedValue(null); mockDb.mockClear(); });
  test('harmless always advises, even with scope/prior-treatment language in the caption', async () => {
    const result = await gaugeOpportunity({
      type: 'tree_shrub',
      analysis: TREE_ANALYSIS(null, 95),
      customer: null,
      body: 'both sides of the house, we already tried treating it and it keeps coming back',
      images: [],
    });
    expect(result.mode).toBe('advise');
    expect(result.reasons).toContain('harmless');
    expect(result.quote).toBeNull();
  });

  test('existing customer, one tree under cultural stress, offer core prices tree & shrub → quote (the quoted-T&S reference shape)', async () => {
    mockBuildOffer.mockResolvedValueOnce(PRICED_OFFER('tree_shrub'));
    const customer = { id: 'existing-lawn-1', pipeline_stage: 'active_customer', active: true };
    const result = await gaugeOpportunity({
      type: 'tree_shrub',
      analysis: TREE_ANALYSIS('water_heat_mechanical_stress', 62),
      customer,
      body: 'my tree looks stressed, can you take a look',
      images: [],
    });
    expect(mockBuildOffer).toHaveBeenCalledWith('existing-lawn-1', mockDb, 'tree_shrub');
    expect(result.mode).toBe('quote');
    expect(result.reasons).toEqual(expect.arrayContaining(['cultural', 'quoted']));
    expect(result.reasons).not.toContain('lead');
    // Per-application is the ONLY price the quote carries — no monthly/
    // annual/plan totals ever reach the draft (AGENTS.md P1).
    expect(result.quote).toEqual({
      service: 'tree_shrub', label: 'Standard program', option_id: 'tree_shrub-opt', per_visit: 83,
    });
    expect(result.quote).not.toHaveProperty('monthly');
    expect(result.quote).not.toHaveProperty('annual');
  });

  test('offer core demotes to the unpriced CTA (review-worthy facts, correction on file...) → advise, quote_needs_review', async () => {
    mockBuildOffer.mockResolvedValueOnce(CTA_OFFER('tree_shrub'));
    const result = await gaugeOpportunity({
      type: 'tree_shrub',
      analysis: TREE_ANALYSIS('pest_activity', 45),
      customer: { id: 'existing-1', pipeline_stage: 'active_customer', active: true },
      body: 'bugs on one of my shrubs',
      images: [],
    });
    expect(result.mode).toBe('advise');
    expect(result.reasons).toEqual(expect.arrayContaining(['actionable', 'quote_needs_review']));
    expect(result.quote).toBeNull();
  });

  test('offer core declines (family owned, ownership unknown, no plan, commercial...) → advise, never a second pitch', async () => {
    mockBuildOffer.mockResolvedValueOnce(null);
    const lawnRow = (findings, score) => ({
      report_contract: JSON.stringify({ diagnosis: { findings } }), overall_score: score, created_at: new Date(),
    });
    const result = await gaugeOpportunity({
      type: 'lawn',
      analysis: lawnRow([{ name: 'Chinch bug pressure', confidence: 'moderate' }], 55),
      customer: { id: 'existing-lawn-3', pipeline_stage: 'active_customer', active: true },
      body: 'weeds are spreading in the yard',
      images: [],
    });
    expect(mockBuildOffer).toHaveBeenCalledWith('existing-lawn-3', mockDb, 'lawn_care');
    expect(result.mode).toBe('advise');
    expect(result.reasons).toContain('no_offer');
    expect(result.quote).toBeNull();
  });

  test('family already on the plan (offer core says owned) → advise with already_owned, never a pitch', async () => {
    mockBuildOffer.mockResolvedValueOnce({ serviceKey: 'lawn_care', label: 'x', mode: 'owned', relationship: 'owned', option: null });
    const lawnRow = (findings, score) => ({
      report_contract: JSON.stringify({ diagnosis: { findings } }), overall_score: score, created_at: new Date(),
    });
    const result = await gaugeOpportunity({
      type: 'lawn',
      analysis: lawnRow([{ name: 'Chinch bug pressure', confidence: 'moderate' }], 55),
      customer: { id: 'existing-lawn-4', pipeline_stage: 'active_customer', active: true },
      body: 'weeds are spreading in the yard',
      images: [],
    });
    expect(result.mode).toBe('advise');
    expect(result.reasons).toContain('already_owned');
    expect(result.reasons).not.toContain('no_offer');
    expect(result.quote).toBeNull();
  });

  test('offer core fails closed (mode unavailable) → advise with offer_unavailable, no pitch', async () => {
    mockBuildOffer.mockResolvedValueOnce({ serviceKey: 'tree_shrub', label: 'x', mode: 'unavailable', relationship: 'unknown', option: null });
    const result = await gaugeOpportunity({
      type: 'tree_shrub',
      analysis: TREE_ANALYSIS('pest_activity', 45),
      customer: { id: 'existing-1', pipeline_stage: 'active_customer', active: true },
      body: 'bugs on one of my shrubs',
      images: [],
    });
    expect(result.mode).toBe('advise');
    expect(result.reasons).toContain('offer_unavailable');
    expect(result.quote).toBeNull();
  });

  test('a palm photo never reaches the tree & shrub offer (assessment-first family)', async () => {
    const result = await gaugeOpportunity({
      type: 'tree_shrub',
      analysis: TREE_ANALYSIS('pest_activity', 45),
      customer: { id: 'existing-1', pipeline_stage: 'active_customer', active: true },
      body: 'something is eating my palm fronds',
      images: [],
    });
    expect(mockBuildOffer).not.toHaveBeenCalled();
    expect(result.mode).toBe('advise');
    expect(result.reasons).toContain('palm_assessment_first');
    // Nothing stored for the dispatch recheck to substitute T&S into (r11).
    expect(result.family).toBeNull();
  });

  test('the owner-visible per-application amount keeps cents', async () => {
    mockBuildOffer.mockResolvedValueOnce(PRICED_OFFER('tree_shrub', { perVisit: 83.33 }));
    const result = await gaugeOpportunity({
      type: 'tree_shrub',
      analysis: TREE_ANALYSIS('pest_activity', 45),
      customer: { id: 'existing-1', pipeline_stage: 'active_customer', active: true },
      body: 'bugs on one of my shrubs',
      images: [],
    });
    expect(result.quote.per_visit).toBe(83.33);
  });

  test('an inactive row that still says active_customer is a lead (live-customer predicate)', async () => {
    const result = await gaugeOpportunity({
      type: 'tree_shrub',
      analysis: TREE_ANALYSIS('pest_activity', 45),
      customer: { id: 'former-1', pipeline_stage: 'active_customer', active: false },
      body: 'the spray we put down on the hedges on both sides did not work',
      images: [],
    });
    expect(result.reasons).toContain('lead');
    expect(result.mode).toBe('onsite');
  });

  test('a priced offer for a DIFFERENT family than the photo never becomes this quote', async () => {
    mockBuildOffer.mockResolvedValueOnce(PRICED_OFFER('pest_control'));
    const result = await gaugeOpportunity({
      type: 'tree_shrub',
      analysis: TREE_ANALYSIS('pest_activity', 45),
      customer: { id: 'existing-1', pipeline_stage: 'active_customer', active: true },
      body: 'bugs on one of my shrubs',
      images: [],
    });
    expect(result.mode).toBe('advise');
    expect(result.reasons).toContain('no_offer');
  });

  test('a priced offer with a $0 per-application amount is not a quote', async () => {
    mockBuildOffer.mockResolvedValueOnce(PRICED_OFFER('tree_shrub', { perVisit: 0 }));
    const result = await gaugeOpportunity({
      type: 'tree_shrub',
      analysis: TREE_ANALYSIS('pest_activity', 45),
      customer: { id: 'existing-1', pipeline_stage: 'active_customer', active: true },
      body: 'bugs on one of my shrubs',
      images: [],
    });
    expect(result.mode).toBe('advise');
    expect(result.reasons).toContain('quote_needs_review');
  });

  test('offer core throws → advise with offer_unavailable (fail closed, no quote ask), never onsite, never a quote', async () => {
    mockBuildOffer.mockRejectedValueOnce(new Error('boom'));
    const result = await gaugeOpportunity({
      type: 'tree_shrub',
      analysis: TREE_ANALYSIS('pest_activity', 45),
      customer: { id: 'existing-1', pipeline_stage: 'active_customer', active: true },
      body: 'bugs on one of my shrubs',
      images: [],
    });
    expect(result.mode).toBe('advise');
    expect(result.reasons).toContain('offer_unavailable');
  });

  test('an active pest customer\'s bug photo runs the ownership check → owned → advise with no pitch', async () => {
    mockBuildOffer.mockResolvedValueOnce({ serviceKey: 'pest_control', label: 'x', mode: 'owned', relationship: 'owned', option: null });
    const result = await gaugeOpportunity({
      type: 'pest',
      analysis: PEST_ANALYSIS({ line: 'pest', key: 'pest' }),
      customer: { id: 'existing-1', pipeline_stage: 'active_customer', active: true },
      body: 'found this on the patio',
      images: [],
    });
    expect(mockBuildOffer).toHaveBeenCalledWith('existing-1', mockDb, 'pest_control');
    expect(result.mode).toBe('advise');
    expect(result.reasons).toContain('already_owned');
    expect(result.family).toBe('pest_control');
  });

  describe('a pest ID checks the family its allowlisted service names (codex #4810 r11)', () => {
    const EXISTING = { id: 'existing-1', pipeline_stage: 'active_customer', active: true };
    const gauge = (service, customer = EXISTING) => gaugeOpportunity({
      type: 'pest', analysis: PEST_ANALYSIS(service), customer, body: 'what is this', images: [],
    });

    test('a mosquito or rodent ID has no checkable family → an existing customer gets no pitch, no lookup', async () => {
      for (const service of [{ line: 'mosquito', key: 'mosquito' }, { line: 'rodent', key: null }]) {
        const result = await gauge(service);
        expect(result).toMatchObject({ mode: 'advise', family: null, quote: null });
        expect(result.reasons).toContain('offer_unavailable');
      }
      expect(mockBuildOffer).not.toHaveBeenCalled();
    });

    test('a lead with a mosquito ID still gets the manual-quote ask (nothing to own)', async () => {
      const result = await gauge({ line: 'mosquito', key: 'mosquito' }, null);
      expect(result.reasons).toContain('no_customer_record');
      expect(result.reasons).not.toContain('offer_unavailable');
    });

    test('termite (inspection-first) checks termite ownership and is never program-priced', async () => {
      mockBuildOffer.mockResolvedValueOnce(PRICED_OFFER('termite'));
      const result = await gauge({ line: 'termite', key: null });
      expect(mockBuildOffer).toHaveBeenCalledWith('existing-1', mockDb, 'termite');
      expect(result).toMatchObject({ mode: 'advise', family: 'termite', quote: null });
      expect(result.reasons).toContain('manual_quote');
    });

    test('a lawn-pest ID checks lawn_care; a plant-feeding insect checks tree_shrub; neither is program-priced', async () => {
      mockBuildOffer.mockImplementation(async (_c, _db, key) => PRICED_OFFER(key));
      const lawnPest = await gauge({ line: 'lawn', key: 'lawnPestControl' });
      const plantPest = await gauge({ line: 'tree_shrub', key: null });
      expect(mockBuildOffer.mock.calls.map((c) => c[2])).toEqual(['lawn_care', 'tree_shrub']);
      expect([lawnPest.mode, plantPest.mode]).toEqual(['advise', 'advise']);
      expect(lawnPest.reasons).toContain('manual_quote');
      expect(plantPest.reasons).toContain('manual_quote');
    });

    test('a general pest ID on a customer without pest control is priced as the pest program', async () => {
      mockBuildOffer.mockResolvedValueOnce(PRICED_OFFER('pest_control'));
      const result = await gauge({ line: 'pest', key: 'pest' });
      expect(result).toMatchObject({ mode: 'quote', family: 'pest_control' });
      expect(result.quote.service).toBe('pest_control');
    });
  });

  test('a watch-level finding never becomes a quote even when the offer core priced it, but still learns ownership', async () => {
    mockBuildOffer.mockResolvedValueOnce(PRICED_OFFER('tree_shrub'));
    const watch = await gaugeOpportunity({
      type: 'tree_shrub',
      analysis: TREE_ANALYSIS('foliage_fullness', 65),
      customer: { id: 'existing-1', pipeline_stage: 'active_customer', active: true },
      body: 'is my shrub ok',
      images: [],
    });
    expect(watch.mode).toBe('advise');
    expect(watch.reasons).toContain('quote_withheld');
    expect(watch.quote).toBeNull();
    mockBuildOffer.mockResolvedValueOnce({ serviceKey: 'tree_shrub', label: 'x', mode: 'owned', relationship: 'owned', option: null });
    const owned = await gaugeOpportunity({
      type: 'tree_shrub',
      analysis: TREE_ANALYSIS('foliage_fullness', 65),
      customer: { id: 'existing-1', pipeline_stage: 'active_customer', active: true },
      body: 'is my shrub ok',
      images: [],
    });
    expect(owned.reasons).toContain('already_owned');
  });

  test('new lead, whole-property finding, already tried and failed → onsite', async () => {
    const result = await gaugeOpportunity({
      type: 'pest',
      analysis: { report_contract: JSON.stringify({ identification: { category: 'insect' } }) },
      customer: null, // new lead — no customer row yet
      body: 'bugs on the hedges on both sides of the house, we and our lawn company already tried treating it and it did not work',
      images: [],
    });
    expect(result.mode).toBe('onsite');
    expect(result.reasons).toEqual(expect.arrayContaining(['lead', 'large_scope', 'prior_treatment_failed', 'actionable']));
    expect(result.quote).toBeNull();
  });

  test('a customer row still in a lead stage is never priced — the offer core is not even asked (codex #4810 r5)', async () => {
    mockBuildOffer.mockResolvedValueOnce(PRICED_OFFER('tree_shrub'));
    const result = await gaugeOpportunity({
      type: 'tree_shrub',
      analysis: TREE_ANALYSIS('pest_activity', 55),
      customer: { id: 'newlead-1', pipeline_stage: 'new_lead', active: true },
      body: 'small bug spot on one shrub',
      images: [],
    });
    expect(mockBuildOffer).not.toHaveBeenCalled();
    expect(result.mode).toBe('advise');
    expect(result.reasons).toEqual(expect.arrayContaining(['lead', 'lead_not_priced']));
    expect(result.quote).toBeNull();
  });

  test('prior_treatment_failed + large_scope sends to onsite even for an existing customer (not gated on lead)', async () => {
    const customer = { id: 'existing-2', pipeline_stage: 'active_customer', active: true, lot_sqft: 8000 };
    const result = await gaugeOpportunity({
      type: 'tree_shrub',
      analysis: TREE_ANALYSIS('pest_activity', 40),
      customer,
      body: 'every hedge on the whole property is infested, we already tried treating it ourselves and it keeps coming back',
      images: [],
    });
    expect(result.mode).toBe('onsite');
    expect(result.reasons).not.toContain('lead');
  });

  test('actionable + no scope/prior-failure language on a lead with no customer row → advise (not onsite, not quote; leads never get engine quotes)', async () => {
    const result = await gaugeOpportunity({
      type: 'tree_shrub',
      analysis: TREE_ANALYSIS('pest_activity', 45),
      customer: null,
      body: 'found a bug on one leaf',
      images: [],
    });
    expect(result.mode).toBe('advise');
    expect(result.reasons).toContain('lead');
    expect(result.reasons).not.toContain('onsite_scope');
  });
});

// ── recheckDraftOffer (dispatch-time, admin-drafts approve/revise) ───────

describe('recheckDraftOffer', () => {
  beforeEach(() => { mockBuildOffer.mockReset(); mockBuildOffer.mockResolvedValue(null); });
  const FLAGS = (overrides = {}) => ({
    origin: 'photo_triage', assessment_type: 'tree_shrub', offer_family: 'tree_shrub', opportunity_mode: 'quote',
    opportunity_reasons: ['actionable', 'quoted'], quote: { service: 'tree_shrub', per_visit: 83.33 }, ...overrides,
  });

  test('non-photo-triage flags, no customer, or a draft that pitches nothing → ok without a lookup', async () => {
    expect(await recheckDraftOffer({ customerId: 'c1', flags: { origin: 'other' } })).toEqual({ ok: true });
    expect(await recheckDraftOffer({ customerId: null, flags: FLAGS() })).toEqual({ ok: true });
    expect(await recheckDraftOffer({ customerId: 'c1', flags: FLAGS({ opportunity_mode: 'advise', opportunity_reasons: ['actionable', 'already_owned'], quote: null }) })).toEqual({ ok: true });
    expect(await recheckDraftOffer({ customerId: 'c1', flags: FLAGS({ opportunity_mode: 'onsite', quote: null }) })).toEqual({ ok: true });
    expect(mockBuildOffer).not.toHaveBeenCalled();
  });

  test('customer enrolled meanwhile → blocked owned; plan rate landed → blocked unavailable', async () => {
    mockBuildOffer.mockResolvedValueOnce({ serviceKey: 'tree_shrub', mode: 'owned', option: null });
    expect(await recheckDraftOffer({ customerId: 'c1', flags: FLAGS() })).toEqual({ blocked: 'owned', family: 'tree_shrub' });
    mockBuildOffer.mockResolvedValueOnce({ serviceKey: 'lawn_care', mode: 'unavailable', option: null });
    const advise = FLAGS({ assessment_type: 'lawn', offer_family: 'lawn_care', opportunity_mode: 'advise', opportunity_reasons: ['actionable', 'no_offer'], quote: null });
    expect(await recheckDraftOffer({ customerId: 'c1', flags: advise })).toEqual({ blocked: 'unavailable', family: 'lawn_care' });
    expect(mockBuildOffer).toHaveBeenLastCalledWith('c1', mockDb, 'lawn_care', { throwOnError: true });
  });

  test('quote draft: same figure → ok; drifted figure → repriced; no longer priced → blocked', async () => {
    mockBuildOffer.mockResolvedValueOnce(PRICED_OFFER('tree_shrub', { perVisit: 83.33 }));
    expect(await recheckDraftOffer({ customerId: 'c1', flags: FLAGS() })).toEqual({ ok: true });
    mockBuildOffer.mockResolvedValueOnce(PRICED_OFFER('tree_shrub', { perVisit: 91.5 }));
    expect(await recheckDraftOffer({ customerId: 'c1', flags: FLAGS() })).toEqual({ repriced: 91.5, family: 'tree_shrub' });
    mockBuildOffer.mockResolvedValueOnce(CTA_OFFER('tree_shrub'));
    expect(await recheckDraftOffer({ customerId: 'c1', flags: FLAGS() })).toEqual({ blocked: 'no_longer_priced', family: 'tree_shrub' });
  });

  test('checks the family STORED at creation, never the assessment type: a palm or uncheckable photo stored none → ok without a lookup (codex #4810 r11)', async () => {
    // A palm caption on a tree_shrub assessment: the draft's manual-quote
    // ask is not re-judged against the unrelated standard T&S program.
    const palm = FLAGS({ offer_family: null, opportunity_mode: 'advise', opportunity_reasons: ['actionable', 'palm_assessment_first'], quote: null });
    expect(await recheckDraftOffer({ customerId: 'c1', flags: palm })).toEqual({ ok: true });
    expect(mockBuildOffer).not.toHaveBeenCalled();
    // A termite ID on a pest assessment is rechecked as termite, not as
    // the pest assessment type's pest_control.
    const pest = FLAGS({ assessment_type: 'pest', offer_family: 'termite', opportunity_mode: 'advise', opportunity_reasons: ['actionable', 'manual_quote'], quote: null });
    mockBuildOffer.mockResolvedValueOnce({ serviceKey: 'termite', mode: 'owned', option: null });
    expect(await recheckDraftOffer({ customerId: 'c1', flags: pest })).toEqual({ blocked: 'owned', family: 'termite' });
    expect(mockBuildOffer).toHaveBeenCalledWith('c1', mockDb, 'termite', { throwOnError: true });
  });

  test('a recipient linked or re-linked since the draft was gauged holds the draft — onsite and uncheckable-family drafts too (codex #4810 r12)', async () => {
    const onsiteLead = FLAGS({ gauged_customer_id: null, offer_family: 'tree_shrub', opportunity_mode: 'onsite', opportunity_reasons: ['lead', 'actionable', 'large_scope', 'onsite_scope'], quote: null });
    expect(await recheckDraftOffer({ customerId: 'c1', flags: onsiteLead })).toEqual({ blocked: 'recipient_changed', family: 'tree_shrub' });
    const mosquitoLead = FLAGS({ gauged_customer_id: null, assessment_type: 'pest', offer_family: null, opportunity_mode: 'advise', opportunity_reasons: ['lead', 'actionable', 'no_customer_record'], quote: null });
    expect(await recheckDraftOffer({ customerId: 'c1', flags: mosquitoLead })).toEqual({ blocked: 'recipient_changed', family: null });
    expect(await recheckDraftOffer({ customerId: 'c2', flags: FLAGS({ gauged_customer_id: 'c1' }) })).toEqual({ blocked: 'recipient_changed', family: 'tree_shrub' });
    expect(mockBuildOffer).not.toHaveBeenCalled();
    // Same customer → the normal recheck.
    mockBuildOffer.mockResolvedValueOnce(PRICED_OFFER('tree_shrub', { perVisit: 83.33 }));
    expect(await recheckDraftOffer({ customerId: 'c1', flags: FLAGS({ gauged_customer_id: 'c1' }) })).toEqual({ ok: true });
    // An unlinked draft still unlinked → nothing to recheck.
    expect(await recheckDraftOffer({ customerId: null, flags: mosquitoLead })).toEqual({ ok: true });
  });

  test('the text is never an input — the recheck reads only the stored verdict (drafts are approve-as-written)', async () => {
    const held = FLAGS({ opportunity_mode: 'advise', opportunity_reasons: ['actionable', 'already_owned'], quote: null });
    expect(await recheckDraftOffer({ customerId: 'c1', flags: held, outgoingText: 'Want a quote for pest control? $80.' })).toEqual({ ok: true });
    expect(mockBuildOffer).not.toHaveBeenCalled();
  });

  test('an advise draft that still pitches a quote is fine when the offer core simply has nothing (manual quote conversation)', async () => {
    mockBuildOffer.mockResolvedValueOnce(null);
    const advise = FLAGS({ opportunity_mode: 'advise', opportunity_reasons: ['actionable', 'no_offer'], quote: null });
    expect(await recheckDraftOffer({ customerId: 'c1', flags: advise })).toEqual({ ok: true });
  });

  test('a lookup failure propagates (the route fails closed)', async () => {
    mockBuildOffer.mockRejectedValueOnce(new Error('down'));
    await expect(recheckDraftOffer({ customerId: 'c1', flags: FLAGS() })).rejects.toThrow('down');
  });
});

describe('stripQuotePitch', () => {
  test('replaces either fixed pitch closer, keeps label/advice, is idempotent', () => {
    expect(stripQuotePitch("From what we can see, it's thin foliage. Want a quote for our tree & shrub program? Just reply yes."))
      .toBe("From what we can see, it's thin foliage. Reply if you have questions.");
    expect(stripQuotePitch("From what we can see, it's weed pressure. Reply if you'd like a quote."))
      .toBe("From what we can see, it's weed pressure. Reply if you have questions.");
    expect(stripQuotePitch("From what we can see, it's weed pressure. Reply if you have questions."))
      .toBe("From what we can see, it's weed pressure. Reply if you have questions.");
    expect(stripQuotePitch('')).toBe('Reply if you have questions.');
  });
});
