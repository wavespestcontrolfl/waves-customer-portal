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
  firstNameFrom: jest.requireActual('../services/customer-contact').firstNameFrom,
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn((url) => Promise.resolve(url)),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const { getServiceContact } = require('../services/customer-contact');
const { shortenOrPassthrough } = require('../services/short-url');
const ReviewService = require('../services/review-request');

function chain(overrides = {}) {
  return {
    where: jest.fn(function () { return this; }),
    whereIn: jest.fn(function () { return this; }),
    whereNull: jest.fn(function () { return this; }),
    whereNotNull: jest.fn(function () { return this; }),
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
      if (table === 'review_requests') return insert.query;
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
      expect(ReviewService.sendSMS).toHaveBeenCalledWith('rr-admin');
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
      chain({
        first: jest.fn().mockResolvedValue({
          id: 'rr-existing',
          service_record_id: 'sr-1',
          status: 'pending',
          sms_sent_at: null,
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

      expect(ReviewService.sendSMS).toHaveBeenCalledWith('rr-existing');
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

  test('marks inline delivery only for pending unsent rows', async () => {
    const updateQuery = chain();
    db.mockImplementation((table) => {
      if (table === 'review_requests') return updateQuery;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await ReviewService.markInlineDelivered('rr-inline');

    expect(updateQuery.where).toHaveBeenCalledWith({ id: 'rr-inline' });
    expect(updateQuery.whereNull).toHaveBeenCalledWith('sms_sent_at');
    expect(updateQuery.where).toHaveBeenCalledWith('status', 'pending');
    expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      scheduled_for: null,
      status: 'sent',
    }));
  });
});
