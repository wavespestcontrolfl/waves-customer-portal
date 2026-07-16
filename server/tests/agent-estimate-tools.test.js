const mockDb = jest.fn();
mockDb.transaction = jest.fn();
mockDb.fn = { now: jest.fn(() => 'db-now') };

let mockTransactionDb;
const mockGenerateEstimate = jest.fn();
const mockDuplicateBlock = jest.fn();
const mockWithPhoneLock = jest.fn(async (_phone, callback) => callback(mockTransactionDb));
const mockBuildAgentEstimateContext = jest.fn(async () => ({
  is_existing_customer: false,
  quote_form: { message_fields: [{ field: 'message', text: 'quarterly pest' }] },
  calls: [],
  sms_thread: [],
  activities: [],
}));
const mockComputeMembershipContext = jest.fn(async () => null);
const mockLoadCurrentServiceSpendContext = jest.fn(async () => ({
  existingServiceKeys: [], currentServices: [], currentSpendPerVisitTotal: 0,
}));

jest.mock('../models/db', () => mockDb);
jest.mock('../services/pricing-engine', () => ({
  generateEstimate: (...args) => mockGenerateEstimate(...args),
  needsSync: jest.fn(() => false),
  syncConstantsFromDB: jest.fn(async () => true),
}));
jest.mock('../services/estimator-engine/draft-builder', () => ({
  deriveTotals: (engineResult) => ({
    monthly: Number(engineResult?.summary?.recurringMonthlyAfterDiscount || 0),
    annual: Number(engineResult?.summary?.recurringAnnualAfterDiscount || 0),
    oneTime: Number(engineResult?.summary?.oneTimeTotal || 0),
  }),
}));
jest.mock('../services/estimate-automation-duplicates', () => ({
  blockIfAutomatedEstimateDuplicate: (...args) => mockDuplicateBlock(...args),
  withAutomatedEstimatePhoneLock: (...args) => mockWithPhoneLock(...args),
}));
jest.mock('../services/agent-estimate-context', () => ({
  buildAgentEstimateContext: (...args) => mockBuildAgentEstimateContext(...args),
}));
jest.mock('../services/estimate-membership-context', () => ({
  computeMembershipContext: (...args) => mockComputeMembershipContext(...args),
  loadCurrentServiceSpendContext: (...args) => mockLoadCurrentServiceSpendContext(...args),
}));
jest.mock('../routes/property-lookup-v2', () => ({ performPropertyLookup: jest.fn() }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (url) => url) }));

const { executeEstimateTool, _private } = require('../services/intelligence-bar/estimate-tools');
const { performPropertyLookup } = require('../routes/property-lookup-v2');

const ENGINE_RESULT = {
  summary: {
    recurringMonthlyAfterDiscount: 54.17,
    recurringAnnualAfterDiscount: 650,
    oneTimeTotal: 0,
  },
  waveGuard: { tier: 'bronze' },
  lineItems: [{
    service: 'pest_control',
    annualAfterDiscount: 650,
    monthlyAfterDiscount: 54.17,
    costs: { annualCost: 420 },
    pricingConfidence: 'high',
  }],
};

const LAWN_TREE_ENGINE_RESULT = {
  summary: {
    recurringMonthlyAfterDiscount: 145,
    recurringAnnualAfterDiscount: 1740,
    oneTimeTotal: 0,
  },
  waveGuard: { tier: 'gold' },
  lineItems: [
    {
      service: 'lawn_care', annualAfterDiscount: 900, monthlyAfterDiscount: 75,
      costs: { annualCost: 540 }, pricingConfidence: 'high',
    },
    {
      service: 'tree_shrub', annualAfterDiscount: 840, monthlyAfterDiscount: 70,
      costs: { annualCost: 500 }, pricingConfidence: 'high',
    },
  ],
};

const INPUT = {
  leadId: 'lead-1',
  customerName: 'Road Tester',
  customerPhone: '9415550100',
  customerEmail: 'road@example.com',
  address: '1 Test St, Bradenton FL 34208',
  engineInputs: {
    homeSqFt: 2000,
    lotSqFt: 8000,
    lotSizeMeasured: true,
    services: { pest: { frequency: 'quarterly' } },
  },
  reasoning: 'Transcript and quote form both request quarterly pest service.',
  assumptions: [],
  uncertainty: [],
  evidence: [{ source: 'quote_form', quote: 'quarterly pest', decision: 'pest frequency' }],
  propertyFacts: {
    address: { value: '1 Test St, Bradenton FL 34208', source: 'lead', confidence: 'high' },
    homeSqFt: { value: 2000, source: 'county', confidence: 'high' },
  },
  protocolReview: [{ serviceKey: 'pest', programKey: 'pest', visitCount: 4 }],
  inventoryReview: [{ serviceKey: 'pest', productName: 'Pest protocol products', status: 'in_stock', onHand: 8 }],
};

function thenable(value) {
  return {
    returning: async () => value,
    then: (resolve) => resolve(Array.isArray(value) ? value.length : value),
  };
}

function makeDatabase({
  // Default lead carries the contact INPUT expects — the anchor now uses the
  // lead as the only recipient authority, so a bare lead would null them out.
  lead = { id: 'lead-1', customer_id: null, estimate_id: null, phone: '9415550100', email: 'road@example.com' },
  customer = null,
  estimate = null,
  estimateRows = null,
  turfRows = [],
} = {}) {
  const writes = [];
  const database = (table) => {
    const builder = {
      where: () => builder,
      whereNull: () => builder,
      whereNot: () => builder,
      whereIn: () => builder,
      whereNotIn: () => builder,
      whereRaw: () => builder,
      leftJoin: () => builder,
      select: () => builder,
      limit: () => builder,
      forUpdate: () => builder,
      first: async () => {
        if (table === 'leads') return lead;
        if (table === 'customers') return customer;
        if (table === 'estimates') return estimate;
        return null;
      },
      insert: (payload) => {
        writes.push({ table, op: 'insert', payload });
        if (table === 'estimates') return thenable([{ id: 'estimate-1', token: 'token-1' }]);
        return thenable([{ id: 'row-1', ...payload }]);
      },
      update: (payload) => {
        writes.push({ table, op: 'update', payload });
        if (table === 'estimates') return thenable([{ id: estimate?.id || 'estimate-1', token: estimate?.token || 'token-1' }]);
        return thenable(1);
      },
      then: (resolve) => resolve(
        table === 'customers as c' ? turfRows
          : table === 'estimates' ? (estimateRows ?? (estimate ? [estimate] : []))
            : [],
      ),
    };
    return builder;
  };
  database.fn = mockDb.fn;
  return { database, writes };
}

