const mockLoadCustomerByPhone = jest.fn();
const mockLoadSmsThread = jest.fn(async () => [{ body: 'phone-scoped text' }]);
const mockLoadPriorEstimates = jest.fn(async () => [{ id: 'phone-scoped-estimate' }]);
let mockContextLead = null;
let mockContextCallRows = [];
let mockContextSidCallRow = null;
let mockContextOtherLeads = [];
let mockLinkedCustomerRow = null;
let mockOtherCustomerOnPhone = null;

jest.mock('../models/db', () => {
  const db = (table) => {
    const builder = {
      _leftJoin: false,
      _whereRaw: false,
      leftJoin() { this._leftJoin = true; return this; },
      select() { return this; },
      where() { return this; },
      whereNull() { return this; },
      whereNot() { return this; },
      whereRaw() { this._whereRaw = true; return this; },
      orderBy() { return this; },
      limit() { return this; },
      modify(fn) { fn(this); return this; },
      async first() {
        if (table === 'leads') return this._leftJoin ? mockContextLead : null;
        if (table === 'call_log') return mockContextSidCallRow;
        // The linked-customer load queries by id; the other-owner probe is
        // the only customers query using whereRaw (last-10 match).
        if (table === 'customers') return this._whereRaw ? mockOtherCustomerOnPhone : mockLinkedCustomerRow;
        return null;
      },
      catch() { return this; },
      then(resolve) {
        if (table === 'call_log') return resolve(mockContextCallRows);
        if (table === 'leads') return resolve(mockContextOtherLeads);
        return resolve([]);
      },
    };
    return builder;
  };
  return db;
});
jest.mock('../services/estimator-engine/context-builder', () => ({
  loadCustomerByPhone: (...args) => mockLoadCustomerByPhone(...args),
  loadPriorEstimates: (...args) => mockLoadPriorEstimates(...args),
  loadSmsThread: (...args) => mockLoadSmsThread(...args),
  _private: {
    extractionFromCall: () => ({ extraction: {}, source: 'none' }),
    firstExternalPhone: (...candidates) => {
      const SENTINELS = new Set(['266696687', '7378742833', '86282452253']);
      for (const candidate of candidates) {
        const digits = String(candidate || '').replace(/\D/g, '');
        if (digits.length >= 10 && !SENTINELS.has(digits) && !SENTINELS.has(digits.replace(/^1/, ''))) {
          return candidate;
        }
      }
      return null;
    },
    last10: (value) => {
      const digits = String(value || '').replace(/\D/g, '');
      return digits.length >= 10 ? digits.slice(-10) : null;
    },
  },
}));
jest.mock('../services/estimate-membership-context', () => ({
  loadCurrentServiceSpendContext: jest.fn(async () => ({
    existingServiceKeys: [], currentServices: [], currentSpendPerVisitTotal: 0,
    currentTier: null, currentTierLabel: null, currentDiscountPct: 0,
  })),
}));

const { buildAgentEstimateContext, _private } = require('../services/agent-estimate-context');

