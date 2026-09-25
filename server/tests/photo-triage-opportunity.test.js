// gaugeOpportunity — the photo-triage upsell gauge (owner ruling 2026-09-25).
// Pure metric/rule tests plus the two named reference cases (Shelley
// Chismer → quote, Gretchen Dimartini → onsite). DB reads (property facts,
// active-service check) are mocked; real pricing-engine/pest-identification
// modules run unmocked so the numbers are the real engine's.

const mockState = { customersRow: undefined, estimates: [] };
function resetState() {
  mockState.customersRow = undefined; // undefined = "assert not queried"; null/object = the row
  mockState.estimates = [];
}
resetState();

function mockQuery(table) {
  const q = {};
  for (const method of ['whereRaw', 'orWhereRaw', 'orWhere', 'whereNull', 'whereIn', 'orderBy', 'limit']) q[method] = () => q;
  q.where = () => q;
  q.first = async (...cols) => {
    if (table !== 'customers') throw new Error(`unexpected first() on ${table}`);
    if (mockState.customersRow === undefined) throw new Error('unexpected customers read');
    if (mockState.customersRow === null) return null;
    const row = {};
    for (const col of cols) row[col] = mockState.customersRow[col] ?? null;
    return row;
  };
  q.select = async () => {
    if (table !== 'estimates') throw new Error(`unexpected select() on ${table}`);
    return mockState.estimates;
  };
  return q;
}
const mockDb = jest.fn((table) => mockQuery(table));
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { gaugeOpportunity, _test } = require('../services/photo-triage-opportunity');
const { largeScope, priorTreatmentFailed, outcomeFor, loadPropertyFacts, customerHasActiveService } = _test;

beforeEach(() => {
  jest.clearAllMocks();
  resetState();
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
    'the hedges are covered in webs',
    'along the borders of the property',
    'bugs all around the house',
  ])('%p reads as large scope', (body) => expect(largeScope(body)).toBe(true));

  test.each(['just this one spot', 'a small patch by the door', ''])(
    '%p is not large scope', (body) => expect(largeScope(body)).toBe(false),
  );

  test.each([
    'we tried treating it ourselves',
    'our lawn company already treated it',
    "it still won't go away",
    "can't get rid of it",
    'it keeps coming back every year',
    "it's still there after the last visit",
    "our lawn guy came out and couldn't fix it",
  ])('%p reads as prior treatment failed', (body) => expect(priorTreatmentFailed(body)).toBe(true));

  test('a bare description with no treatment history is not a prior failure', () => {
    expect(priorTreatmentFailed('bugs on the hibiscus by the front door')).toBe(false);
  });
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