describe('Agent Estimate draft tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateEstimate.mockReturnValue(ENGINE_RESULT);
    mockDuplicateBlock.mockResolvedValue(null);
  });

  test('model-supplied confirmed is ignored and returns a margin-aware preview', async () => {
    const { database, writes } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', { ...INPUT, confirmed: true });

    expect(result.preview).toBe(true);
    expect(result.pending_confirmation).toBe(true);
    expect(result.lines[0]).toEqual(expect.objectContaining({
      estimated_annual_cost: 420,
      collected_margin: 0.354,
      margin_floor_ok: true,
    }));
    expect(writes).toEqual([]);
  });

  test('keeps the lane yellow when evidence, property, protocol, or inventory checks are missing', async () => {
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      evidence: [],
      propertyFacts: {},
      protocolReview: [],
      inventoryReview: [],
    });

    expect(result.lane).toBe('yellow');
    expect(result.lane_reasons).toEqual(expect.arrayContaining([
      expect.stringMatching(/source evidence/i),
      expect.stringMatching(/property facts/i),
      expect.stringMatching(/complete protocols/i),
      expect.stringMatching(/inventory/i),
    ]));
  });

  test('marks a draft for review when a model-presented quote is not in the selected lead evidence', async () => {
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      evidence: [{ source: 'quote_form', quote: 'fabricated customer statement', decision: 'pest frequency' }],
    });

    expect(result.lane).toBe('yellow');
    expect(result.lane_reasons).toContain('1 evidence quote(s) could not be verified against the selected lead');
  });

  test('computes one-time collected margin when the engine exposes a cost basis', () => {
    expect(_private.compactAgentLine({
      service: 'trenching',
      price: 1000,
      costs: { total: 600 },
    })).toEqual(expect.objectContaining({
      one_time: 1000,
      estimated_cost: 600,
      collected_margin: 0.4,
      margin_floor_ok: true,
    }));
  });

  test('server-confirmed creation re-prices and stores one pricing truth with internal-only reasoning', async () => {
    const { database, writes } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', INPUT, {
      confirmed: true,
      technicianId: 'tech-1',
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      estimate_id: 'estimate-1',
      token: 'token-1',
      monthly_total: 54.17,
      annual_total: 650,
    }));
    expect(mockGenerateEstimate).toHaveBeenCalledWith(INPUT.engineInputs);
    const insert = writes.find((write) => write.table === 'estimates' && write.op === 'insert').payload;
    expect(insert.source).toBe('estimator_engine');
    expect(insert.status).toBe('draft');
    expect(insert.notes).toBeNull();
    expect(insert.created_by_technician_id).toBe('tech-1');

    const stored = JSON.parse(insert.estimate_data);
    expect(Object.keys(stored).sort()).toEqual([
      'agentDraft', 'engineInputs', 'engineResult', 'estimatorEngine', 'lead_id',
    ].sort());
    expect(stored.engineInputs).toEqual(INPUT.engineInputs);
    expect(stored.engineResult).toEqual(ENGINE_RESULT);
    expect(stored).not.toHaveProperty('result');
    expect(stored.estimatorEngine).toEqual(expect.objectContaining({
      origin: 'manual_agent',
      pricingAuthority: 'generateEstimate',
      loadedLaborRate: 35,
      targetCollectedMargin: 0.35,
      reasoning: INPUT.reasoning,
      evidenceVerification: expect.objectContaining({ quoted: 1, verified: 1, unverified: 0 }),
    }));
    expect(writes).toContainEqual(expect.objectContaining({ table: 'leads', op: 'update' }));
  });

  test('revises only its owned draft in place and bounds history to five revisions', async () => {
    const existing = {
      id: 'estimate-old',
      token: 'same-token',
      status: 'draft',
      source: 'estimator_engine',
      estimate_data: JSON.stringify({
        engineInputs: { homeSqFt: 1800, services: { pest: { frequency: 'quarterly' } } },
        engineResult: ENGINE_RESULT,
        estimatorEngine: {
          origin: 'manual_agent',
          reasoning: 'old basis',
          revisions: Array.from({ length: 5 }, (_, index) => ({ revision: index + 1 })),
        },
      }),
    };
    const { database, writes } = makeDatabase({ estimate: existing });
    mockDb.mockImplementation(database);
    mockDb.transaction.mockImplementation(async (callback) => callback(database));

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      estimateId: existing.id,
    }, { confirmed: true, technicianId: 'tech-1' });

    expect(result.success).toBe(true);
    expect(result.revised).toBe(true);
    expect(result.estimate_id).toBe(existing.id);
    expect(result.token).toBe(existing.token);
    const update = writes.find((write) => write.table === 'estimates' && write.op === 'update').payload;
    const stored = JSON.parse(update.estimate_data);
    expect(stored.estimatorEngine.revisions).toHaveLength(5);
    expect(stored.estimatorEngine.revisions.at(-1)).toEqual(expect.objectContaining({
      reasoning: 'old basis',
    }));
    expect(update.notes).toBeNull();
  });

  test('David-style existing-customer expansion preserves current pest and prices only lawn plus tree-shrub', async () => {
    const { database, writes } = makeDatabase({
      lead: { id: 'lead-1', customer_id: 'customer-1', estimate_id: null, phone: '9415550100', email: 'road@example.com' },
      customer: { id: 'customer-1', pipeline_stage: 'active' },
    });
    mockDb.mockImplementation(database);
    mockTransactionDb = database;
    mockBuildAgentEstimateContext.mockResolvedValueOnce({
      is_existing_customer: true,
      customer_account: {
        recognized: true,
        customer_id: 'customer-1',
        active_plan: true,
        current_tier: 'Bronze',
        current_discount_pct: 0,
        existing_service_keys: ['pest_control'],
        current_services: [{
          key: 'pest_control', label: 'Pest Control', currentPerVisit: 117, spendSource: 'last_paid_invoice',
        }],
        current_spend_per_visit_total: 117,
      },
      quote_form: { message_fields: [{ field: 'message', text: 'add lawn and tree shrub; Oasis currently charges $65/month for lawn' }] },
      calls: [{
        id: 'david-call',
        transcript: 'I want a monthly 12-month lawn program and tree and shrub treatment for the hibiscus, front beds, and palms. Please bundle the services.',
      }],
      sms_thread: [], activities: [],
    });
    mockComputeMembershipContext.mockResolvedValueOnce({
      isExistingCustomer: true,
      existingServiceKeys: ['pest_control'],
      discountAppliesTo: 'new_services_only',
      currentServices: [{ key: 'pest_control', currentPerVisit: 117 }],
      existingServices: [],
      newServices: [{ key: 'lawn_care' }, { key: 'tree_shrub' }],
    });
    mockGenerateEstimate.mockReturnValueOnce(LAWN_TREE_ENGINE_RESULT);

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: {
        ...INPUT.engineInputs,
        services: {
          lawn: { track: 'st_augustine', lawnFreq: 9 },
          treeShrub: { tier: 'standard' },
        },
      },
      evidence: [{ source: 'call_transcript', quote: 'monthly 12-month lawn program and tree and shrub treatment', decision: 'new services' }],
    }, { confirmed: true });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      presentation_template: 'multi_service_bundle',
      service_template_keys: ['lawn_care', 'tree_shrub'],
    }));
    expect(mockGenerateEstimate).toHaveBeenCalledWith(expect.objectContaining({
      priorQualifyingServices: ['pest_control'],
      services: expect.objectContaining({ lawn: expect.any(Object), treeShrub: expect.any(Object) }),
    }));
    const pricedInput = mockGenerateEstimate.mock.calls.at(-1)[0];
    expect(pricedInput.services).not.toHaveProperty('pest');
    const insert = writes.find((write) => write.table === 'estimates' && write.op === 'insert').payload;
    expect(insert.customer_id).toBe('customer-1');
    const stored = JSON.parse(insert.estimate_data);
    expect(stored.priorQualifyingServices).toEqual(['pest_control']);
    expect(stored.membershipSnapshot).toEqual(expect.objectContaining({
      isExistingCustomer: true,
      discountAppliesTo: 'new_services_only',
      currentServices: [expect.objectContaining({ key: 'pest_control', currentPerVisit: 117 })],
      existingServices: [],
    }));
    expect(stored.estimatorEngine).toEqual(expect.objectContaining({
      existingCustomerExpansion: true,
      presentationTemplate: 'multi_service_bundle',
      serviceTemplateKeys: ['lawn_care', 'tree_shrub'],
    }));
  });

  test('a phone-matched customer is linked to the estimate without mutating model pricing inputs', async () => {
    const { database, writes } = makeDatabase({ lead: { id: 'lead-1', customer_id: null, estimate_id: null, phone: '9415550100', email: 'road@example.com' } });
    mockDb.mockImplementation(database);
    mockTransactionDb = database;
    mockBuildAgentEstimateContext.mockResolvedValueOnce({
      is_existing_customer: true,
      customer_account: {
        recognized: true,
        customer_id: 'customer-phone-match',
        existing_service_keys: [],
        current_services: [],
      },
      quote_form: { message_fields: [] }, calls: [], sms_thread: [], activities: [],
    });

    const result = await executeEstimateTool('create_agent_estimate_draft', INPUT, { confirmed: true });

    expect(result.success).toBe(true);
    expect(mockGenerateEstimate).toHaveBeenCalledWith(INPUT.engineInputs);
    expect(writes.find((write) => write.table === 'estimates').payload.customer_id).toBe('customer-phone-match');
  });

  test('rejects contact details that do not belong to the selected lead', async () => {
    const { database, writes } = makeDatabase({
      lead: {
        id: 'lead-1', customer_id: null, estimate_id: null,
        first_name: 'Right', last_name: 'Lead', phone: '9415550100', email: 'right@example.com',
      },
    });
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      customerPhone: '9415559999',
    }, { confirmed: true });

    expect(result.error).toMatch(/phone does not match/i);
    expect(mockGenerateEstimate).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  test('allows an evidence-backed address correction only as a yellow review draft', async () => {
    const { database } = makeDatabase({
      lead: {
        id: 'lead-1', customer_id: null, estimate_id: null,
        address: '1 Original St', city: 'Bradenton', zip: '34208',
      },
    });
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      address: '99 Corrected Ave, Bradenton FL 34209',
      propertyFacts: {
        ...INPUT.propertyFacts,
        address: { value: '99 Corrected Ave, Bradenton FL 34209', source: 'customer_sms', confidence: 'high' },
      },
    });

    expect(result.lane).toBe('yellow');
    expect(result.lane_reasons).toContain('draft service address differs from the selected lead address');
  });

  test('will not revise an Agent Estimate draft that belongs to another lead', async () => {
    const existing = {
      id: 'estimate-other',
      token: 'other-token',
      status: 'draft',
      source: 'estimator_engine',
      estimate_data: JSON.stringify({
        lead_id: 'lead-2',
        engineInputs: INPUT.engineInputs,
        engineResult: ENGINE_RESULT,
        estimatorEngine: { origin: 'manual_agent' },
      }),
    };
    const { database, writes } = makeDatabase({ estimate: existing });
    mockDb.mockImplementation(database);
    mockDb.transaction.mockImplementation(async (callback) => callback(database));

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      estimateId: existing.id,
    }, { confirmed: true });

    expect(result.error).toMatch(/different lead/i);
    expect(writes).toEqual([]);
  });
});