describe('Agent Estimate context helpers', () => {
  test('finds nested quote-form narrative without copying unrelated scalar fields', () => {
    const rows = _private.collectSubmissionText({
      customer: { first_name: 'Synthetic', phone: '9410000000' },
      quote: {
        service: 'lawn',
        details: { message: 'Please price the front and side lawn only.' },
        comments: 'Gate is on the east side.',
      },
    });
    expect(rows).toEqual([
      { field: 'quote.details.message', text: 'Please price the front and side lawn only.' },
      { field: 'quote.comments', text: 'Gate is on the east side.' },
    ]);
    expect(JSON.stringify(rows)).not.toContain('9410000000');
  });

  test('suggested prompt carries the pricing, property, inventory, and no-send boundaries', () => {
    const prompt = _private.suggestedPrompt({ first_name: 'Synthetic', last_name: 'Lead' }, null);
    expect(prompt).toMatch(/home\/building sqft/i);
    expect(prompt).toMatch(/treatable turf/i);
    expect(prompt).toMatch(/\$35 loaded labor rate/i);
    expect(prompt).toMatch(/untracked/i);
    expect(prompt).toMatch(/only compute_estimate for dollars/i);
    expect(prompt).toMatch(/never send automatically/i);
  });

  test('existing draft changes the prompt to revision language', () => {
    const prompt = _private.suggestedPrompt(
      { first_name: 'Synthetic', last_name: 'Lead' },
      { status: 'draft', source: 'estimator_engine' },
    );
    expect(prompt).toMatch(/review and revise/i);
  });

  test('recognized customer prompt preserves current service and quotes only additions', () => {
    const prompt = _private.suggestedPrompt(
      { id: 'lead-1', first_name: 'David', last_name: 'Thomas' },
      null,
      { recognized: true },
    );
    expect(prompt).toMatch(/recognized customer expansion/i);
    expect(prompt).toMatch(/preserve every active current service/i);
    expect(prompt).toMatch(/quote only services.*wants to add/i);
    expect(prompt).toMatch(/selected lead ID to compute_estimate/i);
    expect(prompt).toMatch(/presentation.*newly quoted service mix/i);
  });

  test('oversized extracted data is bounded before entering the model prompt', () => {
    const compact = _private.compactJson({ message: 'x'.repeat(20000) }, 100);
    expect(compact.truncated).toBe(true);
    expect(compact.raw_excerpt.length).toBe(100);
  });

  test('an unavailable authoritatively linked customer fails closed', async () => {
    mockContextLead = {
      id: 'lead-linked', customer_id: 'customer-missing', estimate_id: null,
      first_name: 'Linked', last_name: 'Customer', phone: '9415550100',
      email: null, address: '1 St', city: 'Bradenton', zip: '34208',
      twilio_call_sid: null, transcript_summary: null, extracted_data: null,
      status: 'new',
    };
    mockContextCallRows = [];
    mockContextOtherLeads = [];

    const context = await buildAgentEstimateContext('lead-linked');

    expect(context.customer_profile).toBeNull();
    expect(context.customer_account).toEqual(expect.objectContaining({
      recognized: true,
      customer_id: 'customer-missing',
      match_method: 'linked_customer_id_unavailable',
      service_context_unavailable: true,
    }));
  });
});

describe('ambiguous customer phone suppression', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContextLead = {
      id: 'lead-1', customer_id: null, estimate_id: null,
      first_name: 'Pat', last_name: 'Shared', phone: '9415550100',
      email: null, address: '1 St', city: 'Bradenton', zip: '34208',
      twilio_call_sid: null, transcript_summary: null, extracted_data: null,
      status: 'new',
    };
    mockContextCallRows = [{
      id: 'call-9', twilio_call_sid: 'CA-other-lead', direction: 'inbound',
      duration_seconds: 60, transcription: 'someone else calling', created_at: '2026-07-01',
    }];
    mockContextOtherLeads = [];
  });

  test('suppresses SMS, prior estimates, and phone-matched calls when the phone matches multiple customers', async () => {
    mockLoadCustomerByPhone.mockResolvedValue({ customer: { id: 'cust-1' }, ambiguous: true });

    const context = await buildAgentEstimateContext('lead-1');

    expect(context.customer_profile).toBeNull();
    expect(context.customer_account.recognized).toBe(false);
    expect(context.customer_account.match_method).toBe('ambiguous_customer_suppressed');
    expect(context.ambiguous_customer_history_suppressed).toBe(true);
    expect(context.shared_phone_history_suppressed).toBe(false);
    expect(context.sms_thread).toEqual([]);
    expect(context.prior_estimates).toEqual([]);
    expect(context.calls).toEqual([]);
    expect(mockLoadSmsThread).not.toHaveBeenCalled();
    expect(mockLoadPriorEstimates).not.toHaveBeenCalled();
  });

  test('an unambiguous phone keeps loading phone-scoped history', async () => {
    mockLoadCustomerByPhone.mockResolvedValue({ customer: null, ambiguous: false });

    const context = await buildAgentEstimateContext('lead-1');

    expect(context.ambiguous_customer_history_suppressed).toBe(false);
    expect(context.calls).toHaveLength(1);
    expect(context.sms_thread).toEqual([{ body: 'phone-scoped text' }]);
    expect(mockLoadSmsThread).toHaveBeenCalled();
    expect(mockLoadPriorEstimates).toHaveBeenCalled();
  });
});

