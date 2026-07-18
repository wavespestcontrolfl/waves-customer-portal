/**
 * Email → draft-estimate lane (GATE_EMAIL_QUOTE_DRAFTS).
 *
 * Pins: the address parse feeding the readiness gate, the not-ready skip
 * (email stays a plain lead), the duplicate guard riding the phone lock,
 * the draft insert shape (source email_inquiry, customer-visible notes NULL,
 * provenance in estimate_data only), and the lead→estimate link.
 */

jest.mock('googleapis', () => ({ google: {} }));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/email/gmail-client', () => ({
  trashMessage: jest.fn(),
  archiveMessage: jest.fn(),
  modifyLabels: jest.fn(),
}));

let mockState;
jest.mock('../models/db', () => {
  const builderFor = (table) => {
    const chain = {
      where: () => chain,
      update: async (payload) => {
        mockState.updates.push({ table, payload });
        return 1;
      },
      insert: (payload) => ({
        returning: async () => {
          mockState.inserts.push({ table, payload });
          return [{ id: `${table}-row-1` }];
        },
      }),
    };
    return chain;
  };
  return jest.fn((table) => builderFor(table));
});

const mockReadiness = jest.fn();
const mockBuilder = jest.fn();
jest.mock('../services/lead-estimate-automation', () => ({
  evaluateLeadEstimateAutomationReadiness: (...args) => mockReadiness(...args),
  buildAutomatedLeadDraftEstimate: (...args) => mockBuilder(...args),
}));

const mockDuplicate = jest.fn();
jest.mock('../services/estimate-automation-duplicates', () => ({
  blockIfAutomatedEstimateDuplicate: (...args) => mockDuplicate(...args),
  // The lock hands its transaction executor to the callback — reuse the db
  // mock so trx('estimates') resolves to the same recording builder.
  withAutomatedEstimatePhoneLock: async (_phone, callback) => callback(require('../models/db')),
}));

// The lock passes its executor to the callback; the db mock above must also
// serve when the callback uses it as a query builder.
jest.mock('../services/email/spam-blocker', () => ({
  isOperationalDomain: () => false,
  domainFromAddress: () => 'example.com',
  domainMatches: () => false,
  normalizeAddress: (a) => String(a || '').toLowerCase(),
}));
jest.mock('../services/customer-stages', () => ({ whereLiveCustomer: (q) => q }));

const {
  parseExtractedAddress,
  maybeDraftEstimateFromEmailLead,
  emailQuoteDraftsEnabled,
} = require('../services/email/email-actions');

const EMAIL = { id: 'email-1', gmail_thread_id: 'thread-1', received_at: '2026-07-18T12:00:00Z' };
const LEAD = { id: 'lead-1', first_name: 'Pat', last_name: 'Jones', email: 'pat@example.com' };
const EXTRACTED = {
  phone: '(941) 555-0100',
  address: '123 Palm Ave, Sarasota, FL 34239',
  service_interest: 'Pest Control',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockState = { inserts: [], updates: [] };
  mockReadiness.mockReturnValue({ ready: true, serviceInterest: 'Pest Control', missing: [] });
  mockBuilder.mockReturnValue({
    monthly: 62, annual: 744, oneTimeTotal: 0,
    automation: { status: 'generated' },
    estimateData: { automation: { draftEstimateAutomation: { status: 'generated' } } },
  });
  mockDuplicate.mockResolvedValue(null);
});

describe('emailQuoteDraftsEnabled', () => {
  test('defaults off', () => {
    delete process.env.GATE_EMAIL_QUOTE_DRAFTS;
    expect(emailQuoteDraftsEnabled()).toBe(false);
    process.env.GATE_EMAIL_QUOTE_DRAFTS = 'true';
    expect(emailQuoteDraftsEnabled()).toBe(true);
    delete process.env.GATE_EMAIL_QUOTE_DRAFTS;
  });
});

describe('parseExtractedAddress', () => {
  test('splits street / city / state / zip from a classifier address string', () => {
    expect(parseExtractedAddress('123 Palm Ave, Sarasota, FL 34239')).toEqual({
      line1: '123 Palm Ave', city: 'Sarasota', state: 'FL', zip: '34239',
    });
  });

  test('partial addresses degrade without inventing fields', () => {
    expect(parseExtractedAddress('123 Palm Ave')).toEqual({
      line1: '123 Palm Ave', city: null, state: null, zip: null,
    });
    expect(parseExtractedAddress('')).toEqual({ line1: null, city: null, state: null, zip: null });
  });
});

describe('maybeDraftEstimateFromEmailLead', () => {
  test('not-ready extraction leaves the email as a plain lead', async () => {
    mockReadiness.mockReturnValue({ ready: false, missing: ['phone'] });
    const result = await maybeDraftEstimateFromEmailLead({ email: EMAIL, extracted: EXTRACTED, lead: LEAD });
    expect(result).toEqual({ created: false, skipped: 'not_ready', missing: ['phone'] });
    expect(mockState.inserts).toHaveLength(0);
  });

  test('duplicate open automated estimate blocks inside the phone lock', async () => {
    mockDuplicate.mockResolvedValueOnce({ blocked: true, existingEstimateId: 'est-9' });
    const result = await maybeDraftEstimateFromEmailLead({ email: EMAIL, extracted: EXTRACTED, lead: LEAD });
    expect(result.created).toBe(false);
    expect(result.skipped).toBe('duplicate');
    expect(mockState.inserts).toHaveLength(0);
  });

  test('ready extraction inserts a priced email_inquiry draft and links the lead', async () => {
    const result = await maybeDraftEstimateFromEmailLead({ email: EMAIL, extracted: EXTRACTED, lead: LEAD });
    expect(result.created).toBe(true);

    const insert = mockState.inserts.find((entry) => entry.table === 'estimates');
    expect(insert).toBeTruthy();
    expect(insert.payload.source).toBe('email_inquiry');
    expect(insert.payload.status).toBe('draft');
    expect(insert.payload.customer_phone).toBe(EXTRACTED.phone);
    expect(insert.payload.monthly_total).toBe(62);
    // estimates.notes is customer-visible — provenance must live in
    // estimate_data only.
    expect(insert.payload.notes).toBeNull();
    const data = JSON.parse(insert.payload.estimate_data);
    expect(data.emailInquiry.emailId).toBe('email-1');
    expect(data.lead_id).toBe('lead-1');

    const link = mockState.updates.find((entry) => entry.table === 'leads');
    expect(link.payload.estimate_id).toBe(result.estimateId);
  });
});