describe('Agent Estimate property lookup safety', () => {
  test('returns analyzed satellite availability without exposing signed provider image URLs', async () => {
    performPropertyLookup.mockResolvedValue({
      propertyRecord: {
        formattedAddress: '1 Test St, Bradenton FL 34208',
        squareFootage: 2000,
        lotSize: 8000,
        _source: 'county',
      },
      satellite: {
        lat: 27.5,
        lng: -82.5,
        inServiceArea: true,
        closeUrl: 'https://maps.googleapis.com/maps/api/staticmap?key=secret-key',
        microCloseUrl: 'https://maps.googleapis.com/maps/api/staticmap?key=secret-key-2',
      },
      aiAnalysis: { _sources: ['claude'] },
      enriched: { treatableLawnSqFt: 4200 },
    });

    const result = await executeEstimateTool('lookup_property', { address: '1 Test St' });

    expect(result.satellite).toEqual(expect.objectContaining({ imageAvailable: true, inServiceArea: true }));
    expect(result.enriched).toEqual({ treatableLawnSqFt: 4200 });
    expect(JSON.stringify(result)).not.toMatch(/secret-key|staticmap|imageUrl|microCloseUrl/);
  });
});

describe('Agent Estimate compute input boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateEstimate.mockReturnValue(ENGINE_RESULT);
  });

  test('passes verified treatable turf and commercial building measurements into the pricing engine', async () => {
    const result = await executeEstimateTool('compute_estimate', {
      buildingSqFt: 48000,
      buildingSizeMeasured: true,
      lotSqFt: 90000,
      measuredTurfSf: 12000,
      turfSource: 'operator_confirmed',
      propertyType: 'Commercial',
      isCommercial: true,
      services: { lawn: { track: 'st_augustine', lawnFreq: 9 } },
    });

    expect(result.error).toBeUndefined();
    expect(mockGenerateEstimate).toHaveBeenCalledWith(expect.objectContaining({
      homeSqFt: 48000,
      buildingSqFt: 48000,
      buildingSizeMeasured: true,
      lotSqFt: 90000,
      lotSizeMeasured: true,
      measuredTurfSf: 12000,
      turfSource: 'operator_confirmed',
      isCommercial: true,
    }));
  });

  test('loads recognized-customer membership inputs server-side and selects service presentation', async () => {
    mockBuildAgentEstimateContext.mockResolvedValueOnce({
      customer_account: {
        recognized: true,
        customer_id: 'customer-1',
        existing_service_keys: ['pest_control'],
        current_services: [{ key: 'pest_control', currentPerVisit: 117 }],
      },
    });
    mockGenerateEstimate.mockReturnValueOnce(LAWN_TREE_ENGINE_RESULT);

    const result = await executeEstimateTool('compute_estimate', {
      leadId: 'lead-1',
      homeSqFt: 2000,
      measuredTurfSf: 4500,
      services: {
        lawn: { track: 'st_augustine', lawnFreq: 9 },
        treeShrub: { tier: 'standard' },
      },
    });

    expect(mockGenerateEstimate).toHaveBeenCalledWith(expect.objectContaining({
      priorQualifyingServices: ['pest_control'],
    }));
    expect(result.engine_input).not.toHaveProperty('priorQualifyingServices');
    expect(result.customer_account).toEqual(expect.objectContaining({ customer_id: 'customer-1' }));
    expect(result.presentation).toEqual({
      template: 'multi_service_bundle',
      serviceTemplateKeys: ['lawn_care', 'tree_shrub'],
      reactPage: 'estimate_v2',
      mode: 'recurring',
      selectionAuthority: 'priced_line_items',
    });
  });

  test('selects approved one-time and cockroach React presentations from priced lines', () => {
    expect(_private.presentationForServices(
      { oneTimePest: { urgency: 'NONE' } },
      { lineItems: [{ service: 'one_time_pest', price: 250 }] },
    )).toEqual({
      template: 'one_time_pest',
      serviceTemplateKeys: ['one_time_pest'],
      reactPage: 'estimate_v2',
      mode: 'one_time',
      selectionAuthority: 'priced_line_items',
    });

    expect(_private.presentationForServices(
      { pestInitialRoach: { roachType: 'regular' } },
      { lineItems: [{ service: 'pest_initial_roach', price: 239 }] },
    )).toEqual(expect.objectContaining({
      template: 'cockroach_control',
      serviceTemplateKeys: ['cockroach_control'],
      reactPage: 'estimate_v2',
      mode: 'one_time',
    }));

    expect(_private.presentationForServices(
      { germanRoach: { severity: 'moderate' } },
      { lineItems: [{ service: 'german_roach', total: 450 }] },
    )).toEqual(expect.objectContaining({
      template: 'german_roach_cleanout',
      serviceTemplateKeys: ['german_roach_cleanout'],
      mode: 'one_time',
    }));
  });

  test('refuses to quote an active service again for a recognized customer', async () => {
    mockBuildAgentEstimateContext.mockResolvedValueOnce({
      customer_account: {
        recognized: true,
        customer_id: 'customer-1',
        existing_service_keys: ['pest_control'],
        current_services: [{ key: 'pest_control', currentPerVisit: 117 }],
      },
    });

    const result = await executeEstimateTool('compute_estimate', {
      leadId: 'lead-1',
      homeSqFt: 2000,
      services: { pest: { frequency: 'quarterly' } },
    });

    expect(result.error).toMatch(/already has active pest_control/i);
    expect(mockGenerateEstimate).not.toHaveBeenCalled();
  });

  test('rejects model-controlled price, cost, margin, discount, and manager override inputs', async () => {
    const result = await executeEstimateTool('compute_estimate', {
      homeSqFt: 2000,
      services: {
        trenching: { customPriceOverride: 1, measurements: { perimeterLF: 160 } },
      },
    });

    expect(result.error).toMatch(/cannot set price, cost, discount, margin, or manager-override/i);
    expect(result.error).toMatch(/customPriceOverride/);
    expect(mockGenerateEstimate).not.toHaveBeenCalled();
  });

  test('rejects a forbidden pricing override even if create draft is called directly', async () => {
    const { database, writes } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: {
        ...INPUT.engineInputs,
        manualDiscount: { type: 'PERCENT', value: 99 },
      },
    }, { confirmed: true });

    expect(result.error).toMatch(/manualDiscount/);
    expect(mockGenerateEstimate).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  test('rejects model-supplied prior qualifying services', async () => {
    const { database, writes } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: { ...INPUT.engineInputs, priorQualifyingServices: ['pest_control', 'lawn_care'] },
    }, { confirmed: true });

    expect(result.error).toMatch(/priorQualifyingServices/);
    expect(mockGenerateEstimate).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  test('rejects implausible direct draft measurements before pricing', async () => {
    const { database, writes } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: { ...INPUT.engineInputs, homeSqFt: 25 },
    }, { confirmed: true });

    expect(result.error).toMatch(/homeSqFt or buildingSqFt/i);
    expect(mockGenerateEstimate).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});

