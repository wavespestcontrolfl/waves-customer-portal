/**
 * Estimator scope guards (GATE_ESTIMATOR_SCOPE_GUARDS, default OFF).
 *
 * Pins the guards born from the 2026-07-30 incidents (all identifiers
 * below are synthetic):
 *  - deterministic out-of-scope veto ("power washing service" is not a
 *    lead) runs before any model call and needs service-request phrasing —
 *    a surname like "Painter" or a street like "Roofers Rd" never trips it;
 *  - triage grounding: sender/address→customer matches (primary AND
 *    secondary properties, confirmed against the full normalized street),
 *    booked visits, and the recent inbound thread are loaded fail-open and
 *    time-bounded for the FAST classifier;
 *  - clarify suppression: a composer skip with skip_category
 *    out_of_scope / not_a_quote / existing_job must not park a
 *    customer-facing which-service question — while "ambiguous" skips and
 *    gate-off behavior keep parking exactly as today.
 */

let mockState;
jest.mock('../models/db', () => {
  const makeChain = (table) => {
    const chain = {
      where() { return chain; },
      whereNull() { return chain; },
      whereIn() { return chain; },
      // Builder-arg recorders: the chain can't express row-count effects
      // (limit crowding, status filtering), so pins assert the ARGS the
      // query was built with instead.
      whereNotIn(col, vals) {
        (mockState.whereNotIn = mockState.whereNotIn || []).push({ table, col, vals });
        return chain;
      },
      whereRaw() { return chain; },
      orderBy() { return chain; },
      limit(n) {
        const limits = (mockState.limits = mockState.limits || {});
        (limits[table] = limits[table] || []).push(n);
        return chain;
      },
      join() { return chain; },
      modify(fn) { fn(chain); return chain; },
      timeout() { return chain; },
      whereNot() { return chain; },
      async distinct() {
        if (mockState.throwOn === table) throw new Error(`${table} query down`);
        return mockState.rows[`${table}:distinct`] || [];
      },
      async select() {
        if (mockState.throwOn === table) throw new Error(`${table} query down`);
        if (mockState.hangOn === table) return new Promise(() => {});
        return mockState.rows[table] || [];
      },
      async first() { return null; },
      async update() { return 1; },
    };
    return chain;
  };
  const db = (table) => makeChain(table);
  db.transaction = async (cb) => cb(db);
  db.raw = () => ({});
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/property-lookup-v2', () => ({
  performPropertyLookup: async () => ({}),
}));

const mockComposeIntent = jest.fn();
jest.mock('../services/estimator-engine/intent-composer', () => ({
  composeIntent: (...args) => mockComposeIntent(...args),
}));

jest.mock('../services/pricing-engine', () => ({
  generateEstimate: () => ({ lineItems: [] }),
}));

const mockLoadCustomerByPhone = jest.fn();
jest.mock('../services/estimator-engine/context-builder', () => ({
  buildCallContext: jest.fn(),
  existingDraftForCall: jest.fn(),
  loadCustomerByPhone: (...args) => mockLoadCustomerByPhone(...args),
}));

jest.mock('../services/estimator-engine/source-arbitration', () => ({
  resolvePropertyFacts: () => ({ home: { value: null }, lot: { value: null } }),
  normalizeParcelView: () => null,
  SQFT_SOURCES: {},
  FALLBACK_SQFT_SOURCES: [],
}));

const mockClassifyLane = jest.fn();
jest.mock('../services/estimator-engine/draft-builder', () => ({
  LANES: { GREEN: 'green', YELLOW: 'yellow', RED: 'red' },
  buildEngineInput: () => ({}),
  deriveTotals: () => ({ monthly: 0, annual: 0, oneTime: 0 }),
  compsBand: async () => null,
  calibrationWarnings: async () => [],
  classifyLane: (...args) => mockClassifyLane(...args),
  createDraftEstimate: jest.fn(),
}));

jest.mock('../services/estimator-engine/commercial-proposal', () => ({
  commercialProposalsEnabled: () => false,
  maybeBuildCommercialProposalDraft: jest.fn(),
}));

const mockNotifyAdmin = jest.fn();
jest.mock('../services/notification-service', () => ({
  notifyAdmin: (...args) => { mockNotifyAdmin(...args); return Promise.resolve({ id: 'bell-1' }); },
}));

const mockParkClarify = jest.fn();
jest.mock('../services/estimate-clarify-asks', () => ({
  parkClarifyAsk: (...args) => mockParkClarify(...args),
}));

const {
  scopeGuardsEnabled,
  deterministicOutOfScope,
  extractAddressCandidates,
  loadThreadTriageContext,
} = require('../services/estimator-engine/scope-guards');

beforeEach(() => {
  jest.clearAllMocks();
  mockState = { rows: {}, throwOn: null, hangOn: null };
  delete process.env.GATE_ESTIMATOR_SCOPE_GUARDS;
  mockLoadCustomerByPhone.mockResolvedValue({ customer: null, ambiguous: false });
});

describe('gate', () => {
  test('off by default, on for 1/true/on', () => {
    expect(scopeGuardsEnabled()).toBe(false);
    for (const v of ['1', 'true', 'on']) {
      process.env.GATE_ESTIMATOR_SCOPE_GUARDS = v;
      expect(scopeGuardsEnabled()).toBe(true);
    }
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'false';
    expect(scopeGuardsEnabled()).toBe(false);
  });
});

describe('deterministicOutOfScope', () => {
  test('vetoes texts requesting only out-of-scope home services', () => {
    expect(deterministicOutOfScope('I would like to know if you available for power washing service')).toBe(true);
    expect(deterministicOutOfScope('do you do gutter cleaning?')).toBe(true);
    expect(deterministicOutOfScope('quote for pool service and window washing please')).toBe(true);
    expect(deterministicOutOfScope('looking for a plumber, any recommendations')).toBe(true);
  });

  test('never vetoes when a pest/lawn noun is present', () => {
    expect(deterministicOutOfScope('power wash the patio and spray for ants')).toBe(false);
    expect(deterministicOutOfScope('Can you spray my yard and pressure wash the driveway?')).toBe(false);
    expect(deterministicOutOfScope('need the house treated and the roof cleaned')).toBe(false);
    expect(deterministicOutOfScope('spiders at the house, can you spray the lanai?')).toBe(false);
    expect(deterministicOutOfScope('how much for quarterly pest control')).toBe(false);
  });

  test('bare nouns without service phrasing never trip it (surnames, street names, orgs)', () => {
    expect(deterministicOutOfScope("Hi, I'm Jane Painter. Can I get a quote?")).toBe(false);
    expect(deterministicOutOfScope('I live at 12 Roofers Rd, what do you charge?')).toBe(false);
    expect(deterministicOutOfScope('this is Sam Gutter, following up on a quote')).toBe(false);
    expect(deterministicOutOfScope("Hi, I'm Joe Plumber. Can I get a quote?")).toBe(false);
    expect(deterministicOutOfScope('This is Gulf Coast Painting, can I get a quote for our office?')).toBe(false);
    expect(deterministicOutOfScope('painting quote please')).toBe(true);
    expect(deterministicOutOfScope('need some painting done at the house')).toBe(true);
    expect(deterministicOutOfScope('this is Handyman Hardware confirming your service quote')).toBe(false);
    expect(deterministicOutOfScope('quote for the Drywall Bros office please')).toBe(false);
    // …while real trade requests still veto.
    expect(deterministicOutOfScope('need a handyman for the fence')).toBe(true);
    expect(deterministicOutOfScope('hvac repair quote please')).toBe(true);
    expect(deterministicOutOfScope('drywall repair estimate?')).toBe(true);
  });

  test('article-free trade requests still veto; trade surnames still do not', () => {
    expect(deterministicOutOfScope('need plumber asap')).toBe(true);
    expect(deterministicOutOfScope('want to hire electrician for the panel')).toBe(true);
    expect(deterministicOutOfScope('looking for handyman')).toBe(true);
    expect(deterministicOutOfScope("Hi, I'm Joe Plumber. Can I get a quote?")).toBe(false);
    expect(deterministicOutOfScope('this is Handyman Hardware confirming your service quote')).toBe(false);
  });

  test('roofing org names never trip the veto; roofing service requests still do', () => {
    // An org introducing itself while asking for OUR service is a lead.
    expect(deterministicOutOfScope('Hi, this is Gulf Coast Roofing — can we get a quote for our office?')).toBe(false);
    // …while actual roofing requests still veto.
    expect(deterministicOutOfScope('roofing quote please')).toBe(true);
    expect(deterministicOutOfScope('how much for a roof replacement estimate')).toBe(true);
    expect(deterministicOutOfScope('we need a new roof, do you do that?')).toBe(true);
    expect(deterministicOutOfScope('roof leak, can you help')).toBe(true);
  });

  test('solar/christmas-lights/remodel org names never trip the veto; requests still do', () => {
    expect(deterministicOutOfScope('This is Gulf Coast Remodeling; can I get a service quote?')).toBe(false);
    expect(deterministicOutOfScope('Sunshine Solar Panels LLC here — quote for our warehouse please')).toBe(false);
    expect(deterministicOutOfScope('Christmas Lights Bros, following up on a quote')).toBe(false);
    // …while actual requests still veto.
    expect(deterministicOutOfScope('remodeling quote for the kitchen')).toBe(true);
    expect(deterministicOutOfScope('we are planning a remodel, can you help')).toBe(true);
    expect(deterministicOutOfScope('solar panel installation quote please')).toBe(true);
    expect(deterministicOutOfScope('need new solar panels on the roof')).toBe(true);
    expect(deterministicOutOfScope('christmas light installation for the house')).toBe(true);
    expect(deterministicOutOfScope('can you hang our christmas lights')).toBe(true);
  });

  test('does not fire on plain quote chatter', () => {
    expect(deterministicOutOfScope('how much do you charge?')).toBe(false);
    expect(deterministicOutOfScope('')).toBe(false);
  });
});