describe('phone customer lookup failure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContextLead = {
      id: 'lead-1', customer_id: null, estimate_id: null,
      first_name: 'Pat', last_name: 'Member', phone: '9415550100',
      email: null, address: '1 St', city: 'Bradenton', zip: '34208',
      twilio_call_sid: null, transcript_summary: null, extracted_data: null,
      status: 'new',
    };
    mockContextCallRows = [];
    mockContextOtherLeads = [];
  });

  test('an errored customers query fails closed instead of pricing as a new prospect', async () => {
    // loadCustomerByPhone's catch path — a DOWN query, not a no-match.
    mockLoadCustomerByPhone.mockResolvedValue({ customer: null, ambiguous: false, unavailable: true });

    const context = await buildAgentEstimateContext('lead-1');

    expect(context.customer_profile).toBeNull();
    expect(context.customer_account).toEqual(expect.objectContaining({
      recognized: true,
      customer_id: null,
      match_method: 'phone_lookup_unavailable',
      service_context_unavailable: true,
    }));
    expect(context.customer_account.existing_service_keys).toEqual([]);
  });

  test('a genuine no-match still prices as a new prospect', async () => {
    mockLoadCustomerByPhone.mockResolvedValue({ customer: null, ambiguous: false });

    const context = await buildAgentEstimateContext('lead-1');

    expect(context.customer_profile).toBeNull();
    expect(context.customer_account.recognized).toBe(false);
    expect(context.customer_account.match_method).toBeNull();
    expect(context.customer_account.service_context_unavailable).toBeUndefined();
  });
});

describe('linked customer on a phone another customer also owns', () => {
  const LINKED = {
    id: 'customer-linked', first_name: 'Pat', last_name: 'Linked',
    phone: '9415550100', email: null, address_line1: '1 St', city: 'Bradenton',
    state: 'FL', zip: '34208', pipeline_stage: 'active_customer',
    waveguard_tier: 'Silver', lawn_type: null, property_sqft: null,
    lot_sqft: null, property_type: null, company_name: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockContextLead = {
      id: 'lead-1', customer_id: 'customer-linked', estimate_id: null,
      first_name: 'Pat', last_name: 'Linked', phone: '9415550100',
      email: null, address: '1 St', city: 'Bradenton', zip: '34208',
      twilio_call_sid: null, transcript_summary: null, extracted_data: null,
      status: 'new',
    };
    mockContextCallRows = [{
      id: 'call-9', twilio_call_sid: 'CA-phone-history', direction: 'inbound',
      duration_seconds: 60, transcription: 'phone-matched call', created_at: '2026-07-01',
    }];
    mockContextOtherLeads = [];
    mockLinkedCustomerRow = LINKED;
    mockOtherCustomerOnPhone = null;
  });

  afterAll(() => {
    mockLinkedCustomerRow = null;
    mockOtherCustomerOnPhone = null;
  });

  test('another customer row on the number suppresses phone-scoped history but keeps the linked identity', async () => {
    mockOtherCustomerOnPhone = { id: 'customer-other' };

    const context = await buildAgentEstimateContext('lead-1');

    // Identity stays recognized — the link is authoritative.
    expect(context.customer_account).toEqual(expect.objectContaining({
      recognized: true,
      customer_id: 'customer-linked',
      match_method: 'linked_customer_id',
    }));
    // But the OTHER account's comms must not enter this lead's evidence pack.
    expect(context.customer_phone_shared_with_other_customer).toBe(true);
    expect(context.sms_thread).toEqual([]);
    expect(context.prior_estimates).toEqual([]);
    expect(context.calls).toEqual([]);
    expect(mockLoadSmsThread).not.toHaveBeenCalled();
    expect(mockLoadPriorEstimates).not.toHaveBeenCalled();
  });

  test('an exclusively-owned number keeps loading phone-scoped history (regression)', async () => {
    const context = await buildAgentEstimateContext('lead-1');

    expect(context.customer_phone_shared_with_other_customer).toBe(false);
    expect(context.customer_account.match_method).toBe('linked_customer_id');
    expect(context.sms_thread).toEqual([{ body: 'phone-scoped text' }]);
    expect(context.calls).toHaveLength(1);
    expect(mockLoadSmsThread).toHaveBeenCalled();
    expect(mockLoadPriorEstimates).toHaveBeenCalled();
  });
});