describe('Agent Estimate curated tool cabinet', () => {
  test('exposes one draft write and no send/update/schedule tools', () => {
    const route = require('../routes/admin-intelligence-bar');
    const names = route.AGENT_ESTIMATE_TOOL_NAMES;
    expect(names).toBeInstanceOf(Set);
    expect(names.has('create_agent_estimate_draft')).toBe(true);
    expect(names.has('compute_estimate')).toBe(true);
    expect(names.has('lookup_property')).toBe(true);
    expect(names.has('get_protocol')).toBe(true);
    expect(names.has('query_stock')).toBe(true);
    expect(names.has('send_sms')).toBe(false);
    expect(names.has('create_pending_estimate')).toBe(false);
    expect(names.has('update_lead_status')).toBe(false);
    expect(names.has('create_appointment')).toBe(false);
  });
});

describe('neighborhood grass prior', () => {
  test('returns aggregate counts without customer rows and labels a small sample weak', async () => {
    const { database } = makeDatabase({
      turfRows: [
        { grass_type: 'st_augustine', lawn_type: null },
        { grass_type: null, lawn_type: 'Floratam full sun' },
        { grass_type: 'zoysia', lawn_type: null },
      ],
    });
    mockDb.mockImplementation(database);

    const result = await _private.getNeighborhoodGrassProfile({ postal_code: '34208' });

    expect(result).toEqual(expect.objectContaining({
      postal_code: '34208',
      known_grass_samples: 3,
      typical_grass: 'st_augustine',
      confidence: 'weak_prior',
    }));
    expect(result.distribution[0]).toEqual(expect.objectContaining({ grass: 'st_augustine', count: 2 }));
    expect(JSON.stringify(result)).not.toContain('customer');
    expect(result.warning).toMatch(/verify this property/i);
  });
});

