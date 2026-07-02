/**
 * Email→lead ingestion guards (handleLeadInquiry). Regression for the prod
 * incidents where a lead was auto-created from a reply to Waves' own
 * auto-acknowledgment ("Re: Thanks for reaching out to Waves, Santos") and
 * junk leads were minted with automated SENDER addresses stored as the
 * lead's contact email (voicemail@twimlets.com, do-not-reply@thumbtack.com,
 * a retired payment processor's messenger bot).
 *
 * Guards under test: existing-customer skip (silent), confidence floor
 * (needs-review), hard-skip sender list (silent), automated-sender contact
 * rules, vendor skip (needs-review), Waves auto-ack / reply-thread skip
 * (needs-review).
 */

jest.mock('googleapis', () => ({ google: {} }), { virtual: true });
jest.mock('../models/db', () => jest.fn());
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

const db = require('../models/db');
const {
  handleLeadInquiry,
  isHardSkippedLeadSender,
  isAutomatedSender,
  isWavesAutoAckReply,
} = require('../services/email/email-actions');

const CHAIN_METHODS = [
  'where', 'orWhere', 'whereRaw', 'orWhereRaw', 'whereNot', 'whereNotIn',
  'whereNull', 'whereNotNull', 'whereILike', 'andWhereILike', 'orderBy',
];

/**
 * Chainable knex mock. `.first()` resolves per-table FIFO queues
 * (missing/exhausted queues resolve null); inserts and updates are recorded
 * for assertions.
 */
function setupDb(firstResults = {}) {
  const state = { inserts: [], updates: [], firstTables: [], raws: [] };
  const queues = Object.fromEntries(
    Object.entries(firstResults).map(([table, rows]) => [table, [...rows]])
  );

  db.mockImplementation((table) => {
    const builder = {};
    for (const method of CHAIN_METHODS) {
      builder[method] = jest.fn((...args) => {
        if (typeof args[0] === 'function') args[0].call(builder);
        if (method.toLowerCase().includes('raw')) {
          state.raws.push({ table, sql: args[0], bindings: args[1] });
        }
        return builder;
      });
    }
    builder.first = jest.fn(async () => {
      state.firstTables.push(table);
      const queue = queues[table];
      return queue && queue.length ? queue.shift() : null;
    });
    builder.update = jest.fn(async (patch) => {
      state.updates.push({ table, patch });
      return 1;
    });
    builder.insert = jest.fn((row) => {
      state.inserts.push({ table, row });
      const rows = (Array.isArray(row) ? row : [row])
        .map((r, idx) => ({ id: `${table}-${state.inserts.length}-${idx}`, ...r }));
      const promise = Promise.resolve(rows);
      return {
        returning: jest.fn(async () => rows),
        then: promise.then.bind(promise),
        catch: promise.catch.bind(promise),
      };
    });
    return builder;
  });

  return state;
}

function makeEmail(overrides = {}) {
  return {
    id: 'email-1',
    gmail_id: 'g-1',
    gmail_thread_id: 'thread-1',
    from_address: 'jane.prospect@example.com',
    from_name: 'Jane Prospect',
    subject: 'Need a pest control quote',
    received_at: new Date('2026-07-01T12:00:00Z'),
    classification: null,
    extracted_data: null,
    ...overrides,
  };
}