describe('suppressed-caller sentinel phones', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContextLead = {
      id: 'lead-1', customer_id: null, estimate_id: null,
      first_name: 'Blocked', last_name: 'Caller', phone: '+7378742833',
      email: null, address: '1 St', city: 'Bradenton', zip: '34208',
      twilio_call_sid: null, transcript_summary: null, extracted_data: null,
      status: 'new',
    };
    mockContextCallRows = [{
      id: 'call-77', twilio_call_sid: 'CA-stranger', direction: 'inbound',
      duration_seconds: 45, transcription: 'unrelated blocked caller', created_at: '2026-07-02',
    }];
  });

  test('a RESTRICTED sentinel phone never keys phone-scoped history or customer matching', async () => {
    mockLoadCustomerByPhone.mockResolvedValue({ customer: { id: 'cust-x' }, ambiguous: false });

    const context = await buildAgentEstimateContext('lead-1');

    expect(context.calls).toEqual([]);
    expect(context.sms_thread).toEqual([]);
    expect(context.prior_estimates).toEqual([]);
    expect(context.customer_profile).toBeNull();
    expect(context.customer_account.recognized).toBe(false);
    expect(mockLoadCustomerByPhone).not.toHaveBeenCalled();
    expect(mockLoadSmsThread).not.toHaveBeenCalled();
    expect(mockLoadPriorEstimates).not.toHaveBeenCalled();
  });
});

describe('lead call anchoring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContextLead = {
      id: 'lead-1', customer_id: null, estimate_id: null,
      first_name: 'Pat', last_name: 'Caller', phone: '9415550100',
      email: null, address: '1 St', city: 'Bradenton', zip: '34208',
      twilio_call_sid: 'CA-anchor', transcript_summary: null, extracted_data: null,
      status: 'new',
    };
    mockContextSidCallRow = {
      id: 'call-anchor', twilio_call_sid: 'CA-anchor', direction: 'inbound',
      duration_seconds: 120, transcription: 'the quote call itself', created_at: '2026-07-01',
    };
    // Three NEWER phone-matched calls — before the anchor fix these filled
    // every slot and crowded the lead's own transcript out of the pack.
    mockContextCallRows = [
      { id: 'call-n1', twilio_call_sid: 'CA-n1', direction: 'inbound', duration_seconds: 30, transcription: 'newer 1', created_at: '2026-07-10' },
      { id: 'call-n2', twilio_call_sid: 'CA-n2', direction: 'outbound', duration_seconds: 30, transcription: 'newer 2', created_at: '2026-07-09' },
      { id: 'call-n3', twilio_call_sid: 'CA-n3', direction: 'inbound', duration_seconds: 30, transcription: 'newer 3', created_at: '2026-07-08' },
    ];
    mockContextOtherLeads = [];
  });
  afterEach(() => { mockContextSidCallRow = null; });

  test("the lead's own call is never crowded out by newer phone-matched calls", async () => {
    mockLoadCustomerByPhone.mockResolvedValue({ customer: null, ambiguous: false });

    const context = await buildAgentEstimateContext('lead-1');

    expect(context.calls.map((call) => call.call_sid)).toContain('CA-anchor');
  });
});

describe('repeat leads vs shared phones', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContextLead = {
      id: 'lead-1', customer_id: null, estimate_id: null,
      first_name: 'Pat', last_name: 'Repeat', phone: '9415550100',
      email: null, address: '1 St', city: 'Bradenton', zip: '34208',
      twilio_call_sid: null, transcript_summary: null, extracted_data: null,
      status: 'new',
    };
    mockContextCallRows = [];
    mockLoadCustomerByPhone.mockResolvedValue({ customer: null, ambiguous: false });
  });

  test('an older lead with the SAME full name is a repeat lead, not a shared line', async () => {
    mockContextOtherLeads = [{ first_name: 'Pat', last_name: 'Repeat' }];

    const context = await buildAgentEstimateContext('lead-1');

    expect(context.shared_phone_history_suppressed).toBe(false);
    expect(mockLoadSmsThread).toHaveBeenCalled();
    expect(mockLoadCustomerByPhone).toHaveBeenCalled();
  });

  test('a different name on the same number stays a shared line', async () => {
    mockContextOtherLeads = [{ first_name: 'Sam', last_name: 'Other' }];

    const context = await buildAgentEstimateContext('lead-1');

    expect(context.shared_phone_history_suppressed).toBe(true);
    expect(mockLoadSmsThread).not.toHaveBeenCalled();
  });

  test('a nameless row on the same number stays conservatively shared', async () => {
    mockContextOtherLeads = [{ first_name: null, last_name: null }];

    const context = await buildAgentEstimateContext('lead-1');

    expect(context.shared_phone_history_suppressed).toBe(true);
  });
});