describe('Agent Estimate review-hardening regressions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateEstimate.mockReturnValue(ENGINE_RESULT);
    mockDuplicateBlock.mockResolvedValue(null);
  });

  test('rejects model-supplied service credits like the discount alias', async () => {
    const result = await executeEstimateTool('compute_estimate', {
      homeSqFt: 2000,
      services: { pest: { frequency: 'quarterly' } },
      serviceSpecificCredits: [{ service: 'pest', amount: 500 }],
    });

    expect(result.error).toMatch(/cannot set price, cost, discount, margin, or manager-override/i);
    expect(result.error).toMatch(/serviceSpecificCredits/);
    expect(mockGenerateEstimate).not.toHaveBeenCalled();
  });

  test('counts a specialty-only cleanout as a priced scenario with the specialty upfront total', async () => {
    mockGenerateEstimate.mockReturnValue({
      summary: {
        recurringMonthlyAfterDiscount: 0,
        recurringAnnualAfterDiscount: 0,
        oneTimeTotal: 0,
        specialtyTotal: 1200,
      },
      lineItems: [{ service: 'german_roach', total: 1200, costs: { total: 700 } }],
    });

    const result = await executeEstimateTool('compute_estimate', {
      homeSqFt: 2000,
      services: { germanRoach: {} },
    });

    expect(result.error).toBeUndefined();
    expect(result.onetime_total).toBe(1200);
    expect(result.presentation.template).toBe('german_roach_cleanout');
  });

  test('refuses to re-quote an active non-WaveGuard recurring service', async () => {
    mockBuildAgentEstimateContext.mockResolvedValueOnce({
      customer_account: {
        recognized: true,
        customer_id: 'customer-1',
        existing_service_keys: [],
        current_services: [{ key: 'rodent_bait', currentPerVisit: 45 }],
      },
    });

    const result = await executeEstimateTool('compute_estimate', {
      leadId: 'lead-1',
      homeSqFt: 2000,
      services: { rodentBait: {} },
    });

    expect(result.error).toMatch(/already has active rodent_bait/i);
    expect(mockGenerateEstimate).not.toHaveBeenCalled();
  });

  test('keeps the lawn-pest template when the engine prices it under generic one_time_lawn', () => {
    const presentation = _private.presentationForServices(
      { lawnPestControl: {} },
      { lineItems: [{ service: 'one_time_lawn', price: 189, name: 'Lawn Pest Knockdown' }] },
    );

    expect(presentation.template).toBe('lawn_pest_knockdown');
    expect(presentation.serviceTemplateKeys).toEqual(['lawn_pest_knockdown']);
    expect(presentation.selectionAuthority).toBe('priced_line_items');
  });

  test('flags a same-number different-street draft address as a lead mismatch', async () => {
    const { database } = makeDatabase({
      lead: {
        id: 'lead-1', customer_id: null, estimate_id: null,
        address: '123 Main St', city: 'Bradenton', zip: '34208',
      },
    });
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      address: '123 Oak St, Bradenton FL 34208',
      propertyFacts: {
        ...INPUT.propertyFacts,
        address: { value: '123 Oak St, Bradenton FL 34208', source: 'customer_sms', confidence: 'high' },
      },
    });

    expect(result.lane).toBe('yellow');
    expect(result.lane_reasons).toContain('draft service address differs from the selected lead address');
  });

  test('an email-only draft still runs inside a transaction instead of bare statements', async () => {
    const { database, writes } = makeDatabase({
      lead: { id: 'lead-1', customer_id: null, estimate_id: null, email: 'road@example.com' },
    });
    mockDb.mockImplementation(database);
    mockDb.transaction.mockImplementation(async (callback) => callback(database));
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      customerPhone: null,
    }, { confirmed: true });

    expect(result.success).toBe(true);
    expect(mockWithPhoneLock).not.toHaveBeenCalled();
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(writes.find((write) => write.table === 'estimates' && write.op === 'insert')).toBeTruthy();
  });

  test('phone duplicate block is bypassed when the open estimate is a different property', async () => {
    const { database, writes } = makeDatabase({
      estimate: { id: 'estimate-dup', address: '500 Other Rd, Venice FL 34285' },
    });
    mockDb.mockImplementation(database);
    mockTransactionDb = database;
    mockDuplicateBlock.mockResolvedValue({
      blocked: true,
      existingEstimateId: 'estimate-dup',
      message: 'An automated estimate is already open for this phone number',
    });

    const result = await executeEstimateTool('create_agent_estimate_draft', INPUT, { confirmed: true });

    expect(result.success).toBe(true);
    expect(writes.find((write) => write.table === 'estimates' && write.op === 'insert')).toBeTruthy();
  });

  test('phone duplicate block holds when the open estimate is the same street', async () => {
    const { database, writes } = makeDatabase({
      estimate: { id: 'estimate-dup', address: '1 Test St, Bradenton FL 34208' },
    });
    mockDb.mockImplementation(database);
    mockTransactionDb = database;
    mockDuplicateBlock.mockResolvedValue({
      blocked: true,
      existingEstimateId: 'estimate-dup',
      message: 'An automated estimate is already open for this phone number',
    });

    const result = await executeEstimateTool('create_agent_estimate_draft', INPUT, { confirmed: true });

    expect(result.error).toMatch(/already open for this phone number/i);
    expect(result.blocked).toBe(true);
    expect(writes.find((write) => write.table === 'estimates' && write.op === 'insert')).toBeUndefined();
  });

  test('membership snapshot sees the recurring aggregate so capped discounts are not overstated', async () => {
    mockBuildAgentEstimateContext.mockResolvedValueOnce({
      customer_account: {
        recognized: true,
        customer_id: 'customer-1',
        existing_service_keys: ['pest_control'],
        current_services: [{ key: 'pest_control', currentPerVisit: 117 }],
      },
      quote_form: { message_fields: [{ field: 'message', text: 'quarterly pest' }] },
    });
    mockGenerateEstimate.mockReturnValue({
      summary: {
        recurringMonthlyAfterDiscount: 70,
        recurringAnnualAfterDiscount: 840,
        recurringAnnualBeforeDiscount: 900,
        oneTimeTotal: 0,
      },
      waveGuard: { tier: 'silver' },
      lineItems: [{
        service: 'lawn_care', annualAfterDiscount: 840, monthlyAfterDiscount: 70,
        costs: { annualCost: 500 }, pricingConfidence: 'high',
      }],
    });
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: { ...INPUT.engineInputs, services: { lawn: { frequency: 'monthly' } } },
    });

    expect(result.pending_confirmation).toBe(true);
    expect(mockComputeMembershipContext).toHaveBeenCalledWith(mockDb, {
      customerId: 'customer-1',
      estData: {
        lineItems: [expect.objectContaining({ service: 'lawn_care' })],
        recurring: { annualBeforeDiscount: 900, annualAfterDiscount: 840 },
      },
    });
  });
});

