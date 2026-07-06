jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn((url) => Promise.resolve(url)),
}));
jest.mock('../services/customer-contact', () => ({
  getServiceContact: jest.fn(),
  firstNameFrom: jest.requireActual('../services/customer-contact').firstNameFrom,
}));
jest.mock('../utils/portal-url', () => ({
  publicPortalUrl: jest.fn(() => 'https://waves.test'),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { getServiceContact } = require('../services/customer-contact');
const smsTemplates = require('../routes/admin-sms-templates');
const ReviewService = require('../services/review-request');

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    whereNotNull: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    first: jest.fn(),
    update: jest.fn().mockResolvedValue(1),
    limit: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue([{ count: 0 }]),
    ...overrides,
  };
}

describe('review request quiet-hours handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getServiceContact.mockReturnValue({ phone: '+19415551212', name: 'Jamie' });
    smsTemplates.getTemplate.mockResolvedValue('Please review us: https://short.test/r');
  });

  test('requeues quiet-hours holds instead of suppressing the request', async () => {
    const nextAllowedAt = '2026-05-26T12:00:00.000Z';
    const requestQuery = chain({
      first: jest.fn().mockResolvedValue({
        id: 10,
        token: 'token-10',
        customer_id: 20,
        tech_name: 'Tech One',
        sms_sent_at: null,
      }),
    });
    const updateQuery = chain();
    const customerQuery = chain({
      first: jest.fn().mockResolvedValue({
        id: 20,
        first_name: 'Jamie',
        phone: '+19415551212',
        has_left_google_review: false,
      }),
    });
    const reviewRequestQueries = [requestQuery, updateQuery];

    db.mockImplementation((table) => {
      if (table === 'review_requests') return reviewRequestQueries.shift();
      if (table === 'customers') return customerQuery;
      throw new Error(`Unexpected table query: ${table}`);
    });
    sendCustomerMessage.mockResolvedValue({
      sent: false,
      blocked: true,
      code: 'QUIET_HOURS_HOLD',
      retryable: true,
      deferred: true,
      nextAllowedAt,
      auditLogId: 'audit-1',
    });

    await ReviewService.sendSMS(10);

    expect(updateQuery.update).toHaveBeenCalledWith({
      status: 'pending',
      scheduled_for: new Date(nextAllowedAt),
    });
    expect(updateQuery.update).not.toHaveBeenCalledWith({ status: 'suppressed' });
  });
});
