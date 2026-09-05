jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(),
}));
jest.mock('../services/customer-contact', () => ({
  getServiceContact: jest.fn(),
  getServiceContactSmsRecipient: jest.fn(),
  firstNameFrom: jest.requireActual('../services/customer-contact').firstNameFrom,
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn((url) => Promise.resolve(url)),
  existingShortUrlFor: jest.fn().mockResolvedValue(null),
}));
// Provider-side reconcile for stale inline claims (claimInlineForSend).
jest.mock('../services/twilio', () => ({
  findOutboundMessageSince: jest.fn(async () => ({ unavailable: true })),
}));
// Manual create() runs under the per-customer advisory lock; with the db mock
// there is no pool so the real runExclusive would fail closed (skipped:
// no_connection). The lock's own behavior is covered by its suite — here it
// just runs the body.
jest.mock('../utils/cron-lock', () => ({
  runExclusive: async (_key, fn) => fn(),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const { getServiceContact, getServiceContactSmsRecipient } = require('../services/customer-contact');
const { shortenOrPassthrough } = require('../services/short-url');
const ReviewService = require('../services/review-request');

function chain(overrides = {}) {
  return {
    where: jest.fn(function () { return this; }),
    whereIn: jest.fn(function () { return this; }),
    whereNotIn: jest.fn(function () { return this; }),
    whereNull: jest.fn(function () { return this; }),
    whereNotNull: jest.fn(function () { return this; }),
    whereRaw: jest.fn(function () { return this; }),
    orderByRaw: jest.fn(function () { return this; }),
    whereNotExists: jest.fn(function () { return this; }),
    whereExists: jest.fn(function () { return this; }),
    leftJoin: jest.fn(function () { return this; }),
    select: jest.fn(function () { return this; }),
    orderBy: jest.fn(function () { return this; }),
    limit: jest.fn(function () { return this; }),
    first: jest.fn(),
    update: jest.fn().mockResolvedValue(1),
    ...overrides,
  };
}

function collection(rows) {
  return chain({
    limit: jest.fn().mockResolvedValue(rows),
  });
}

function insertReturning(inserted) {
  const holder = {
    payload: null,
    returning: jest.fn().mockResolvedValue([inserted]),
  };
  return {
    holder,
    query: {
      insert: jest.fn((payload) => {
        holder.payload = payload;
        if (!inserted.token && payload.token) inserted.token = payload.token;
        return holder;
      }),
    },
  };
}

describe('review request follow-up flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-06-03T14:00:00.000Z'));
    shortenOrPassthrough.mockImplementation((url) => Promise.resolve(url));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('renders customer follow-up template with the current request id', async () => {
    const updateQuery = chain();
    const reviewRequestQueries = [
      chain(), // deleted-customer follow-up close-out pre-pass
      collection([]),
      collection([
        {
          id: 'rr-1',
          customer_id: 'cust-1',
          sms_sent_at: '2026-05-30T15:00:00.000Z',
          status: 'sent',
          score: null,
        },
      ]),
      chain({ first: jest.fn().mockResolvedValue(null) }),
      updateQuery,
    ];
    const customerQuery = chain({
      first: jest.fn().mockResolvedValue({
        id: 'cust-1',
        first_name: 'Jamie',
        last_name: 'Rios',
        phone: '+19415550123',
        city: 'Sarasota',
        has_left_google_review: false,
      }),
    });

    db.mockImplementation((table) => {
      if (table === 'review_requests') return reviewRequestQueries.shift();
      if (table === 'customers') return customerQuery;
      throw new Error(`Unexpected table query: ${table}`);
    });
    // Service contact stored as a full name — the {first_name} slot must be the
    // first token only ("Jamie"), not "Jamie Rios".
    getServiceContact.mockReturnValue({ phone: '+19415550123', name: 'Jamie Rios' });
    getServiceContactSmsRecipient.mockReturnValue({ phone: '+19415550123', name: 'Jamie Rios' });
    renderSmsTemplate.mockResolvedValue('Please review us');
    sendCustomerMessage.mockResolvedValue({ sent: true, auditLogId: 'audit-1' });

    const result = await ReviewService.processFollowups();

    expect(result).toEqual({ sent: 1, suppressed: 0, internalFollowups: 0 });
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'review_request_followup',
      expect.objectContaining({ first_name: 'Jamie' }),
      expect.objectContaining({
        workflow: 'review_request_followup',
        entity_type: 'review_request',
        entity_id: 'rr-1',
      }),
    );
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'review_request',
      customerId: 'cust-1',
      metadata: expect.objectContaining({ review_request_id: 'rr-1' }),
    }));
    expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      followup_sent: true,
    }));
  });

  test('marks terminal follow-up policy blocks as handled', async () => {
    const updateQuery = chain();
    const reviewRequestQueries = [
      chain(), // deleted-customer follow-up close-out pre-pass
      collection([]),
      collection([
        {
          id: 'rr-optout',
          customer_id: 'cust-1',
          sms_sent_at: '2026-05-30T15:00:00.000Z',
          status: 'sent',
          score: null,
        },
      ]),
      chain({ first: jest.fn().mockResolvedValue(null) }),
      updateQuery,
    ];
    const customerQuery = chain({
      first: jest.fn().mockResolvedValue({
        id: 'cust-1',
        first_name: 'Jamie',
        last_name: 'Rios',
        phone: '+19415550123',
        city: 'Sarasota',
        has_left_google_review: false,
      }),
    });

    db.mockImplementation((table) => {
      if (table === 'review_requests') return reviewRequestQueries.shift();
      if (table === 'customers') return customerQuery;
      throw new Error(`Unexpected table query: ${table}`);
    });
    getServiceContact.mockReturnValue({ phone: '+19415550123', name: 'Jamie' });
    getServiceContactSmsRecipient.mockReturnValue({ phone: '+19415550123', name: 'Jamie' });
    renderSmsTemplate.mockResolvedValue('Please review us');
    sendCustomerMessage.mockResolvedValue({
      sent: false,
      blocked: true,
      code: 'PURPOSE_OPTED_OUT',
      retryable: false,
      deferred: false,
      auditLogId: 'audit-1',
    });

    const result = await ReviewService.processFollowups();

    expect(result).toEqual({ sent: 0, suppressed: 1, internalFollowups: 0 });
    expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      followup_sent: true,
    }));
  });

  test('leaves transient follow-up consent lookup failures retryable', async () => {
    const updateQuery = chain();
    const reviewRequestQueries = [
      chain(), // deleted-customer follow-up close-out pre-pass
      collection([]),
      collection([
        {
          id: 'rr-consent-retry',
          customer_id: 'cust-1',
          sms_sent_at: '2026-05-30T15:00:00.000Z',
          status: 'sent',
          score: null,
        },
      ]),
      chain({ first: jest.fn().mockResolvedValue(null) }),
      updateQuery,
    ];
    const customerQuery = chain({
      first: jest.fn().mockResolvedValue({
        id: 'cust-1',
        first_name: 'Jamie',
        last_name: 'Rios',
        phone: '+19415550123',
        city: 'Sarasota',
        has_left_google_review: false,
      }),
    });

    db.mockImplementation((table) => {
      if (table === 'review_requests') return reviewRequestQueries.shift();
      if (table === 'customers') return customerQuery;
      throw new Error(`Unexpected table query: ${table}`);
    });
    getServiceContact.mockReturnValue({ phone: '+19415550123', name: 'Jamie' });
    getServiceContactSmsRecipient.mockReturnValue({ phone: '+19415550123', name: 'Jamie' });
    renderSmsTemplate.mockResolvedValue('Please review us');
    sendCustomerMessage.mockResolvedValue({
      sent: false,
      blocked: true,
      code: 'CONSENT_LOOKUP_FAILED',
      retryable: false,
      deferred: false,
      auditLogId: 'audit-1',
    });

    const result = await ReviewService.processFollowups();

    expect(result).toEqual({ sent: 0, suppressed: 0, internalFollowups: 0 });
    expect(updateQuery.update).not.toHaveBeenCalled();
  });

  test('creates inline review rows as pending until the bundled completion SMS is delivered', async () => {
    const existingQuery = chain({ first: jest.fn().mockResolvedValue(null) });
    const serviceRecordQuery = chain({
      first: jest.fn().mockResolvedValue({
        id: 'sr-1',
        technician_id: 'tech-1',
        tech_name: 'Alex',
        service_type: 'general pest',
        service_date: '2026-06-03',
      }),
    });
    const insert = insertReturning({ id: 'rr-inline' });
    const reviewRequestQueries = [existingQuery, insert.query];

    db.mockImplementation((table) => {
      if (table === 'customers') {
        return chain({
          first: jest.fn().mockResolvedValue({
            id: 'cust-1',
            has_left_google_review: false,
          }),
        });
      }
      if (table === 'notification_prefs') {
        return chain({
          first: jest.fn().mockResolvedValue({
            sms_enabled: true,
            review_request: true,
          }),
        });
      }
      if (table === 'review_requests') return reviewRequestQueries.shift();
      if (table === 'service_records') return serviceRecordQuery;
      throw new Error(`Unexpected table query: ${table}`);
    });

    const result = await ReviewService.createInline({
      customerId: 'cust-1',
      serviceRecordId: 'sr-1',
    });

    expect(insert.holder.payload).toEqual(expect.objectContaining({
      customer_id: 'cust-1',
      service_record_id: 'sr-1',
      triggered_by: 'auto_inline',
      scheduled_for: expect.any(Date),
      sms_sent_at: null,
      status: 'pending',
    }));
    expect(result).toMatchObject({
      requestId: 'rr-inline',
      token: insert.holder.payload.token,
    });
    expect(result.url).toContain(`/rate/${insert.holder.payload.token}`);
  });

  test('does not rebundle an existing review request that was already sent', async () => {
    db.mockImplementation((table) => {
      if (table === 'customers') {
        return chain({
          first: jest.fn().mockResolvedValue({
            id: 'cust-1',
            has_left_google_review: false,
          }),
        });
      }
      if (table === 'notification_prefs') {
        return chain({
          first: jest.fn().mockResolvedValue({
            sms_enabled: true,
            review_request: true,
          }),
        });
      }
      if (table === 'review_requests') {
        return chain({
          first: jest.fn().mockResolvedValue({
            id: 'rr-sent',
            token: 'token-sent',
            status: 'sent',
            sms_sent_at: new Date('2026-06-03T13:00:00.000Z'),
          }),
        });
      }
      throw new Error(`Unexpected table query: ${table}`);
    });

    const result = await ReviewService.createInline({
      customerId: 'cust-1',
      serviceRecordId: 'sr-1',
    });

    expect(result).toBeNull();
    expect(shortenOrPassthrough).not.toHaveBeenCalled();
  });

  test('does not create inline review rows when review requests are disabled', async () => {
    db.mockImplementation((table) => {
      if (table === 'customers') {
        return chain({
          first: jest.fn().mockResolvedValue({
            id: 'cust-1',
            has_left_google_review: false,
          }),
        });
      }
      if (table === 'notification_prefs') {
        return chain({
          first: jest.fn().mockResolvedValue({
            sms_enabled: true,
            review_request: false,
          }),
        });
      }
      throw new Error(`Unexpected table query: ${table}`);
    });

    const result = await ReviewService.createInline({
      customerId: 'cust-1',
      serviceRecordId: 'sr-1',
    });

    expect(result).toBeNull();
    expect(shortenOrPassthrough).not.toHaveBeenCalled();
  });

  test('does not rebundle an existing suppressed inline review request', async () => {
    db.mockImplementation((table) => {
      if (table === 'customers') {
        return chain({
          first: jest.fn().mockResolvedValue({
            id: 'cust-1',
            has_left_google_review: false,
          }),
        });
      }
      if (table === 'notification_prefs') {
        return chain({
          first: jest.fn().mockResolvedValue({
            sms_enabled: true,
            review_request: true,
          }),
        });
      }
      if (table === 'review_requests') {
        return chain({
          first: jest.fn().mockResolvedValue({
            id: 'rr-suppressed',
            token: 'token-suppressed',
            status: 'suppressed',
            sms_sent_at: null,
          }),
        });
      }
      throw new Error(`Unexpected table query: ${table}`);
    });

    const result = await ReviewService.createInline({
      customerId: 'cust-1',
      serviceRecordId: 'sr-1',
    });

    expect(result).toBeNull();
    expect(shortenOrPassthrough).not.toHaveBeenCalled();
  });

  test('manual create paths send immediately when no future delay is supplied', async () => {
    const originalSendSMS = ReviewService.sendSMS;
    ReviewService.sendSMS = jest.fn().mockResolvedValue();
    const insert = insertReturning({ id: 'rr-admin' });

    db.mockImplementation((table) => {
      if (table === 'customers') {
        return chain({
          first: jest.fn().mockResolvedValue({ id: 'cust-1', city: 'Sarasota' }),
        });
      }
      if (table === 'review_requests') {
        // create() with a manual trigger now runs the shared unscheduled-ask
        // gate stack first (codex #3285 r1 P1): getDeliveredAskStats reads
        // this table (…select → rows) and the queued-ask check (…first). Both
        // must come back empty so the gates pass and the insert proceeds.
        return {
          ...chain({
            whereRaw: jest.fn(function () { return this; }),
            orderByRaw: jest.fn(function () { return this; }),
            limit: jest.fn().mockResolvedValue([]),
            first: jest.fn().mockResolvedValue(null),
          }),
          insert: insert.query.insert,
        };
      }
      throw new Error(`Unexpected table query: ${table}`);
    });

    try {
      await ReviewService.create({
        customerId: 'cust-1',
        triggeredBy: 'admin',
      });

      expect(insert.holder.payload).toEqual(expect.objectContaining({
        customer_id: 'cust-1',
        triggered_by: 'admin',
        scheduled_for: null,
        status: 'pending',
      }));
      expect(ReviewService.sendSMS).toHaveBeenCalledWith('rr-admin', { expectedPhone: null });
    } finally {
      ReviewService.sendSMS = originalSendSMS;
    }
  });

  test('manual create accelerates an existing pending request for the same service', async () => {
    const originalSendSMS = ReviewService.sendSMS;
    ReviewService.sendSMS = jest.fn().mockResolvedValue();
    const refreshedQuery = chain({
      first: jest.fn().mockResolvedValue({
        id: 'rr-existing',
        status: 'sent',
        sms_sent_at: new Date('2026-06-03T14:01:00.000Z'),
      }),
    });
    const reviewRequestQueries = [
      // Same-service idempotency lookup runs FIRST (codex #3285 r8); the
      // pending-unsent row makes this a RESEND, so the gate stack then runs.
      // 1. per-service-record dedupe lookup.
      chain({
        first: jest.fn().mockResolvedValue({
          id: 'rr-existing',
          service_record_id: 'sr-1',
          status: 'pending',
          sms_sent_at: null,
          scheduled_for: new Date('2026-06-03T16:00:00.000Z'),
        }),
      }),
      // 2. getDeliveredAskStats — no delivered asks.
      chain({
        whereRaw: jest.fn(function () { return this; }),
        orderByRaw: jest.fn(function () { return this; }),
        limit: jest.fn().mockResolvedValue([]),
      }),
      // 3. in-flight composer claim check — none.
      chain({ first: jest.fn().mockResolvedValue(null) }),
      // 4. queued-ask check — returns THIS pending row, so the resend is the
      //    one already_queued outcome allowed through (queuedId match).
      chain({
        whereRaw: jest.fn(function () { return this; }),
        first: jest.fn().mockResolvedValue({
          id: 'rr-existing',
          scheduled_for: new Date('2026-06-03T16:00:00.000Z'),
        }),
      }),
      refreshedQuery,
    ];

    db.mockImplementation((table) => {
      if (table === 'customers') {
        return chain({
          first: jest.fn().mockResolvedValue({ id: 'cust-1', city: 'Sarasota' }),
        });
      }
      if (table === 'review_requests') return reviewRequestQueries.shift();
      throw new Error(`Unexpected table query: ${table}`);
    });

    try {
      const result = await ReviewService.create({
        customerId: 'cust-1',
        serviceRecordId: 'sr-1',
        triggeredBy: 'tech',
      });

      expect(ReviewService.sendSMS).toHaveBeenCalledWith('rr-existing', { expectedPhone: null });
      expect(result).toMatchObject({ id: 'rr-existing', status: 'sent' });
    } finally {
      ReviewService.sendSMS = originalSendSMS;
    }
  });

  test('requeues inline review rows for retryable bundled completion SMS failures', async () => {
    const updateQuery = chain();
    db.mockImplementation((table) => {
      if (table === 'review_requests') return updateQuery;
      throw new Error(`Unexpected table query: ${table}`);
    });

    const scheduledFor = new Date('2026-06-03T16:00:00.000Z');
    await ReviewService.markInlineRetryable('rr-inline', scheduledFor);

    expect(updateQuery.update).toHaveBeenCalledWith({
      status: 'pending',
      scheduled_for: scheduledFor,
    });
  });

  test('marks inline delivery only for unsent pending/claimed rows', async () => {
    const updateQuery = chain();
    db.mockImplementation((table) => {
      if (table === 'review_requests') return updateQuery;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await ReviewService.markInlineDelivered('rr-inline');

    expect(updateQuery.where).toHaveBeenCalledWith({ id: 'rr-inline' });
    expect(updateQuery.whereNull).toHaveBeenCalledWith('sms_sent_at');
    // 'pending' = the dispatch path, 'sending' = the composer's pre-send claim.
    expect(updateQuery.whereIn).toHaveBeenCalledWith('status', ['pending', 'sending']);
    expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      scheduled_for: null,
      status: 'sent',
    }));
  });

  test('claimInlineForSend claims conditionally and reports a lost claim', async () => {
    const updateQuery = chain();
    db.mockImplementation((table) => {
      if (table === 'review_requests') return updateQuery;
      throw new Error(`Unexpected table query: ${table}`);
    });

    expect(await ReviewService.claimInlineForSend('rr-inline')).toBeInstanceOf(Date);
    expect(updateQuery.where).toHaveBeenCalledWith({ id: 'rr-inline', triggered_by: 'auto_inline', status: 'pending' });
    expect(updateQuery.whereNull).toHaveBeenCalledWith('sms_sent_at');
    // A Text-only claim clears the owed email leg; a Both claim stamps it
    // (the Quick Links retry path's evidence the ask asked for an email).
    expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'sending', email_leg_owed_at: null }));
    expect(await ReviewService.claimInlineForSend('rr-inline', { emailRequested: true })).toBeInstanceOf(Date);
    expect(updateQuery.update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'sending', email_leg_owed_at: expect.any(Date) }));

    // A colleague's fresh (non-stale) claim already holds the row — the
    // conditional UPDATE matches nothing, the stale lookup finds nothing,
    // and the caller must reject its own send.
    updateQuery.update.mockResolvedValueOnce(0);
    updateQuery.first.mockResolvedValueOnce(undefined);
    expect(await ReviewService.claimInlineForSend('rr-inline')).toBe(false);
  });

  test('a stale claim with outbound-log evidence is repaired to sent, not reclaimed', async () => {
    const rrQuery = chain();
    const smsLogQuery = chain({ whereNotIn: jest.fn(function () { return this; }) });
    rrQuery.update.mockResolvedValueOnce(0); // pending claim misses
    rrQuery.first.mockResolvedValueOnce({ id: 'rr-inline', token: 'tok-64chars' });
    smsLogQuery.first.mockResolvedValueOnce({ id: 'sms-1' }); // the ask already left
    db.mockImplementation((table) => {
      if (table === 'review_requests') return rrQuery;
      if (table === 'sms_log') return smsLogQuery;
      throw new Error(`Unexpected table query: ${table}`);
    });

    expect(await ReviewService.claimInlineForSend('rr-inline')).toBe(false);
    // The missing delivered stamp is repaired from the log evidence.
    expect(rrQuery.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'sent' }));
  });

  // A stale claim with NO local log evidence is decided by the PROVIDER —
  // twilio.js swallows post-accept sms_log insert failures, so a missing
  // local row proves nothing on its own.
  function wireStaleClaimNoLocalEvidence() {
    const rrQuery = chain();
    const smsLogQuery = chain({ whereNotIn: jest.fn(function () { return this; }) });
    rrQuery.update.mockResolvedValueOnce(0); // pending claim misses
    rrQuery.first.mockResolvedValueOnce({
      id: 'rr-inline', token: 'tok-64chars', customer_id: 'cust-1', claimed_at: new Date('2026-06-03T13:00:00.000Z'),
    });
    smsLogQuery.first.mockResolvedValue(undefined);
    const customersQuery = chain({ first: jest.fn().mockResolvedValue({ phone: '+19415550123' }) });
    db.mockImplementation((table) => {
      if (table === 'review_requests') return rrQuery;
      if (table === 'sms_log') return smsLogQuery;
      if (table === 'customers') return customersQuery;
      throw new Error(`Unexpected table query: ${table}`);
    });
    return { rrQuery };
  }

  test('stale claim, provider unreachable → stays blocked (unknown is not "not sent")', async () => {
    const { findOutboundMessageSince } = require('../services/twilio');
    findOutboundMessageSince.mockResolvedValueOnce({ unavailable: true });
    const { rrQuery } = wireStaleClaimNoLocalEvidence();

    expect(await ReviewService.claimInlineForSend('rr-inline')).toBe(false);
    expect(rrQuery.update).toHaveBeenCalledTimes(1); // only the missed pending claim
  });

  test('stale claim, provider has the message → repaired to sent, not reclaimed', async () => {
    const { findOutboundMessageSince } = require('../services/twilio');
    findOutboundMessageSince.mockResolvedValueOnce({ found: true });
    const { rrQuery } = wireStaleClaimNoLocalEvidence();

    expect(await ReviewService.claimInlineForSend('rr-inline')).toBe(false);
    expect(findOutboundMessageSince).toHaveBeenCalledWith(expect.objectContaining({
      to: '+19415550123', bodyFragment: 'tok-64chars',
    }));
    expect(rrQuery.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'sent' }));
  });

  test('stale claim, provider confirms nothing left → pre-provider crash, claim released', async () => {
    const { findOutboundMessageSince } = require('../services/twilio');
    findOutboundMessageSince.mockResolvedValueOnce({ found: false });
    const { rrQuery } = wireStaleClaimNoLocalEvidence();
    rrQuery.update.mockResolvedValueOnce(1); // the reclaim

    expect(await ReviewService.claimInlineForSend('rr-inline')).toBeInstanceOf(Date);
    expect(rrQuery.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'sent' }));
  });

  test('reviewSmsAllowedNow refuses deleted / already-reviewed customers, an exclusive email channel, and fails closed on a read failure', async () => {
    const prefsQuery = chain();
    const customersQuery = chain();
    customersQuery.first.mockResolvedValue({ id: 'cust-1', deleted_at: null, has_left_google_review: false });
    db.mockImplementation((table) => {
      if (table === 'notification_prefs') return prefsQuery;
      if (table === 'customers') return customersQuery;
      throw new Error(`Unexpected table query: ${table}`);
    });

    // Live customer state the mint-time check can't see: a draft can outlive
    // an archive or the CSR's already-reviewed toggle.
    customersQuery.first.mockResolvedValueOnce({ id: 'cust-1', deleted_at: new Date(), has_left_google_review: false });
    prefsQuery.first.mockResolvedValueOnce(null);
    expect(await ReviewService.reviewSmsAllowedNow('cust-1')).toEqual({ allowed: false, reason: 'customer_deleted' });

    customersQuery.first.mockResolvedValueOnce({ id: 'cust-1', deleted_at: null, has_left_google_review: true });
    prefsQuery.first.mockResolvedValueOnce(null);
    expect(await ReviewService.reviewSmsAllowedNow('cust-1')).toEqual({ allowed: false, reason: 'already_reviewed' });

    prefsQuery.first.mockResolvedValueOnce({ review_request: true, sms_enabled: true, review_request_channel: 'email' });
    expect(await ReviewService.reviewSmsAllowedNow('cust-1')).toEqual({ allowed: false, reason: 'email_only' });

    prefsQuery.first.mockResolvedValueOnce({ review_request: true, sms_enabled: true, review_request_channel: 'both' });
    expect(await ReviewService.reviewSmsAllowedNow('cust-1')).toEqual({ allowed: true });

    prefsQuery.first.mockResolvedValueOnce(null); // no row — SMS consent is re-checked downstream
    expect(await ReviewService.reviewSmsAllowedNow('cust-1')).toEqual({ allowed: true });

    prefsQuery.first.mockRejectedValueOnce(new Error('db down'));
    expect(await ReviewService.reviewSmsAllowedNow('cust-1')).toEqual({ allowed: false, reason: 'prefs_unavailable' });
  });

  // Quick Links "Both": the emailed copy of an inline ask (owner ruling 2026-09-03).
  describe('findInlineAwaitingEmail', () => {
    test('finds the latest texted Both row whose email leg is still owed, inside the cooldown window', async () => {
      const q = chain({ first: jest.fn().mockResolvedValue({ id: 'rr-texted', status: 'sent', sms_sent_at: new Date() }) });
      db.mockImplementation((table) => {
        if (table === 'review_requests') return q;
        throw new Error(`Unexpected table query: ${table}`);
      });

      expect(await ReviewService.findInlineAwaitingEmail('cust-1')).toEqual({ id: 'rr-texted' });
      expect(q.where).toHaveBeenCalledWith({ customer_id: 'cust-1', triggered_by: 'auto_inline' });
      // Texted rows in ANY later lifecycle status (opened / rated …) plus
      // stranded 'sending' claims (r16 P2) — no status list.
      expect(q.where).toHaveBeenCalledWith(expect.any(Function));
      // …but never a row the customer already answered / that was stopped (r17 P2).
      expect(q.whereNotIn).toHaveBeenCalledWith('status', ['completed', 'stopped', 'suppressed', 'failed', 'rated']);
      expect(q.whereNull).toHaveBeenCalledWith('submitted_at');
      expect(q.whereNull).toHaveBeenCalledWith('rated_at');
      expect(q.whereNull).toHaveBeenCalledWith('redirected_at');
      // …nor a non-promoter draft score (score set, category not promoter) — r19 P2.
      const draftPredicate = q.where.mock.calls.map(([a]) => a).filter((a) => typeof a === 'function').pop();
      const qb = { whereNull: jest.fn(() => qb), orWhere: jest.fn(() => qb), whereNotNull: jest.fn(() => qb) };
      draftPredicate(qb);
      expect(qb.whereNull).toHaveBeenCalledWith('score');
      expect(qb.orWhere).toHaveBeenCalledWith({ category: 'promoter' });
      expect(q.whereNull).toHaveBeenCalledWith('sent_at');
      // Only asks that requested an email leg (and still owe it) match —
      // never a Text-only or completion-SMS ask (GH Codex #3856 r8 P1).
      expect(q.whereNotNull).toHaveBeenCalledWith('email_leg_owed_at');
      expect(q.where).toHaveBeenCalledWith('email_leg_owed_at', '>=', expect.any(Date));
      expect(q.orderBy).toHaveBeenCalledWith('email_leg_owed_at', 'desc');
      expect(q.update).not.toHaveBeenCalled();
      expect(await ReviewService.findInlineAwaitingEmail(null)).toBeNull();
    });

    test('a stranded claim (text left, delivered stamp lost) is repaired from evidence and offered; no evidence = not this row (r10 P2)', async () => {
      const stranded = { id: 'rr-stranded', status: 'sending', token: 'tok-64chars', customer_id: 'cust-1', claimed_at: new Date(), sms_sent_at: null };
      const rrQuery = chain({ first: jest.fn().mockResolvedValue(stranded) });
      const smsLogQuery = chain({ whereNotIn: jest.fn(function () { return this; }) });
      smsLogQuery.first.mockResolvedValueOnce({ id: 'sms-1' }); // the ask already left
      db.mockImplementation((table) => {
        if (table === 'review_requests') return rrQuery;
        if (table === 'sms_log') return smsLogQuery;
        throw new Error(`Unexpected table query: ${table}`);
      });
      expect(await ReviewService.findInlineAwaitingEmail('cust-1')).toEqual({ id: 'rr-stranded' });
      expect(rrQuery.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'sent', sms_sent_at: expect.any(Date) }));

      // No local row and the provider positively has nothing → not this row.
      rrQuery.update.mockClear();
      smsLogQuery.first.mockResolvedValue(undefined);
      const customersQuery = chain({ first: jest.fn().mockResolvedValue({ phone: '+19415550123' }) });
      db.mockImplementation((table) => {
        if (table === 'review_requests') return rrQuery;
        if (table === 'sms_log') return smsLogQuery;
        if (table === 'customers') return customersQuery;
        throw new Error(`Unexpected table query: ${table}`);
      });
      require('../services/twilio').findOutboundMessageSince.mockResolvedValueOnce({ found: false });
      expect(await ReviewService.findInlineAwaitingEmail('cust-1')).toBeNull();
      expect(rrQuery.update).not.toHaveBeenCalled();

      // Provider unreachable = unknown: throws so the route fails closed (r14 P2).
      require('../services/twilio').findOutboundMessageSince.mockResolvedValueOnce({ unavailable: true });
      await expect(ReviewService.findInlineAwaitingEmail('cust-1')).rejects.toThrow(/evidence unavailable/);
      expect(rrQuery.update).not.toHaveBeenCalled();
    });
  });

  describe('sendInlineEmailCopy', () => {
    const EmailLib = require('../services/email-template-library');
    let rrUpdate;
    const CLAIM_STAMP = expect.objectContaining({ email_leg_owed_at: null, channel: 'both', sent_at: expect.anything() });
    const wire = ({ prefs, prefsThrow = false, email = 'megan@example.com', customerRow = {}, requestRow = {}, technicianName = null } = {}) => {
      rrUpdate = jest.fn().mockResolvedValue(1);
      // The claim's sent_at is COALESCE(sent_at, now) — a raw binding.
      db.raw = (sql, bindings) => ({ sql, bindings });
      getServiceContact.mockReturnValue({ email, name: 'Megan Example' });
      db.mockImplementation((table) => {
        if (table === 'review_requests') {
          const q = chain({
            first: jest.fn().mockResolvedValue({ id: 'rr-1', customer_id: 'cust-1', token: 'tok-1', status: 'sent', ...requestRow }),
            update: rrUpdate,
          });
          // A real promise: the pre-dispatch owed clear is awaited directly,
          // the sent stamp goes through .catch().
          q.update = jest.fn((patch) => rrUpdate(patch));
          return q;
        }
        if (table === 'customers') {
          return chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Megan', city: 'Bradenton', ...customerRow }) });
        }
        if (table === 'technicians') {
          // the by-id name lookup for a row that carries technician_id but no tech_name
          return { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(technicianName ? { name: technicianName } : undefined) };
        }
        if (table === 'notification_prefs') {
          if (prefsThrow) return chain({ first: jest.fn().mockRejectedValue(new Error('db down')) });
          return chain({ first: jest.fn().mockResolvedValue(prefs) });
        }
        throw new Error(`Unexpected table query: ${table}`);
      });
    };

    test('the email names the technician createInline persisted on the row; else the row\'s technician_id; else a neutral label — never a hardcoded person (r30 P2, Field Team Phase 0)', async () => {
      wire({ prefs: { review_request: true, email_enabled: true }, requestRow: { tech_name: 'Alex' } });
      EmailLib.sendTemplate.mockImplementation(async (opts) => { await opts.onQueued({ id: 'em-1' }); return { sent: true }; });
      expect(await ReviewService.sendInlineEmailCopy('rr-1')).toEqual({ sent: true });
      expect(EmailLib.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ tech_name: 'Alex' }) }));

      // tech_name missing but the row points at a technician → their first name
      EmailLib.sendTemplate.mockClear();
      wire({ prefs: { review_request: true, email_enabled: true }, requestRow: { tech_name: null, technician_id: 'tech-9' }, technicianName: 'Jordan Reyes' });
      EmailLib.sendTemplate.mockImplementation(async (opts) => { await opts.onQueued({ id: 'em-2' }); return { sent: true }; });
      expect(await ReviewService.sendInlineEmailCopy('rr-1')).toEqual({ sent: true });
      expect(EmailLib.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ tech_name: 'Jordan' }) }));

      // nothing on the row → neutral copy, and no technician lookup is attempted
      EmailLib.sendTemplate.mockClear();
      wire({ prefs: { review_request: true, email_enabled: true }, requestRow: { tech_name: null, technician_id: null } });
      EmailLib.sendTemplate.mockImplementation(async (opts) => { await opts.onQueued({ id: 'em-3' }); return { sent: true }; });
      const callsBefore = db.mock.calls.length;
      expect(await ReviewService.sendInlineEmailCopy('rr-1')).toEqual({ sent: true });
      expect(EmailLib.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ tech_name: 'Your technician' }) }));
      expect(db.mock.calls.slice(callsBefore).map((c) => c[0])).not.toContain('technicians');
    });

    test('emails the SAME ask (same token) and stamps sent_at once — status untouched', async () => {
      wire({ prefs: { review_request: true, email_enabled: true } });
      EmailLib.sendTemplate.mockImplementation(async (opts) => {
        expect(await opts.onQueued({ id: 'em-1' })).toBe(true);
        return { sent: true };
      });

      expect(await ReviewService.sendInlineEmailCopy('rr-1')).toEqual({ sent: true });
      // The owed leg is cleared durably BEFORE dispatch (r9 P2) — and the
      // row texted AND emailed is recorded as channel 'both' + sent_at in
      // that same write, so the outreach analytics count the email leg and
      // the follow-up / cooldown clock can never be left on the text's date
      // by a lost post-send stamp (r22 P2).
      expect(rrUpdate).toHaveBeenNthCalledWith(1, CLAIM_STAMP);
      const claimPatch = rrUpdate.mock.calls[0][0];
      expect(claimPatch.sent_at).toEqual({ sql: 'COALESCE(sent_at, ?)', bindings: [expect.any(Date)] });
      // The dispatch claim itself carries the terminal + customer predicates.
      const rrQ = db.mock.results.map((r) => r.value).find((v) => v && v.whereExists && v.whereExists.mock.calls.length);
      expect(rrQ.whereNotIn).toHaveBeenCalledWith('status', ['completed', 'stopped', 'suppressed', 'failed', 'rated']);
      expect(rrQ.whereNull).toHaveBeenCalledWith('submitted_at');
      expect(rrQ.whereExists).toHaveBeenCalledWith(expect.any(Function));
      // …and re-checks consent as of the write, the last fence before the
      // provider (r23 P1): a prefs row for the customer with review_request
      // and email_enabled not false — the recipient read's predicate.
      const consent = rrQ.whereExists.mock.calls.map(([fn]) => fn).find((fn) => fn.name === 'emailConsent');
      const sub = { select: jest.fn(() => sub), from: jest.fn(() => sub), whereRaw: jest.fn(() => sub) };
      consent.call(sub);
      expect(sub.from).toHaveBeenCalledWith('notification_prefs');
      expect(sub.whereRaw.mock.calls.map(([sql]) => sql)).toEqual([
        'notification_prefs.customer_id = review_requests.customer_id',
        'COALESCE(notification_prefs.review_request, true) = true',
        'COALESCE(notification_prefs.email_enabled, true) = true',
      ]);
      // The dispatch claim excludes a non-promoter draft score too (r19 P2).
      const claimDraft = rrQ.where.mock.calls.map(([a]) => a).filter((a) => typeof a === 'function').pop();
      const qb2 = { whereNull: jest.fn(() => qb2), orWhere: jest.fn(() => qb2) };
      claimDraft(qb2);
      expect(qb2.whereNull).toHaveBeenCalledWith('score');
      expect(qb2.orWhere).toHaveBeenCalledWith({ category: 'promoter' });
      const call = EmailLib.sendTemplate.mock.calls[0][0];
      expect(call).toMatchObject({
        templateKey: 'review_request_email',
        to: 'megan@example.com',
        recipientId: 'cust-1',
        // Per attempt (r10 P2): a blocked attempt must not dedupe a corrected address.
        idempotencyKey: expect.stringMatching(/^review_touch:rr-1:email:[0-9a-z]+$/),
        suppressProviderErrorLog: true,
      });
      expect(call.payload.first_name).toBe('Megan');
      expect(call.payload.review_url).toContain('tok-1');
      // No second write: nothing after the provider call is left to lose.
      expect(rrUpdate).toHaveBeenCalledTimes(1);
    });

    test('a failed pre-dispatch owed clear aborts the provider call — retryable, leg still owed (r9 P2)', async () => {
      wire({ prefs: { review_request: true, email_enabled: true } });
      rrUpdate.mockRejectedValueOnce(new Error('db down'));
      EmailLib.sendTemplate.mockImplementation(async (opts) => {
        const keep = await opts.onQueued({ id: 'em-1' });
        if (keep === false) return { sent: false, aborted: true, reason: 'aborted_by_caller_before_dispatch' };
        throw new Error('must not dispatch');
      });
      expect(await ReviewService.sendInlineEmailCopy('rr-1')).toEqual({ sent: false, reason: 'email_send_failed' });
      expect(rrUpdate).toHaveBeenCalledTimes(1);

      // A sibling attempt already cleared the owed leg (conditional update hit
      // no row): this attempt aborts before the provider — never two emails.
      wire({ prefs: { review_request: true, email_enabled: true } });
      rrUpdate.mockResolvedValueOnce(0);
      expect(await ReviewService.sendInlineEmailCopy('rr-1')).toEqual({ sent: false, reason: 'email_send_failed' });
      expect(rrUpdate).toHaveBeenCalledTimes(1);
    });

    test('a lost post-send write cannot strand a Both row on its text date: sent_at + channel are the pre-dispatch claim itself (r22 P2)', async () => {
      wire({ prefs: { review_request: true, email_enabled: true } });
      // The only write fails on its first try → the dispatch is aborted, the
      // leg stays owed; there is no separate stamp left to lose after a send.
      rrUpdate.mockRejectedValueOnce(new Error('db down'));
      EmailLib.sendTemplate.mockImplementation(async (opts) => {
        const keep = await opts.onQueued({ id: 'em-1' });
        if (keep === false) return { sent: false, aborted: true, reason: 'aborted_by_caller_before_dispatch' };
        return { sent: true };
      });
      expect(await ReviewService.sendInlineEmailCopy('rr-1')).toEqual({ sent: false, reason: 'email_send_failed' });
      expect(rrUpdate).toHaveBeenCalledTimes(1);
      expect(rrUpdate).toHaveBeenCalledWith(CLAIM_STAMP);
    });

    test('refuses when review or email notifications are off, or prefs cannot be read (fail closed)', async () => {
      wire({ prefs: { review_request: false, email_enabled: true } });
      expect(await ReviewService.sendInlineEmailCopy('rr-1')).toEqual({ sent: false, reason: 'email_off' });
      wire({ prefs: { review_request: true, email_enabled: false } });
      expect(await ReviewService.sendInlineEmailCopy('rr-1')).toEqual({ sent: false, reason: 'email_off' });
      wire({ prefsThrow: true });
      expect(await ReviewService.sendInlineEmailCopy('rr-1')).toEqual({ sent: false, reason: 'prefs_unavailable' });
      wire({ prefs: { review_request: true, email_enabled: true }, email: '' });
      expect(await ReviewService.sendInlineEmailCopy('rr-1')).toEqual({ sent: false, reason: 'no_email' });
      // No prefs row = no recorded email consent (same as sendOutreachTouch's canEmail).
      wire({ prefs: null });
      expect(await ReviewService.sendInlineEmailCopy('rr-1')).toEqual({ sent: false, reason: 'email_off' });
      expect(EmailLib.sendTemplate).not.toHaveBeenCalled();
    });

    test('a blocked send reports the library reason and never throws', async () => {
      wire({ prefs: { review_request: true, email_enabled: true } });
      EmailLib.sendTemplate.mockResolvedValue({ sent: false, reason: 'suppressed' });
      expect(await ReviewService.sendInlineEmailCopy('rr-1')).toEqual({ sent: false, reason: 'suppressed' });
      // A throw BEFORE dispatch (onQueued never fired) reached no one: a
      // plain, retryable failure — the owed leg stays.
      EmailLib.sendTemplate.mockRejectedValue(new Error('boom'));
      expect(await ReviewService.sendInlineEmailCopy('rr-1')).toEqual({ sent: false, reason: 'email_send_failed' });
      expect(rrUpdate).not.toHaveBeenCalled();
    });

    test('a throw AFTER dispatch is uncertain: the owed leg is cleared so no retry re-sends it (r8 P2)', async () => {
      wire({ prefs: { review_request: true, email_enabled: true } });
      EmailLib.sendTemplate.mockImplementation(async (opts) => {
        await opts.onQueued({ id: 'em-1' });
        throw new Error('post-dispatch bookkeeping failed');
      });
      expect(await ReviewService.sendInlineEmailCopy('rr-1')).toEqual({ sent: false, reason: 'email_uncertain' });
      // Cleared once, before dispatch — no second write after the throw. The
      // provider may hold the email, so the claim's sent_at (the cooldown
      // and follow-up anchor) stays: conservative.
      expect(rrUpdate).toHaveBeenCalledTimes(1);
      expect(rrUpdate).toHaveBeenCalledWith(CLAIM_STAMP);
    });

    test('_sendOutreachEmail (one-off): a post-dispatch throw is uncertain — counted as the ask, never "try again" (r9 P2)', async () => {
      const rrUpdateOneOff = jest.fn().mockResolvedValue(1);
      db.mockImplementation((table) => {
        if (table === 'review_requests') return chain({ update: rrUpdateOneOff });
        throw new Error(`Unexpected table query: ${table}`);
      });
      const args = { request: { id: 'rr-7' }, customer: { id: 'cust-1', first_name: 'Megan' }, contact: { email: 'megan@example.com', name: 'Megan' }, reviewUrl: 'https://x/rate/t', techName: 'Adam', manageRetryVia: null };

      EmailLib.sendTemplate.mockImplementationOnce(async (opts) => {
        await opts.onQueued({ id: 'em-7' });
        throw new Error('post-dispatch bookkeeping failed');
      });
      expect(await ReviewService._sendOutreachEmail(args)).toEqual({ ok: false, terminal: true, channel: 'email', requestId: 'rr-7', reason: 'email_uncertain' });
      expect(rrUpdateOneOff).toHaveBeenCalledWith(expect.objectContaining({ status: 'sent', sent_at: expect.any(Date) }));

      // A REAL send whose sent stamp is lost twice must not read as "sent":
      // the row would be invisible to the gates (r12 P2). Once lost = fine.
      rrUpdateOneOff.mockClear();
      rrUpdateOneOff.mockRejectedValueOnce(new Error('db down')).mockRejectedValueOnce(new Error('db down'));
      EmailLib.sendTemplate.mockResolvedValueOnce({ sent: true });
      expect(await ReviewService._sendOutreachEmail(args)).toEqual({ ok: false, terminal: true, channel: 'email', requestId: 'rr-7', reason: 'email_sent_unrecorded' });
      rrUpdateOneOff.mockClear();
      rrUpdateOneOff.mockRejectedValueOnce(new Error('db blip'));
      EmailLib.sendTemplate.mockResolvedValueOnce({ sent: true });
      expect(await ReviewService._sendOutreachEmail(args)).toEqual({ ok: true, sent: true, channel: 'email', requestId: 'rr-7' });
      // A sequence step keeps its retry contract even when the stamp is lost.
      rrUpdateOneOff.mockRejectedValueOnce(new Error('db down')).mockRejectedValueOnce(new Error('db down'));
      EmailLib.sendTemplate.mockResolvedValueOnce({ sent: true });
      expect(await ReviewService._sendOutreachEmail({ ...args, manageRetryVia: 'sequence' })).toMatchObject({ ok: true, sent: true });

      // Lost twice: no cooldown guard in the DB → the distinct reason tells
      // the operator not to send again (r13 P2).
      rrUpdateOneOff.mockClear();
      rrUpdateOneOff.mockRejectedValueOnce(new Error('db down')).mockRejectedValueOnce(new Error('db down'));
      EmailLib.sendTemplate.mockImplementationOnce(async (opts) => { await opts.onQueued({ id: 'em-10' }); throw new Error('post-dispatch'); });
      expect(await ReviewService._sendOutreachEmail(args)).toMatchObject({ terminal: true, reason: 'email_uncertain_unrecorded' });

      // The cooldown stamp is the duplicate guard: retried once (r11 P2).
      rrUpdateOneOff.mockClear();
      rrUpdateOneOff.mockRejectedValueOnce(new Error('db blip'));
      EmailLib.sendTemplate.mockImplementationOnce(async (opts) => { await opts.onQueued({ id: 'em-9' }); throw new Error('post-dispatch'); });
      expect(await ReviewService._sendOutreachEmail(args)).toMatchObject({ reason: 'email_uncertain' });
      expect(rrUpdateOneOff).toHaveBeenCalledTimes(2);

      // A definite 4xx after dispatch: failed, no cooldown stamp (r16 P2).
      rrUpdateOneOff.mockClear();
      EmailLib.sendTemplate.mockImplementationOnce(async (opts) => {
        await opts.onQueued({ id: 'em-7b' });
        const err = new Error('SendGrid 400');
        err.status = 400;
        throw err;
      });
      expect(await ReviewService._sendOutreachEmail(args)).toEqual({ ok: false, terminal: true, channel: 'email', requestId: 'rr-7', reason: 'email_send_failed' });
      expect(rrUpdateOneOff).toHaveBeenCalledWith({ status: 'failed' });
      expect(rrUpdateOneOff).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'sent' }));

      // Pre-dispatch (no onQueued): nothing reached SendGrid — the plain failure.
      rrUpdateOneOff.mockClear();
      EmailLib.sendTemplate.mockRejectedValueOnce(new Error('template missing'));
      expect(await ReviewService._sendOutreachEmail(args)).toEqual({ ok: false, terminal: true, channel: 'email', requestId: 'rr-7', reason: 'email_send_failed' });
      expect(rrUpdateOneOff).toHaveBeenCalledWith({ status: 'failed' });

      // A sequence step keeps its retry contract (step-stable idempotency key).
      EmailLib.sendTemplate.mockImplementationOnce(async (opts) => {
        await opts.onQueued({ id: 'em-8' });
        throw new Error('post-dispatch bookkeeping failed');
      });
      expect(await ReviewService._sendOutreachEmail({ ...args, manageRetryVia: 'sequence' })).toEqual({ ok: false, retryable: true, channel: 'email', requestId: 'rr-7' });
    });

    test('a definite SendGrid 4xx after dispatch is a plain failure: the owed leg is handed back (r16 P2)', async () => {
      wire({ prefs: { review_request: true, email_enabled: true } });
      EmailLib.sendTemplate.mockImplementation(async (opts) => {
        await opts.onQueued({ id: 'em-1' });
        const err = new Error('SendGrid 400: bad address');
        err.status = 400;
        throw err;
      });
      expect(await ReviewService.sendInlineEmailCopy('rr-1')).toEqual({ sent: false, reason: 'email_send_failed' });
      // Cleared pre-dispatch, restored on the definite rejection — with the
      // claim's analytics stamp reverted: no email went out, so the row is
      // texted-only again (the mock row carries no channel → 'sms').
      expect(rrUpdate).toHaveBeenNthCalledWith(1, CLAIM_STAMP);
      expect(rrUpdate).toHaveBeenNthCalledWith(2, { email_leg_owed_at: expect.any(Date), channel: 'sms', sent_at: null });
      // Restore lost twice → this row cannot be retried from here (r17 P2).
      wire({ prefs: { review_request: true, email_enabled: true } });
      rrUpdate.mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('db down')).mockRejectedValueOnce(new Error('db down'));
      expect(await ReviewService.sendInlineEmailCopy('rr-1')).toEqual({ sent: false, reason: 'email_retry_lost' });
      // A 408 (timeout-style — the provider may have processed the POST)
      // stays uncertain like a 5xx; only conclusive 4xx codes are definite.
      wire({ prefs: { review_request: true, email_enabled: true } });
      EmailLib.sendTemplate.mockImplementation(async (opts) => {
        await opts.onQueued({ id: 'em-1' });
        const err = new Error('SendGrid 408');
        err.status = 408;
        throw err;
      });
      expect(await ReviewService.sendInlineEmailCopy('rr-1')).toEqual({ sent: false, reason: 'email_uncertain' });
      // A 5xx stays uncertain.
      wire({ prefs: { review_request: true, email_enabled: true } });
      EmailLib.sendTemplate.mockImplementation(async (opts) => {
        await opts.onQueued({ id: 'em-1' });
        const err = new Error('SendGrid 503');
        err.status = 503;
        throw err;
      });
      expect(await ReviewService.sendInlineEmailCopy('rr-1')).toEqual({ sent: false, reason: 'email_uncertain' });
      expect(rrUpdate).toHaveBeenCalledTimes(1);
    });

    test('re-checks the live customer: already reviewed or removed refuses before any send (r8 P2)', async () => {
      wire({ prefs: { review_request: true, email_enabled: true }, customerRow: { has_left_google_review: true } });
      expect(await ReviewService.sendInlineEmailCopy('rr-1')).toEqual({ sent: false, reason: 'already_reviewed' });
      wire({ prefs: { review_request: true, email_enabled: true }, customerRow: { deleted_at: new Date() } });
      expect(await ReviewService.sendInlineEmailCopy('rr-1')).toEqual({ sent: false, reason: 'no_customer' });
      expect(EmailLib.sendTemplate).not.toHaveBeenCalled();
    });
  });

  test('sendOutreachTouch strictChannel: an unavailable chosen channel refuses instead of swapping', async () => {
    const insert = jest.fn();
    getServiceContact.mockReturnValue({ email: '', name: 'Megan' });
    getServiceContactSmsRecipient.mockReturnValue({ phone: '+19415550101', name: 'Megan' });
    db.mockImplementation((table) => {
      if (table === 'notification_prefs') {
        return chain({ first: jest.fn().mockResolvedValue({ review_request: true, sms_enabled: true, email_enabled: true }) });
      }
      if (table === 'review_requests') return { ...chain({ first: jest.fn().mockResolvedValue(null) }), insert };
      return chain({ first: jest.fn().mockResolvedValue(null) });
    });
    const customer = { id: 'cust-1', first_name: 'Megan', city: 'Bradenton' };

    // Email chosen, no email on file: strict = refused, no text goes out.
    const strict = await ReviewService.sendOutreachTouch({ customer, channel: 'email', strictChannel: true });
    expect(strict).toMatchObject({ ok: false, reason: 'no_contact', terminal: true });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  test('composer mint refuses an email-only review preference', async () => {
    const insert = insertReturning({ id: 'rr-new', token: null });
    db.mockImplementation((table) => {
      if (table === 'customers') {
        return chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', has_left_google_review: false }) });
      }
      if (table === 'notification_prefs') {
        return chain({ first: jest.fn().mockResolvedValue({ review_request: true, sms_enabled: true, review_request_channel: 'email' }) });
      }
      if (table === 'review_requests') {
        return { ...chain({ first: jest.fn().mockResolvedValue(null) }), insert: insert.query.insert };
      }
      throw new Error(`Unexpected table query: ${table}`);
    });

    expect(await ReviewService.createInline({ customerId: 'cust-1', armSafetyNet: false })).toBeNull();
    expect(insert.query.insert).not.toHaveBeenCalled();
  });

  test('claim token fences mark/release and the pre-provider check — a superseded holder cannot act', async () => {
    const rrQuery = chain();
    db.mockImplementation((table) => {
      if (table === 'review_requests') return rrQuery;
      throw new Error(`Unexpected table query: ${table}`);
    });
    const mine = new Date('2026-06-03T14:00:00.000Z');
    const theirs = new Date('2026-06-03T14:11:00.000Z'); // a later reclaim

    // Fenced mark + release scope the UPDATE to the token the caller holds.
    await ReviewService.markInlineDelivered('rr-inline', mine);
    expect(rrQuery.where).toHaveBeenCalledWith('claimed_at', mine);
    await ReviewService.releaseInlineClaim('rr-inline', mine);
    expect(rrQuery.where).toHaveBeenCalledWith('claimed_at', mine);

    // Pre-provider fence: the row now carries the reclaim's token.
    rrQuery.first.mockResolvedValueOnce({ claimed_at: theirs });
    expect(await ReviewService.inlineClaimStillHeld('rr-inline', mine)).toBe(false);
    rrQuery.first.mockResolvedValueOnce({ claimed_at: mine });
    expect(await ReviewService.inlineClaimStillHeld('rr-inline', mine)).toBe(true);
  });

  test('a live composer claim blocks every canonical one-off ask path via the gates', async () => {
    // The composer's row is 'sending' + unscheduled: invisible to the queued
    // arm and the delivered stats, yet about to text — the in-flight arm
    // must refuse a concurrent /trigger or satisfaction ask.
    const statsSpy = jest.spyOn(ReviewService, 'getDeliveredAskStats').mockResolvedValue({ count: 0, lastAt: null });
    const rrQuery = chain();
    rrQuery.first.mockResolvedValueOnce({ id: 'rr-in-flight' });
    db.mockImplementation((table) => {
      if (table === 'review_requests') return rrQuery;
      if (table === 'review_sequences') return chain({ first: jest.fn().mockResolvedValue(null) });
      throw new Error(`Unexpected table query: ${table}`);
    });

    expect(await ReviewService.checkUnscheduledAskGates('cust-1')).toEqual({ allowed: false, outcome: 'in_flight' });
    expect(rrQuery.where).toHaveBeenCalledWith({ customer_id: 'cust-1', status: 'sending' });
    expect(rrQuery.where).toHaveBeenCalledWith('claimed_at', '>=', expect.any(Date));
    statsSpy.mockRestore();
  });

  test('releaseInlineClaim hands a claimed row back to pending', async () => {
    const updateQuery = chain();
    db.mockImplementation((table) => {
      if (table === 'review_requests') return updateQuery;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await ReviewService.releaseInlineClaim('rr-inline');

    expect(updateQuery.where).toHaveBeenCalledWith({ id: 'rr-inline', status: 'sending' });
    expect(updateQuery.whereNull).toHaveBeenCalledWith('sms_sent_at');
    expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending' }));
  });

  test('composer mint (armSafetyNet:false) inserts an UNSCHEDULED row', async () => {
    const insert = insertReturning({ id: 'rr-composer', token: null });
    db.mockImplementation((table) => {
      if (table === 'customers') {
        return chain({
          first: jest.fn().mockResolvedValue({ id: 'cust-1', has_left_google_review: false }),
        });
      }
      if (table === 'notification_prefs') {
        return chain({ first: jest.fn().mockResolvedValue(null) });
      }
      if (table === 'review_requests') {
        return {
          ...chain({ first: jest.fn().mockResolvedValue(null) }),
          insert: insert.query.insert,
        };
      }
      throw new Error(`Unexpected table query: ${table}`);
    });

    const result = await ReviewService.createInline({
      customerId: 'cust-1',
      armSafetyNet: false,
    });

    expect(insert.holder.payload).toEqual(expect.objectContaining({
      customer_id: 'cust-1',
      triggered_by: 'auto_inline',
      scheduled_for: null,
      status: 'pending',
    }));
    expect(result.requestId).toBe('rr-composer');
  });

  test('composer mint reuses an existing pending unscheduled row instead of stacking tokens', async () => {
    const insert = insertReturning({ id: 'rr-new', token: null });
    db.mockImplementation((table) => {
      if (table === 'customers') {
        return chain({
          first: jest.fn().mockResolvedValue({ id: 'cust-1', has_left_google_review: false }),
        });
      }
      if (table === 'notification_prefs') {
        return chain({ first: jest.fn().mockResolvedValue(null) });
      }
      if (table === 'review_requests') {
        return {
          ...chain({
            first: jest.fn().mockResolvedValue({
              id: 'rr-open-tab',
              token: 'token-open-tab',
              status: 'pending',
              sms_sent_at: null,
              scheduled_for: null,
            }),
          }),
          insert: insert.query.insert,
        };
      }
      throw new Error(`Unexpected table query: ${table}`);
    });

    const result = await ReviewService.createInline({
      customerId: 'cust-1',
      armSafetyNet: false,
    });

    expect(result).toMatchObject({ requestId: 'rr-open-tab', token: 'token-open-tab' });
    expect(insert.query.insert).not.toHaveBeenCalled();
  });

  test('composer reuse also matches a row mid-claim and reuses its short URL', async () => {
    const { existingShortUrlFor } = require('../services/short-url');
    // Another tab's /sms is between claim and delivery-mark: status 'sending'.
    // Minting a fresh token here would ride past the claim gate — the reuse
    // query must see the claimed row too.
    const rrChain = chain({
      first: jest.fn().mockResolvedValue({
        id: 'rr-claimed',
        token: 'token-claimed',
        status: 'sending',
        sms_sent_at: null,
        scheduled_for: null,
      }),
    });
    db.mockImplementation((table) => {
      if (table === 'customers') {
        return chain({
          first: jest.fn().mockResolvedValue({ id: 'cust-1', has_left_google_review: false }),
        });
      }
      if (table === 'notification_prefs') {
        return chain({ first: jest.fn().mockResolvedValue(null) });
      }
      if (table === 'review_requests') return rrChain;
      throw new Error(`Unexpected table query: ${table}`);
    });
    // The row already has a minted code — the second insert must carry the
    // SAME short URL, or its body slips past the /sms linkInBody claim gate.
    existingShortUrlFor.mockResolvedValueOnce('https://portal.wavespestcontrol.com/s/abc123');

    const result = await ReviewService.createInline({
      customerId: 'cust-1',
      armSafetyNet: false,
    });

    expect(rrChain.whereIn).toHaveBeenCalledWith('status', ['pending', 'sending']);
    expect(result).toMatchObject({
      requestId: 'rr-claimed',
      token: 'token-claimed',
      url: 'https://portal.wavespestcontrol.com/s/abc123',
    });
    expect(shortenOrPassthrough).not.toHaveBeenCalled();
  });

  test('manual-ask detection recognizes the seeded Yelp and Facebook write-a-review links', async () => {
    for (const body of [
      'Review us on Yelp here: yelp.com/writeareview/biz/waves-pest-control-bradenton-6',
      'Review us on Facebook here: facebook.com/wavespestcontrol/reviews',
    ]) {
      db.mockImplementation((table) => {
        if (table === 'sms_log') {
          return chain({
            whereNotIn: jest.fn(function () { return this; }),
            select: jest.fn().mockResolvedValue([
              { message_body: body, created_at: new Date('2026-06-01T12:00:00.000Z') },
            ]),
          });
        }
        if (table === 'review_requests') {
          return chain({ select: jest.fn().mockResolvedValue([]) });
        }
        throw new Error(`Unexpected table query: ${table}`);
      });

      const detected = await ReviewService.manualReviewAskSentRecently('cust-1');
      expect(detected).toBe(true);
    }
  });
});