describe('Agent Estimate recurring-customer flag control', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateEstimate.mockReturnValue({
      summary: { recurringMonthlyAfterDiscount: 0, recurringAnnualAfterDiscount: 0, oneTimeTotal: 0, specialtyTotal: 450 },
      lineItems: [{ service: 'german_roach_initial', total: 450, costs: { total: 200 } }],
    });
    mockDuplicateBlock.mockResolvedValue(null);
  });

  test('rejects a model-supplied recurring-customer discount flag', async () => {
    const result = await executeEstimateTool('compute_estimate', {
      homeSqFt: 2000,
      services: { germanRoachInitial: { isRecurringCustomer: true } },
    });

    expect(result.error).toMatch(/cannot set price, cost, discount, margin, or manager-override/i);
    expect(result.error).toMatch(/isRecurringCustomer/);
    expect(mockGenerateEstimate).not.toHaveBeenCalled();
  });

  test('derives the recurring-customer flag from the server-loaded account, not the model', async () => {
    mockBuildAgentEstimateContext.mockResolvedValueOnce({
      customer_account: {
        recognized: true,
        customer_id: 'customer-1',
        existing_service_keys: ['pest_control'],
        current_services: [{ key: 'pest_control', currentPerVisit: 117 }],
      },
    });

    const result = await executeEstimateTool('compute_estimate', {
      leadId: 'lead-1',
      homeSqFt: 2000,
      services: { germanRoachInitial: {} },
    });

    expect(result.error).toBeUndefined();
    const engineArg = mockGenerateEstimate.mock.calls[0][0];
    expect(engineArg.services.germanRoachInitial.isRecurringCustomer).toBe(true);
    // The echoed engine_input must stay clean or the guard rejects the
    // round-trip on the next draft revision.
    expect(result.engine_input.services.germanRoachInitial.isRecurringCustomer).toBeUndefined();
  });

  test('a new lead never gets the recurring-customer discount flag', async () => {
    const result = await executeEstimateTool('compute_estimate', {
      homeSqFt: 2000,
      services: { germanRoachInitial: {} },
    });

    expect(result.error).toBeUndefined();
    const engineArg = mockGenerateEstimate.mock.calls[0][0];
    expect(engineArg.services.germanRoachInitial.isRecurringCustomer).toBe(false);
  });
});