describe('extractAddressCandidates', () => {
  test('captures the street run with prefix variants and skips durations', () => {
    const [cand] = extractAddressCandidates('coordinator here for 4021 Coral Bay Loop, spiders at house');
    expect(cand.num).toBe('4021');
    expect(cand.firstWord).toBe('Coral');
    expect(cand.variants).toEqual(['4021 Coral', '4021 Coral Bay', '4021 Coral Bay Loop']);
    expect(extractAddressCandidates('call me back in 24 hours or 30 minutes')).toEqual([]);
  });

  test('accepts short house numbers and numbered streets, skips bare number pairs', () => {
    expect(extractAddressCandidates('quote for 7 Palm Ave please')[0].variants).toContain('7 Palm Ave');
    expect(extractAddressCandidates('we are at 123 5th Ave')[0].variants).toContain('123 5th Ave');
    expect(extractAddressCandidates('see you at 4 30 tomorrow')).toEqual([]);
  });

  test('numeric route tokens after the first street word are captured (US 41, State Road 64)', () => {
    expect(extractAddressCandidates('quote for 123 US 41 please')[0].variants).toContain('123 US 41');
    expect(extractAddressCandidates('service at 123 State Road 64, thanks')[0].variants).toContain('123 State Road 64');
    // The bare-number-pair and time guards stay intact.
    expect(extractAddressCandidates('see you at 4 30 tomorrow')).toEqual([]);
    expect(extractAddressCandidates('see you at 2 pm')).toEqual([]);
    // Full street + validated locality extraction is unchanged.
    const [cand] = extractAddressCandidates('quote for 100 Palm Ave, Venice FL 34285 please');
    expect(cand.variants).toContain('100 Palm Ave');
    expect(cand.locality).toBe(', Venice 34285');
  });

  test('binds the ZIP in comma-free locality forms, never after prose', () => {
    // With an FL marker the city is rebuilt too (was ZIP-only pre-r10).
    expect(extractAddressCandidates('quote for 100 Palm Ave Venice FL 34285')[0].locality).toBe(', Venice 34285');
    expect(extractAddressCandidates('quote for 100 Palm Ave 34285')[0].locality).toBe(', 34285');
    expect(extractAddressCandidates('quote for 100 Palm Ave with a budget of 15000')[0].locality).toBe('');
  });

  test('state-only no-comma localities rebuild the city (multi-word cities included)', () => {
    expect(extractAddressCandidates('quote for 100 Palm Ave Venice FL')[0].locality).toBe(', Venice');
    expect(extractAddressCandidates('quote for 100 Palm Ave North Port FL 34287')[0].locality).toBe(', North Port 34287');
    // Directionals are street tokens, not city boundaries — but a city
    // STARTING with one keeps its first word.
    expect(extractAddressCandidates('quote for 100 Palm Ave North Port FL')[0].locality).toBe(', North Port');
    // No suffix anywhere: fall back to the single word before FL.
    expect(extractAddressCandidates('we are at 100 Palm Venice FL')[0].locality).toBe(', Venice');
  });

  test('suffixes without alias pairs (Loop, Way, Trail, …) still bound the city', () => {
    expect(extractAddressCandidates('quote for 100 Sample Loop North Port FL')[0].locality).toBe(', North Port');
    expect(extractAddressCandidates('quote for 100 Sample Way Venice FL 34285')[0].locality).toBe(', Venice 34285');
  });

  test('the CANONICAL normalizer vocabulary supplies the boundaries (walk, plaza, ridge, …)', () => {
    // Sourced from utils/address-normalizer's STREET_SPLIT_SUFFIXES, not a
    // hand-maintained parallel list that drifts.
    expect(extractAddressCandidates('quote for 100 Sample Walk North Port FL')[0].locality).toBe(', North Port');
    expect(extractAddressCandidates('quote for 100 Sample Plaza Venice FL')[0].locality).toBe(', Venice');
    expect(extractAddressCandidates('quote for 100 Sample Ridge Venice FL 34285')[0].locality).toBe(', Venice 34285');
    expect(extractAddressCandidates('service at 100 Sample Causeway Venice FL')[0].locality).toBe(', Venice');
  });

  test('numbered routes keep their route number in the STREET, not the city', () => {
    // The last suffix boundary is 'Road'; without the numeric advance the
    // city reconstructed as '64 Bradenton'.
    expect(extractAddressCandidates('quote for 123 State Road 64 Bradenton FL 34208')[0].locality)
      .toBe(', Bradenton 34208');
    expect(extractAddressCandidates('service at 123 US 41 Venice FL')[0].locality).toBe(', Venice');
  });

  test('unit token patterns match units, never house numbers or superstring units', () => {
    const { _private } = require('../services/estimator-engine/scope-guards');
    const { line1Pattern, line2Pattern } = _private.unitTokenPatterns('6');
    // \m/\M are Postgres word boundaries — equivalent to JS \b for these
    // alphanumeric values.
    const js = (p) => new RegExp(p.replace(/\\[mM]/g, '\\b'), 'i');
    const l1 = js(line1Pattern);
    const l2 = js(line2Pattern);
    // line2: designator-tolerant exact value.
    expect(l2.test('6')).toBe(true);
    expect(l2.test('Apt 6')).toBe(true);
    expect(l2.test('#6')).toBe(true);
    expect(l2.test('Apt #6')).toBe(true);
    expect(l2.test('Apt 16')).toBe(false);
    expect(l2.test('Apt 26')).toBe(false);
    expect(l2.test('16')).toBe(false);
    // line1: the value counts ONLY after a designator/#, never as street
    // text — the house number of 600 Palm Ave must not satisfy Unit 6.
    expect(l1.test('600 Palm Ave Apt 6')).toBe(true);
    expect(l1.test('600 Palm Ave #6')).toBe(true);
    expect(l1.test('600 Palm Ave')).toBe(false);
    expect(l1.test('600 Palm Ave Apt 16')).toBe(false);
    expect(l1.test('6 Palm Ave')).toBe(false);
  });

  test('CITY-PREFIX tokens are not consumed as the street boundary', () => {
    // "St James City", "Lake Wales", "Key Largo" all START with a
    // suffix-shaped token; taking the LAST suffix as the boundary
    // reconstructed 'James City' and then rejected the stored row. Mirrors
    // splitStreetAndCity's protection in utils/address-normalizer.
    expect(extractAddressCandidates('quote for 100 Main St St James City FL 33956')[0].locality)
      .toBe(', St James City 33956');
    expect(extractAddressCandidates('quote for 100 Main St Lake Wales FL')[0].locality).toBe(', Lake Wales');
    expect(extractAddressCandidates('service at 100 Main St Key Largo FL 33037')[0].locality)
      .toBe(', Key Largo 33037');
    // A plain city after a suffix is unaffected.
    expect(extractAddressCandidates('quote for 100 Main St Venice FL')[0].locality).toBe(', Venice');
  });

  test('boundary-only suffixes also bind a bare trailing ZIP', () => {
    // The bare-ZIP test used to consult the alias table alone, so Loop/Way/
    // Trail forms silently dropped their ZIP.
    expect(extractAddressCandidates('quote for 100 Sample Loop 34287')[0].locality).toBe(', 34287');
    expect(extractAddressCandidates('service at 100 Sample Way 34285')[0].locality).toBe(', 34285');
    expect(extractAddressCandidates('quote for 100 Sample Trail 34205')[0].locality).toBe(', 34205');
    // …and prose still binds nothing.
    expect(extractAddressCandidates('quote for 100 Sample Loop with a budget of 15000')[0].locality).toBe('');
  });

  test('LETTERED straddled units keep the comma-free state-only locality', () => {
    // 'B' is captured into the street run, which used to swallow the
    // city+FL out of the locality source entirely.
    const [cand] = extractAddressCandidates('quote for 100 Palm Ave Apt B Venice FL');
    expect(cand.variants.every((v) => v.endsWith(' Apt B'))).toBe(true);
    expect(cand.variants).toContain('100 Palm Ave Apt B');
    expect(cand.locality).toBe(', Venice');
    const [withZip] = extractAddressCandidates('quote for 100 Palm Ave Apt B Venice FL 34285');
    expect(withZip.locality).toBe(', Venice 34285');
    // Prose after a lettered unit still binds nothing.
    expect(extractAddressCandidates('quote for 100 Palm Ave Apt B please')[0].locality).toBe('');
  });

  test('comma-free localities still bind after an explicit unit (word and hash forms)', () => {
    const [apt] = extractAddressCandidates('quote for 100 Palm Ave Apt 6 Venice FL 34285');
    expect(apt.variants).toContain('100 Palm Ave Apt 6');
    expect(apt.locality).toBe(', Venice 34285');
    const [hash] = extractAddressCandidates('quote for 100 Palm Ave #6 Venice FL 34285');
    expect(hash.variants.every((v) => v.endsWith(' Apt 6'))).toBe(true);
    expect(hash.locality).toBe(', Venice 34285');
    // State-only after a unit works too.
    expect(extractAddressCandidates('quote for 100 Palm Ave Apt 6 Venice FL')[0].locality).toBe(', Venice');
  });

  test('captures locality only when a state or ZIP validates it', () => {
    const [cand] = extractAddressCandidates('quote for 100 Palm Ave, Venice FL 34285 please');
    expect(cand.locality).toBe(', Venice 34285');
    expect(extractAddressCandidates('quote for 100 Palm Ave before Saturday')[0].locality).toBe('');
    // Comma-separated prose is NOT a city.
    expect(extractAddressCandidates('quote for 100 Palm Ave, please')[0].locality).toBe('');
    expect(extractAddressCandidates('100 Palm Ave, spray before Saturday.')[0].locality).toBe('');
  });

  test('captures STRUCTURAL unit designators with their original word', () => {
    const [lot] = extractAddressCandidates('quote for 100 Park Rd Lot 6 please');
    expect(lot.variants.every((v) => v.endsWith(' Lot 6'))).toBe(true);
    expect(lot.variants).toContain('100 Park Rd Lot 6');
    const [space] = extractAddressCandidates('service at 100 Park Rd Space 6');
    expect(space.variants.every((v) => v.endsWith(' Space 6'))).toBe(true);
    // Locality still parses after a structural unit.
    const [withLoc] = extractAddressCandidates('quote for 100 Park Rd Lot 6, Venice FL 34285');
    expect(withLoc.locality).toBe(', Venice 34285');
  });

  test('street-LEADING designator words are street text, never a unit', () => {
    // The old unanchored unit search read "Space Coast" as "Space" + value.
    const [space] = extractAddressCandidates('quote for 100 Space Coast Parkway please');
    expect(space.variants).toEqual(['100 Space', '100 Space Coast', '100 Space Coast Parkway', '100 Space Coast Parkway please']);
    const [bldg] = extractAddressCandidates('service at 100 Building B Way');
    expect(bldg.variants).toEqual(['100 Building', '100 Building B', '100 Building B Way']);
    // …while a REAL trailing unit after such a street still captures.
    const [withUnit] = extractAddressCandidates('quote for 100 Space Coast Parkway Apt 6');
    expect(withUnit.variants.every((v) => v.endsWith(' Apt 6'))).toBe(true);
    expect(withUnit.variants).toContain('100 Space Coast Parkway Apt 6');
  });

  test('Fl is the FLOOR designator before a floor number, the STATE marker otherwise', () => {
    // Canonical isStateZipPair rule + short-floor-number refinement.
    const [fl] = extractAddressCandidates('quote for 100 Palm Ave Fl 2 please');
    expect(fl.variants.every((v) => v.endsWith(' Fl 2'))).toBe(true);
    expect(fl.unitValue).toBe('2');
    // Tail form after a comma.
    const [flTail] = extractAddressCandidates('quote for 100 Palm Ave, Fl 2, Venice FL 34285');
    expect(flTail.unit).toBe('Fl 2');
    expect(flTail.locality).toBe(', Venice 34285');
    // ZIP-shaped next value ⇒ state marker: locality behavior unchanged.
    const [state] = extractAddressCandidates('quote for 100 Palm Ave Venice FL 34285');
    expect(state.unit).toBeNull();
    expect(state.locality).toBe(', Venice 34285');
    // Terminal FL ⇒ state marker, unchanged.
    const [term] = extractAddressCandidates('quote for 100 Palm Ave Venice FL');
    expect(term.unit).toBeNull();
    expect(term.locality).toBe(', Venice');
  });

  test('pricing-detail numbers never crowd out the real address (plausibility cap)', () => {
    const cands = extractAddressCandidates(
      'Competitor quoted 99 initial, 49 monthly, and 4 quarterly visits; quote service at 100 Palm Ave',
    );
    expect(cands).toHaveLength(1);
    expect(cands[0].variants).toContain('100 Palm Ave');
  });

  test('a suffix-less candidate emits only when nothing plausible exists', () => {
    // Alone: still extracted (fallback) — confirmation gates it anyway.
    const alone = extractAddressCandidates('quote for 100 Sample');
    expect(alone).toHaveLength(1);
    expect(alone[0].variants).toContain('100 Sample');
    // Alongside a plausible address: dropped in its favor.
    const both = extractAddressCandidates('quote for 100 Sample and also 200 Oak St please');
    expect(both).toHaveLength(1);
    expect(both[0].variants).toContain('200 Oak St');
  });

  test('route-designator spellings expand in the prefix builder (both directions)', () => {
    const { _private } = require('../services/estimator-engine/scope-guards');
    expect(_private.prefixVariants('123', 'State', 'Road')).toEqual(expect.arrayContaining(['123 State%', '123 SR%']));
    expect(_private.prefixVariants('123', 'SR')).toEqual(expect.arrayContaining(['123 SR%', '123 State%']));
    expect(_private.prefixVariants('123', 'County', 'Road')).toEqual(expect.arrayContaining(['123 County%', '123 CR%']));
    expect(_private.prefixVariants('55', 'Route')).toEqual(expect.arrayContaining(['55 Route%', '55 Rt%', '55 Rte%']));
    // Non-route first words are untouched.
    expect(_private.prefixVariants('100', 'Palm', 'Ave')).toEqual(['100 Palm%']);
  });

  test('the SQL unit patterns accept the fl/floor designator spellings', () => {
    // Without 'fl', a 'Fl 2' candidate REJECTED the row storing 'Fl 2' in
    // address_line2 before confirmation ever saw it. No ZIP guard needed
    // in SQL: patterns are built from a candidate's already-classified
    // unitValue (extraction applied isStateZipPair), so a state marker
    // never produces a pattern.
    const { _private } = require('../services/estimator-engine/scope-guards');
    const { line1Pattern, line2Pattern } = _private.unitTokenPatterns('2');
    const js = (p) => new RegExp(p.replace(/\\[mM]/g, '\\b'), 'i');
    expect(js(line2Pattern).test('Fl 2')).toBe(true);
    expect(js(line2Pattern).test('Floor 2')).toBe(true);
    expect(js(line1Pattern).test('100 Palm Ave Fl 2')).toBe(true);
    expect(js(line2Pattern).test('Fl 12')).toBe(false);
    // State-marker forms classify unit-less at extraction ⇒ discriminate
    // builds no unit pattern at all.
    expect(extractAddressCandidates('quote for 100 Palm Ave Venice FL 34285')[0].unitValue).toBeNull();
  });

  test('the scanner never re-enters a consumed unit/locality tail', () => {
    // '6 Venice FL' used to emit as a phantom second candidate, making
    // burst uniqueness see two addresses and withholding shorthand
    // grounding.
    const cands = extractAddressCandidates('100 Palm Ave Apt 6 Venice FL 34285');
    expect(cands).toHaveLength(1);
    expect(cands[0].unit).toBe('Apt 6');
    expect(cands[0].locality).toBe(', Venice 34285');
    // Multi-address messages still yield each address.
    const two = extractAddressCandidates('quotes for 100 Palm Ave and 200 Oak St, Venice FL 34285');
    expect(two).toHaveLength(2);
    // Hash and floor tails advance the scanner too.
    expect(extractAddressCandidates('100 Palm Ave #6, Venice FL 34285')).toHaveLength(1);
    expect(extractAddressCandidates('100 Palm Ave Fl 2 Venice FL 34285')).toHaveLength(1);
  });

  test('trailing-period tokens normalize at the tokenizer (N., Apt., Ste.)', () => {
    // 'Apt.' used to fail the designator cut entirely — no unit captured,
    // exact-unit guard bypassed.
    const [apt] = extractAddressCandidates('quote for 100 Palm Ave Apt. 6 please');
    expect(apt.variants.every((v) => v.endsWith(' Apt 6'))).toBe(true);
    expect(apt.variants).toContain('100 Palm Ave Apt 6');
    const [ste] = extractAddressCandidates('service at 200 Trade Ctr Blvd Ste. 12');
    expect(ste.variants.every((v) => v.endsWith(' Ste 12'))).toBe(true);
    // 'N.' now expands through the directional aliases like bare 'N'.
    const [dir] = extractAddressCandidates('quote for 100 N. Palm Ave please');
    expect(dir.firstWord).toBe('N');
    const { _private } = require('../services/estimator-engine/scope-guards');
    expect(_private.prefixVariants(dir.num, dir.firstWord)).toEqual(expect.arrayContaining(['100 N%', '100 north%']));
  });

  test('measurement-shaped numbers never consume the candidate cap', () => {
    // '2 bedrooms', '3 bathrooms', '1500 sqft' each burned one of the three
    // slots and the REAL address was lost.
    const cands = extractAddressCandidates('2 bedrooms, 3 bathrooms, 1500 sqft, service at 100 Palm Ave');
    expect(cands).toHaveLength(1);
    expect(cands[0].variants).toContain('100 Palm Ave');
  });

  test('captures explicit units onto every variant (word and hash forms)', () => {
    const [cand] = extractAddressCandidates('quote for 100 Palm Ave Apt 6 please');
    expect(cand.variants.every((v) => v.endsWith(' Apt 6'))).toBe(true);
    expect(cand.variants).toContain('100 Palm Ave Apt 6');
    const [hash] = extractAddressCandidates('quote for 100 Palm Ave #6 please');
    expect(hash.variants.every((v) => v.endsWith(' Apt 6'))).toBe(true);
  });

  test('ZIPs bind only to the matched address, never to distant numbers', () => {
    const cands = extractAddressCandidates('quotes for 100 Palm Ave and 200 Oak St, Venice FL 34285');
    expect(cands[0].locality).toBe('');
    expect(cands[1].locality).toBe(', Venice 34285');
    expect(extractAddressCandidates('quote for 100 Palm Ave with a budget of 15000')[0].locality).toBe('');
  });

  test('prefixVariants expands directional and suffix aliases both ways', () => {
    const { _private } = require('../services/estimator-engine/scope-guards');
    expect(_private.prefixVariants('100', 'N')).toEqual(expect.arrayContaining(['100 N%', '100 north%']));
    expect(_private.prefixVariants('100', 'North')).toEqual(expect.arrayContaining(['100 North%', '100 n%']));
    expect(_private.prefixVariants('100', 'Palm')).toEqual(['100 Palm%']);
  });

  test('locality still parses after an explicit unit', () => {
    const [cand] = extractAddressCandidates('quote for 100 Palm Ave Apt 6, Venice FL 34285');
    expect(cand.variants).toContain('100 Palm Ave Apt 6');
    expect(cand.locality).toBe(', Venice 34285');
    const [hash] = extractAddressCandidates('quote for 100 Palm Ave #6, Venice FL 34285');
    expect(hash.locality).toBe(', Venice 34285');
  });

  test('captures long street names (up to seven words)', () => {
    const [cand] = extractAddressCandidates('service at 100 Dr Martin Luther King Jr Blvd please');
    expect(cand.variants).toContain('100 Dr Martin Luther King Jr Blvd');
  });

  test('caps at three candidates', () => {
    const text = '100 Alpha St, 200 Beta Ave, 300 Gamma Rd, 400 Delta Ct';
    expect(extractAddressCandidates(text)).toHaveLength(3);
  });
});

