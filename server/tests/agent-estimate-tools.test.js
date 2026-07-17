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
const mockExecuteProcurementTool = jest.fn(async (_toolName, input) => ({
  products: [{
    id: `product-${String(input.search || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name: input.search,
    on_hand: 8,
    unit: 'oz',
  }],
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
jest.mock('../services/intelligence-bar/procurement-tools', () => ({
  PROCUREMENT_TOOLS: [{ name: 'query_stock' }],
  executeProcurementTool: (...args) => mockExecuteProcurementTool(...args),
}));
jest.mock('../routes/property-lookup-v2', () => ({ performPropertyLookup: jest.fn() }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (url) => url) }));

const { executeEstimateTool, _private } = require('../services/intelligence-bar/estimate-tools');
const { agentEstimatePreviewFingerprint } = require('../services/agent-estimate-preview');
const { performPropertyLookup } = require('../routes/property-lookup-v2');
const TWILIO_NUMBERS = require('../config/twilio-numbers');

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
    'services.pest.frequency': { value: 'quarterly', source: 'operator_confirmation', confidence: 'high' },
  },
  protocolReview: [{ serviceKey: 'pest', programKey: 'pest', visitCount: 6 }],
  inventoryReview: [
    { serviceKey: 'pest', productName: 'Demand CS', status: 'in_stock', onHand: 8 },
    { serviceKey: 'pest', productName: 'Alpine WSG', status: 'in_stock', onHand: 8 },
    { serviceKey: 'pest', productName: 'Advion WDG Granular', status: 'in_stock', onHand: 8 },
    { serviceKey: 'pest', productName: 'Advion Cockroach Gel Bait', status: 'in_stock', onHand: 8 },
    { serviceKey: 'pest', productName: 'Gentrol IGR', status: 'in_stock', onHand: 8 },
    { serviceKey: 'pest', productName: 'Advion Ant Gel', status: 'in_stock', onHand: 8 },
    { serviceKey: 'pest', productName: 'Contrac Blox', status: 'in_stock', onHand: 8 },
  ],
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
  lockedLead = null,
  customer = null,
  estimate = null,
  estimateRows = null,
  turfRows = [],
} = {}) {
  const writes = [];
  let leadReadCount = 0;
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
        if (table === 'leads') {
          leadReadCount += 1;
          return lockedLead && leadReadCount > 1 ? lockedLead : lead;
        }
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

  test('rejects model-only pricing facts even when source and confidence look authoritative', async () => {
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: { homeSqFt: 10000, services: { pest: { frequency: 'quarterly' } } },
      propertyFacts: {
        address: INPUT.propertyFacts.address,
        homeSqFt: { value: 10000, source: 'county', confidence: 'high' },
      },
    });

    expect(result.lane).toBe('yellow');
    expect(result.lane_reasons).toEqual(expect.arrayContaining([
      'home/building square footage was used for pricing without a matching verified property fact',
      expect.stringMatching(/homeSqFt lacks a server-verified/i),
    ]));
  });

  test('verifies structured form and call extraction quotes only against those sources', () => {
    const context = {
      quote_form: { message_fields: [], extracted_data: { selectedService: 'lawn care' } },
      calls: [{ transcript: 'unrelated words', transcript_summary: 'unrelated summary', extraction: { stationCount: '12 stations' } }],
      sms_thread: [],
      activities: [],
    };
    expect(_private.verifyAgentEvidenceQuotes([
      { source: 'quote_form', quote: 'lawn care' },
      { source: 'call_extraction', quote: '12 stations' },
    ], context)).toMatchObject({ quoted: 2, verified: 2, unverified: 0 });
    expect(_private.verifyAgentEvidenceQuotes([
      { source: 'call_transcript', quote: '12 stations' },
    ], context)).toMatchObject({ quoted: 1, verified: 0, unverified: 1 });
  });

  test('does not verify a fabricated quote assembled across separate source records', () => {
    const context = {
      quote_form: { message_fields: [], extracted_data: {} },
      calls: [],
      sms_thread: [{ body: 'The home is' }, { body: '8,000 square feet' }],
      activities: [],
    };

    expect(_private.verifyAgentEvidenceQuotes([
      { source: 'sms', quote: 'The home is 8,000 square feet' },
    ], context)).toMatchObject({ quoted: 1, verified: 0, unverified: 1 });
  });

  test('accepts exact facts for specialty top-level and nested price measurements', async () => {
    mockGenerateEstimate.mockReturnValue({
      summary: { recurringMonthlyAfterDiscount: 0, recurringAnnualAfterDiscount: 0, oneTimeTotal: 500 },
      waveGuard: { tier: 'none' },
      lineItems: [{ service: 'rodent', price: 500, costs: { total: 250 }, pricingConfidence: 'high' }],
    });
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: {
        homeSqFt: 2000,
        atticSqFt: 1200,
        services: { rodentTrapping: { stationCount: 12 } },
      },
      propertyFacts: {
        ...INPUT.propertyFacts,
        atticSqFt: { value: 1200, source: 'satellite', confidence: 'high' },
        stationCount: { value: 12, source: 'inspection', confidence: 'high' },
      },
      protocolReview: [{ serviceKey: 'rodentTrapping', programKey: 'rodent', visitCount: 4 }],
      inventoryReview: [{ serviceKey: 'rodentTrapping', productName: 'Traps', status: 'in_stock', onHand: 12 }],
    });

    expect(result.error).toBeUndefined();
    expect(result.lane_reasons || []).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/attic square footage.*without a matching/i),
      expect.stringMatching(/services\.rodentTrapping\.stationCount.*without a matching/i),
      expect.stringMatching(/atticSqFt does not match/i),
      expect.stringMatching(/stationCount does not match/i),
    ]));
  });

  test('requires a verified fact when buildingSqFt supplies the effective home size', async () => {
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: {
        buildingSqFt: 2500,
        services: { pest: { frequency: 'quarterly' } },
      },
      propertyFacts: {
        address: INPUT.propertyFacts.address,
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.lane).toBe('yellow');
    expect(result.lane_reasons).toContain(
      'home/building square footage was used for pricing without a matching verified property fact',
    );
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

  test('validates protocol program and cadence against the server protocol catalog', async () => {
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      protocolReview: [{ serviceKey: 'pest', programKey: 'anything', visitCount: 1 }],
    });

    expect(result.lane).toBe('yellow');
    expect(result.lane_reasons).toContain('protocol review for pest names the wrong program');
  });

  test('uses live stock instead of a model-asserted available inventory row', async () => {
    mockExecuteProcurementTool.mockResolvedValueOnce({
      products: [{ id: 'product-pest', name: 'Demand CS', on_hand: 0, unit: 'oz' }],
    });
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      inventoryReview: [{
        serviceKey: 'pest', productName: 'Demand CS', status: 'in_stock', onHand: 99,
      }],
    });

    expect(result.lane).toBe('yellow');
    expect(result.lane_reasons).toContain('Demand CS: unavailable (0 on hand)');
    expect(result.inventoryReview[0]).toEqual(expect.objectContaining({
      onHand: 0,
      status: 'unavailable',
      verifiedLive: true,
    }));
  });

  test('requires each reviewed inventory product to belong to the selected service protocol', async () => {
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      inventoryReview: [{
        serviceKey: 'pest', productName: 'Unrelated Catalog Product', status: 'in_stock', onHand: 8,
      }],
    });

    expect(result.lane_reasons).toContain(
      'Unrelated Catalog Product: product is not named in the pest protocol',
    );
    expect(result.inventoryReview[0]).toEqual(expect.objectContaining({
      verifiedLive: true,
      protocolMatched: false,
    }));
  });

  test('requires inventory coverage for every structured protocol treatment group', async () => {
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      inventoryReview: [{
        serviceKey: 'pest', productName: 'Demand CS', status: 'in_stock', onHand: 8,
      }],
    });

    expect(result.lane_reasons).toEqual(expect.arrayContaining([
      'inventory review for pest is missing protocol product: Alpine WSG',
      'inventory review for pest is missing protocol product: Advion WDG Granular',
    ]));
  });

  test('requires evidence for every numeric nested service price driver including rooms', async () => {
    mockGenerateEstimate.mockReturnValue({
      summary: {
        recurringMonthlyAfterDiscount: 0,
        recurringAnnualAfterDiscount: 0,
        oneTimeTotal: 500,
      },
      waveGuard: { tier: 'bronze' },
      lineItems: [{
        service: 'bed_bug', price: 500, costs: { total: 250 }, pricingConfidence: 'high',
      }],
    });
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: {
        homeSqFt: 2000,
        services: { bedBug: { rooms: 2, method: 'chemical' } },
      },
      protocolReview: [{ serviceKey: 'bedBug', programKey: 'bed_bug', visitCount: 3 }],
      inventoryReview: [{
        serviceKey: 'bedBug', productName: 'Bed Bug Product', status: 'in_stock', onHand: 8,
      }],
    });

    expect(result.error).toBeUndefined();
    expect(result.lane).toBe('yellow');
    expect(result.lane_reasons).toContain(
      'services.bedBug.rooms was used for pricing without a matching verified property fact',
    );
    expect(result.lane_reasons).toContain(
      'services.bedBug.method was used for pricing without a matching verified property fact',
    );
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
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateEstimate.mockReturnValue(ENGINE_RESULT);
    mockDuplicateBlock.mockResolvedValue(null);
  });

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
    expect(result.property_fact_verification_token).toEqual(expect.any(String));
    expect(JSON.stringify(result)).not.toMatch(/secret-key|staticmap|imageUrl|microCloseUrl/);
  });

  test('signed lookup facts can satisfy the server evidence binding', async () => {
    performPropertyLookup.mockResolvedValue({
      propertyRecord: {
        formattedAddress: '1 Test St, Bradenton FL 34208',
        squareFootage: 2000,
        _source: 'county',
      },
      satellite: { inServiceArea: true },
    });
    const lookup = await executeEstimateTool('lookup_property', { address: INPUT.address });
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: { homeSqFt: 2000, services: { pest: { frequency: 'quarterly' } } },
      propertyFactVerificationToken: lookup.property_fact_verification_token,
    });

    expect(result.error).toBeUndefined();
    expect(result.lane).toBe('green');
  });

  test('a building-level lookup credential cannot authenticate an explicit unit', async () => {
    performPropertyLookup.mockResolvedValue({
      propertyRecord: {
        formattedAddress: '1 Test St, Bradenton FL 34208',
        squareFootage: 8000,
        _source: 'county',
      },
      satellite: { inServiceArea: true },
    });
    const unitAddress = '1 Test St Apt A, Bradenton FL 34208';
    const lookup = await executeEstimateTool('lookup_property', { address: unitAddress });
    const { database } = makeDatabase({
      lead: {
        id: 'lead-1', customer_id: null, estimate_id: null,
        phone: '9415550100', email: 'road@example.com', address: unitAddress,
      },
    });
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      address: unitAddress,
      engineInputs: { homeSqFt: 8000, services: { pest: { frequency: 'quarterly' } } },
      propertyFactVerificationToken: lookup.property_fact_verification_token,
      propertyFacts: {
        address: { value: unitAddress, source: 'lead', confidence: 'high' },
        homeSqFt: { value: 8000, source: 'property_lookup', confidence: 'high' },
        'services.pest.frequency': INPUT.propertyFacts['services.pest.frequency'],
      },
    });

    expect(result.lane_reasons).toEqual(expect.arrayContaining([
      'home/building square footage was used for pricing without a matching verified property fact',
      expect.stringMatching(/homeSqFt lacks a server-verified/i),
    ]));
  });

  test('tampering with a lookup credential leaves its model facts unverified', async () => {
    performPropertyLookup.mockResolvedValue({
      propertyRecord: { formattedAddress: INPUT.address, squareFootage: 2000, _source: 'county' },
      satellite: { inServiceArea: true },
    });
    const lookup = await executeEstimateTool('lookup_property', { address: INPUT.address });
    const token = lookup.property_fact_verification_token;
    const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: { homeSqFt: 2000, services: { pest: { frequency: 'quarterly' } } },
      propertyFactVerificationToken: tampered,
    });

    expect(result.lane).toBe('yellow');
    expect(result.lane_reasons).toContain(
      'home/building square footage was used for pricing without a matching verified property fact',
    );
  });

  test('an exact server-loaded operator quote can ground a pricing measurement', async () => {
    const quote = 'Operator confirmed the home is 2000 square feet and wants quarterly pest service';
    mockBuildAgentEstimateContext.mockResolvedValueOnce({
      lead: { id: 'lead-1', customer_id: null, address: INPUT.address, phone: INPUT.customerPhone },
      quote_form: { message_fields: [{ field: 'message', text: quote }], extracted_data: {} },
      calls: [], sms_thread: [], activities: [],
      customer_account: { recognized: false, existing_service_keys: [], current_services: [] },
    });
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: { homeSqFt: 2000, services: { pest: { frequency: 'quarterly' } } },
      evidence: [{ source: 'quote_form', quote, decision: 'home square footage' }],
      propertyFacts: {
        address: INPUT.propertyFacts.address,
        homeSqFt: { value: 2000, source: 'operator_confirmation', confidence: 'high' },
        'services.pest.frequency': INPUT.propertyFacts['services.pest.frequency'],
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.lane).toBe('green');
  });

  test('a lot square-foot quote cannot authenticate home square footage', async () => {
    const quote = 'The lot is 8,000 square feet';
    mockBuildAgentEstimateContext.mockResolvedValueOnce({
      lead: {
        id: 'lead-1', customer_id: null, address: INPUT.address, phone: INPUT.customerPhone,
      },
      quote_form: { message_fields: [{ field: 'message', text: quote }], extracted_data: {} },
      calls: [], sms_thread: [], activities: [],
      customer_account: { recognized: false, existing_service_keys: [], current_services: [] },
    });
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: { homeSqFt: 8000, services: { pest: { frequency: 'quarterly' } } },
      evidence: [{ source: 'quote_form', quote, decision: 'home square footage' }],
      propertyFacts: {
        address: INPUT.propertyFacts.address,
        homeSqFt: { value: 8000, source: 'operator_confirmation', confidence: 'high' },
      },
    });

    expect(result.lane).toBe('yellow');
    expect(result.lane_reasons).toEqual(expect.arrayContaining([
      'home/building square footage was used for pricing without a matching verified property fact',
      expect.stringMatching(/homeSqFt lacks a server-verified/i),
    ]));
  });

  test('binds a structure fact to its own value when one quote names multiple dimensions', async () => {
    const quote = 'The home is 2,000 square feet with an 8,000 square foot lot';
    mockBuildAgentEstimateContext.mockResolvedValueOnce({
      lead: {
        id: 'lead-1', customer_id: null, address: INPUT.address, phone: INPUT.customerPhone,
      },
      quote_form: { message_fields: [{ field: 'message', text: quote }], extracted_data: {} },
      calls: [], sms_thread: [], activities: [],
      customer_account: { recognized: false, existing_service_keys: [], current_services: [] },
    });
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: { homeSqFt: 8000, services: { pest: { frequency: 'quarterly' } } },
      evidence: [{ source: 'quote_form', quote, decision: 'home square footage' }],
      propertyFacts: {
        address: INPUT.propertyFacts.address,
        homeSqFt: { value: 8000, source: 'operator_confirmation', confidence: 'high' },
      },
    });

    expect(result.lane).toBe('yellow');
    expect(result.lane_reasons).toContain(
      'home/building square footage was used for pricing without a matching verified property fact',
    );
  });

  test('associates story and structure labels with their own neighboring numbers', async () => {
    const quote = 'The home has 2 stories and 2,000 square feet and needs quarterly pest service';
    mockBuildAgentEstimateContext.mockResolvedValueOnce({
      lead: {
        id: 'lead-1', customer_id: null, address: INPUT.address, phone: INPUT.customerPhone,
      },
      quote_form: { message_fields: [{ field: 'message', text: quote }], extracted_data: {} },
      calls: [], sms_thread: [], activities: [],
      customer_account: { recognized: false, existing_service_keys: [], current_services: [] },
    });
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: { homeSqFt: 2000, stories: 2, services: { pest: { frequency: 'quarterly' } } },
      evidence: [{ source: 'quote_form', quote, decision: 'home size and stories' }],
      propertyFacts: {
        address: INPUT.propertyFacts.address,
        homeSqFt: { value: 2000, source: 'operator_confirmation', confidence: 'high' },
        stories: { value: 2, source: 'operator_confirmation', confidence: 'high' },
        'services.pest.frequency': INPUT.propertyFacts['services.pest.frequency'],
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.lane).toBe('green');
  });

  test('does not apply pool-cage negation to a separate positive pool phrase', async () => {
    const quote = 'The home is 2,000 square feet. No pool cage, but there is a pool.';
    mockBuildAgentEstimateContext.mockResolvedValueOnce({
      lead: {
        id: 'lead-1', customer_id: null, address: INPUT.address, phone: INPUT.customerPhone,
      },
      quote_form: { message_fields: [{ field: 'message', text: quote }], extracted_data: {} },
      calls: [], sms_thread: [], activities: [],
      customer_account: { recognized: false, existing_service_keys: [], current_services: [] },
    });
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: { homeSqFt: 2000, pool: false, services: { pest: { frequency: 'quarterly' } } },
      evidence: [{ source: 'quote_form', quote, decision: 'home size and pool' }],
      propertyFacts: {
        address: INPUT.propertyFacts.address,
        homeSqFt: { value: 2000, source: 'operator_confirmation', confidence: 'high' },
        pool: { value: false, source: 'operator_confirmation', confidence: 'high' },
      },
    });

    expect(result.lane_reasons).toEqual(expect.arrayContaining([
      'pool presence was used for pricing without a matching verified property fact',
      expect.stringMatching(/pool lacks a server-verified/i),
    ]));
  });

  test('does not authenticate a negated categorical price driver', async () => {
    const quote = "The building is 2,000 square feet. This isn't commercial; it is residential.";
    mockBuildAgentEstimateContext.mockResolvedValueOnce({
      lead: {
        id: 'lead-1', customer_id: null, address: INPUT.address, phone: INPUT.customerPhone,
      },
      quote_form: { message_fields: [{ field: 'message', text: quote }], extracted_data: {} },
      calls: [], sms_thread: [], activities: [],
      customer_account: { recognized: false, existing_service_keys: [], current_services: [] },
    });
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: {
        buildingSqFt: 2000,
        propertyType: 'commercial',
        services: { pest: { frequency: 'quarterly' } },
      },
      evidence: [{ source: 'quote_form', quote, decision: 'building size and property type' }],
      propertyFacts: {
        address: INPUT.propertyFacts.address,
        buildingSqFt: { value: 2000, source: 'operator_confirmation', confidence: 'high' },
        propertyType: { value: 'commercial', source: 'operator_confirmation', confidence: 'high' },
      },
    });

    expect(result.lane_reasons).toEqual(expect.arrayContaining([
      'property type was used for pricing without a matching verified property fact',
      expect.stringMatching(/propertyType lacks a server-verified/i),
    ]));
  });

  test('does not authenticate a positive pool-cage fact from compound negation', async () => {
    const quote = 'The home is 2,000 square feet. The pool has no cage.';
    mockBuildAgentEstimateContext.mockResolvedValueOnce({
      lead: {
        id: 'lead-1', customer_id: null, address: INPUT.address, phone: INPUT.customerPhone,
      },
      quote_form: { message_fields: [{ field: 'message', text: quote }], extracted_data: {} },
      calls: [], sms_thread: [], activities: [],
      customer_account: { recognized: false, existing_service_keys: [], current_services: [] },
    });
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: {
        homeSqFt: 2000,
        poolCage: true,
        services: { pest: { frequency: 'quarterly' } },
      },
      evidence: [{ source: 'quote_form', quote, decision: 'home size and pool cage' }],
      propertyFacts: {
        address: INPUT.propertyFacts.address,
        homeSqFt: { value: 2000, source: 'operator_confirmation', confidence: 'high' },
        poolCage: { value: true, source: 'operator_confirmation', confidence: 'high' },
      },
    });

    expect(result.lane_reasons).toEqual(expect.arrayContaining([
      'pool cage presence was used for pricing without a matching verified property fact',
      expect.stringMatching(/poolCage lacks a server-verified/i),
    ]));
  });

  test('does not let a low-confidence call extraction masquerade as operator confirmation', async () => {
    mockBuildAgentEstimateContext.mockResolvedValueOnce({
      lead: {
        id: 'lead-1', customer_id: null, address: INPUT.address, phone: INPUT.customerPhone,
      },
      quote_form: { message_fields: [{ field: 'message', text: 'quarterly pest' }], extracted_data: {} },
      calls: [{ transcript: '', transcript_summary: '', extraction: { homeSqFt: 2000 } }],
      sms_thread: [], activities: [],
      customer_account: { recognized: false, existing_service_keys: [], current_services: [] },
    });
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: { homeSqFt: 2000, services: { pest: { frequency: 'quarterly' } } },
      propertyFacts: {
        address: INPUT.propertyFacts.address,
        homeSqFt: { value: 2000, source: 'operator_confirmation', confidence: 'high' },
      },
    });

    expect(result.lane).toBe('yellow');
    expect(result.lane_reasons).toContain(
      'homeSqFt lacks a server-verified value, source, confidence, or evidence binding',
    );
    expect(result.propertyFacts.homeSqFt).toEqual(expect.objectContaining({
      claimedSource: 'operator_confirmation',
      source: 'call_extraction',
      confidence: 'low',
    }));
  });

  test('keeps an exact transcript-summary quote at low confidence', async () => {
    const quote = 'The home is 2000 square feet';
    mockBuildAgentEstimateContext.mockResolvedValueOnce({
      lead: {
        id: 'lead-1', customer_id: null, address: INPUT.address, phone: INPUT.customerPhone,
      },
      quote_form: { message_fields: [], extracted_data: {} },
      calls: [{ transcript: '', transcript_summary: quote, extraction: {} }],
      sms_thread: [], activities: [],
      customer_account: { recognized: false, existing_service_keys: [], current_services: [] },
    });
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: { homeSqFt: 2000, services: { pest: { frequency: 'quarterly' } } },
      evidence: [{ source: 'transcript_summary', quote, decision: 'home square footage' }],
      propertyFacts: {
        address: INPUT.propertyFacts.address,
        homeSqFt: { value: 2000, source: 'operator_confirmation', confidence: 'high' },
      },
    });

    expect(result.lane_reasons).toContain(
      'homeSqFt lacks a server-verified value, source, confidence, or evidence binding',
    );
    expect(result.propertyFacts.homeSqFt).toEqual(expect.objectContaining({
      source: 'transcript_summary',
      confidence: 'low',
    }));
  });

  test('requires verified facts for every supplied top-level price driver', async () => {
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: {
        homeSqFt: 2000,
        yearBuilt: 1985,
        imperviousSurfacePercent: 40,
        pool: true,
        poolCage: true,
        services: { pest: { frequency: 'quarterly' } },
      },
    });

    expect(result.lane_reasons).toEqual(expect.arrayContaining([
      'year built was used for pricing without a matching verified property fact',
      'impervious surface percent was used for pricing without a matching verified property fact',
      'pool presence was used for pricing without a matching verified property fact',
      'pool cage presence was used for pricing without a matching verified property fact',
    ]));
  });

  test('does not promote an estimated turf lookup into a measured turf credential', async () => {
    performPropertyLookup.mockResolvedValue({
      propertyRecord: { formattedAddress: INPUT.address, squareFootage: 2000, _source: 'county' },
      satellite: { inServiceArea: true },
      enriched: { estimatedTurfSf: 4200 },
    });
    const lookup = await executeEstimateTool('lookup_property', { address: INPUT.address });
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: {
        homeSqFt: 2000,
        measuredTurfSf: 4200,
        services: { pest: { frequency: 'quarterly' } },
      },
      propertyFactVerificationToken: lookup.property_fact_verification_token,
      propertyFacts: {
        ...INPUT.propertyFacts,
        measuredTurfSf: { value: 4200, source: 'property_lookup', confidence: 'high' },
      },
    });

    expect(result.lane).toBe('yellow');
    expect(result.lane_reasons).toContain(
      'measuredTurfSf lacks a server-verified value, source, confidence, or evidence binding',
    );
  });

  test('keeps an estimated turf lookup groundable only as estimated turf', async () => {
    performPropertyLookup.mockResolvedValue({
      propertyRecord: { formattedAddress: INPUT.address, squareFootage: 2000, _source: 'county' },
      satellite: { inServiceArea: true },
      enriched: { estimatedTurfSf: 4200 },
    });
    const lookup = await executeEstimateTool('lookup_property', { address: INPUT.address });
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: {
        homeSqFt: 2000,
        estimatedTurfSf: 4200,
        services: { pest: { frequency: 'quarterly' } },
      },
      propertyFactVerificationToken: lookup.property_fact_verification_token,
      propertyFacts: {
        ...INPUT.propertyFacts,
        estimatedTurfSf: { value: 4200, source: 'property_lookup', confidence: 'high' },
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.lane_reasons).not.toContain(
      'estimatedTurfSf lacks a server-verified value, source, confidence, or evidence binding',
    );
  });

  test('does not sign missing or derived-default lookup measurements', async () => {
    performPropertyLookup.mockResolvedValue({
      propertyRecord: {
        formattedAddress: INPUT.address,
        squareFootage: 2000,
        stories: null,
        _source: 'county',
      },
      satellite: { inServiceArea: true },
      enriched: {
        stories: 1,
        estimatedAtticSqFt: 1000,
        estimatedSlabSqFt: 1000,
      },
    });
    const lookup = await executeEstimateTool('lookup_property', { address: INPUT.address });
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: {
        homeSqFt: 2000,
        stories: 1,
        atticSqFt: 1000,
        slabSqFt: 1000,
        services: { pest: { frequency: 'quarterly' } },
      },
      propertyFactVerificationToken: lookup.property_fact_verification_token,
      propertyFacts: {
        ...INPUT.propertyFacts,
        stories: { value: 1, source: 'property_lookup', confidence: 'high' },
        atticSqFt: { value: 1000, source: 'property_lookup', confidence: 'high' },
        slabSqFt: { value: 1000, source: 'property_lookup', confidence: 'high' },
      },
    });

    expect(result.lane).toBe('yellow');
    expect(result.lane_reasons).toEqual(expect.arrayContaining([
      'story count was used for pricing without a matching verified property fact',
      'attic square footage was used for pricing without a matching verified property fact',
      'slab square footage was used for pricing without a matching verified property fact',
      expect.stringMatching(/stories lacks a server-verified/i),
    ]));
  });
});

describe('Agent Estimate recipient phone safety', () => {
  test.each([
    'RESTRICTED',
    '7378742833',
    TWILIO_NUMBERS.mainLine.number,
  ])('does not anchor non-customer phone %s as a draft recipient', (phone) => {
    const result = _private.anchorAgentEstimateContact(
      { ...INPUT, customerPhone: phone },
      { id: 'lead-1', phone, email: INPUT.customerEmail },
    );

    expect(result.error).toBeUndefined();
    expect(result.input.customerPhone).toBeNull();
  });

  test('keeps a real external lead phone as the draft recipient', () => {
    const result = _private.anchorAgentEstimateContact(INPUT, {
      id: 'lead-1', phone: INPUT.customerPhone, email: INPUT.customerEmail,
    });
    expect(result.input.customerPhone).toBe(INPUT.customerPhone);
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

describe('Agent Estimate round-6 hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateEstimate.mockReturnValue(ENGINE_RESULT);
    mockDuplicateBlock.mockResolvedValue(null);
  });

  test('an active commercial program blocks re-quoting its base service', async () => {
    mockBuildAgentEstimateContext.mockResolvedValueOnce({
      customer_account: {
        recognized: true,
        customer_id: 'customer-1',
        existing_service_keys: [],
        current_services: [{ key: 'commercial_pest_control', currentPerVisit: 210 }],
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

  test('a multi-property customer can be quoted the same service at a DIFFERENT property', async () => {
    const account = {
      recognized: true,
      customer_id: 'customer-1',
      existing_service_keys: ['pest_control'],
      current_services: [{
        key: 'pest_control',
        currentPerVisit: 117,
        serviceAddresses: ['1 Test St, Bradenton FL 34208'],
        serviceAddressesComplete: true,
      }],
    };
    mockBuildAgentEstimateContext.mockResolvedValueOnce({ customer_account: account });
    const other = await executeEstimateTool('compute_estimate', {
      leadId: 'lead-1',
      address: '500 Other Rd, Venice FL 34285',
      homeSqFt: 2000,
      services: { pest: { frequency: 'quarterly' } },
    });
    expect(other.error).toBeUndefined();
    expect(mockGenerateEstimate).toHaveBeenCalled();

    mockGenerateEstimate.mockClear();
    mockBuildAgentEstimateContext.mockResolvedValueOnce({ customer_account: account });
    const same = await executeEstimateTool('compute_estimate', {
      leadId: 'lead-1',
      address: '1 Test St, Bradenton FL 34208',
      homeSqFt: 2000,
      services: { pest: { frequency: 'quarterly' } },
    });
    expect(same.error).toMatch(/already has active pest_control/i);

    mockBuildAgentEstimateContext.mockResolvedValueOnce({ customer_account: account });
    const unknown = await executeEstimateTool('compute_estimate', {
      leadId: 'lead-1',
      homeSqFt: 2000,
      services: { pest: { frequency: 'quarterly' } },
    });
    expect(unknown.error).toMatch(/already has active pest_control/i);
  });

  test('combined-service duplicate checks use each component service address', async () => {
    const account = {
      recognized: true,
      customer_id: 'customer-1',
      existing_service_keys: ['pest_control', 'lawn_care'],
      current_services: [{
        key: 'pest_control',
        keys: ['pest_control', 'lawn_care'],
        componentServiceAddresses: {
          pest_control: ['1 Property A St, Bradenton FL 34208', '2 Property B St, Venice FL 34285'],
          lawn_care: ['1 Property A St, Bradenton FL 34208'],
        },
        componentServiceAddressesComplete: { pest_control: true, lawn_care: true },
      }],
    };
    mockGenerateEstimate.mockReturnValue({
      summary: { recurringMonthlyAfterDiscount: 75, recurringAnnualAfterDiscount: 900, oneTimeTotal: 0 },
      waveGuard: { tier: 'gold' },
      lineItems: [{
        service: 'lawn_care', annualAfterDiscount: 900, monthlyAfterDiscount: 75,
        costs: { annualCost: 540 }, pricingConfidence: 'high',
      }],
    });
    mockBuildAgentEstimateContext.mockResolvedValueOnce({ customer_account: account });
    const expansion = await executeEstimateTool('compute_estimate', {
      leadId: 'lead-1',
      address: '2 Property B St, Venice FL 34285',
      homeSqFt: 2000,
      services: { lawn: { frequency: 'monthly' } },
    });
    expect(expansion.error).toBeUndefined();
    expect(mockGenerateEstimate).toHaveBeenCalled();

    mockGenerateEstimate.mockClear();
    mockBuildAgentEstimateContext.mockResolvedValueOnce({ customer_account: account });
    const duplicate = await executeEstimateTool('compute_estimate', {
      leadId: 'lead-1',
      address: '1 Property A St, Bradenton FL 34208',
      homeSqFt: 2000,
      services: { lawn: { frequency: 'monthly' } },
    });
    expect(duplicate.error).toMatch(/already has active lawn_care/i);
    expect(mockGenerateEstimate).not.toHaveBeenCalled();
  });

  test('a draft with an unpriced requested service is refused', async () => {
    mockGenerateEstimate.mockReturnValue({
      summary: { recurringMonthlyAfterDiscount: 54.17, recurringAnnualAfterDiscount: 650, oneTimeTotal: 0 },
      waveGuard: { tier: 'bronze' },
      lineItems: [
        {
          service: 'pest_control', annualAfterDiscount: 650, monthlyAfterDiscount: 54.17,
          costs: { annualCost: 420 }, pricingConfidence: 'high',
        },
        { service: 'bed_bug', quoteRequired: true, manualReviewReasons: ['needs inspection'] },
      ],
    });
    const { database, writes } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: { ...INPUT.engineInputs, services: { pest: {}, bedBug: {} } },
    }, { confirmed: true });

    expect(result.error).toMatch(/no price for: bed_bug/i);
    expect(result.error).toMatch(/manual quote/i);
    expect(writes).toEqual([]);
  });

  test('a create never adopts a lead.customer_id that pricing did not recognize', async () => {
    const { database, writes } = makeDatabase({
      lead: {
        id: 'lead-1', customer_id: 'customer-linked-late', estimate_id: null,
        phone: '9415550100', email: 'road@example.com',
      },
      customer: { id: 'customer-linked-late' },
    });
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', INPUT, { confirmed: true });

    expect(result.success).toBe(true);
    const insert = writes.find((write) => write.table === 'estimates' && write.op === 'insert').payload;
    expect(insert.customer_id).toBeNull();
  });

  test('a phone-derived customer match is rejected when the locked lead phone changed', async () => {
    mockBuildAgentEstimateContext.mockResolvedValueOnce({
      lead: { id: 'lead-1', customer_id: null, phone: '9415550100' },
      customer_account: {
        recognized: true,
        customer_id: 'customer-by-old-phone',
        match_method: 'unambiguous_phone',
        existing_service_keys: [],
        current_services: [],
      },
      quote_form: { message_fields: [{ field: 'message', text: 'quarterly pest' }] },
      calls: [], sms_thread: [], activities: [],
    });
    const initialLead = {
      id: 'lead-1', customer_id: null, estimate_id: null,
      phone: '9415550100', email: 'road@example.com',
    };
    const { database, writes } = makeDatabase({
      lead: initialLead,
      lockedLead: { ...initialLead, phone: '9415550199' },
    });
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', INPUT, { confirmed: true });

    expect(result.error).toMatch(/lead phone changed after customer recognition/i);
    expect(writes.find((write) => write.table === 'estimates' && write.op === 'insert')).toBeUndefined();
  });

  test('a revision invalidates authored proposal data when engine pricing changes', async () => {
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
        proposal: { enabled: true, buildings: [{ name: 'Main office' }] },
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
    const stored = JSON.parse(update.estimate_data);
    expect(stored.proposal).toBeUndefined();
    expect(stored.proposalDelivery).toBeUndefined();
    expect(stored.proposalInvalidated?.reason).toMatch(/pricing was revised/i);
    expect(stored.estimatorEngine.origin).toBe('manual_agent');
  });
});

describe('Agent Estimate round-7 hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateEstimate.mockReturnValue(ENGINE_RESULT);
    mockDuplicateBlock.mockResolvedValue(null);
  });

  test('rejects a model-selected pricing version', async () => {
    const result = await executeEstimateTool('compute_estimate', {
      homeSqFt: 2000,
      services: { pest: { frequency: 'bimonthly', version: 'v2' } },
    });

    expect(result.error).toMatch(/version/);
    expect(mockGenerateEstimate).not.toHaveBeenCalled();
  });

  test('rejects the pre-slab legacy pricing compatibility payload', async () => {
    const result = await executeEstimateTool('compute_estimate', {
      homeSqFt: 2000,
      services: { preSlabTermiticide: { legacyPayload: true } },
    });

    expect(result.error).toMatch(/legacyPayload/);
    expect(mockGenerateEstimate).not.toHaveBeenCalled();
  });

  test('accepts canonical commercial output for a requested base service', async () => {
    mockGenerateEstimate.mockReturnValue({
      summary: {
        recurringMonthlyAfterDiscount: 200,
        recurringAnnualAfterDiscount: 2400,
        oneTimeTotal: 0,
      },
      waveGuard: { tier: 'bronze' },
      lineItems: [{
        service: 'commercial_pest',
        annualAfterDiscount: 2400,
        monthlyAfterDiscount: 200,
        costs: { annualCost: 1400 },
        pricingConfidence: 'high',
      }],
    });
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: {
        buildingSqFt: 2000,
        propertyType: 'commercial',
        services: { pest: { frequency: 'quarterly' } },
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.lines).toEqual([expect.objectContaining({ service: 'commercial_pest' })]);
  });

  test('binds lawn protocol and inventory review to the priced lawn track', async () => {
    mockGenerateEstimate.mockReturnValue({
      summary: {
        recurringMonthlyAfterDiscount: 75,
        recurringAnnualAfterDiscount: 900,
        oneTimeTotal: 0,
      },
      waveGuard: { tier: 'bronze' },
      lineItems: [{
        service: 'lawn_care',
        annualAfterDiscount: 900,
        monthlyAfterDiscount: 75,
        costs: { annualCost: 500 },
        pricingConfidence: 'high',
      }],
    });
    const { database } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    const result = await executeEstimateTool('create_agent_estimate_draft', {
      ...INPUT,
      engineInputs: { homeSqFt: 2000, services: { lawn: { track: 'bermuda' } } },
      protocolReview: [{
        serviceKey: 'lawn', programKey: 'lawn', lawnTrack: 'st_augustine', visitCount: 12,
      }],
      inventoryReview: [{
        serviceKey: 'lawn', productName: 'SpeedZone Southern', status: 'in_stock', onHand: 8,
      }],
    });

    expect(result.lane_reasons).toContain(
      'protocol review for lawn uses st_augustine instead of priced bermuda',
    );
    expect(result.inventoryReview).toEqual([
      expect.objectContaining({ productName: 'SpeedZone Southern', protocolMatched: true }),
    ]);
  });

  test('confirmed persistence rejects a second preview that drifted after approval', async () => {
    const { database, writes } = makeDatabase();
    mockDb.mockImplementation(database);
    mockTransactionDb = database;

    mockGenerateEstimate.mockReturnValue({
      ...ENGINE_RESULT,
      lineItems: [{
        ...ENGINE_RESULT.lineItems[0],
        tiers: [
          { tier: 'standard', annual: 650, monthly: 54.17 },
          { tier: 'premium', annual: 900, monthly: 75 },
        ],
      }],
    });
    const approvedPreview = await executeEstimateTool('create_agent_estimate_draft', INPUT);
    const approvedPreviewFingerprint = agentEstimatePreviewFingerprint(approvedPreview);
    mockGenerateEstimate.mockReturnValue({
      ...ENGINE_RESULT,
      lineItems: [{
        ...ENGINE_RESULT.lineItems[0],
        tiers: [
          { tier: 'standard', annual: 650, monthly: 54.17 },
          { tier: 'premium', annual: 960, monthly: 80 },
        ],
      }],
    });

    const result = await executeEstimateTool(
      'create_agent_estimate_draft',
      INPUT,
      { confirmed: true, approvedPreviewFingerprint },
    );

    expect(result).toEqual(expect.objectContaining({ preview_changed: true }));
    expect(result.error).toMatch(/changed after preview/i);
    expect(writes).toEqual([]);
  });

  test('a mixed known/unknown address set keeps the account-wide duplicate block', async () => {
    mockBuildAgentEstimateContext.mockResolvedValueOnce({
      customer_account: {
        recognized: true,
        customer_id: 'customer-1',
        existing_service_keys: ['pest_control'],
        current_services: [{
          key: 'pest_control',
          currentPerVisit: 117,
          serviceAddresses: ['1 Test St, Bradenton FL 34208'],
          serviceAddressesComplete: false,
        }],
      },
    });

    const result = await executeEstimateTool('compute_estimate', {
      leadId: 'lead-1',
      address: '500 Other Rd, Venice FL 34285',
      homeSqFt: 2000,
      services: { pest: { frequency: 'quarterly' } },
    });

    expect(result.error).toMatch(/already has active pest_control/i);
    expect(mockGenerateEstimate).not.toHaveBeenCalled();
  });

  test('a canonical commercial turf program blocks a requested lawn service', async () => {
    mockBuildAgentEstimateContext.mockResolvedValueOnce({
      customer_account: {
        recognized: true,
        customer_id: 'customer-1',
        existing_service_keys: [],
        current_services: [{ key: 'commercial_lawn_care', currentPerVisit: 300 }],
      },
    });

    const result = await executeEstimateTool('compute_estimate', {
      leadId: 'lead-1',
      homeSqFt: 2000,
      services: { lawn: { frequency: 'monthly' } },
    });

    expect(result.error).toMatch(/already has active lawn_care/i);
    expect(mockGenerateEstimate).not.toHaveBeenCalled();
  });
});