function makeClassification(overrides = {}) {
  return {
    category: 'lead_inquiry',
    confidence: 0.95,
    summary: 'Prospect wants a pest control quote',
    extracted: {
      person_name: 'Jane Prospect',
      email: 'jane.prospect@example.com',
      phone: '(941) 555-1234',
      service_interest: 'pest control',
      ...(overrides.extracted || {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'extracted')),
  };
}

function insertsFor(state, table) {
  return state.inserts.filter((i) => i.table === table);
}

function emailUpdates(state) {
  return state.updates.filter((u) => u.table === 'emails').map((u) => u.patch);
}

describe('handleLeadInquiry — lead-creation guards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
  });

  afterEach(() => {
    delete process.env.EMAIL_LEAD_MIN_CONFIDENCE;
  });

  test('happy path: new prospect still creates a lead + new_lead notification', async () => {
    const state = setupDb();

    const result = await handleLeadInquiry(makeEmail(), makeClassification());

    expect(result).toEqual({ action: 'lead_created', leadId: expect.any(String) });
    const [leadInsert] = insertsFor(state, 'leads');
    expect(leadInsert.row).toMatchObject({
      first_name: 'Jane',
      last_name: 'Prospect',
      email: 'jane.prospect@example.com',
      phone: '(941) 555-1234',
      lead_type: 'email_inquiry',
      status: 'new',
    });
    expect(insertsFor(state, 'lead_activities')).toHaveLength(1);
    const [notification] = insertsFor(state, 'notifications');
    expect(notification.row.category).toBe('new_lead');
    expect(emailUpdates(state)).toContainEqual(
      expect.objectContaining({ auto_action: 'lead_created' })
    );
  });

  test('existing live customer by email skips lead creation silently', async () => {
    const state = setupDb({ customers: [{ id: 'cust-1' }] });

    const result = await handleLeadInquiry(makeEmail(), makeClassification());

    expect(result).toEqual({ action: 'skipped_existing_customer', customerId: 'cust-1' });
    expect(insertsFor(state, 'leads')).toHaveLength(0);
    expect(insertsFor(state, 'notifications')).toHaveLength(0);
    expect(emailUpdates(state)).toContainEqual(
      expect.objectContaining({
        customer_id: 'cust-1',
        auto_action: 'lead_skipped_existing_customer',
      })
    );
  });

  test('existing live customer by phone (last-10 digits) also skips', async () => {
    // Email lookup misses, phone lookup hits.
    const state = setupDb({ customers: [null, { id: 'cust-2' }] });

    const result = await handleLeadInquiry(
      makeEmail(),
      makeClassification({ extracted: { phone: '+1 (941) 555-1234' } })
    );

    expect(result).toEqual({ action: 'skipped_existing_customer', customerId: 'cust-2' });
    expect(insertsFor(state, 'leads')).toHaveLength(0);
    const phoneRaw = state.raws.find((r) => r.table === 'customers' && String(r.sql).includes('RIGHT('));
    expect(phoneRaw).toBeDefined();
    expect(phoneRaw.bindings).toEqual(['9415551234']);
  });

  test('soft-delete filter is applied to the customer lookup', async () => {
    setupDb();
    const email = makeEmail();
    await handleLeadInquiry(email, makeClassification());

    // Every customers query in the guard must exclude soft-deleted rows.
    const customerBuilders = db.mock.calls
      .map((call, idx) => ({ table: call[0], result: db.mock.results[idx].value }))
      .filter((b) => b.table === 'customers');
    expect(customerBuilders.length).toBeGreaterThan(0);
    for (const { result } of customerBuilders) {
      expect(result.whereNull).toHaveBeenCalledWith('deleted_at');
    }
  });

  test('confidence below the floor blocks creation and raises a needs-review notification', async () => {
    const state = setupDb();

    const result = await handleLeadInquiry(makeEmail(), makeClassification({ confidence: 0.4 }));

    expect(result).toEqual({ action: 'lead_needs_review', reason: 'low_confidence' });
    expect(insertsFor(state, 'leads')).toHaveLength(0);
    const [notification] = insertsFor(state, 'notifications');
    expect(notification.row.category).toBe('email_alert');
    expect(notification.row.title).toContain('needs review');
    expect(JSON.parse(notification.row.metadata)).toMatchObject({
      emailId: 'email-1',
      reason: 'low_confidence',
    });
    expect(emailUpdates(state)).toContainEqual(
      expect.objectContaining({ auto_action: 'lead_needs_review:low_confidence' })
    );
  });

  test('missing confidence counts as below the floor', async () => {
    const state = setupDb();

    const result = await handleLeadInquiry(makeEmail(), makeClassification({ confidence: undefined }));

    expect(result).toEqual({ action: 'lead_needs_review', reason: 'low_confidence' });
    expect(insertsFor(state, 'leads')).toHaveLength(0);
  });

  test('EMAIL_LEAD_MIN_CONFIDENCE env var overrides the default floor', async () => {
    process.env.EMAIL_LEAD_MIN_CONFIDENCE = '0.3';
    const state = setupDb();

    const result = await handleLeadInquiry(makeEmail(), makeClassification({ confidence: 0.4 }));

    expect(result.action).toBe('lead_created');
    expect(insertsFor(state, 'leads')).toHaveLength(1);
  });

  test('hard-skip senders never create a lead and skip silently (no notification)', async () => {
    const state = setupDb();

    const result = await handleLeadInquiry(
      makeEmail({ from_address: 'voicemail@twimlets.com', from_name: null }),
      makeClassification({ extracted: { email: 'voicemail@twimlets.com', phone: null } })
    );

    expect(result).toEqual({ action: 'skipped_automated_sender' });
    expect(insertsFor(state, 'leads')).toHaveLength(0);
    expect(insertsFor(state, 'notifications')).toHaveLength(0);
    expect(emailUpdates(state)).toContainEqual(
      expect.objectContaining({ auto_action: 'lead_skipped_automated_sender' })
    );
    // Nothing else was queried — machine noise short-circuits before dedup.
    expect(state.firstTables).toHaveLength(0);
  });

  test('automated sender with a real extracted contact creates the lead WITHOUT storing the automated address', async () => {
    const state = setupDb();

    const result = await handleLeadInquiry(
      makeEmail({ from_address: 'do-not-reply@thumbtack.com', from_name: 'Thumbtack' }),
      makeClassification({
        extracted: {
          person_name: 'Sam Homeowner',
          email: 'sam.homeowner@gmail.com',
          phone: '941-555-9876',
          service_interest: 'termite',
        },
      })
    );

    expect(result.action).toBe('lead_created');
    const [leadInsert] = insertsFor(state, 'leads');
    expect(leadInsert.row.email).toBe('sam.homeowner@gmail.com');
    expect(leadInsert.row.phone).toBe('941-555-9876');
    // The from_address dedup fallback must be skipped for automated senders
    // (one leads lookup for the extracted contact, not two).
    expect(state.firstTables.filter((t) => t === 'leads')).toHaveLength(1);
  });

  test('automated sender whose extraction only echoes the sender address gets a lead with NO email (phone present)', async () => {
    const state = setupDb();

    const result = await handleLeadInquiry(
      makeEmail({ from_address: 'notifications@leadrelay.example.com' }),
      makeClassification({
        extracted: { email: 'notifications@leadrelay.example.com', phone: '941-555-2222' },
      })
    );

    expect(result.action).toBe('lead_created');
    const [leadInsert] = insertsFor(state, 'leads');
    expect(leadInsert.row.email).toBeNull();
    expect(leadInsert.row.phone).toBe('941-555-2222');
  });

  test('automated sender with no real extracted contact routes to needs-review', async () => {
    const state = setupDb();

    const result = await handleLeadInquiry(
      makeEmail({ from_address: 'noreply@somelistings.example.com' }),
      makeClassification({
        extracted: { email: 'noreply@somelistings.example.com', phone: null },
      })
    );

    expect(result).toEqual({ action: 'lead_needs_review', reason: 'automated_sender_no_contact' });
    expect(insertsFor(state, 'leads')).toHaveLength(0);
    const [notification] = insertsFor(state, 'notifications');
    expect(notification.row.category).toBe('email_alert');
  });

  test('vendor-tagged at sync time (classification=vendor) never becomes a lead', async () => {
    const state = setupDb();

    const result = await handleLeadInquiry(
      makeEmail({ classification: 'vendor' }),
      makeClassification()
    );

    expect(result).toEqual({ action: 'lead_needs_review', reason: 'vendor_sender' });
    expect(insertsFor(state, 'leads')).toHaveLength(0);
    expect(insertsFor(state, 'notifications')).toHaveLength(1);
    expect(emailUpdates(state)).toContainEqual(
      expect.objectContaining({ auto_action: 'lead_needs_review:vendor_sender' })
    );
  });

  test('a live vendor_email_domains match also blocks lead creation', async () => {
    const state = setupDb({
      vendor_email_domains: [{ domain: 'supplierco.example.com', vendor_name: 'SupplierCo' }],
    });

    const result = await handleLeadInquiry(
      makeEmail({ from_address: 'rep@supplierco.example.com' }),
      makeClassification({ extracted: { email: 'rep@supplierco.example.com' } })
    );

    expect(result).toEqual({ action: 'lead_needs_review', reason: 'vendor_sender' });
    expect(insertsFor(state, 'leads')).toHaveLength(0);
  });

  test('reply to the Waves auto-acknowledgment routes to needs-review (Santos incident)', async () => {
    const state = setupDb();

    const result = await handleLeadInquiry(
      makeEmail({ subject: 'Re: Thanks for reaching out to Waves, Santos' }),
      makeClassification({ extracted: { person_name: 'Santos Lopez' } })
    );

    expect(result).toEqual({ action: 'lead_needs_review', reason: 'waves_auto_ack_reply' });
    expect(insertsFor(state, 'leads')).toHaveLength(0);
    expect(insertsFor(state, 'notifications')).toHaveLength(1);
  });

  test('reply on a thread already processed WITHOUT a lead routes to needs-review', async () => {
    const state = setupDb({
      emails: [
        { id: 'email-0', classification: 'other', lead_id: null }, // prior processed
        null, // no prior email in the thread carries a lead
      ],
    });

    const result = await handleLeadInquiry(
      makeEmail({ subject: 'Re: hello again' }),
      makeClassification()
    );

    expect(result).toEqual({ action: 'lead_needs_review', reason: 'reply_thread_no_prior_lead' });
    expect(insertsFor(state, 'leads')).toHaveLength(0);
    expect(insertsFor(state, 'notifications')).toHaveLength(1);
  });

  test('reply on a thread whose earlier message DID produce a lead falls through to normal handling', async () => {
    const state = setupDb({
      emails: [
        { id: 'email-0', classification: 'lead_inquiry', lead_id: 'lead-9' },
        { id: 'email-0', classification: 'lead_inquiry', lead_id: 'lead-9' },
      ],
    });

    const result = await handleLeadInquiry(
      makeEmail({ subject: 'Re: Need a pest control quote' }),
      makeClassification()
    );

    expect(result.action).toBe('lead_created');
  });

  test('existing open lead still links instead of creating (unchanged behavior)', async () => {
    const state = setupDb({ leads: [{ id: 'lead-77' }] });

    const result = await handleLeadInquiry(makeEmail(), makeClassification());

    expect(result).toEqual({ action: 'linked_to_existing_lead', leadId: 'lead-77' });
    expect(insertsFor(state, 'leads')).toHaveLength(0);
    expect(emailUpdates(state)).toContainEqual(
      expect.objectContaining({ lead_id: 'lead-77', auto_action: 'linked_to_existing_lead' })
    );
  });
});