describe('loadThreadTriageContext', () => {
  test('describes active sender and full-street-confirmed address matches with booked visits', async () => {
    mockLoadCustomerByPhone.mockResolvedValue({
      customer: { id: 'c-1', first_name: 'Taylor', last_name: 'Sample', address_line1: '99 Placeholder Way', active: true, pipeline_stage: 'active_customer' },
      ambiguous: false,
    });
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Pat', last_name: 'Homeowner', address_line1: '4021 Coral Bay Loop' },
    ];
    mockState.rows.scheduled_services = [
      { service_type: 'Quarterly Pest Control Service', scheduled_date: '2026-08-01', status: 'pending' },
    ];
    const triage = await loadThreadTriageContext({
      phone: '+17245550000',
      triggerBody: 'this is the property manager for 4021 Coral Bay Loop',
    });
    expect(triage.matchedExistingCustomer).toBe(true);
    const joined = triage.lines.join('\n');
    expect(joined).toContain('Taylor Sample');
    expect(joined).toContain('Pat Homeowner');
    expect(joined).toContain('4021 Coral Bay Loop');
    expect(joined).toContain('Quarterly Pest Control Service 2026-08-01 (pending)');
  });

  test('inactive or ambiguous sender matches never ground as the sender', async () => {
    mockLoadCustomerByPhone.mockResolvedValue({
      customer: { id: 'c-1', first_name: 'Former', last_name: 'Customer', active: false },
      ambiguous: false,
    });
    let triage = await loadThreadTriageContext({ phone: '+17245550000', triggerBody: 'quote please' });
    expect(triage.lines).toEqual([]);

    // Column missing from the select (undefined) must read as NOT active.
    mockLoadCustomerByPhone.mockResolvedValue({
      customer: { id: 'c-1', first_name: 'No', last_name: 'ActiveCol' },
      ambiguous: false,
    });
    triage = await loadThreadTriageContext({ phone: '+17245550000', triggerBody: 'quote please' });
    expect(triage.lines).toEqual([]);

    mockLoadCustomerByPhone.mockResolvedValue({
      customer: { id: 'c-1', first_name: 'Shared', last_name: 'Line', active: true, pipeline_stage: 'active_customer' },
      ambiguous: true,
    });
    triage = await loadThreadTriageContext({ phone: '+17245550000', triggerBody: 'quote please' });
    expect(triage.lines).toEqual([]);
  });

  test('a webhook-minted prospect row (active, pipeline_stage new_lead) never grounds', async () => {
    mockLoadCustomerByPhone.mockResolvedValue({
      customer: { id: 'c-1', first_name: 'Fresh', last_name: 'Prospect', active: true, pipeline_stage: 'new_lead' },
      ambiguous: false,
    });
    const triage = await loadThreadTriageContext({ phone: '+17245550000', triggerBody: 'quote please' });
    expect(triage.matchedExistingCustomer).toBe(false);
    expect(triage.lines).toEqual([]);
  });

  test('address-matched grounding scopes booked visits to THAT property', async () => {
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Pat', last_name: 'Homeowner', address_line1: '4021 Coral Bay Loop' },
    ];
    mockState.rows.scheduled_services = [
      { service_type: 'Quarterly Pest Control Service', scheduled_date: '2026-08-01', status: 'pending', service_address_line1: '4021 Coral Bay Loop' },
      { service_type: 'Lawn Care Visit', scheduled_date: '2026-08-03', status: 'pending', service_address_line1: '900 Other Property Rd' },
      { service_type: 'Flea Treatment', scheduled_date: '2026-08-04', status: 'pending', service_address_line1: '4021 Coral Bay Loop', service_address_city: 'North Port' },
    ];
    const triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'need a treatment at 4021 Coral Bay Loop',
    });
    const joined = triage.lines.join('\n');
    expect(joined).toContain('Quarterly Pest Control Service 2026-08-01 (pending)');
    expect(joined).not.toContain('Lawn Care Visit');
  });

  test('a same-prefix different street is NOT a match (100 Palm Ave vs 100 Palm St)', async () => {
    mockState.rows.customers = [
      { id: 'c-9', first_name: 'Other', last_name: 'Person', address_line1: '100 Palm St' },
    ];
    const triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'new customer here, quote for 100 Palm Ave please',
    });
    expect(triage.matchedExistingCustomer).toBe(false);
    expect(triage.lines).toEqual([]);
  });

  test('grounds against addresses named in the CURRENT burst, not just the trigger body', async () => {
    mockState.rows.sms_log = [
      { message_body: 'Hi, this is the coordinator for Pat Homeowner at 4021 Coral Bay Loop', created_at: new Date().toISOString() },
    ];
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Pat', last_name: 'Homeowner', address_line1: '4021 Coral Bay Loop' },
    ];
    const triage = await loadThreadTriageContext({
      phone: '+17245550000',
      triggerBody: 'can you spray before Saturday?',
    });
    expect(triage.matchedExistingCustomer).toBe(true);
    expect(triage.lines.join('\n')).toContain('Pat Homeowner');
  });

  test('a STALE text\'s address (outside the burst window) never grounds a customer', async () => {
    // Yesterday's conversation about customer A must not become grounding
    // (or groundedCustomerId) for today's quote about an unmatched
    // property B — the classifier prompt still SEES the stale text via
    // recentTexts, but no customer entry is built from it.
    mockState.rows.sms_log = [
      {
        message_body: 'Hi, this is the coordinator for Pat Homeowner at 4021 Coral Bay Loop',
        created_at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      },
    ];
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Pat', last_name: 'Homeowner', address_line1: '4021 Coral Bay Loop' },
    ];
    const triage = await loadThreadTriageContext({
      phone: '+17245550000',
      triggerBody: 'how much would a quarterly plan cost?',
    });
    expect(triage.matchedExistingCustomer).toBe(false);
    expect(triage.groundedCustomerId).toBeNull();
    expect(triage.lines).toEqual([]);
    expect(triage.recentTexts.join('\n')).toContain('4021 Coral Bay Loop');
  });

  test('directional/suffix abbreviations still confirm against the stored long form', async () => {
    mockState.rows.customers = [
      { id: 'c-7', first_name: 'Dir', last_name: 'Ectional', address_line1: '100 North Palm Avenue', city: 'Bradenton' },
    ];
    const triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 100 N Palm Ave please',
    });
    expect(triage.matchedExistingCustomer).toBe(true);
    expect(triage.lines.join('\n')).toContain('100 North Palm Avenue');
  });

  test('an explicit unit must match the row unit (Apt 6 never grounds against Apt 1)', async () => {
    mockState.rows.customers = [
      { id: 'c-8', first_name: 'Unit', last_name: 'One', address_line1: '100 Palm Ave', address_line2: 'Apt 1', city: 'Bradenton' },
    ];
    let triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'new quote for 100 Palm Ave Apt 6 please',
    });
    expect(triage.matchedExistingCustomer).toBe(false);

    mockState.rows.customers = [
      { id: 'c-8', first_name: 'Unit', last_name: 'Six', address_line1: '100 Palm Ave', address_line2: 'Apt 6', city: 'Bradenton' },
    ];
    triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'new quote for 100 Palm Ave Apt 6 please',
    });
    expect(triage.matchedExistingCustomer).toBe(true);
  });

  test('vetoTexts is burst-scoped; recentTexts keeps the full window with direction labels', async () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    mockState.rows.sms_log = [
      { message_body: 'fresh text', created_at: now, direction: 'inbound' },
      { message_body: 'stale text', created_at: old, direction: 'inbound' },
    ];
    const triage = await loadThreadTriageContext({ phone: '+17245550000', triggerBody: 'quote please' });
    expect(triage.recentTexts).toEqual(['[sender] fresh text', '[sender] stale text']);
    expect(triage.vetoTexts).toEqual(['fresh text']);
  });

  test('Waves\' own OUTBOUND text grounds the sender\'s reply', async () => {
    mockState.rows.sms_log = [
      {
        message_body: 'Confirmed: quarterly visit at 4021 Coral Bay Loop is booked for Friday',
        created_at: new Date().toISOString(),
        direction: 'outbound',
      },
    ];
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Pat', last_name: 'Homeowner', address_line1: '4021 Coral Bay Loop' },
    ];
    const triage = await loadThreadTriageContext({
      phone: '+17245550000',
      triggerBody: 'can you add flea treatment to that visit?',
    });
    expect(triage.matchedExistingCustomer).toBe(true);
    expect(triage.lines.join('\n')).toContain('Pat Homeowner');
    expect(triage.recentTexts[0]).toContain('[Waves]');
  });

  test('a 6+ message burst fully grounds — the display cap never truncates the burst', async () => {
    const now = Date.now();
    // Six in-burst texts, the ADDRESS only in the oldest (6th) — a fetch
    // capped at the 5-text display limit would drop exactly that one.
    mockState.rows.sms_log = [
      ...['a', 'b', 'c', 'd', 'e'].map((tag, i) => ({
        message_body: `filler text ${tag}`,
        created_at: new Date(now - i * 60 * 1000).toISOString(),
        direction: 'inbound',
      })),
      {
        message_body: 'coordinator here for 4021 Coral Bay Loop',
        created_at: new Date(now - 5 * 60 * 1000).toISOString(),
        direction: 'inbound',
      },
    ];
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Pat', last_name: 'Homeowner', address_line1: '4021 Coral Bay Loop' },
    ];
    const triage = await loadThreadTriageContext({ phone: '+17245550000', triggerBody: 'quote please' });
    expect(triage.matchedExistingCustomer).toBe(true);
    expect(triage.lines.join('\n')).toContain('Pat Homeowner');
    // The classifier prompt list stays capped…
    expect(triage.recentTexts).toHaveLength(5);
    // …and the fetch bound is the sanity bound, not the display limit.
    expect(mockState.limits.sms_log).toContain(25);
  });

  test('an outbound out-of-scope mention never enters vetoTexts', async () => {
    mockState.rows.sms_log = [
      {
        message_body: 'Sorry, we do not offer power washing.',
        created_at: new Date().toISOString(),
        direction: 'outbound',
      },
    ];
    const triage = await loadThreadTriageContext({ phone: '+17245550000', triggerBody: 'ok how much then?' });
    expect(triage.vetoTexts).toEqual([]);
    expect(triage.recentTexts).toEqual(['[Waves] Sorry, we do not offer power washing.']);
  });

  test('a stated locality that disagrees with the row is NOT a match', async () => {
    mockState.rows.customers = [
      { id: 'c-9', first_name: 'Other', last_name: 'City', address_line1: '100 Palm Ave', city: 'Bradenton', zip: '34205' },
    ];
    const triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'new quote please for 100 Palm Ave, Venice FL 34285',
    });
    expect(triage.matchedExistingCustomer).toBe(false);
  });

  test('sender match and a scoped address match for the SAME customer both ground — but only the scoped line carries visits', async () => {
    mockLoadCustomerByPhone.mockResolvedValue({
      customer: { id: 'c-2', first_name: 'Multi', last_name: 'Property', address_line1: '1 Primary St', active: true, pipeline_stage: 'active_customer' },
      ambiguous: false,
    });
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Multi', last_name: 'Property', address_line1: '4021 Coral Bay Loop' },
    ];
    // An open visit at the PRIMARY property must not appear anywhere when
    // the text is about the other property: the sender line loses its
    // visit list (scoped sibling exists) and the scoped line's full-stamp
    // filter rejects the primary-address visit.
    mockState.rows.scheduled_services = [
      { service_type: 'Quarterly Pest Control Service', scheduled_date: '2026-08-01', status: 'pending', service_address_line1: '1 Primary St' },
    ];
    const triage = await loadThreadTriageContext({
      phone: '+17245550000',
      triggerBody: 'about 4021 Coral Bay Loop please',
    });
    expect(triage.lines).toHaveLength(2);
    expect(triage.lines[0]).toContain('Sender phone matches');
    expect(triage.lines[0]).toContain('booked work listed under the matched property below');
    expect(triage.lines[0]).not.toContain('booked:');
    expect(triage.lines[1]).toContain('4021 Coral Bay Loop');
    expect(triage.lines[1]).not.toContain('Quarterly Pest Control Service');
  });

  test('matches secondary customer_properties addresses', async () => {
    mockState.rows['customer_properties as cp'] = [
      { id: 'c-3', first_name: 'Multi', last_name: 'Property', address_line1: '77 Rental Cove' },
    ];
    const triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'need service at 77 Rental Cove',
    });
    expect(triage.matchedExistingCustomer).toBe(true);
    expect(triage.lines.join('\n')).toContain('77 Rental Cove (secondary property)');
  });

  test('grounding lines carry the customer\'s recurring service coverage', async () => {
    mockLoadCustomerByPhone.mockResolvedValue({
      customer: { id: 'c-1', first_name: 'Taylor', last_name: 'Sample', address_line1: '99 Placeholder Way', active: true, pipeline_stage: 'active_customer' },
      ambiguous: false,
    });
    mockState.rows['scheduled_services:distinct'] = [{ service_type: 'Quarterly Pest Control Service' }];
    const triage = await loadThreadTriageContext({ phone: '+17245550000', triggerBody: 'quote please' });
    expect(triage.lines[0]).toContain('recurring services on file: Quarterly Pest Control Service');
  });

  test('address-scoped coverage keeps only rows stamped at THAT property', async () => {
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Pat', last_name: 'Homeowner', address_line1: '4021 Coral Bay Loop' },
    ];
    mockState.rows['scheduled_services:distinct'] = [
      { service_type: 'Quarterly Pest Control Service', service_address_line1: '4021 Coral Bay Loop' },
      { service_type: 'Lawn Care Program', service_address_line1: '900 Other Property Rd' },
    ];
    const triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'need a treatment at 4021 Coral Bay Loop',
    });
    const joined = triage.lines.join('\n');
    expect(joined).toContain('recurring services on file: Quarterly Pest Control Service');
    expect(joined).not.toContain('Lawn Care Program');
  });

  test('unstamped recurring rows count for the primary-address match only', async () => {
    mockState.rows['scheduled_services:distinct'] = [{ service_type: 'Quarterly Pest Control Service' }];
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Pat', last_name: 'Homeowner', address_line1: '4021 Coral Bay Loop' },
    ];
    let triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'need a treatment at 4021 Coral Bay Loop',
    });
    expect(triage.lines.join('\n')).toContain('recurring services on file');

    // Same unstamped row against a SECONDARY property match: not coverage.
    mockState.rows.customers = [];
    mockState.rows['customer_properties as cp'] = [
      { id: 'c-3', first_name: 'Multi', last_name: 'Property', address_line1: '77 Rental Cove' },
    ];
    triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'need service at 77 Rental Cove',
    });
    expect(triage.matchedExistingCustomer).toBe(true);
    expect(triage.lines.join('\n')).not.toContain('recurring services on file');
  });

  test('multi-property counter-case: coverage is per entry, never cached customer-wide', async () => {
    // Sender line (unscoped) sees the customer-wide plan; the address-scoped
    // line for the OTHER property must not inherit it from a
    // customerId-keyed cache — the plan is stamped at the primary.
    mockLoadCustomerByPhone.mockResolvedValue({
      customer: { id: 'c-2', first_name: 'Multi', last_name: 'Property', address_line1: '1 Primary St', active: true, pipeline_stage: 'active_customer' },
      ambiguous: false,
    });
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Multi', last_name: 'Property', address_line1: '4021 Coral Bay Loop' },
    ];
    mockState.rows['scheduled_services:distinct'] = [
      { service_type: 'Quarterly Pest Control Service', service_address_line1: '1 Primary St' },
    ];
    const triage = await loadThreadTriageContext({
      phone: '+17245550000',
      triggerBody: 'about 4021 Coral Bay Loop please',
    });
    expect(triage.lines).toHaveLength(2);
    expect(triage.lines[0]).toContain('Sender phone matches');
    expect(triage.lines[0]).toContain('recurring services on file: Quarterly Pest Control Service');
    expect(triage.lines[1]).toContain('4021 Coral Bay Loop');
    expect(triage.lines[1]).not.toContain('recurring services on file');
  });

  test('coverage excludes the CANONICAL terminal statuses, not just cancelled', async () => {
    const { TERMINAL_STATUSES } = require('../services/waveguard-existing-services');
    mockLoadCustomerByPhone.mockResolvedValue({
      customer: { id: 'c-1', first_name: 'Taylor', last_name: 'Sample', active: true, pipeline_stage: 'active_customer' },
      ambiguous: false,
    });
    await loadThreadTriageContext({ phone: '+17245550000', triggerBody: 'quote please' });
    const statusFilters = (mockState.whereNotIn || [])
      .filter((c) => c.table === 'scheduled_services' && c.col === 'status');
    expect(statusFilters.length).toBeGreaterThan(0);
    expect(statusFilters[0].vals).toEqual(TERMINAL_STATUSES);
    expect(statusFilters[0].vals).toEqual(
      expect.arrayContaining(['cancelled', 'completed', 'no_show', 'skipped', 'rescheduled']),
    );
  });

  test('address-row fetches use the wide sanity bound (25) so a named unit cannot be crowded out', async () => {
    // The chainable mock cannot express row counts, so pin the builder arg:
    // both address queries must fetch 25 before candidateMatchesRow gates.
    mockState.rows.customers = [];
    mockState.rows['customer_properties as cp'] = [];
    await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 100 Palm Ave Apt 20 please',
    });
    // cap + 1: the extra row is the SATURATION probe (see the over-cap pin).
    expect(mockState.limits.customers).toContain(26);
    expect(mockState.limits['customer_properties as cp']).toContain(26);
  });

  test('an over-cap address fetch is AMBIGUOUS, never a silent "no customer"', async () => {
    // 26 rows come back for a broad same-street prefix: the request cannot
    // be attributed to one of them. It must red-lane, not fall through to
    // an unlinked prospect draft on somebody's property.
    mockState.rows.customers = Array.from({ length: 26 }, (_, i) => ({
      id: `c-${i}`, first_name: 'Some', last_name: 'Body', address_line1: '100 Palm Ave', address_line2: `Apt ${i}`,
    }));
    const triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 100 Palm Ave please',
    });
    expect(triage.groundedOvercap).toBe(true);
    expect(triage.matchedExistingCustomer).toBe(false);
    expect(triage.groundedCustomerId).toBeNull();
  });

  test('the named unit still grounds when many same-street rows exist (SQL-side discrimination)', async () => {
    // The unit predicate runs server-side, so the mock stands in for a
    // filtered result set: the named unit survives the cap.
    mockState.rows.customers = [
      { id: 'c-20', first_name: 'Named', last_name: 'Unit', address_line1: '100 Palm Ave', address_line2: 'Apt 20', city: 'Venice' },
    ];
    const triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 100 Palm Ave Apt 20 please',
    });
    expect(triage.matchedExistingCustomer).toBe(true);
    expect(triage.groundedScope).toMatchObject({ line2: 'Apt 20' });
    expect(triage.groundedOvercap).toBe(false);
  });

  test('the coverage query uses a wide sanity bound (100) so another property\'s combos cannot crowd out the matched property\'s coverage', async () => {
    mockLoadCustomerByPhone.mockResolvedValue({
      customer: { id: 'c-1', first_name: 'Taylor', last_name: 'Sample', active: true, pipeline_stage: 'active_customer' },
      ambiguous: false,
    });
    await loadThreadTriageContext({ phone: '+17245550000', triggerBody: 'quote please' });
    expect(mockState.limits.scheduled_services).toContain(100);
  });

  test('groundedCustomerId carries exactly-one-distinct-customer matches, else null', async () => {
    // Address-only single match → that customer's id.
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Pat', last_name: 'Homeowner', address_line1: '4021 Coral Bay Loop' },
    ];
    let triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'need a treatment at 4021 Coral Bay Loop',
    });
    expect(triage.groundedCustomerId).toBe('c-2');
    expect(triage.groundedConflict).toBe(false);

    // Sender + address match for the SAME customer is still one distinct id.
    mockLoadCustomerByPhone.mockResolvedValue({
      customer: { id: 'c-2', first_name: 'Multi', last_name: 'Property', address_line1: '1 Primary St', active: true, pipeline_stage: 'active_customer' },
      ambiguous: false,
    });
    triage = await loadThreadTriageContext({
      phone: '+17245550000',
      triggerBody: 'about 4021 Coral Bay Loop please',
    });
    expect(triage.groundedCustomerId).toBe('c-2');

    // Sender ≠ addressed customer → two distinct ids → null (no guessing).
    mockLoadCustomerByPhone.mockResolvedValue({
      customer: { id: 'c-1', first_name: 'Taylor', last_name: 'Sample', address_line1: '99 Placeholder Way', active: true, pipeline_stage: 'active_customer' },
      ambiguous: false,
    });
    triage = await loadThreadTriageContext({
      phone: '+17245550000',
      triggerBody: 'this is the property manager for 4021 Coral Bay Loop',
    });
    expect(triage.matchedExistingCustomer).toBe(true);
    expect(triage.groundedCustomerId).toBeNull();
    // …and the distinct-customer conflict is flagged so the context build
    // can downgrade the phone-matched profile to the ambiguous posture.
    expect(triage.groundedConflict).toBe(true);

    // No matches at all → null, no conflict.
    mockLoadCustomerByPhone.mockResolvedValue({ customer: null, ambiguous: false });
    mockState.rows.customers = [];
    triage = await loadThreadTriageContext({ phone: '+17245550000', triggerBody: 'quote please' });
    expect(triage.groundedCustomerId).toBeNull();
    expect(triage.groundedConflict).toBe(false);
  });

  test('groundedScope carries the matched property stamp; sender-only grounding has none', async () => {
    // Primary-address match → scope with isPrimary true.
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Pat', last_name: 'Homeowner', address_line1: '4021 Coral Bay Loop', city: 'Venice', zip: '34285' },
    ];
    let triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'need a treatment at 4021 Coral Bay Loop',
    });
    expect(triage.groundedScope).toMatchObject({ address: '4021 Coral Bay Loop', city: 'Venice', zip: '34285', isPrimary: true });

    // Secondary-property match → scope with isPrimary false.
    mockState.rows.customers = [];
    mockState.rows['customer_properties as cp'] = [
      { id: 'c-3', first_name: 'Multi', last_name: 'Property', address_line1: '77 Rental Cove', city: 'North Port', zip: '34287' },
    ];
    triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'need service at 77 Rental Cove',
    });
    expect(triage.groundedScope).toMatchObject({ address: '77 Rental Cove', city: 'North Port', zip: '34287', isPrimary: false });

    // Sender-phone (unscoped) grounding → no scope to carry.
    mockState.rows['customer_properties as cp'] = [];
    mockLoadCustomerByPhone.mockResolvedValue({
      customer: { id: 'c-1', first_name: 'Taylor', last_name: 'Sample', active: true, pipeline_stage: 'active_customer' },
      ambiguous: false,
    });
    triage = await loadThreadTriageContext({ phone: '+17245550000', triggerBody: 'quote please' });
    expect(triage.groundedCustomerId).toBe('c-1');
    expect(triage.groundedScope).toBeNull();
  });

  test('an EXPLICIT unit never grounds against a unitless row', async () => {
    // sameStreetAddress's default mode calls known-unit == missing-unit
    // equal (conservative for duplicate detection, wrong for grounding):
    // "Apt 6" would have grounded the building-level row and priced it.
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Building', last_name: 'Level', address_line1: '100 Palm Ave', address_line2: null, city: 'Venice' },
    ];
    let triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 100 Palm Ave Apt 6 please',
    });
    expect(triage.matchedExistingCustomer).toBe(false);

    // The SAME unit still grounds.
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Apt', last_name: 'Six', address_line1: '100 Palm Ave', address_line2: 'Apt 6', city: 'Venice' },
    ];
    triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 100 Palm Ave Apt 6 please',
    });
    expect(triage.matchedExistingCustomer).toBe(true);

    // A unit-LESS candidate keeps the conservative behavior.
    mockState.rows.customers = [
      { id: 'c-3', first_name: 'Apt', last_name: 'One', address_line1: '100 Palm Ave', address_line2: 'Apt 1', city: 'Venice' },
    ];
    triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 100 Palm Ave please',
    });
    expect(triage.matchedExistingCustomer).toBe(true);
  });

  test('grounding is anchored to the TRIGGER — burst context never imports an address', async () => {
    // Waves texted the manager about customer A minutes ago; the manager
    // now asks about a DIFFERENT, unmatched property. Grounding to A would
    // link the draft (and A's membership) to a request that never
    // mentioned A.
    mockState.rows.sms_log = [
      {
        message_body: 'Confirmed: visit at 4021 Coral Bay Loop is booked for Friday',
        created_at: new Date().toISOString(),
        direction: 'outbound',
      },
    ];
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Pat', last_name: 'Homeowner', address_line1: '4021 Coral Bay Loop' },
    ];
    const triage = await loadThreadTriageContext({
      phone: '+17245550000',
      triggerBody: 'what would you charge at 200 Oak St?',
    });
    expect(triage.matchedExistingCustomer).toBe(false);
    expect(triage.groundedCustomerId).toBeNull();
  });

  test('burst uniqueness keys on the FULL street — Ave vs St never collapse to one', async () => {
    mockState.rows.sms_log = [
      { message_body: 'visit at 100 Palm Ave Friday', created_at: new Date().toISOString(), direction: 'outbound' },
      { message_body: 'also 100 Palm St Monday', created_at: new Date().toISOString(), direction: 'outbound' },
    ];
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Pat', last_name: 'Homeowner', address_line1: '100 Palm Ave' },
    ];
    let triage = await loadThreadTriageContext({
      phone: '+17245550000',
      triggerBody: 'can you add flea treatment at the same place?',
    });
    expect(triage.matchedExistingCustomer).toBe(false);
    expect(triage.groundedCustomerId).toBeNull();

    // The SAME address twice (different prose tails) is one key and grounds.
    mockState.rows.sms_log = [
      { message_body: 'visit at 100 Palm Ave Friday', created_at: new Date().toISOString(), direction: 'outbound' },
      { message_body: 'reminder about 100 Palm Ave Monday', created_at: new Date().toISOString(), direction: 'outbound' },
    ];
    triage = await loadThreadTriageContext({
      phone: '+17245550000',
      triggerBody: 'can you add flea treatment at the same place?',
    });
    expect(triage.groundedCustomerId).toBe('c-2');
  });

  test('punctuated directionals still ground against the stored long form', async () => {
    mockState.rows.customers = [
      { id: 'c-7', first_name: 'Dir', last_name: 'Ectional', address_line1: '100 North Palm Avenue', city: 'Bradenton' },
    ];
    const triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 100 N. Palm Ave please',
    });
    expect(triage.matchedExistingCustomer).toBe(true);
    expect(triage.lines.join('\n')).toContain('100 North Palm Avenue');
  });

  test('a punctuated unit (Apt. 6) still enforces the exact-unit guard', async () => {
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Building', last_name: 'Level', address_line1: '100 Palm Ave', address_line2: null, city: 'Venice' },
    ];
    let triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 100 Palm Ave Apt. 6 please',
    });
    expect(triage.matchedExistingCustomer).toBe(false);

    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Apt', last_name: 'Six', address_line1: '100 Palm Ave', address_line2: 'Apt 6', city: 'Venice' },
    ];
    triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 100 Palm Ave Apt. 6 please',
    });
    expect(triage.matchedExistingCustomer).toBe(true);
  });

  test('a UNIT scope only counts booked visits stamped with that unit', async () => {
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Apt', last_name: 'Six', address_line1: '100 Palm Ave', address_line2: 'Apt 6', city: 'Venice' },
    ];
    // Unitless legacy visit stamp — must NOT read as Apt 6's booked work.
    mockState.rows.scheduled_services = [
      { service_type: 'Quarterly Pest Control Service', scheduled_date: '2026-08-05', status: 'pending', service_address_line1: '100 Palm Ave' },
    ];
    let triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 100 Palm Ave Apt 6 please',
    });
    expect(triage.lines.join('\n')).not.toContain('booked:');

    // A stamp carrying the SAME unit is booked work.
    mockState.rows.scheduled_services = [
      { service_type: 'Quarterly Pest Control Service', scheduled_date: '2026-08-05', status: 'pending', service_address_line1: '100 Palm Ave', service_address_line2: 'Apt 6' },
    ];
    triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 100 Palm Ave Apt 6 please',
    });
    expect(triage.lines.join('\n')).toContain('booked: Quarterly Pest Control Service 2026-08-05 (pending)');
  });

  test('a POST-DIRECTIONAL street matches only complete variants', async () => {
    // '100 53rd Ave' (truncating the E) would ground the UNRELATED
    // non-directional street; the full compare treats the trailing E as
    // significant and the truncated variant bypassed it.
    const { extractAddressCandidates: extract } = require('../services/estimator-engine/scope-guards');
    const [cand] = extract('quote for 100 53rd Ave E please');
    expect(cand.variants).toContain('100 53rd Ave E');
    expect(cand.variants).not.toContain('100 53rd Ave');

    mockState.rows.customers = [
      { id: 'c-8', first_name: 'Other', last_name: 'Street', address_line1: '100 53rd Ave', city: 'Bradenton' },
    ];
    let triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 100 53rd Ave E please',
    });
    expect(triage.matchedExistingCustomer).toBe(false);

    mockState.rows.customers = [
      { id: 'c-8', first_name: 'East', last_name: 'Street', address_line1: '100 53rd Ave E', city: 'Bradenton' },
    ];
    triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 100 53rd Ave E please',
    });
    expect(triage.matchedExistingCustomer).toBe(true);
  });

  test('abbreviated and spelled-out routes key identically in the burst', async () => {
    mockState.rows.sms_log = [
      { message_body: 'visit at 100 SR 64 Bradenton FL', created_at: new Date().toISOString(), direction: 'outbound' },
      { message_body: 'that is 100 State Road 64, Bradenton FL', created_at: new Date().toISOString(), direction: 'inbound' },
    ];
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Route', last_name: 'Stored', address_line1: '100 SR 64', city: 'Bradenton' },
    ];
    let triage = await loadThreadTriageContext({
      phone: '+17245550000',
      triggerBody: 'can you quote the same place?',
    });
    expect(triage.groundedCustomerId).toBe('c-2');

    // Genuinely different routes stay distinct — no grounding.
    mockState.rows.sms_log = [
      { message_body: 'about 100 SR 64 please', created_at: new Date().toISOString(), direction: 'inbound' },
      { message_body: 'also 100 SR 70 please', created_at: new Date().toISOString(), direction: 'inbound' },
    ];
    triage = await loadThreadTriageContext({
      phone: '+17245550000',
      triggerBody: 'can you quote the same place?',
    });
    expect(triage.groundedCustomerId).toBeNull();
  });

  test('a stated FLOOR enforces the exact-unit guard (Fl 2 never grounds Floor 1\'s row)', async () => {
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Floor', last_name: 'One', address_line1: '100 Palm Ave', address_line2: 'Fl 1', city: 'Venice' },
    ];
    let triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 100 Palm Ave Fl 2 please',
    });
    expect(triage.matchedExistingCustomer).toBe(false);

    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Floor', last_name: 'Two', address_line1: '100 Palm Ave', address_line2: 'Fl 2', city: 'Venice' },
    ];
    triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 100 Palm Ave Fl 2 please',
    });
    expect(triage.matchedExistingCustomer).toBe(true);
  });

  test('route spellings ground each other (State Road 64 ↔ SR 64, US Highway ↔ US)', async () => {
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Route', last_name: 'Stored', address_line1: '123 SR 64', city: 'Bradenton' },
    ];
    let triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 123 State Road 64 please',
    });
    expect(triage.matchedExistingCustomer).toBe(true);

    mockState.rows.customers = [
      { id: 'c-3', first_name: 'Long', last_name: 'Stored', address_line1: '123 State Road 64', city: 'Bradenton' },
    ];
    triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 123 SR 64 please',
    });
    expect(triage.matchedExistingCustomer).toBe(true);

    mockState.rows.customers = [
      { id: 'c-4', first_name: 'Us', last_name: 'Stored', address_line1: '6812 US Highway 41', city: 'Venice' },
    ];
    triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 6812 US 41 please',
    });
    expect(triage.matchedExistingCustomer).toBe(true);
  });

  test('complementary burst texts MERGE — unit and locality both carry', async () => {
    // 'Apt 6' in one text, 'Venice FL 34285' in another: one property; the
    // merged candidate must enforce the unit AND bind the locality.
    mockState.rows.sms_log = [
      { message_body: 'about 100 Palm Ave Apt 6', created_at: new Date().toISOString(), direction: 'inbound' },
      { message_body: 'that is 100 Palm Avenue, Venice FL 34285', created_at: new Date().toISOString(), direction: 'inbound' },
    ];
    // A unitless building-level row: the merged unit must reject it.
    mockState.rows.customers = [
      { id: 'c-9', first_name: 'Building', last_name: 'Level', address_line1: '100 Palm Ave', address_line2: null, city: 'Venice', zip: '34285' },
    ];
    let triage = await loadThreadTriageContext({
      phone: '+17245550000',
      triggerBody: 'can you quote the same place?',
    });
    expect(triage.groundedCustomerId).toBeNull();

    // The Apt 6 row in the stated city grounds.
    mockState.rows.customers = [
      { id: 'c-9', first_name: 'Apt', last_name: 'Six', address_line1: '100 Palm Ave', address_line2: 'Apt 6', city: 'Venice', zip: '34285' },
    ];
    triage = await loadThreadTriageContext({
      phone: '+17245550000',
      triggerBody: 'can you quote the same place?',
    });
    expect(triage.groundedCustomerId).toBe('c-9');
    expect(triage.groundedScope).toMatchObject({ line2: 'Apt 6' });
  });

  test('conflicting units in the burst stay DISTINCT (no grounding)', async () => {
    mockState.rows.sms_log = [
      { message_body: 'about 100 Palm Ave Apt 6', created_at: new Date().toISOString(), direction: 'inbound' },
      { message_body: 'also 100 Palm Ave Apt 7', created_at: new Date().toISOString(), direction: 'inbound' },
    ];
    mockState.rows.customers = [
      { id: 'c-9', first_name: 'Apt', last_name: 'Six', address_line1: '100 Palm Ave', address_line2: 'Apt 6', city: 'Venice' },
    ];
    const triage = await loadThreadTriageContext({
      phone: '+17245550000',
      triggerBody: 'can you quote the same place?',
    });
    expect(triage.groundedCustomerId).toBeNull();
  });

  test('notation variants of ONE address merge for the implicit-reference fallback', async () => {
    // 'Ave, Venice FL 34285' and 'Avenue' are the same property — the raw
    // string keys used to count them as two and withhold grounding.
    mockState.rows.sms_log = [
      { message_body: 'Waves: your visit is booked at 100 Palm Ave, Venice FL 34285', created_at: new Date().toISOString(), direction: 'outbound' },
      { message_body: 'confirming 100 Palm Avenue works', created_at: new Date().toISOString(), direction: 'inbound' },
    ];
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Pat', last_name: 'Homeowner', address_line1: '100 Palm Ave', city: 'Venice', zip: '34285' },
    ];
    const triage = await loadThreadTriageContext({
      phone: '+17245550000',
      triggerBody: 'can you add flea treatment at the same place?',
    });
    expect(triage.groundedCustomerId).toBe('c-2');
  });

  test('a UNIT scope only counts recurring coverage stamped with that unit', async () => {
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Apt', last_name: 'Six', address_line1: '100 Palm Ave', address_line2: 'Apt 6', city: 'Venice' },
    ];
    // Unitless legacy stamp: conservative equality would call Apt 6 covered
    // by the building-level row.
    mockState.rows['scheduled_services:distinct'] = [
      { service_type: 'Quarterly Pest Control Service', service_address_line1: '100 Palm Ave' },
    ];
    let triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 100 Palm Ave Apt 6 please',
    });
    expect(triage.lines.join('\n')).not.toContain('recurring services on file');

    // A stamp carrying the SAME unit is coverage.
    mockState.rows['scheduled_services:distinct'] = [
      { service_type: 'Quarterly Pest Control Service', service_address_line1: '100 Palm Ave', service_address_line2: 'Apt 6' },
    ];
    triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 100 Palm Ave Apt 6 please',
    });
    expect(triage.lines.join('\n')).toContain('recurring services on file: Quarterly Pest Control Service');
  });

  test('a trigger with NO address resolves an implicit reference from a single burst address', async () => {
    mockState.rows.sms_log = [
      {
        message_body: 'Confirmed: visit at 4021 Coral Bay Loop is booked for Friday',
        created_at: new Date().toISOString(),
        direction: 'outbound',
      },
    ];
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Pat', last_name: 'Homeowner', address_line1: '4021 Coral Bay Loop' },
    ];
    let triage = await loadThreadTriageContext({
      phone: '+17245550000',
      triggerBody: 'can you add flea treatment at the same place?',
    });
    expect(triage.groundedCustomerId).toBe('c-2');

    // …but TWO distinct burst addresses leave nothing to resolve to.
    mockState.rows.sms_log = [
      { message_body: 'visit at 4021 Coral Bay Loop Friday', created_at: new Date().toISOString(), direction: 'outbound' },
      { message_body: 'and 900 Other Property Rd Monday', created_at: new Date().toISOString(), direction: 'outbound' },
    ];
    triage = await loadThreadTriageContext({
      phone: '+17245550000',
      triggerBody: 'can you add flea treatment at the same place?',
    });
    expect(triage.groundedCustomerId).toBeNull();
  });

  test('two UNITS of the same customer stay distinct entries and drop groundedScope', async () => {
    // address_line1 alone as the dedup key collapsed Apt 1 and Apt 6 into
    // one arbitrary entry, and the surviving scope priced whichever DB row
    // landed first.
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Multi', last_name: 'Unit', address_line1: '100 Palm Ave', address_line2: 'Apt 1', city: 'Venice' },
      { id: 'c-2', first_name: 'Multi', last_name: 'Unit', address_line1: '100 Palm Ave', address_line2: 'Apt 6', city: 'Venice' },
    ];
    const triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 100 Palm Ave Apt 1, also 100 Palm Ave Apt 6',
    });
    // Both properties still ground for the classifier…
    expect(triage.lines).toHaveLength(2);
    expect(triage.matchedExistingCustomer).toBe(true);
    // …one distinct customer, so the identity still links…
    expect(triage.groundedCustomerId).toBe('c-2');
    expect(triage.groundedConflict).toBe(false);
    // …but there is no single property to price, and that ambiguity is
    // SIGNALLED so the context build red-lanes instead of quietly pricing
    // the primary parcel.
    expect(triage.groundedScope).toBeNull();
    expect(triage.groundedMultiScope).toBe(true);
  });

  test('a single unit still yields exactly one entry and a usable scope', async () => {
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Multi', last_name: 'Unit', address_line1: '100 Palm Ave', address_line2: 'Apt 6', city: 'Venice' },
    ];
    const triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 100 Palm Ave Apt 6 please',
    });
    expect(triage.lines).toHaveLength(1);
    expect(triage.groundedCustomerId).toBe('c-2');
    expect(triage.groundedScope).toMatchObject({ address: '100 Palm Ave', line2: 'Apt 6', isPrimary: true });
    expect(triage.groundedMultiScope).toBe(false);
  });

  test('fails open to null on query errors', async () => {
    mockState.throwOn = 'customers';
    const triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 4021 Coral Bay Loop',
    });
    expect(triage).toBeNull();
  });

  test('a hung query hits the time budget and fails open to null (webhook safety)', async () => {
    mockState.hangOn = 'customers';
    const started = Date.now();
    const triage = await loadThreadTriageContext({
      phone: null,
      triggerBody: 'quote for 4021 Coral Bay Loop',
    });
    expect(triage).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('composer prompt + schema', () => {
  const { _private } = jest.requireActual('../services/estimator-engine/intent-composer');
  const { validateIntent } = jest.requireActual('../services/estimator-engine/intent-schema');

  test('gate off keeps the system prompt byte-identical', () => {
    expect(_private.buildSystemPrompt()).toBe(_private.SYSTEM_PROMPT);
  });

  test('gate on appends the skip-category addendum', () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    const prompt = _private.buildSystemPrompt();
    expect(prompt.startsWith(_private.SYSTEM_PROMPT)).toBe(true);
    expect(prompt).toContain('ADDITIONAL SKIP RULE');
    expect(prompt).toContain('skip_category');
  });

  test('schema accepts skip_category values and rejects unknown ones', () => {
    const base = {
      decision: 'skip', skip_reason: 'out of scope', category: 'RESIDENTIAL',
      is_commercial: false, services: {}, evidence: [], confidence: 'high',
    };
    expect(validateIntent({ ...base, skip_category: 'out_of_scope' }).valid).toBe(true);
    expect(validateIntent({ ...base, skip_category: null }).valid).toBe(true);
    expect(validateIntent(base).valid).toBe(true);
    expect(validateIntent({ ...base, skip_category: 'because' }).valid).toBe(false);
  });
});

describe('clarify suppression in the red lane', () => {
  const { runDraftPipeline } = require('../services/estimator-engine');

  const ORIGIN = {
    channel: 'sms_thread',
    noun: 'text thread',
    threadKey: 'sms:9415550000',
    strings: {
      redTitle: 'RED-TITLE',
      redBody: (label, reasons) => `RED-BODY ${label} (${reasons})`,
      composerFailBody: (label) => `FAIL ${label}`,
      errorBody: 'ERROR',
      blockedTitle: 'BLOCKED-TITLE',
      blockedBody: (label) => `BLOCKED ${label}`,
      proposalTitle: 'PROPOSAL-TITLE',
      proposalBody: (label) => `PROPOSAL-BODY ${label}`,
    },
  };

  const skipIntent = (skipCategory) => ({
    decision: 'skip',
    skip_reason: 'they want power washing',
    ...(skipCategory !== undefined ? { skip_category: skipCategory } : {}),
    customer_name: null,
    customer_phone: null,
    customer_email: null,
    address: null,
    category: 'RESIDENTIAL',
    is_commercial: false,
    services: {},
    evidence: [],
    constraint_flags: [],
    uncertainties: [],
    confidence: 'high',
  });

  const CONTEXT = {
    call: null,
    phone: '+19415550000',
    lead: null,
    leadIsForThisCall: false,
    customer: null,
    customerPhoneAmbiguous: false,
    extraction: {},
    transcript: 'synthetic sms conversation text for the composer',
  };

  const run = () => runDraftPipeline({
    context: { ...CONTEXT },
    origin: ORIGIN,
    result: { lane: null, created: false },
    quotePromised: true,
  });

  beforeEach(() => {
    mockClassifyLane.mockReturnValue({ lane: 'red', reasons: ['composer skipped'], causes: [] });
  });

  test('gate on: scope-based skips keep the bell but never park a clarify ask', async () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    for (const category of ['out_of_scope', 'not_a_quote', 'existing_job']) {
      mockNotifyAdmin.mockClear();
      mockParkClarify.mockClear();
      mockComposeIntent.mockResolvedValue({ intent: skipIntent(category), model: 'test-model' });
      const result = await run();
      expect(result.lane).toBe('red');
      expect(mockNotifyAdmin).toHaveBeenCalled();
      expect(mockParkClarify).not.toHaveBeenCalled();
    }
  });

  test('gate on: ambiguous and needs_human_scoping skips still park', async () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    for (const category of ['ambiguous', 'needs_human_scoping']) {
      mockParkClarify.mockClear();
      mockComposeIntent.mockResolvedValue({ intent: skipIntent(category), model: 'test-model' });
      await run();
      expect(mockParkClarify).toHaveBeenCalled();
    }
  });

  test('gate on: a skip with NO category is unclarifiable (conservative: no customer text)', async () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    mockComposeIntent.mockResolvedValue({ intent: skipIntent(undefined), model: 'test-model' });
    await run();
    expect(mockNotifyAdmin).toHaveBeenCalled();
    expect(mockParkClarify).not.toHaveBeenCalled();
  });

  test('gate off: even a scope-based skip parks exactly as today', async () => {
    mockComposeIntent.mockResolvedValue({ intent: skipIntent('out_of_scope'), model: 'test-model' });
    await run();
    expect(mockParkClarify).toHaveBeenCalled();
  });
});
