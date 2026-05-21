jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/estimate-delivery-options', () => ({
  estimateDataHasQuoteRequirement: jest.fn((estimateData) => {
    const data = typeof estimateData === 'string' ? JSON.parse(estimateData) : estimateData;
    return data?.result?.quoteRequired === true ||
      data?.quoteRequired === true ||
      data?.result?.specItems?.some((item) => item.quoteRequired === true);
  }),
  validateEstimateDeliveryOptions: jest.fn(),
}));
jest.mock('../services/estimate-pricing-audit', () => ({
  buildEstimatePricingAudit: jest.fn(),
  buildEstimatePricingRiskBatch: jest.fn(),
  getLatestEstimatePricingAuditSnapshot: jest.fn(),
  saveEstimatePricingAuditSnapshot: jest.fn(),
}));
jest.mock('../services/lead-estimate-link', () => ({ markLinkedLeadEstimateSent: jest.fn() }));
jest.mock('../services/estimate-manual-acceptance', () => ({ markEstimateManuallyAccepted: jest.fn() }));
jest.mock('../services/admin-estimate-persistence', () => ({
  createOrReuseAdminEstimate: jest.fn(),
  estimateViewUrl: jest.fn(),
}));
jest.mock('../routes/estimate-public', () => ({
  acceptanceServiceLists: jest.fn(),
  bookingServiceFor: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn() }));

const router = require('../routes/admin-estimates');
const EmailTemplateLibrary = require('../services/email-template-library');
const sendgrid = require('../services/sendgrid-mail');

describe('admin estimate email delivery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sendgrid.isConfigured.mockReturnValue(true);
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({
      sent: true,
      message: { provider_message_id: 'sg-123' },
    });
  });

  test('sends estimate.delivery with state-scoped idempotency so later manual re-sends are delivered', async () => {
    const result = await router._internals.sendEstimateEmail({
      estimate: {
        id: 'estimate-1',
        customer_email: 'taylor@example.com',
        customer_id: null,
        status: 'sent',
        updated_at: '2026-05-18T10:00:00.000Z',
      },
      firstName: 'Taylor',
      viewUrl: 'https://portal.wavespestcontrol.com/estimate/sample',
      priceLine: '$89/month',
      idempotencyKey: 'send-click-1',
    });

    expect(result).toEqual({
      ok: true,
      messageId: 'sg-123',
      template: 'estimate.delivery',
    });
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'estimate.delivery',
      to: 'taylor@example.com',
      recipientType: 'lead',
      recipientId: null,
      triggerEventId: 'estimate_delivery:estimate-1',
      idempotencyKey: expect.stringMatching(/^estimate\.delivery:[a-f0-9]{64}$/),
      categories: ['estimate_delivery'],
      payload: {
        first_name: 'Taylor',
        estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample',
        price_summary: '$89/month',
      },
    }));
    const nextSendKey = router._internals.estimateEmailIdempotencyKey({
      id: 'estimate-1',
      customer_email: 'taylor@example.com',
      status: 'sent',
      updated_at: '2026-05-18T10:05:00.000Z',
    }, 'send-click-2');
    expect(nextSendKey).toMatch(/^estimate\.delivery:[a-f0-9]{64}$/);
    expect(nextSendKey).not.toBe(EmailTemplateLibrary.sendTemplate.mock.calls[0][0].idempotencyKey);
  });

  test('uses a stable scheduled estimate idempotency key across retry claims', () => {
    const firstAttemptKey = router._internals.estimateEmailIdempotencyKey({
      id: 'estimate-1',
      customer_email: 'taylor@example.com',
      status: 'sending',
      scheduled_at: '2026-05-18T15:00:00.000Z',
      created_at: '2026-05-18T09:00:00.000Z',
      updated_at: '2026-05-18T15:01:00.000Z',
      scheduled_send_attempts: 1,
    });
    const retryKey = router._internals.estimateEmailIdempotencyKey({
      id: 'estimate-1',
      customer_email: 'taylor@example.com',
      status: 'sending',
      scheduled_at: '2026-05-18T15:05:00.000Z',
      created_at: '2026-05-18T09:00:00.000Z',
      updated_at: '2026-05-18T15:10:00.000Z',
      scheduled_send_attempts: 2,
    });

    expect(firstAttemptKey).toMatch(/^estimate\.delivery:[a-f0-9]{64}$/);
    expect(retryKey).toBe(firstAttemptKey);
  });

  test('blocks sending quote-required estimates', () => {
    expect(() => router._internals.assertEstimateSendable({
      id: 'estimate-quote-required',
      status: 'draft',
      estimate_data: {
        result: {
          quoteRequired: true,
          specItems: [
            { service: 'commercial_pest', quoteRequired: true },
          ],
        },
      },
    })).toThrow(/Quote-required estimates need manual review/);
  });

  test('sent-only estimate scope includes delivery attempts but not generated drafts', () => {
    const { estimateMatchesSentOnlyScope } = router._internals;

    expect(estimateMatchesSentOnlyScope({ status: 'draft', sent_at: null })).toBe(false);
    expect(estimateMatchesSentOnlyScope({ status: 'draft', sent_at: '2026-05-20T12:00:00.000Z' })).toBe(true);
    expect(estimateMatchesSentOnlyScope({ status: 'sent', sent_at: '2026-05-20T12:00:00.000Z' })).toBe(true);
    expect(estimateMatchesSentOnlyScope({ status: 'viewed', sent_at: '2026-05-20T12:00:00.000Z' })).toBe(true);
    expect(estimateMatchesSentOnlyScope({ status: 'scheduled', sent_at: null })).toBe(true);
    expect(estimateMatchesSentOnlyScope({ status: 'sending', sent_at: null })).toBe(true);
    expect(estimateMatchesSentOnlyScope({ status: 'send_failed', sent_at: null })).toBe(true);
  });
});