describe('Agent Estimate open-lead enforcement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateEstimate.mockReturnValue(ENGINE_RESULT);
    mockDuplicateBlock.mockResolvedValue(null);
  });

  test.each(['won', 'lost', 'unresponsive', 'duplicate'])(
    'rejects a confirmed draft write for a %s lead server-side',
    async (status) => {
      const { database, writes } = makeDatabase({
        lead: { id: 'lead-1', customer_id: null, estimate_id: null, status },
      });
      mockDb.mockImplementation(database);
      mockTransactionDb = database;

      const result = await executeEstimateTool('create_agent_estimate_draft', INPUT, { confirmed: true });

      expect(result.error).toMatch(new RegExp(status.replace(/_/g, ' '), 'i'));
      expect(result.error).toMatch(/open leads only/i);
      expect(mockGenerateEstimate).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
    },
  );

  test('an open contacted lead still drafts normally', async () => {
    const { database, writes } = makeDatabase({
      lead: { id: 'lead-1', customer_id: null, estimate_id: null, status: 'contacted', phone: '9415550100', email: 'road@example.com' },
    });
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', INPUT, { confirmed: true });

    expect(result.success).toBe(true);
    expect(writes.find((write) => write.table === 'estimates' && write.op === 'insert')).toBeTruthy();
  });
});

describe('Agent Estimate round-4 hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateEstimate.mockReturnValue(ENGINE_RESULT);
    mockDuplicateBlock.mockResolvedValue(null);
  });

  test('rejects any custom* or *override* engine control by pattern', async () => {
    const result = await executeEstimateTool('compute_estimate', {
      homeSqFt: 2000,
      services: { palm: { customPricePerPalm: 12, palmCount: 8 } },
    });

    expect(result.error).toMatch(/customPricePerPalm/);
    expect(mockGenerateEstimate).not.toHaveBeenCalled();

    const containerCost = await executeEstimateTool('compute_estimate', {
      homeSqFt: 2000,
      services: { preSlabTermiticide: { customContainerCost: 90 } },
    });
    expect(containerCost.error).toMatch(/customContainerCost/);
  });

  test('derives recurring collected margin from the canonical costs.total', () => {
    expect(_private.compactAgentLine({
      service: 'lawn_care',
      annualAfterDiscount: 800,
      monthlyAfterDiscount: 66.67,
      costs: { total: 600 },
      margin: 0.45,
    })).toEqual(expect.objectContaining({
      annual: 800,
      estimated_annual_cost: 600,
      collected_margin: 0.25,
      margin_floor_ok: false,
    }));
  });

  test('an older open estimate for the same address still blocks on a shared phone', async () => {
    const { database, writes } = makeDatabase({
      estimateRows: [
        { id: 'est-old', address: '1 Test St, Bradenton FL 34208' },
        { id: 'est-new', address: '500 Other Rd, Venice FL 34285' },
      ],
    });
    mockDb.mockImplementation(database);
    mockTransactionDb = database;
    mockDuplicateBlock.mockResolvedValue({
      blocked: true,
      existingEstimateId: 'est-new',
      message: 'An automated estimate is already open for this phone number',
    });

    const result = await executeEstimateTool('create_agent_estimate_draft', INPUT, { confirmed: true });

    expect(result.error).toMatch(/already open for this phone number/i);
    expect(result.existing_estimate_id).toBe('est-old');
    expect(writes.find((write) => write.table === 'estimates' && write.op === 'insert')).toBeUndefined();
  });

  test('an unknown address among open estimates keeps the conservative block', async () => {
    const { database, writes } = makeDatabase({
      estimateRows: [
        { id: 'est-new', address: '500 Other Rd, Venice FL 34285' },
        { id: 'est-blank', address: null },
      ],
    });
    mockDb.mockImplementation(database);
    mockTransactionDb = database;
    mockDuplicateBlock.mockResolvedValue({
      blocked: true,
      existingEstimateId: 'est-new',
      message: 'An automated estimate is already open for this phone number',
    });

    const result = await executeEstimateTool('create_agent_estimate_draft', INPUT, { confirmed: true });

    expect(result.error).toMatch(/already open for this phone number/i);
    expect(writes.find((write) => write.table === 'estimates' && write.op === 'insert')).toBeUndefined();
  });

  test('a revision fails closed when the lead was closed mid-flight', async () => {
    const existing = {
      id: 'estimate-old',
      token: 'old-token',
      status: 'draft',
      source: 'estimator_engine',
      estimate_data: JSON.stringify({
        lead_id: 'lead-1',
        engineInputs: INPUT.engineInputs,
        engineResult: ENGINE_RESULT,
        estimatorEngine: { origin: 'manual_agent' },
      }),
    };
    const { database, writes } = makeDatabase({
      lead: { id: 'lead-1', customer_id: null, estimate_id: existing.id, status: 'lost' },
      estimate: existing,
    });
    mockDb.mockImplementation(database);
    mockDb.transaction.mockImplementation(async (callback) => callback(database));
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      estimateId: existing.id,
    }, { confirmed: true });

    expect(result.error).toMatch(/lost/i);
    expect(writes.filter((write) => write.op === 'update' && write.table === 'estimates')).toEqual([]);
  });
});

