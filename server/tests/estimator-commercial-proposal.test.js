/**
 * Commercial/HOA proposal lane (GATE_ESTIMATOR_COMMERCIAL_PROPOSALS).
 *
 * Pins: the double gate (proposal gate AND engine gate, fail-closed), the
 * relationship-red predicate truth table, the NO-DOLLAR contract (any dollar
 * figure in the composed brief rejects the WHOLE brief; the deterministic
 * scaffold carries the lane), the scaffold shape (enabled:false + every line
 * $0 + requiresCustomQuote stamp + NULL price columns + notes ABSENT — the
 * column is customer-visible), the duplicate/open-estimate suppression, the
 * phone-less call-lock recheck, and fail-soft on any error. All fixtures
 * synthetic (public repo — no real customer data).
 */

let mockState;
jest.mock('../models/db', () => {
  const makeBuilder = (table) => {
    const builder = {
      where() { return builder; },
      whereIn() { return builder; },
      whereNull() { return builder; },
      whereRaw(...args) { mockState.whereRaws.push({ table, args }); return builder; },
      orderBy() { return builder; },
      select() { return builder; },
      first: async () => (mockState.firstQueue.length ? mockState.firstQueue.shift() : null),
      insert: (payload) => ({
        returning: async () => {
          if (mockState.insertError) { const e = mockState.insertError; mockState.insertError = null; throw e; }
          mockState.inserts.push({ table, payload });
          return [{ id: 'est-1', token: payload.token }];
        },
      }),
      update: async (payload) => {
        mockState.updates.push({ table, payload });
        return 1;
      },
    };
    return builder;
  };
  const dbMock = jest.fn((table) => makeBuilder(table));
  const trx = Object.assign((table) => makeBuilder(table), {
    raw: async (...args) => { mockState.raws.push(args); return {}; },
  });
  dbMock.transaction = async (callback) => callback(trx);
  dbMock.raw = (...args) => ({ __raw: args });
  return dbMock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockEngineEnabled = jest.fn();
jest.mock('../services/estimator-engine/index', () => ({
  estimatorEngineEnabled: () => mockEngineEnabled(),
}));

const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({
  dispatchWithFallback: (...args) => mockDispatch(...args),
}));

const mockListOpen = jest.fn();
jest.mock('../services/estimate-automation-duplicates', () => ({
  automatedDuplicateBlock: (row) => ({ blocked: true, existingEstimateId: row.id }),
  listOpenEstimatesByPhone: (...args) => mockListOpen(...args),
  phoneLookupValues: (phone) => {
    const digits = String(phone || '').replace(/\D/g, '');
    return { last10: digits.length >= 10 ? digits.slice(-10) : null };
  },
  withAutomatedEstimatePhoneLock: async (_phone, callback) => callback(require('../models/db')),
  blockIfAutomatedEstimateDuplicate: jest.fn(),
  findDuplicateEstimateByPhone: jest.fn(),
  OPEN_ESTIMATE_STATUSES: ['draft', 'sent', 'viewed'],
}));

const {
  commercialProposalsEnabled,
  maybeBuildCommercialProposalDraft,
  _private,
} = require('../services/estimator-engine/commercial-proposal');
const { isCommercialRelationshipRed } = require('../services/estimator-engine/draft-builder');

// ── Fixtures (synthetic) ──────────────────────────────────────
const INTENT = (overrides = {}) => ({
  decision: 'draft',
  customer_name: 'Test Manager',
  customer_phone: '+19410000001',
  address: '500 Example Commons Blvd, Testville, FL 34200',
  category: 'COMMERCIAL',
  is_commercial: true,
  commercial_risk_type: 'standard',
  commercial_subtype: 'hoa',
  services: { pest: { frequency: 'monthly' }, lawn: {} },
  service_interest_label: 'HOA common-area program',
  evidence: [{ decision: 'commercial pest', quote: 'we manage the association', speaker: 'caller' }],
  constraint_flags: [],
  confidence: 'high',
  ...overrides,
});

const CONTEXT = (overrides = {}) => ({
  phone: '+19410000001',
  call: { id: 'call-1', twilio_call_sid: 'CA-test-1' },
  transcript: 'Caller: we manage a 40-unit association and need a full program quote.',
  lead: { id: 'lead-1', email: 'board@example.com', first_name: 'Test' },
  leadIsForThisCall: true,
  customer: null,
  customerPhoneAmbiguous: false,
  ...overrides,
});

const PROPERTY_FACTS = { home: { value: 25000, source: 'county_assessed' }, lot: { value: 200000 } };
const PARCEL_VIEW = { county: 'Manatee', landUseDescription: 'Multifamily condo/HOA association — 40 units, 3 buildings (county aggregate)', lotSqft: 200000, yearBuilt: 1999 };
const PROPERTY_RECORD = { _parcel: { aggregated: true, buildingCount: 3, residentialUnits: 40 } };

const GOOD_BRIEF = () => ({
  summary: 'Forty-unit HOA across three buildings; board seeks combined pest and lawn program.',
  propertyProfile: { propertyType: 'HOA association', footprintSqft: 25000, units: 40, buildings: 3, landUse: 'Multifamily' },
  riskFactors: ['Shared turf complicates lawn treatment scheduling'],
  servicePrograms: [
    { name: 'Common-area pest control', cadence: 'monthly', scope: 'breezeways, clubhouse, trash enclosures' },
    { name: 'Turf program', cadence: 'bimonthly', scope: 'shared lawn areas' },
  ],
  buildings: [
    { name: 'Building A', note: 'two floors' },
    { name: 'Building B', note: null },
    { name: 'Clubhouse', note: 'pool cage adjacent' },
  ],
  walkthroughChecklist: ['Measure clubhouse perimeter'],
  openQuestions: ['Which budget cycle does the board buy in?'],
});

const buildArgs = (overrides = {}) => ({
  intent: INTENT(),
  propertyFacts: PROPERTY_FACTS,
  parcelView: PARCEL_VIEW,
  propertyRecord: PROPERTY_RECORD,
  context: CONTEXT(),
  origin: { channel: 'call', threadKey: null },
  model: 'test-composer',
  reasons: ['commercial building over 10,000 sqft — relationship quote, not an auto-draft'],
  ...overrides,
});

beforeEach(() => {
  mockState = { firstQueue: [], inserts: [], updates: [], raws: [], whereRaws: [], insertError: null };
  mockEngineEnabled.mockReset().mockReturnValue(true);
  mockDispatch.mockReset().mockResolvedValue({ ok: true, json: GOOD_BRIEF(), provider: 'anthropic', model: 'test-model' });
  mockListOpen.mockReset().mockResolvedValue([]);
  process.env.GATE_ESTIMATOR_COMMERCIAL_PROPOSALS = 'true';
});

afterEach(() => {
  delete process.env.GATE_ESTIMATOR_COMMERCIAL_PROPOSALS;
});

// ── Gate ──────────────────────────────────────────────────────
describe('gate', () => {
  test('off when the proposal gate is unset', () => {
    delete process.env.GATE_ESTIMATOR_COMMERCIAL_PROPOSALS;
    expect(commercialProposalsEnabled()).toBe(false);
  });

  test('off when the engine master gate is off (double gate, fail-closed)', () => {
    mockEngineEnabled.mockReturnValue(false);
    expect(commercialProposalsEnabled()).toBe(false);
  });

  test('on only when both gates are on', () => {
    expect(commercialProposalsEnabled()).toBe(true);
  });

  test('gate off ⇒ no draft, no LLM call', async () => {
    delete process.env.GATE_ESTIMATOR_COMMERCIAL_PROPOSALS;
    const outcome = await maybeBuildCommercialProposalDraft(buildArgs());
    expect(outcome).toEqual({ created: false, skipped: 'gate_off' });
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockState.inserts).toHaveLength(0);
  });
});

