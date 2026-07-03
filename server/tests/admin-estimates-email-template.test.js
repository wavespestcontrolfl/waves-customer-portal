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
  estimateDataHasUnresolvedManagerApproval: jest.fn((estimateData) => {
    const data = typeof estimateData === 'string' ? JSON.parse(estimateData) : estimateData;
    const inputsApproved = data?.inputs?.dethatchingManagerApproved === true &&
      data?.inputs?.dethatchingManagerApprovalTrusted === true &&
      String(data?.inputs?.dethatchingManagerApprovalReason || '').trim().length > 0;
    return !inputsApproved && data?.result?.oneTime?.items?.some((item) => (
      item.requiresManagerApproval === true &&
      item.managerApprovalReason === 'st_augustine_dethatching' &&
      item.managerApprovalSatisfied !== true
    ));
  }),
  commercialRiskTypeReviewNeeded: jest.fn(() => false),
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
const db = require('../models/db');
const EmailTemplateLibrary = require('../services/email-template-library');
const sendgrid = require('../services/sendgrid-mail');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { bookingServiceFor } = require('../routes/estimate-public');

function routeHandler(path, method = 'post') {
  const layer = router.stack.find((entry) => (
    entry.route?.path === path && entry.route?.methods?.[method]
  ));
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

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
      payload: expect.objectContaining({
        first_name: 'Taylor',
        estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample',
        price_summary: '$89/month',
        next_step_summary: expect.any(String),
      }),
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

  test('does not fall back to SMTP for estimate delivery in production', async () => {
    const originalEnv = process.env.NODE_ENV;
    const originalPassword = process.env.GOOGLE_SMTP_PASSWORD;
    process.env.NODE_ENV = 'production';
    process.env.GOOGLE_SMTP_PASSWORD = 'configured-for-test';
    EmailTemplateLibrary.sendTemplate.mockRejectedValueOnce(new Error('template not found'));

    try {
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
        ok: false,
        error: 'Email send unavailable: SendGrid template path failed and SMTP fallback is disabled in production',
        template: 'estimate.delivery',
      });
    } finally {
      if (originalEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalEnv;
      }
      if (originalPassword === undefined) {
        delete process.env.GOOGLE_SMTP_PASSWORD;
      } else {
        process.env.GOOGLE_SMTP_PASSWORD = originalPassword;
      }
    }
  });

  test('blocks sending quote-required estimates', () => {
    expect(() => router._internals.assertEstimateSendable({
      id: 'estimate-quote-required',
      token: 'tok-estimate-quote-required',
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

  test('blocks sending estimates without a billable total', () => {
    expect(() => router._internals.assertEstimateSendable({
      id: 'estimate-zero-total',
      token: 'tok-estimate-zero-total',
      status: 'draft',
      monthly_total: 0,
      onetime_total: 0,
      estimate_data: {},
    })).toThrow(/positive monthly or one-time total/);
  });

  test('summarizes lead estimate automation and blocks manual-review automated drafts', () => {
    const estimateData = {
      automation: {
        leadEstimateAutomation: {
          status: 'ready',
          confidence: 'medium',
          minimumConfidence: 'medium',
          review: ['property_measurements_defaulted'],
          missing: [],
        },
        draftEstimateAutomation: {
          status: 'manual_review_required',
          generated: false,
          unsupportedReason: 'termite_treatment_requires_manual_scope',
          review: ['property_measurements_defaulted'],
        },
      },
    };

    expect(router._internals.leadEstimateAutomationSummary(estimateData)).toEqual({
      status: 'manual_review_required',
      generated: false,
      confidence: 'medium',
      minimumConfidence: 'medium',
      quoteRequired: false,
      unsupportedReason: 'termite_treatment_requires_manual_scope',
      quoteRequiredReason: null,
      review: ['property_measurements_defaulted'],
      missing: [],
    });
    expect(router._internals.estimateDataHasBlockingLeadAutomation(estimateData)).toBe(true);
    expect(() => router._internals.assertEstimateSendable({
      id: 'estimate-auto-review',
      token: 'tok-estimate-auto-review',
      status: 'draft',
      estimate_data: estimateData,
    })).toThrow(/Automated lead estimates need manual review/);
  });

  test('allows generated lead automation drafts through the normal send gate', () => {
    const estimateData = {
      automation: {
        leadEstimateAutomation: {
          status: 'ready',
          confidence: 'medium',
          minimumConfidence: 'medium',
          review: ['property_measurements_defaulted'],
          missing: [],
        },
        draftEstimateAutomation: {
          status: 'generated',
          generated: true,
          review: ['property_measurements_defaulted'],
        },
      },
    };

    expect(router._internals.leadEstimateAutomationSummary(estimateData)).toMatchObject({
      status: 'generated',
      generated: true,
      confidence: 'medium',
      review: ['property_measurements_defaulted'],
    });
    expect(router._internals.estimateDataHasBlockingLeadAutomation(estimateData)).toBe(false);
    expect(() => router._internals.assertEstimateSendable({
      id: 'estimate-auto-generated',
      token: 'tok-estimate-auto-generated',
      status: 'draft',
      monthly_total: 89,
      estimate_data: estimateData,
    })).not.toThrow();
  });

  test('blocks sending estimates with unresolved manager approval', () => {
    expect(() => router._internals.assertEstimateSendable({
      id: 'estimate-manager-approval',
      token: 'tok-estimate-manager-approval',
      status: 'draft',
      estimate_data: {
        result: {
          oneTime: {
            items: [
              {
                service: 'dethatching',
                requiresManagerApproval: true,
                managerApprovalReason: 'st_augustine_dethatching',
                managerApprovalSatisfied: false,
              },
            ],
          },
        },
      },
    })).toThrow(/Manager approval is required/);
  });

  test('blocks follow-up SMS for estimates with unresolved manager approval', async () => {
    const query = {
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({
        id: 'estimate-manager-approval',
        token: 'estimate-token',
        customer_name: 'Taylor Smith',
        customer_phone: '+15555550123',
        customer_id: null,
        status: 'sent',
        estimate_data: {
          result: {
            oneTime: {
              items: [
                {
                  service: 'dethatching',
                  requiresManagerApproval: true,
                  managerApprovalReason: 'st_augustine_dethatching',
                  managerApprovalSatisfied: false,
                },
              ],
            },
          },
        },
      }),
      update: jest.fn(),
    };
    db.mockReturnValue(query);

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    await routeHandler('/:id/follow-up')({
      params: { id: 'estimate-manager-approval' },
      body: {},
    }, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.stringMatching(/Manager approval is required/),
    });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test('blocks manual booking-link SMS for estimates with unresolved manager approval', async () => {
    const query = {
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({
        id: 'estimate-manager-approval',
        token: 'estimate-token',
        customer_name: 'Taylor Smith',
        customer_phone: '+15555550123',
        customer_id: null,
        status: 'viewed',
        bill_by_invoice: false,
        estimate_data: {
          result: {
            oneTime: {
              items: [
                {
                  service: 'dethatching',
                  name: 'Dethatching',
                  price: 150,
                  requiresManagerApproval: true,
                  managerApprovalReason: 'st_augustine_dethatching',
                  managerApprovalSatisfied: false,
                },
              ],
            },
          },
        },
      }),
      update: jest.fn(),
    };
    db.mockReturnValue(query);

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    await routeHandler('/:id/send-booking-link')({
      params: { id: 'estimate-manager-approval' },
      body: {},
    }, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.stringMatching(/Manager approval is required/),
    });
    expect(bookingServiceFor).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test('allows manager-approval estimates after approval reason is recorded', () => {
    expect(() => router._internals.assertEstimateSendable({
      id: 'estimate-manager-approved',
      token: 'tok-estimate-manager-approved',
      status: 'draft',
      onetime_total: 150,
      estimate_data: {
        inputs: {
          dethatchingManagerApproved: true,
          dethatchingManagerApprovalReason: 'verified_thatch_probe',
          dethatchingManagerApprovalTrusted: true,
        },
        result: {
          oneTime: {
            items: [
              {
                service: 'dethatching',
                requiresManagerApproval: true,
                managerApprovalReason: 'st_augustine_dethatching',
              },
            ],
          },
        },
      },
    })).not.toThrow();
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
