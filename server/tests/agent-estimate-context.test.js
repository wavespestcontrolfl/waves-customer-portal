const mockLoadCustomerByPhone = jest.fn();
const mockLoadSmsThread = jest.fn(async () => [{ body: 'phone-scoped text' }]);
const mockLoadPriorEstimates = jest.fn(async () => [{ id: 'phone-scoped-estimate' }]);
let mockContextLead = null;
let mockContextCallRows = [];
let mockContextOtherLeads = [];

jest.mock('../models/db', () => {
  const db = (table) => {
    const builder = {
      _leftJoin: false,
      leftJoin() { this._leftJoin = true; return this; },
      select() { return this; },
      where() { return this; },
      whereNull() { return this; },
      whereNot() { return this; },
      whereRaw() { return this; },
      orderBy() { return this; },
      limit() { return this; },
      async first() {
        if (table === 'leads') return this._leftJoin ? mockContextLead : null;
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