// ── Relationship-red predicate ────────────────────────────────
describe('isCommercialRelationshipRed', () => {
  test('commercial over the 10k footprint line is the relationship red', () => {
    expect(isCommercialRelationshipRed({ intent: { is_commercial: true }, propertyFacts: { home: { value: 10001 } } })).toBe(true);
  });

  test('exactly 10k is NOT red (strictly over, matching classifyLane)', () => {
    expect(isCommercialRelationshipRed({ intent: { is_commercial: true }, propertyFacts: { home: { value: 10000 } } })).toBe(false);
  });

  test('residential never matches regardless of size', () => {
    expect(isCommercialRelationshipRed({ intent: { is_commercial: false }, propertyFacts: { home: { value: 50000 } } })).toBe(false);
  });

  test('no footprint fact never matches', () => {
    expect(isCommercialRelationshipRed({ intent: { is_commercial: true }, propertyFacts: { home: { value: null } } })).toBe(false);
  });
});

// ── Draft creation ────────────────────────────────────────────
describe('maybeBuildCommercialProposalDraft', () => {
  test('no address ⇒ skipped (clarify lane owns missing-address reds)', async () => {
    const outcome = await maybeBuildCommercialProposalDraft(buildArgs({ intent: INTENT({ address: null }) }));
    expect(outcome).toEqual({ created: false, skipped: 'no_address' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('creates an unpriced COMMERCIAL draft with brief + disabled scaffold', async () => {
    const outcome = await maybeBuildCommercialProposalDraft(buildArgs());
    expect(outcome.created).toBe(true);
    expect(outcome.estimateId).toBe('est-1');
    expect(outcome.briefComposed).toBe(true);

    expect(mockState.inserts).toHaveLength(1);
    const { table, payload } = mockState.inserts[0];
    expect(table).toBe('estimates');
    expect(payload.category).toBe('COMMERCIAL');
    expect(payload.source).toBe('estimator_engine');
    expect(payload.status).toBe('draft');
    expect(payload.token).toMatch(/^[0-9a-f]{32}$/);
    // NULL never 0 — the price columns must be ABSENT from the insert.
    expect(payload).not.toHaveProperty('monthly_total');
    expect(payload).not.toHaveProperty('annual_total');
    expect(payload).not.toHaveProperty('onetime_total');
    // estimates.notes is CUSTOMER-VISIBLE — never written by this lane.
    expect(payload).not.toHaveProperty('notes');

    const data = JSON.parse(payload.estimate_data);
    expect(data.requiresCustomQuote).toBe(true);
    expect(data.commercialProspect.summary).toContain('Forty-unit');
    expect(data.commercialProspect.researchedAt).toBeTruthy();
    expect(data.estimatorEngine.commercialProposal).toBe(true);
    expect(data.estimatorEngine.lane).toBe('red');
    expect(data.estimatorEngine.callLogId).toBe('call-1');
    expect(data.lead_id).toBe('lead-1');

    const proposal = data.proposal;
    expect(proposal.enabled).toBe(false);
    expect(proposal.synthesized).toBe(false);
    expect(proposal.scaffold).toBe(true);
    expect(proposal.buildings.map((b) => b.name)).toEqual(['Building A', 'Building B', 'Clubhouse']);
    for (const b of proposal.buildings) {
      expect(b.lineItems.length).toBeGreaterThan(0);
      for (const li of b.lineItems) expect(li.unitPrice).toBe(0);
    }

    // Lead linked post-commit.
    expect(mockState.updates).toContainEqual({ table: 'leads', payload: { estimate_id: 'est-1' } });
  });

  test('a phone-matched customer profile is NEVER pre-linked (proposal-win owns profile creation)', async () => {
    const outcome = await maybeBuildCommercialProposalDraft(buildArgs({
      context: CONTEXT({ customer: { id: 'cust-existing', email: 'res@example.com' }, customerPhoneAmbiguous: false }),
    }));
    expect(outcome.created).toBe(true);
    // Contact info may ride along, but the FK stays null — the win path
    // creates the separate commercial profile only when customer_id is
    // absent, and a phone-matched residential account must not be
    // promoted/invoiced in its place.
    expect(mockState.inserts[0].payload.customer_id).toBeNull();
  });

  test('an open estimate suppresses the scaffold BEFORE the brief LLM spend', async () => {
    mockListOpen.mockResolvedValue([{ id: 'open-1', address: '500 Example Commons Blvd, Testville, FL 34200' }]);
    const outcome = await maybeBuildCommercialProposalDraft(buildArgs());
    expect(outcome).toMatchObject({ created: false, blocked: true, existingEstimateId: 'open-1' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('one-time intent keys scaffold as one_time lines, never monthly', async () => {
    mockDispatch.mockResolvedValue({ ok: false, failures: [] });
    await maybeBuildCommercialProposalDraft(buildArgs({
      intent: INTENT({ services: { pest: { frequency: 'monthly' }, lawnPestControl: {}, oneTimeMosquito: {} } }),
    }));
    const data = JSON.parse(mockState.inserts[0].payload.estimate_data);
    const byDesc = Object.fromEntries(data.proposal.buildings[0].lineItems.map((li) => [li.description, li.frequency]));
    expect(byDesc['Pest control program — scope and pricing after walkthrough']).toBe('monthly');
    expect(byDesc['Lawn insect knockdown — scope and pricing after walkthrough']).toBe('one_time');
    expect(byDesc['One-time mosquito treatment — scope and pricing after walkthrough']).toBe('one_time');
  });

  test('a dollar figure ANYWHERE in the brief rejects the whole brief (scaffold survives)', async () => {
    const priced = GOOD_BRIEF();
    priced.servicePrograms[0].scope = 'around $1,200 per month for the breezeways';
    mockDispatch.mockResolvedValue({ ok: true, json: priced, provider: 'anthropic', model: 'test-model' });

    const outcome = await maybeBuildCommercialProposalDraft(buildArgs());
    expect(outcome.created).toBe(true);
    expect(outcome.briefComposed).toBe(false);
    const data = JSON.parse(mockState.inserts[0].payload.estimate_data);
    expect(data).not.toHaveProperty('commercialProspect');
    // Deterministic scaffold: one line per requested service, still $0.
    const descriptions = data.proposal.buildings[0].lineItems.map((li) => li.description);
    expect(descriptions.some((d) => d.startsWith('Pest control program'))).toBe(true);
    expect(descriptions.some((d) => d.startsWith('Lawn care program'))).toBe(true);
  });

  test('LLM failure is fail-soft: draft still created without a brief', async () => {
    mockDispatch.mockRejectedValue(new Error('providers down'));
    const outcome = await maybeBuildCommercialProposalDraft(buildArgs());
    expect(outcome.created).toBe(true);
    expect(outcome.briefComposed).toBe(false);
    expect(mockState.inserts).toHaveLength(1);
  });

  test('brief-less scaffold falls back to aggregate building count', async () => {
    mockDispatch.mockResolvedValue({ ok: false, failures: [] });
    await maybeBuildCommercialProposalDraft(buildArgs());
    const data = JSON.parse(mockState.inserts[0].payload.estimate_data);
    expect(data.proposal.buildings).toHaveLength(3);
    expect(data.proposal.buildings[0].name).toBe('Building 1');
  });

  test('open estimate on the phone for the same property suppresses the scaffold', async () => {
    mockListOpen.mockResolvedValue([{ id: 'open-1', address: '500 Example Commons Blvd, Testville, FL 34200' }]);
    const outcome = await maybeBuildCommercialProposalDraft(buildArgs());
    expect(outcome).toMatchObject({ created: false, blocked: true, existingEstimateId: 'open-1' });
    expect(mockState.inserts).toHaveLength(0);
  });

  test('phone-less prospect: call-scoped lock recheck suppresses a concurrent duplicate', async () => {
    const args = buildArgs({
      intent: INTENT({ customer_phone: null }),
      context: CONTEXT({ phone: null }),
    });
    mockState.firstQueue.push({ id: 'existing-est' }); // in-lock recheck hit
    const outcome = await maybeBuildCommercialProposalDraft(args);
    expect(outcome).toMatchObject({ created: false, blocked: true, existingEstimateId: 'existing-est' });
    expect(mockState.inserts).toHaveLength(0);
    // The call-scoped advisory lock was taken.
    expect(mockState.raws.some((r) => String(r[0]).includes('pg_advisory_xact_lock'))).toBe(true);
  });

  test('insert failure is fail-soft (red bell takes over)', async () => {
    mockState.insertError = new Error('insert exploded');
    const outcome = await maybeBuildCommercialProposalDraft(buildArgs());
    expect(outcome).toEqual({ created: false, skipped: 'error' });
  });
});

// ── Brief validation ──────────────────────────────────────────
describe('brief contract', () => {
  const { validateBrief, DOLLAR_FIGURE_RE } = _private;

  test('accepts a compliant brief', () => {
    expect(validateBrief(GOOD_BRIEF())).toBeNull();
  });

  test('rejects non-objects, missing summary, missing programs', () => {
    expect(validateBrief(null)).toBe('not_object');
    expect(validateBrief([])).toBe('not_object');
    expect(validateBrief({ servicePrograms: [] })).toBe('no_summary');
    expect(validateBrief({ summary: 'x' })).toBe('no_service_programs');
  });

  test('rejects dollar figures in any field', () => {
    const b = GOOD_BRIEF();
    b.openQuestions.push('Is $99 setup acceptable?');
    expect(validateBrief(b)).toBe('contains_dollar_figure');
  });

  test('dollar regex catches spelled and shorthand variants but not bare numbers', () => {
    expect(DOLLAR_FIGURE_RE.test('costs 1200 dollars')).toBe(true);
    expect(DOLLAR_FIGURE_RE.test('about 350 USD annually')).toBe(true);
    expect(DOLLAR_FIGURE_RE.test('$ 45')).toBe(true);
    // Shorthand prices carry no currency marker but are still prices —
    // brief text is copied into customer-facing line descriptions.
    expect(DOLLAR_FIGURE_RE.test('around 1200/mo for the breezeways')).toBe(true);
    expect(DOLLAR_FIGURE_RE.test('roughly 1,200 per month')).toBe(true);
    expect(DOLLAR_FIGURE_RE.test('350 per visit')).toBe(true);
    expect(DOLLAR_FIGURE_RE.test('40 units across 3 buildings built in 1999')).toBe(false);
    expect(DOLLAR_FIGURE_RE.test('25,000 sqft footprint, 12 visits a year included')).toBe(false);
  });
});

// ── Scaffold shape ────────────────────────────────────────────
describe('buildProposalScaffold', () => {
  const { buildProposalScaffold, parcelFacts } = _private;
  const facts = parcelFacts(PROPERTY_RECORD, PARCEL_VIEW);

  test('brief buildings win over the aggregate count', () => {
    const scaffold = buildProposalScaffold({ intent: INTENT(), brief: { buildings: [{ name: 'Tower', note: null }], servicePrograms: [] }, facts });
    expect(scaffold.buildings.map((b) => b.name)).toEqual(['Tower']);
  });

  test('no brief + no aggregate ⇒ single building named after the address', () => {
    const scaffold = buildProposalScaffold({
      intent: INTENT(),
      brief: null,
      facts: parcelFacts(null, null),
    });
    expect(scaffold.buildings).toHaveLength(1);
    expect(scaffold.buildings[0].name).toBe(INTENT().address);
  });

  test('no services at all still yields one generic $0 program line', () => {
    const scaffold = buildProposalScaffold({
      intent: INTENT({ services: {} }),
      brief: null,
      facts: parcelFacts(null, null),
    });
    const lines = scaffold.buildings[0].lineItems;
    expect(lines).toHaveLength(1);
    expect(lines[0].unitPrice).toBe(0);
    expect(lines[0].description).toContain('Commercial service program');
  });

  test('brief program cadence normalizes into proposal frequencies', () => {
    const scaffold = buildProposalScaffold({
      intent: INTENT(),
      brief: { buildings: [], servicePrograms: [{ name: 'Turf', cadence: 'every other month', scope: 'shared lawns' }] },
      facts,
    });
    expect(scaffold.buildings[0].lineItems[0].frequency).toBe('bimonthly');
  });

  test('scaffold is disabled, non-synthesized, and marked', () => {
    const scaffold = buildProposalScaffold({ intent: INTENT(), brief: null, facts });
    expect(scaffold.enabled).toBe(false);
    expect(scaffold.synthesized).toBe(false);
    expect(scaffold.scaffold).toBe(true);
  });
});
