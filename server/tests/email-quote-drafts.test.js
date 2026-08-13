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
      where: (...args) => { mockState.wheres.push({ table, args }); return chain; },
      whereNot: () => chain,
      whereNotNull: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      // The prior-thread scope scan is the only reader here; anything else
      // selecting from a table this mock doesn't stage gets an empty set.
      select: async () => (table === 'emails' ? mockState.threadEmails : []),
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

const mockGate = jest.fn((readiness) => readiness);
jest.mock('../routes/lead-webhook', () => ({
  applyLeadEstimateAutomationGate: (readiness) => mockGate(readiness),
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
  mockState = { inserts: [], updates: [], threadEmails: [], wheres: [] };
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

  test('a unit-first classifier address leads with its street', () => {
    // "Unit 7" as line1 misread the street as the city and readiness asked
    // for an address the customer had already supplied (codex GH r57 P2).
    expect(parseExtractedAddress('Unit 7, 123 Main St, Bradenton, FL 34201')).toEqual({
      line1: '123 Main St, Unit 7', city: 'Bradenton', state: 'FL', zip: '34201',
    });
    // A numberless street never swaps — line1 stays the designator and the
    // address-quality gate asks for the street, which is the right recovery.
    expect(parseExtractedAddress('Unit 7, Bayview Ter, Venice, FL').line1).toBe('Unit 7');
  });

  test('unit designators fold into line1 so the real city survives', () => {
    expect(parseExtractedAddress('123 Main St, Apt 4, Sarasota, FL 34239')).toEqual({
      line1: '123 Main St, Apt 4', city: 'Sarasota', state: 'FL', zip: '34239',
    });
    expect(parseExtractedAddress('55 Bay Dr, #12, Venice, FL')).toEqual({
      line1: '55 Bay Dr, #12', city: 'Venice', state: 'FL', zip: null,
    });
    // Streets named after the state never lose their name to token stripping.
    expect(parseExtractedAddress('710 Florida Ave, Palmetto, FL 34221').line1).toBe('710 Florida Ave');
  });
});

describe('maybeDraftEstimateFromEmailLead', () => {
  test('not-ready extraction leaves the email as a plain lead', async () => {
    mockReadiness.mockReturnValue({ ready: false, missing: ['phone'] });
    const result = await maybeDraftEstimateFromEmailLead({ email: EMAIL, extracted: EXTRACTED, lead: LEAD });
    expect(result).toEqual({ created: false, skipped: 'not_ready', missing: ['phone'] });
    expect(mockState.inserts).toHaveLength(0);
  });

  test('the global GATE_LEAD_ESTIMATE_AUTOMATION kill switch stops email drafts too', async () => {
    mockGate.mockImplementationOnce((readiness) => ({
      ...readiness, ready: false, disabled: true, status: 'disabled',
    }));
    const result = await maybeDraftEstimateFromEmailLead({ email: EMAIL, extracted: EXTRACTED, lead: LEAD });
    expect(result.created).toBe(false);
    expect(result.skipped).toBe('automation_disabled');
    expect(mockState.inserts).toHaveLength(0);
  });

  test('a partial extracted phone never drafts — the lock and dedupe need a real last-10', async () => {
    const result = await maybeDraftEstimateFromEmailLead({
      email: EMAIL,
      extracted: { ...EXTRACTED, phone: '555-0100' },
      lead: LEAD,
    });
    expect(result).toEqual({ created: false, skipped: 'no_usable_phone' });
    expect(mockReadiness).not.toHaveBeenCalled();
    expect(mockState.inserts).toHaveLength(0);
  });

  test('duplicate open automated estimate blocks inside the phone lock', async () => {
    mockDuplicate.mockResolvedValueOnce({ blocked: true, existingEstimateId: 'est-9' });
    const result = await maybeDraftEstimateFromEmailLead({ email: EMAIL, extracted: EXTRACTED, lead: LEAD });
    expect(result.created).toBe(false);
    expect(result.skipped).toBe('duplicate');
    expect(mockState.inserts).toHaveLength(0);
  });

  // A `From:` line is a reply header in a reply and a PAYLOAD FIELD in an
  // automated form notification. Cutting the body at the first `From:`
  // discarded the whole request when the notification opened with one, and
  // the premises wording in its `Message:` field never reached the scan.
  describe('form-notification bodies that open with a From: field', () => {
    const scannedMessage = () => mockReadiness.mock.calls[0][0].intake.message;

    test('a leading From: field keeps the request text that follows it', async () => {
      await maybeDraftEstimateFromEmailLead({
        email: {
          ...EMAIL,
          subject: 'New website inquiry',
          body_text: [
            'From: Jane Doe',
            'Phone: 941-555-0184',
            'Service: Pest Control',
            'Message: We need quarterly service for our warehouse on 48th Ave E.',
          ].join('\n'),
        },
        extracted: EXTRACTED,
        lead: LEAD,
      });
      expect(scannedMessage()).toContain('warehouse');
    });

    test('a preamble line above the From: field does not make it a reply header', async () => {
      // Form notifications routinely open with a banner line before their
      // fields; gating on "content precedes it" still dropped the request.
      await maybeDraftEstimateFromEmailLead({
        email: {
          ...EMAIL,
          subject: 'New inquiry',
          body_text: [
            'New website inquiry',
            'From: Jane Doe',
            'Phone: 941-555-0184',
            'Message: service our warehouse on 48th Ave E.',
          ].join('\n'),
        },
        extracted: EXTRACTED,
        lead: LEAD,
      });
      expect(scannedMessage()).toContain('warehouse');
    });

    test('the sender field itself is never scanned as premises wording', async () => {
      await maybeDraftEstimateFromEmailLead({
        email: {
          ...EMAIL,
          subject: 'New website inquiry',
          body_text: [
            'From: Jane Doe, Sarasota Warehouse Supply',
            'Message: quarterly service for my house please.',
          ].join('\n'),
        },
        extracted: EXTRACTED,
        lead: LEAD,
      });
      // An employer in the sender line says nothing about the treated
      // premises (codex r9 P2) — only the request text below it counts.
      expect(scannedMessage()).not.toContain('Warehouse Supply');
      expect(scannedMessage()).toContain('my house');
    });

    test('a real reply header still ends the sender\'s own text', async () => {
      await maybeDraftEstimateFromEmailLead({
        email: {
          ...EMAIL,
          subject: 'Re: quote',
          body_text: [
            'Sounds good, my number is below.',
            '',
            'From: Jane Doe <jane@example.com>',
            'Sent: Tuesday, August 11, 2026 2:04 PM',
            'To: contact@wavespestcontrolvenice.com',
            'Subject: quote',
            '',
            'Original ask about our warehouse.',
          ].join('\n'),
        },
        extracted: EXTRACTED,
        lead: LEAD,
      });
      expect(scannedMessage()).toContain('Sounds good');
      expect(scannedMessage()).not.toContain('Original ask');
    });

    test('a top-quoted header block with no prose above it is still quoted history', async () => {
      await maybeDraftEstimateFromEmailLead({
        email: {
          ...EMAIL,
          subject: 'Fwd: quote',
          body_text: [
            'From: Jane Doe <jane@example.com>',
            'Date: Tue, Aug 11, 2026 at 2:04 PM',
            'To: contact@wavespestcontrolvenice.com',
            'Subject: quote',
            '',
            'Original ask about our warehouse.',
          ].join('\n'),
        },
        extracted: EXTRACTED,
        lead: LEAD,
      });
      expect(scannedMessage()).not.toContain('Original ask');
    });

    test('an underscore divider inside a form does not end the scan', async () => {
      await maybeDraftEstimateFromEmailLead({
        email: {
          ...EMAIL,
          subject: 'New website inquiry',
          body_text: [
            'New website inquiry',
            '________________',
            'From: Jane Doe',
            'Message: pest control for our warehouse.',
          ].join('\n'),
        },
        extracted: EXTRACTED,
        lead: LEAD,
      });
      expect(scannedMessage()).toContain('warehouse');
    });

    test('an Outlook underscore separator before a quoted header block still cuts', async () => {
      await maybeDraftEstimateFromEmailLead({
        email: {
          ...EMAIL,
          subject: 'RE: quote',
          body_text: [
            'Here is my number.',
            '________________________________',
            'From: Jane Doe <jane@example.com>',
            'Sent: Tuesday, August 11, 2026 2:04 PM',
            'To: contact@wavespestcontrolvenice.com',
            'Subject: quote',
            '',
            'Original ask about our warehouse.',
          ].join('\n'),
        },
        extracted: EXTRACTED,
        lead: LEAD,
      });
      expect(scannedMessage()).toContain('my number');
      expect(scannedMessage()).not.toContain('warehouse');
    });

    test('a forwarded-message separator ends the scan before its header block', async () => {
      await maybeDraftEstimateFromEmailLead({
        email: {
          ...EMAIL,
          subject: 'Fwd: quote',
          body_text: [
            '---------- Forwarded message ---------',
            'From: Jane Doe <jane@example.com>',
            'Message: our warehouse needs service.',
          ].join('\n'),
        },
        extracted: EXTRACTED,
        lead: LEAD,
      });
      expect(scannedMessage()).not.toContain('warehouse');
    });
  });

  // PRIOR means received BEFORE this email — a retry of an older message
  // must not read the thread's later mail as its history (codex r53 P1).
  describe('prior-thread read is bounded to earlier mail', () => {
    const emailsWheres = () => mockState.wheres
      .filter((w) => w.table === 'emails')
      .map((w) => w.args);

    test('the query bounds on received_at when this email carries one', async () => {
      await maybeDraftEstimateFromEmailLead({ email: EMAIL, extracted: EXTRACTED, lead: LEAD });
      expect(emailsWheres()).toEqual(expect.arrayContaining([
        ['received_at', '<', EMAIL.received_at],
      ]));
    });

    test('an email without received_at keeps the whole-thread read', async () => {
      await maybeDraftEstimateFromEmailLead({
        email: { ...EMAIL, received_at: null },
        extracted: EXTRACTED,
        lead: LEAD,
      });
      expect(emailsWheres().some((args) => args[0] === 'received_at')).toBe(false);
    });
  });

  // The premises wording that decides residential-vs-commercial usually
  // arrives in the FIRST message of a thread; the reply that finally supplies
  // a phone often says nothing about the property. The lead row cannot carry
  // it (leads has no description column and the email insert writes no
  // transcript_summary), so the scan reads the thread's own stored mail.
  describe('prior-thread scope evidence', () => {
    const scannedMessage = () => mockReadiness.mock.calls[0][0].intake.message;

    test('an earlier commercial email in the thread reaches the readiness scan', async () => {
      mockState.threadEmails = [{
        subject: 'Pest control for our warehouse',
        body_text: 'We need quarterly service for our 12,000 sq ft warehouse.\n\nThanks',
        snippet: null,
      }];
      await maybeDraftEstimateFromEmailLead({
        email: { ...EMAIL, subject: 'Re: following up', body_text: 'Here is my number.' },
        extracted: EXTRACTED,
        lead: LEAD,
      });
      expect(scannedMessage()).toContain('warehouse');
      expect(scannedMessage()).toContain('12,000 sq ft');
    });

    test('the read is scoped to THIS lead — a stranger sharing the thread never carries (r58)', async () => {
      await maybeDraftEstimateFromEmailLead({
        email: { ...EMAIL, subject: 'Re: following up', body_text: 'Here is my number.' },
        extracted: EXTRACTED,
        lead: LEAD,
      });
      const emailWheres = mockState.wheres.filter((w) => w.table === 'emails').map((w) => w.args);
      expect(emailWheres).toEqual(expect.arrayContaining([['lead_id', 'lead-1']]));
    });

    test('no lead id means no thread read at all', async () => {
      mockState.threadEmails = [{ subject: 'warehouse ask', body_text: 'our warehouse', snippet: null }];
      await maybeDraftEstimateFromEmailLead({
        email: { ...EMAIL, subject: 'Quote please', body_text: 'For my house.' },
        extracted: EXTRACTED,
        lead: { ...LEAD, id: null },
      });
      expect(scannedMessage()).not.toContain('warehouse');
    });

    test('a thread with no earlier mail scans this message alone', async () => {
      await maybeDraftEstimateFromEmailLead({
        email: { ...EMAIL, subject: 'Quote please', body_text: 'For my house.' },
        extracted: EXTRACTED,
        lead: LEAD,
      });
      expect(scannedMessage()).toBe('Quote please\nFor my house.');
    });

    test('a failed thread read degrades to this message, never losing the lead', async () => {
      const db = require('../models/db');
      db.mockImplementationOnce(() => ({
        where: () => { throw new Error('connection reset'); },
      }));
      const result = await maybeDraftEstimateFromEmailLead({
        email: { ...EMAIL, subject: 'Quote please', body_text: 'For my house.' },
        extracted: EXTRACTED,
        lead: LEAD,
      });
      expect(scannedMessage()).toBe('Quote please\nFor my house.');
      expect(result.created).toBe(true);
    });
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
