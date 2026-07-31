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
      whereNotIn() { return chain; },
      whereRaw() { return chain; },
      orderBy() { return chain; },
      limit() { return chain; },
      join() { return chain; },
      modify(fn) { fn(chain); return chain; },
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
    expect(deterministicOutOfScope('this is Handyman Hardware confirming your service quote')).toBe(false);
    expect(deterministicOutOfScope('quote for the Drywall Bros office please')).toBe(false);
    // …while real trade requests still veto.
    expect(deterministicOutOfScope('need a handyman for the fence')).toBe(true);
    expect(deterministicOutOfScope('hvac repair quote please')).toBe(true);
    expect(deterministicOutOfScope('drywall repair estimate?')).toBe(true);
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

  test('captures explicit locality after a comma', () => {
    const [cand] = extractAddressCandidates('quote for 100 Palm Ave, Venice FL 34285 please');
    expect(cand.locality).toBe(', Venice 34285');
    expect(extractAddressCandidates('quote for 100 Palm Ave before Saturday')[0].locality).toBe('');
  });

  test('prefixVariants expands directional and suffix aliases both ways', () => {
    const { _private } = require('../services/estimator-engine/scope-guards');
    expect(_private.prefixVariants('100', 'N')).toEqual(expect.arrayContaining(['100 N%', '100 north%']));
    expect(_private.prefixVariants('100', 'North')).toEqual(expect.arrayContaining(['100 North%', '100 n%']));
    expect(_private.prefixVariants('100', 'Palm')).toEqual(['100 Palm%']);
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

  test('grounds against addresses named in RECENT texts, not just the trigger body', async () => {
    mockState.rows.sms_log = [
      { message_body: 'Hi, this is the coordinator for Pat Homeowner at 4021 Coral Bay Loop' },
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

  test('sender match and a scoped address match for the SAME customer both ground', async () => {
    mockLoadCustomerByPhone.mockResolvedValue({
      customer: { id: 'c-2', first_name: 'Multi', last_name: 'Property', address_line1: '1 Primary St', active: true, pipeline_stage: 'active_customer' },
      ambiguous: false,
    });
    mockState.rows.customers = [
      { id: 'c-2', first_name: 'Multi', last_name: 'Property', address_line1: '4021 Coral Bay Loop' },
    ];
    const triage = await loadThreadTriageContext({
      phone: '+17245550000',
      triggerBody: 'about 4021 Coral Bay Loop please',
    });
    expect(triage.lines).toHaveLength(2);
    expect(triage.lines[0]).toContain('Sender phone matches');
    expect(triage.lines[1]).toContain('4021 Coral Bay Loop');
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