describe('lead-guard helpers', () => {
  test('isHardSkippedLeadSender matches the machine-noise list', () => {
    expect(isHardSkippedLeadSender('voicemail@twimlets.com')).toBe(true);
    expect(isHardSkippedLeadSender('anything@twimlets.com')).toBe(true);
    // The list is live-infrastructure only; one-off junk senders (retired
    // processor bots etc.) go in the blocked_email_senders denylist, which
    // email-sync enforces before classification.
    expect(isHardSkippedLeadSender('jane.prospect@example.com')).toBe(false);
    expect(isHardSkippedLeadSender(null)).toBe(false);
  });

  test('isAutomatedSender matches no-reply local parts and relay domains', () => {
    expect(isAutomatedSender('do-not-reply@thumbtack.com')).toBe(true);
    expect(isAutomatedSender('noreply@anything.example.com')).toBe(true);
    expect(isAutomatedSender('no-reply@anything.example.com')).toBe(true);
    expect(isAutomatedSender('donotreply@anything.example.com')).toBe(true);
    expect(isAutomatedSender('notifications@anything.example.com')).toBe(true);
    expect(isAutomatedSender('leads@mail.thumbtack.com')).toBe(true);
    expect(isAutomatedSender('jane.prospect@example.com')).toBe(false);
    expect(isAutomatedSender('')).toBe(false);
  });

  test('isWavesAutoAckReply requires a reply prefix + the auto-ack subject', () => {
    expect(isWavesAutoAckReply('Re: Thanks for reaching out to Waves, Santos')).toBe(true);
    expect(isWavesAutoAckReply('RE: FW: Thanks for reaching out to Waves, Ana')).toBe(true);
    expect(isWavesAutoAckReply('re:thanks for reaching out to waves')).toBe(true);
    // Outbound auto-ack itself (no reply prefix) is not a reply.
    expect(isWavesAutoAckReply('Thanks for reaching out to Waves, Santos')).toBe(false);
    expect(isWavesAutoAckReply('Re: Quote for my house')).toBe(false);
    expect(isWavesAutoAckReply(null)).toBe(false);
  });
});
