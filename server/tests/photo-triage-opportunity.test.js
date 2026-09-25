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

const { gaugeOpportunity, _test } = require('../services/photo-triage-opportunity');
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
    '',
  ])('%p is not large scope', (body) => expect(largeScope(body)).toBe(false));

  test.each([
    "it still won't go away",
    "can't get rid of it",
    'it keeps coming back every year',
    "it's still there after the last visit",
    "our lawn guy came out and couldn't fix it",
    'our lawn company tried treating it and it did not work',
  ])('%p reads as prior treatment failed', (body) => expect(priorTreatmentFailed(body)).toBe(true));

  // codex review 2026-09-25: "tried"/"treated" ALONE (no failure/recurrence
  // language) must not set prior_treatment_failed — "we tried a home
  // remedy" doesn't say it failed.
  test.each([
    'bugs on the hibiscus by the front door',
    'we tried treating it ourselves',
    'our lawn company already treated it',
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
    const customer = { id: 'existing-lawn-1', pipeline_stage: 'active_customer' };
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
      customer: { id: 'existing-1', pipeline_stage: 'active_customer' },
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
      customer: { id: 'existing-lawn-3', pipeline_stage: 'active_customer' },
      body: 'weeds are spreading in the yard',
      images: [],
    });
    expect(mockBuildOffer).toHaveBeenCalledWith('existing-lawn-3', mockDb, 'lawn_care');
    expect(result.mode).toBe('advise');
    expect(result.reasons).toContain('no_offer');
    expect(result.quote).toBeNull();
  });

  test('a priced offer for a DIFFERENT family than the photo never becomes this quote', async () => {
    mockBuildOffer.mockResolvedValueOnce(PRICED_OFFER('pest_control'));
    const result = await gaugeOpportunity({
      type: 'tree_shrub',
      analysis: TREE_ANALYSIS('pest_activity', 45),
      customer: { id: 'existing-1', pipeline_stage: 'active_customer' },
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
      customer: { id: 'existing-1', pipeline_stage: 'active_customer' },
      body: 'bugs on one of my shrubs',
      images: [],
    });
    expect(result.mode).toBe('advise');
    expect(result.reasons).toContain('quote_needs_review');
  });

  test('offer core throws → advise (fail closed), never onsite, never a quote', async () => {
    mockBuildOffer.mockRejectedValueOnce(new Error('boom'));
    const result = await gaugeOpportunity({
      type: 'tree_shrub',
      analysis: TREE_ANALYSIS('pest_activity', 45),
      customer: { id: 'existing-1', pipeline_stage: 'active_customer' },
      body: 'bugs on one of my shrubs',
      images: [],
    });
    expect(result.mode).toBe('advise');
    expect(result.reasons).toContain('no_offer');
  });

  test('pest photos are never engine-quoted through this lane (no offer call at all)', async () => {
    const result = await gaugeOpportunity({
      type: 'pest',
      analysis: { report_contract: JSON.stringify({ identification: { category: 'insect' } }) },
      customer: { id: 'existing-1', pipeline_stage: 'active_customer' },
      body: 'found this on the patio',
      images: [],
    });
    expect(mockBuildOffer).not.toHaveBeenCalled();
    expect(result.mode).toBe('advise');
    expect(result.reasons).toContain('no_offer');
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

  test('lead with a customer row but no plan → the offer core declines → advise, never a guessed quote', async () => {
    mockBuildOffer.mockResolvedValueOnce(null);
    const result = await gaugeOpportunity({
      type: 'tree_shrub',
      analysis: TREE_ANALYSIS('pest_activity', 55),
      customer: { id: 'newlead-1' }, // pipeline_stage absent → lead
      body: 'small bug spot on one shrub',
      images: [],
    });
    expect(result.mode).toBe('advise');
    expect(result.reasons).toEqual(expect.arrayContaining(['lead', 'no_offer']));
    expect(result.quote).toBeNull();
  });

  test('prior_treatment_failed + large_scope sends to onsite even for an existing customer (not gated on lead)', async () => {
    const customer = { id: 'existing-2', pipeline_stage: 'active_customer', lot_sqft: 8000 };
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