describe('loadPropertyFacts', () => {
  test('reads straight off a customer object that already carries the columns (no DB call)', async () => {
    const facts = await loadPropertyFacts({ id: 'c1', lot_sqft: 8500, property_sqft: 4500, bed_sqft: null });
    expect(facts).toEqual({ lotSqFt: 8500, turfSf: 4500, bedArea: null, homeSqFt: null });
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('falls back to a DB read when the passed customer lacks those columns', async () => {
    mockState.customersRow = { lot_sqft: 9000, property_sqft: null, bed_sqft: 1200 };
    const facts = await loadPropertyFacts({ id: 'c1' });
    expect(facts).toEqual({ lotSqFt: 9000, turfSf: null, bedArea: 1200, homeSqFt: null });
    expect(mockDb).toHaveBeenCalledWith('customers');
  });

  test('no customer, no id, or a fully-empty row → null (never fabricates a guess)', async () => {
    expect(await loadPropertyFacts(null)).toBeNull();
    expect(await loadPropertyFacts({})).toBeNull();
    mockState.customersRow = null;
    expect(await loadPropertyFacts({ id: 'c1' })).toBeNull();
    mockState.customersRow = { lot_sqft: null, property_sqft: null, bed_sqft: null };
    expect(await loadPropertyFacts({ id: 'c2' })).toBeNull();
  });
});

describe('customerHasActiveService', () => {
  test('true only when an accepted estimate prices this exact service', async () => {
    mockState.estimates = [{ estimate_data: { lineItems: [{ service: 'pest_control' }] } }];
    expect(await customerHasActiveService('c1', 'lawn_care')).toBe(false);
    expect(await customerHasActiveService('c1', 'pest_control')).toBe(true);
  });

  test('no customer id → false without a query', async () => {
    expect(await customerHasActiveService(null, 'lawn_care')).toBe(false);
    expect(mockDb).not.toHaveBeenCalled();
  });
});

// ── gaugeOpportunity end to end ──────────────────────────────────────────

const TREE_ANALYSIS = (worstSignal, score) => ({ worst_signal: worstSignal, overall_score: score });

describe('gaugeOpportunity', () => {
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

  test('Shelley Chismer-shaped: existing lawn customer, one tree with water/establishment stress → quote', async () => {
    mockState.estimates = []; // no accepted T&S estimate on file
    const shelley = {
      id: 'shelley-1', pipeline_stage: 'active_customer',
      lot_sqft: 8500, property_sqft: 4500, bed_sqft: null,
    };
    const result = await gaugeOpportunity({
      type: 'tree_shrub',
      analysis: TREE_ANALYSIS('water_heat_mechanical_stress', 62),
      customer: shelley,
      body: 'my tree looks stressed, can you take a look',
      images: [],
    });
    expect(result.mode).toBe('quote');
    expect(result.reasons).toEqual(expect.arrayContaining(['cultural', 'quoted']));
    expect(result.reasons).not.toContain('lead');
    expect(result.quote).toMatchObject({ service: 'tree_shrub', tier: 'standard', frequency: 6 });
    expect(result.quote.monthly).toBeGreaterThan(0);
    expect(result.quote.annual).toBeCloseTo(result.quote.monthly * 12, 0);
    // AGENTS.md P1 "per application price copy": the customer-facing quote
    // line reads per_visit, never the monthly/annual total.
    expect(result.quote.per_visit).toBeGreaterThan(0);
    expect(result.quote.per_visit).toBeCloseTo(result.quote.annual / result.quote.frequency, 0);
  });

  test('Gretchen Dimartini-shaped: new lead, hibiscus hedges on both sides, already tried and failed → onsite', async () => {
    const result = await gaugeOpportunity({
      type: 'pest',
      analysis: { report_contract: JSON.stringify({ identification: { category: 'insect' } }) },
      customer: null, // new lead — no customer row yet
      body: 'bugs on the hibiscus hedges on both sides of the house, we and our lawn company already tried treating it and it did not work',
      images: [],
    });
    expect(result.mode).toBe('onsite');
    expect(result.reasons).toEqual(expect.arrayContaining(['lead', 'large_scope', 'prior_treatment_failed', 'actionable']));
    expect(result.quote).toBeNull();
  });

  test('lead (or unknown customer) with no property facts on file → advise, never a guessed quote', async () => {
    mockState.customersRow = null;
    const result = await gaugeOpportunity({
      type: 'tree_shrub',
      analysis: TREE_ANALYSIS('pest_activity', 55),
      customer: { id: 'newlead-1' }, // pipeline_stage absent → lead; no lot/bed/turf columns present
      body: 'small bug spot on one shrub',
      images: [],
    });
    expect(result.mode).toBe('advise');
    expect(result.reasons).toContain('no_property_facts');
    expect(result.quote).toBeNull();
  });

  test('customer already has this service (accepted estimate on file) → advise, not a second pitch', async () => {
    mockState.estimates = [{ estimate_data: { lineItems: [{ service: 'tree_shrub' }] } }];
    const customer = { id: 'existing-1', pipeline_stage: 'active_customer', lot_sqft: 8000, property_sqft: null, bed_sqft: null };
    const result = await gaugeOpportunity({
      type: 'tree_shrub',
      analysis: TREE_ANALYSIS('pest_activity', 55),
      customer,
      body: 'bugs on one of my shrubs',
      images: [],
    });
    expect(result.mode).toBe('advise');
    expect(result.reasons).toContain('already_active');
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

  test('actionable + no scope/prior-failure language on a lead with no property facts → advise (not onsite, not quote)', async () => {
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