describe('Agent Estimate round-5 hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateEstimate.mockReturnValue(ENGINE_RESULT);
    mockDuplicateBlock.mockResolvedValue(null);
  });

  test('rejects non-custom price levers like volumeDiscount and subcontract costs', async () => {
    const volume = await executeEstimateTool('compute_estimate', {
      homeSqFt: 2000,
      services: { preSlabTermiticide: { volumeDiscount: '10plus' } },
    });
    expect(volume.error).toMatch(/volumeDiscount/);

    const subcontract = await executeEstimateTool('compute_estimate', {
      homeSqFt: 2000,
      services: { bedBug: { subcontractCost: 900 } },
    });
    expect(subcontract.error).toMatch(/subcontractCost/);
    expect(mockGenerateEstimate).not.toHaveBeenCalled();
  });

  test('rejects service keys the engine silently ignores', async () => {
    const result = await executeEstimateTool('compute_estimate', {
      homeSqFt: 2000,
      services: { pest: { frequency: 'quarterly' }, rodent: {} },
    });

    expect(result.error).toMatch(/Unknown service key\(s\): rodent/);
    expect(result.error).toMatch(/rodentBait or rodentTrapping/);
    expect(mockGenerateEstimate).not.toHaveBeenCalled();

    const { database, writes } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;
    const draft = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: { ...INPUT.engineInputs, services: { rodent: {} } },
    }, { confirmed: true });
    expect(draft.error).toMatch(/Unknown service key/);
    expect(writes).toEqual([]);
  });

  test('a model-supplied recipient is dropped when the lead field is blank', async () => {
    const { database, writes } = makeDatabase({
      lead: { id: 'lead-1', customer_id: null, estimate_id: null, phone: '9415550100' },
    });
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      customerEmail: 'invented-by-model@example.com',
    }, { confirmed: true });

    expect(result.success).toBe(true);
    const insert = writes.find((write) => write.table === 'estimates' && write.op === 'insert').payload;
    expect(insert.customer_phone).toBe('9415550100');
    expect(insert.customer_email).toBeNull();
  });

  test('a revision uses only current recognition for the customer link', async () => {
    const existing = {
      id: 'estimate-old',
      token: 'old-token',
      status: 'draft',
      source: 'estimator_engine',
      customer_id: 'customer-stale',
      estimate_data: JSON.stringify({
        lead_id: 'lead-1',
        engineInputs: INPUT.engineInputs,
        engineResult: ENGINE_RESULT,
        estimatorEngine: { origin: 'manual_agent' },
      }),
    };
    const { database, writes } = makeDatabase({ estimate: existing, estimateRows: [] });
    mockDb.mockImplementation(database);
    mockDb.transaction.mockImplementation(async (callback) => callback(database));
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      estimateId: existing.id,
    }, { confirmed: true });

    expect(result.success).toBe(true);
    const update = writes.find((write) => write.table === 'estimates' && write.op === 'update').payload;
    expect(update.customer_id).toBeNull();
  });

  test('a revision recorrected onto an already-quoted property is blocked', async () => {
    const existing = {
      id: 'estimate-old',
      token: 'old-token',
      status: 'draft',
      source: 'estimator_engine',
      estimate_data: JSON.stringify({
        lead_id: 'lead-1',
        engineInputs: INPUT.engineInputs,
        engineResult: ENGINE_RESULT,
        estimatorEngine: { origin: 'manual_agent' },
      }),
    };
    const { database, writes } = makeDatabase({
      estimate: existing,
      estimateRows: [{ id: 'estimate-other', address: '1 Test St, Bradenton FL 34208' }],
    });
    mockDb.mockImplementation(database);
    mockDb.transaction.mockImplementation(async (callback) => callback(database));
    mockTransactionDb = database;
    mockDuplicateBlock.mockResolvedValue({
      blocked: true,
      existingEstimateId: 'estimate-other',
      message: 'An automated estimate is already open for this phone number',
    });

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      estimateId: existing.id,
    }, { confirmed: true });

    expect(result.error).toMatch(/already open for this phone number/i);
    expect(result.existing_estimate_id).toBe('estimate-other');
    expect(writes.filter((write) => write.op === 'update' && write.table === 'estimates')).toEqual([]);
  });

  test('refuses to price a recognized customer whose service context failed to load', async () => {
    mockBuildAgentEstimateContext.mockResolvedValueOnce({
      customer_account: {
        recognized: true,
        customer_id: 'customer-1',
        existing_service_keys: [],
        current_services: [],
        service_context_unavailable: true,
      },
    });

    const result = await executeEstimateTool('compute_estimate', {
      leadId: 'lead-1',
      homeSqFt: 2000,
      services: { lawn: {} },
    });

    expect(result.error).toMatch(/existing-service context could not be loaded/i);
    expect(mockGenerateEstimate).not.toHaveBeenCalled();
  });

  test('margin failures survive the 30-reason lane cap', async () => {
    mockGenerateEstimate.mockReturnValue({
      ...ENGINE_RESULT,
      lineItems: [{
        service: 'pest_control',
        annualAfterDiscount: 650,
        monthlyAfterDiscount: 54.17,
        costs: { annualCost: 500 },
        pricingConfidence: 'high',
      }],
    });
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      assumptions: Array.from({ length: 40 }, (_, index) => `assumption ${index}`),
    });

    expect(result.lane).toBe('yellow');
    expect(result.lane_reasons).toHaveLength(30);
    expect(result.lane_reasons[0]).toBe('pest_control collected margin is below 35%');
  });
});
